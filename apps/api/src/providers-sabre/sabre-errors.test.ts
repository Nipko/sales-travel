import { type ArgumentsHost, HttpStatus, Logger } from '@nestjs/common';
import {
  SabreApiError,
  SabreCancelBookingBuildError,
  SabreConfigError,
  SabreFlightCheckNoMatchedOfferError,
  SabreFlightCheckTenantMismatchError,
  SabreOfferPriceEmptyError,
  SabrePriceRejectedError,
  SabrePriceRequestError,
  SabreShopMappingError,
  type SabreFailureKind,
} from '@sales-travel/sabre';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SabreExceptionFilter } from './sabre-exception.filter.js';
import {
  SabreOperationNotSupportedError,
  humanizeSabreError,
  sabreErrorStatus,
} from './sabre-errors.js';

describe('humanizeSabreError', () => {
  it('red caída / timeout → "no pudimos conectar"', () => {
    expect(humanizeSabreError(new SabreApiError(0, 'fetch failed', '/v5/offers/shop'))).toContain(
      'conectar',
    );
  });

  it('5xx → problema interno de Sabre', () => {
    expect(humanizeSabreError(new SabreApiError(503, 'unavailable', '/v5/offers/shop'))).toContain(
      'problema interno',
    );
  });

  it('403 → alta comercial del PCC pendiente, no caída', () => {
    const mensaje = humanizeSabreError(new SabreApiError(403, 'forbidden', '/v5/offers/shop'));
    expect(mensaje).toContain('PCC');
    expect(mensaje).toContain('alta comercial');
  });

  it('config inválida → no interpola texto libre del error y remite al panel', () => {
    const mensaje = humanizeSabreError(new SabreConfigError('config de Sabre inválida (host:url)'));
    expect(mensaje).not.toContain('host:url');
    expect(mensaje).toContain('Mi Red');
  });

  it('respuesta fuera de contrato → mensaje propio, sin volcar las rutas al vendedor', () => {
    const mensaje = humanizeSabreError(new SabreShopMappingError(['itineraryGroups.0:invalid']));
    expect(mensaje).toContain('no pudimos interpretar');
    expect(mensaje).not.toContain('itineraryGroups');
  });

  it('un error cualquiera no filtra su propio mensaje', () => {
    expect(humanizeSabreError(new Error('ECONNRESET 10.0.0.4:443 token=abc'))).not.toContain(
      'token=abc',
    );
  });

  it('un valor que ni siquiera es Error tampoco revienta', () => {
    expect(humanizeSabreError('cualquier cosa')).toContain('Sabre');
  });

  it('Flight Check sin Matched pide buscar o elegir alternativa, sin sustituirla', () => {
    const err = new SabreFlightCheckNoMatchedOfferError([], 1, []);
    const mensaje = humanizeSabreError(err);

    expect(mensaje).toContain('misma tarifa');
    expect(mensaje).toContain('alternativa');
    expect(sabreErrorStatus(err)).toBe(HttpStatus.CONFLICT);
  });

  it('un cruce de tenants en Flight Check es 400 y no expone el mensaje interno', () => {
    const err = new SabreFlightCheckTenantMismatchError();
    expect(sabreErrorStatus(err)).toBe(HttpStatus.BAD_REQUEST);
    expect(humanizeSabreError(err)).not.toContain('tenants distintos');
  });

  it('nunca hace eco del cuerpo de Sabre, ni con PII dentro', () => {
    // El cuerpo puede traer el eco de la request; en `/v2/auth/token` eso incluye un `secret`
    // que es base64 REVERSIBLE del password de la oficina.
    const err = new SabreApiError(
      400,
      JSON.stringify({ error_description: 'Wrong clientID V1:EPR123:A1B2:AA:c2VjcmV0bw==' }),
      '/v2/auth/token',
    );
    const mensaje = humanizeSabreError(err);
    expect(mensaje).not.toContain('EPR123');
    expect(mensaje).not.toContain('c2VjcmV0bw==');
  });
});

describe('SabreOperationNotSupportedError', () => {
  it('es 501 y nombra la operación que todavía no existe', () => {
    const err = new SabreOperationNotSupportedError('crear la reserva');
    expect(err.getStatus()).toBe(501);
    expect(err.message).toContain('crear la reserva');
  });
});

