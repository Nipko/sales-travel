import { HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import {
  TBO_ERROR_CLASSES,
  TBO_FAILURE_KINDS,
  TBO_OPERATIONS,
  TboApiError,
  TboCancelMappingError,
  TboCancelOutcomeUnknownError,
  TboConfigError,
  TboCredentialsMissingError,
  TboDispatchRejectedError,
  TboError,
  TboOfferExpiredError,
  TboPackageOnlyRateError,
  TboRequestBuildError,
  TboResponseMappingError,
  TboUnsupportedCurrencyError,
  type TboFailureKind,
} from '@sales-travel/tbo-hotels';
import { describe, expect, it } from 'vitest';
import type { CredentialSource } from '../providers/provider.types.js';
import {
  TBO_LOCAL_ERROR_REASONS,
  humanizeTboError,
  tboCircuitEffect,
  tboErrorReason,
  tboErrorStatus,
} from './tbo-hotels-errors.js';

/**
 * Humanizador, estado HTTP, `reason` y efecto en el breaker de los errores de TBO
 * (docs/tbo/01 §8.3, §8.4 y §9.4; 08 RF-04).
 */

const SEARCH = TBO_OPERATIONS.search.path;
const BOOK = TBO_OPERATIONS.book.path;
const CANCEL = TBO_OPERATIONS.cancel.path;
const PREBOOK = TBO_OPERATIONS.prebook.path;

const GENERICO = 'No pudimos procesar la solicitud con TBO. Intentá nuevamente.';

function apiError(kind: TboFailureKind, path: string = SEARCH, status = 200): TboApiError {
  return new TboApiError({ status, tboCode: 999, path, kind, requestId: 'req-00000001' });
}

/**
 * Una instancia de cada clase que el ACL lanza. Si el ACL suma una clase, el test de cobertura de
 * abajo se pone en rojo hasta que tenga su fila aquí y su traducción en `tbo-hotels-errors.ts`.
 */
const INSTANCIAS: Readonly<Record<string, () => TboError>> = {
  TboApiError: () => apiError('UPSTREAM'),
  TboConfigError: () => new TboConfigError(['baseUrl:https_required']),
  TboCredentialsMissingError: () => new TboCredentialsMissingError(['password']),
  TboRequestBuildError: () => new TboRequestBuildError(SEARCH, 'SCHEMA', ['HotelCodes:too_big']),
  TboDispatchRejectedError: () => new TboDispatchRejectedError(SEARCH, 'QUEUE_TIMEOUT', 5_000),
  TboOfferExpiredError: () => new TboOfferExpiredError('2026-11-01T15:27:00.000Z'),
  TboResponseMappingError: () => new TboResponseMappingError(PREBOOK, ['Rooms:invalid_type']),
  TboCancelMappingError: () => new TboCancelMappingError(CANCEL, ['Status:invalid_type']),
  TboCancelOutcomeUnknownError: () =>
    TboCancelOutcomeUnknownError.from(apiError('BOOKING_FAILED', CANCEL)),
  TboUnsupportedCurrencyError: () => new TboUnsupportedCurrencyError(['KWD']),
  TboPackageOnlyRateError: () => new TboPackageOnlyRateError(),
};

describe('cada clase que el ACL lanza tiene traducción propia', () => {
  it('la tabla de instancias cubre TODA la lista del ACL (anti-vacuidad)', () => {
    expect(Object.keys(INSTANCIAS).sort()).toEqual(TBO_ERROR_CLASSES.map((c) => c.name).sort());
  });

  it.each(Object.entries(INSTANCIAS))(
    '%s: la atrapa el filtro, con mensaje, estado y `reason` propios',
    (_nombre, crear) => {
      const err = crear();
      expect(err).toBeInstanceOf(TboError);
      expect(humanizeTboError(err)).not.toBe(GENERICO);
      expect(tboErrorReason(err)).not.toBe('UNKNOWN');
      expect([400, 409, 502, 503]).toContain(tboErrorStatus(err));
    },
  );
});

describe('RF-04: un mensaje por `kind`, nunca texto del proveedor', () => {
  it.each(TBO_FAILURE_KINDS)('%s tiene mensaje en cada operación y origen', (kind) => {
    for (const path of [SEARCH, PREBOOK, BOOK, CANCEL]) {
      for (const credentialSource of [undefined, 'own', 'inherited', 'env'] as const) {
        const err = apiError(kind, path);
        const mensaje = humanizeTboError(err, { credentialSource });
        expect(mensaje.length).toBeGreaterThan(20);
        expect(mensaje).not.toBe(GENERICO);
        // El `message` del error es vocabulario nuestro, pero tampoco es para el vendedor.
        expect(mensaje).not.toContain(err.message);
        expect(mensaje).not.toContain('req-00000001');
      }
    }
  });

  it('no cita lo que vino de TBO ni de la cuenta, aunque la clase lo traiga', () => {
    expect(humanizeTboError(new TboUnsupportedCurrencyError(['KWD']))).not.toContain('KWD');
    expect(humanizeTboError(new TboConfigError(['baseUrl:https_required']))).not.toContain(
      'https_required',
    );
    expect(humanizeTboError(new TboCredentialsMissingError(['password']))).not.toContain(
      'password',
    );
    expect(
      humanizeTboError(new TboResponseMappingError(SEARCH, ['HotelResult.0.Rooms:invalid_type'])),
    ).not.toContain('HotelResult');
  });

  it('un error que no es de TBO ni nuestro no se repite: puede traer cualquier cosa', () => {
    expect(humanizeTboError(new Error('ECONNRESET 10.0.0.7 Authorization: Basic eHh4'))).toBe(
      GENERICO,
    );
    expect(humanizeTboError('texto suelto')).toBe(GENERICO);
  });

  it('una excepción HTTP nuestra (el breaker) ya habla al vendedor y sale tal cual', () => {
    const breaker = new ServiceUnavailableException(
      'El proveedor tbo-hotels está temporalmente deshabilitado.',
    );
    expect(humanizeTboError(breaker)).toBe(
      'El proveedor tbo-hotels está temporalmente deshabilitado.',
    );
  });
});

describe('variantes según de quién es la cuenta (docs/tbo/01 §9.4)', () => {
  const ORIGENES: readonly (CredentialSource | undefined)[] = [
    'own',
    'inherited',
    'env',
    undefined,
  ];

  it.each(['CREDENTIALS_INVALID', 'ACCOUNT_BLOCKED', 'INSUFFICIENT_BALANCE'] as const)(
    '%s: cuatro mensajes distintos, y el heredado manda al consolidador',
    (kind) => {
      const mensajes = ORIGENES.map((credentialSource) =>
        humanizeTboError(apiError(kind), { credentialSource }),
      );
      expect(new Set(mensajes).size).toBe(4);
      expect(mensajes[1]).toContain('consolidador');
      expect(mensajes[2]).toContain('plataforma');
    },
  );

  it('credencial propia rechazada: el camino del panel para corregirla', () => {
    expect(humanizeTboError(apiError('CREDENTIALS_INVALID'), { credentialSource: 'own' })).toBe(
      'TBO rechazó el usuario o la contraseña de tu agencia. Verificalos en Mi Red → Credenciales → TBO Hoteles.',
    );
  });

  it('sin contexto (el filtro) no supone de quién es la cuenta', () => {
    expect(humanizeTboError(apiError('ACCOUNT_BLOCKED'))).toContain(
      'la cuenta con la que opera tu agencia',
    );
  });

  it('la configuración inválida y la cuenta incompleta también cambian de destinatario', () => {
    const config = new TboConfigError(['environment:invalid_type']);
    const incompleta = new TboCredentialsMissingError(['username']);
    expect(humanizeTboError(config, { credentialSource: 'inherited' })).toContain('consolidador');
    expect(humanizeTboError(incompleta, { credentialSource: 'own' })).toContain(
      'Mi Red → Credenciales → TBO Hoteles',
    );
  });
});

describe('variantes según la operación', () => {
  const INCIERTOS = [
    'TRANSPORT',
    'UPSTREAM',
    'THROTTLED',
    'MALFORMED_RESPONSE',
    'UNKNOWN_CODE',
  ] as const;

  it.each(INCIERTOS)(
    '%s en /Book: "no la repitas", porque la reserva pudo quedar hecha',
    (kind) => {
      expect(humanizeTboError(apiError(kind, BOOK))).toContain('no la repitas');
    },
  );

  it.each(INCIERTOS)('%s en /Cancel: "no la canceles de nuevo"', (kind) => {
    expect(humanizeTboError(apiError(kind, CANCEL))).toContain('no la canceles de nuevo');
  });

  it('en una búsqueda, la caída es sólo una caída', () => {
    expect(humanizeTboError(apiError('TRANSPORT', SEARCH))).toBe(
      'No pudimos conectar con TBO. Probá de nuevo en unos segundos.',
    );
  });

  it('`201` en la búsqueda es "no hay"; en el PreBook, "ya no hay"', () => {
    expect(humanizeTboError(apiError('NO_AVAILABILITY', SEARCH))).toContain(
      'no tiene habitaciones disponibles',
    );
    expect(humanizeTboError(apiError('NO_AVAILABILITY', PREBOOK))).toContain('Volvé a buscar');
  });

  it('la lectura fallida de un Book o un Cancel es incierta; la de un PreBook, no', () => {
    expect(humanizeTboError(new TboResponseMappingError(BOOK, []))).toContain('no la repitas');
    expect(humanizeTboError(new TboCancelMappingError(CANCEL, []))).toContain(
      'no la canceles de nuevo',
    );
    // HARD-1: un código de otra operación en /Cancel no habla de reservar ni de volver a buscar.
    const sinDesenlace = TboCancelOutcomeUnknownError.from(apiError('NO_AVAILABILITY', CANCEL));
    expect(humanizeTboError(sinDesenlace)).toContain('no la canceles de nuevo');
    expect(tboErrorReason(sinDesenlace)).toBe('CANCEL_UNVERIFIED');
    expect(tboErrorStatus(sinDesenlace)).toBe(HttpStatus.BAD_GATEWAY);
    expect(humanizeTboError(new TboResponseMappingError(PREBOOK, []))).toContain(
      'no pudimos interpretar',
    );
  });

  it('una búsqueda que TBO no admite dice qué ajustar; un body roto es bug nuestro', () => {
    expect(humanizeTboError(new TboRequestBuildError(SEARCH, 'NOT_ELIGIBLE'))).toContain(
      'nacionalidad',
    );
    expect(humanizeTboError(new TboRequestBuildError(SEARCH, 'CARD_DATA'))).toContain(
      'Ya quedó registrado',
    );
  });

  it('sin cupo en el limitador se reintenta; sin tiempo en la búsqueda, también, pero lo dice', () => {
    expect(humanizeTboError(new TboDispatchRejectedError(SEARCH, 'QUEUE_TIMEOUT', 1))).toContain(
      'unos segundos',
    );
    expect(humanizeTboError(new TboDispatchRejectedError(SEARCH, 'DEADLINE', 1))).toContain(
      'no alcanzó a responder',
    );
  });
});

describe('estado HTTP hacia el front', () => {
  it.each([
    ['NO_AVAILABILITY', HttpStatus.CONFLICT],
    ['RATE_UNAVAILABLE', HttpStatus.CONFLICT],
    ['OFFER_EXPIRED', HttpStatus.CONFLICT],
    ['INSUFFICIENT_BALANCE', HttpStatus.CONFLICT],
    ['THROTTLED', HttpStatus.SERVICE_UNAVAILABLE],
    ['CREDENTIALS_INVALID', HttpStatus.BAD_GATEWAY],
    ['UPSTREAM', HttpStatus.BAD_GATEWAY],
    ['CLIENT_BUG', HttpStatus.BAD_GATEWAY],
  ] as const)('%s → %i', (kind, status) => {
    expect(tboErrorStatus(apiError(kind))).toBe(status);
  });

  it('las clases locales', () => {
    expect(tboErrorStatus(new TboOfferExpiredError('x'))).toBe(HttpStatus.CONFLICT);
    expect(tboErrorStatus(new TboPackageOnlyRateError())).toBe(HttpStatus.CONFLICT);
    expect(tboErrorStatus(new TboDispatchRejectedError(SEARCH, 'ABORTED', 0))).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect(tboErrorStatus(new TboRequestBuildError(SEARCH, 'NOT_ELIGIBLE'))).toBe(
      HttpStatus.BAD_REQUEST,
    );
    expect(tboErrorStatus(new TboRequestBuildError(SEARCH, 'SCHEMA'))).toBe(HttpStatus.BAD_GATEWAY);
    expect(tboErrorStatus(new TboConfigError([]))).toBe(HttpStatus.BAD_GATEWAY);
  });
});

describe('`reason`: campo máquina para la web', () => {
  it('un `TboApiError` lleva su `kind`', () => {
    expect(tboErrorReason(apiError('RATE_UNAVAILABLE'))).toBe('RATE_UNAVAILABLE');
  });

  it('el vencimiento local comparte motivo con el `315`: la acción es la misma', () => {
    expect(tboErrorReason(new TboOfferExpiredError('x'))).toBe('OFFER_EXPIRED');
  });

  it('las clases locales usan su vocabulario, que no pisa ningún `kind`', () => {
    expect(tboErrorReason(new TboCancelMappingError(CANCEL, []))).toBe('CANCEL_UNVERIFIED');
    expect(tboErrorReason(new TboResponseMappingError(SEARCH, []))).toBe('RESPONSE_UNREADABLE');
    expect(tboErrorReason(new TboRequestBuildError(SEARCH, 'NOT_ELIGIBLE'))).toBe(
      'REQUEST_NOT_ELIGIBLE',
    );
    expect(tboErrorReason(new TboRequestBuildError(SEARCH, 'PAYMENT_MODE'))).toBe(
      'REQUEST_REJECTED',
    );
    expect(tboErrorReason(new Error('x'))).toBe('UNKNOWN');
    const locales: readonly string[] = TBO_LOCAL_ERROR_REASONS;
    expect(locales.filter((r) => (TBO_FAILURE_KINDS as readonly string[]).includes(r))).toEqual([]);
  });
});

describe('efecto en el breaker (RNF-03 punto 4)', () => {
  it('un `TboApiError` deja que el breaker lea su `failure.circuit`', () => {
    expect(tboCircuitEffect(apiError('UPSTREAM'))).toBeUndefined();
    expect(tboCircuitEffect(apiError('CREDENTIALS_INVALID'))).toBeUndefined();
  });

  it('HARD-1: un /Cancel sin desenlace conserva el efecto de lo que pasó (una cuenta rechazada la suspende)', () => {
    const rechazada = TboCancelOutcomeUnknownError.from(apiError('CREDENTIALS_INVALID', CANCEL));
    expect(tboCircuitEffect(rechazada)).toBeUndefined();
    expect(rechazada.failure.circuit).toBe('OPEN_ACCOUNT');
  });

  it.each(
    Object.entries(INSTANCIAS).filter(
      ([nombre]) => nombre !== 'TboApiError' && nombre !== 'TboCancelOutcomeUnknownError',
    ),
  )('%s no dice que TBO esté caído: no suma', (_nombre, crear) => {
    expect(tboCircuitEffect(crear())).toBe('IGNORE');
  });

  it('lo que no es de TBO no opina', () => {
    expect(tboCircuitEffect(new Error('x'))).toBeUndefined();
  });
});