/**
 * Los textos que lee el vendedor van en «tú» neutro, nunca en voseo. Se barre TODO lo que esta
 * capa puede devolver —una clase de fallo por cada `SabreFailureKind`, cada error tipado del ACL
 * que tiene mensaje propio, el desconocido y el 501— para que un texto nuevo no se cuele en voseo.
 */
describe('humanizeSabreError — tú neutro', () => {
  /** `Record` completo: si el ACL suma una clase de fallo, esto deja de compilar hasta cubrirla. */
  const KINDS = Object.keys({
    TRANSPORT: true,
    CLIENT_BUG: true,
    AUTH_EXPIRED: true,
    AUTH_POOL: true,
    CREDENTIALS_INVALID: true,
    ENTITLEMENT: true,
    NO_DATA: true,
    THROTTLED: true,
    UPSTREAM: true,
    BUSINESS: true,
    SESSION: true,
    HUMAN_REVIEW: true,
  } satisfies Record<SabreFailureKind, true>) as SabreFailureKind[];

  function apiError(kind: SabreFailureKind): SabreApiError {
    return new SabreApiError(500, 'x', '/v5/offers/shop', {
      failure: {
        kind,
        retry: 'NO_RETRY',
        circuit: 'IGNORE',
        disableAccount: false,
        operatorAlert: false,
        reason: 'test',
      },
    });
  }

  /** Formas de voseo que ya aparecieron en los textos de la plataforma, comparadas por PALABRA. */
  const VOSEO = new Set([
    'probá',
    'verificá',
    'verificalas',
    'revisá',
    'revisala',
    'intentá',
    'volvé',
    'elegí',
    'revalidá',
    'ingresá',
    'usá',
    'cargá',
    'seleccioná',
    'contactá',
    'esperá',
    'reintentá',
    'mandalo',
    'tenés',
    'podés',
    'querés',
  ]);

  function voseoEn(mensaje: string): string[] {
    return mensaje
      .toLowerCase()
      .split(/[^\p{L}]+/u)
      .filter((palabra) => VOSEO.has(palabra));
  }

  const MENSAJES: ReadonlyArray<readonly [string, string]> = [
    ...KINDS.map((kind) => [kind, humanizeSabreError(apiError(kind))] as const),
    ['SabreConfigError', humanizeSabreError(new SabreConfigError('x'))],
    ['SabrePriceRejectedError', humanizeSabreError(new SabrePriceRejectedError([]))],
    ['SabreOfferPriceEmptyError', humanizeSabreError(new SabreOfferPriceEmptyError(0))],
    [
      'SabreFlightCheckNoMatchedOfferError',
      humanizeSabreError(new SabreFlightCheckNoMatchedOfferError([], 0, [])),
    ],
    ['SabrePriceRequestError', humanizeSabreError(new SabrePriceRequestError('x'))],
    [
      'SabreCancelBookingBuildError',
      humanizeSabreError(new SabreCancelBookingBuildError('TICKET_OPERATION_REQUIRED', 'x')),
    ],
    ['desconocido', humanizeSabreError(new Error('x'))],
    ['501', new SabreOperationNotSupportedError('pagar la reserva').message],
  ];

  it.each(MENSAJES)('%s: sin voseo', (_origen, mensaje) => {
    expect(voseoEn(mensaje)).toEqual([]);
  });

  it('CONTROL: el detector sí ve el voseo que había', () => {
    expect(voseoEn('Probá de nuevo. Verificalas en Mi Red; elegí otra.')).toEqual([
      'probá',
      'verificalas',
      'elegí',
    ]);
  });

  it('los textos corregidos dicen lo que dicen, en tú', () => {
    expect(humanizeSabreError(apiError('TRANSPORT'))).toContain('Prueba de nuevo');
    expect(humanizeSabreError(apiError('AUTH_POOL'))).toContain('verifica tus credenciales');
    expect(humanizeSabreError(apiError('CREDENTIALS_INVALID'))).toContain('Verifícalas');
    expect(humanizeSabreError(apiError('BUSINESS'))).toContain(
      'Revisa los datos e intenta nuevamente',
    );
    expect(humanizeSabreError(new Error('x'))).toContain('Intenta nuevamente');
    expect(humanizeSabreError(new SabreOfferPriceEmptyError(0))).toContain('Vuelve a buscar');
    expect(humanizeSabreError(new SabreFlightCheckNoMatchedOfferError([], 0, []))).toContain(
      'elige explícitamente',
    );
    expect(humanizeSabreError(new SabrePriceRequestError('x'))).toContain(
      'Revalida el precio y vuelve a intentar',
    );
    expect(humanizeSabreError(new SabreConfigError('x'))).toContain('Revísala');
    expect(new SabreOperationNotSupportedError('pagar').message).toContain(
      'Elige una oferta de otro proveedor',
    );
  });
});

describe('SabreExceptionFilter', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Doble mínimo del `host` de Nest: sólo interesa el JSON que sale y con qué status. */
  function hostFalso() {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
    return { host, status, json };
  }

  it('traduce un error del proveedor a 502 con mensaje en español', () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { host, status, json } = hostFalso();

    new SabreExceptionFilter().catch(
      new SabreApiError(503, 'unavailable', '/v5/offers/shop'),
      host,
    );

    expect(status).toHaveBeenCalledWith(502);
    const cuerpo = json.mock.calls[0]?.[0] as {
      statusCode: number;
      error: string;
      message: string;
    };
    expect(cuerpo.statusCode).toBe(502);
    expect(cuerpo.error).toBe('Bad Gateway');
    expect(cuerpo.message).toContain('problema interno');
  });

  it('también atrapa la config inválida, que si no saldría como 500 genérico', () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { host, status, json } = hostFalso();

    new SabreExceptionFilter().catch(
      new SabreConfigError('config de Sabre inválida (epr:too_small)'),
      host,
    );

    const cuerpo = json.mock.calls[0]?.[0] as { message: string };
    expect(status).toHaveBeenCalledWith(502);
    expect(cuerpo.message).toContain('Mi Red');
  });

  it('lo que se loguea de un error de Sabre viene ya redactado por el ACL', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { host } = hostFalso();

    new SabreExceptionFilter().catch(
      new SabreApiError(400, 'Wrong clientID V1:EPR123:A1B2:AA', '/v2/auth/token'),
      host,
    );

    const logueado = warn.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    expect(logueado).not.toContain('EPR123');
    expect(logueado).toContain('sabre');
  });

  it('de un error propio se loguea el nombre Y el mensaje, que es lo que lo arregla', () => {
    // Contrato NUEVO. Antes se tiraba el mensaje y quedaba sólo el nombre de la clase, para no
    // arriesgar texto del proveedor en el log. La cautela era buena y la conclusión no: un
    // `SabreCreateBookingError` es un fallo NUESTRO —el body no pasó nuestra propia validación
    // y no llegó a salir al cable—, así que su mensaje nombra el campo que falló y es lo único
    // con lo que se arregla. En producción quedaba «SabreCreateBookingError en el ACL de Sabre»
    // y nadie podía reservar ni saber por qué.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { host } = hostFalso();

    new SabreExceptionFilter().catch(new SabreShopMappingError(['flights.0.pax:invalid']), host);

    const logueado = warn.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    expect(logueado).toContain('SabreShopMappingError');
    expect(logueado).toContain('flights.0.pax');
  });

  it('y ese mensaje pasa por `redactText`: diagnosticar no es aflojar la redacción', () => {
    // La razón por la que se puede loguear el mensaje no es que confiemos en él, es que cruza
    // la MISMA puerta por la que ya pasa todo lo que el ACL escribe. Si un secreto se cuela en
    // el texto de un error propio, sale redactado igual.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { host } = hostFalso();

    new SabreExceptionFilter().catch(
      new SabreShopMappingError(['password=Sup3rSecreto!', 'clientId=V1:EPR123:A1B2:AA']),
      host,
    );

    const logueado = warn.mock.calls.map((c) => JSON.stringify(c)).join(' ');
    expect(logueado).not.toContain('Sup3rSecreto');
    expect(logueado).not.toContain('EPR123');
  });
});
