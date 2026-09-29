import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
} from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { BreakerRejectionError } from './search/circuit-breaker.service.js';
import {
  HotelOfferNotInSearchError,
  HotelSearchContextExpiredError,
} from './hotels/hotel-search-context.store.js';
import { HotelBookRepricedError } from './hotels/hotel-booking-errors.js';

/**
 * Qué cuerpo recibe el navegador de una excepción HTTP nuestra.
 *
 * Lo que este archivo fija es el motivo máquina (`reason`): la web decide "Volver a buscar" o
 * "Reintentar" con él y no con el texto. Hasta PR-4.5 el filtro lo descartaba y los errores del
 * contexto de búsqueda de hoteles, que lo declaran, llegaban sin él.
 */

interface Respuesta {
  host: ArgumentsHost;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

function respuesta(): Respuesta {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: 'POST', url: '/hotels/prebook' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

function cuerpo(r: Respuesta): Record<string, unknown> {
  return r.json.mock.calls[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AllExceptionsFilter — motivo máquina', () => {
  it.each([
    [
      'búsqueda vencida',
      new HotelSearchContextExpiredError(),
      HttpStatus.CONFLICT,
      'SEARCH_CONTEXT_EXPIRED',
    ],
    [
      'tarifa fuera de la búsqueda',
      new HotelOfferNotInSearchError(),
      HttpStatus.BAD_REQUEST,
      'OFFER_NOT_IN_SEARCH',
    ],
  ])('%s → `reason` en el cuerpo, con el mensaje de negocio', (_caso, err, estado, motivo) => {
    const r = respuesta();

    new AllExceptionsFilter().catch(err, r.host);

    expect(r.status).toHaveBeenCalledWith(estado);
    expect(cuerpo(r)).toEqual({
      statusCode: estado,
      error: estado === HttpStatus.CONFLICT ? 'Conflict' : 'Bad Request',
      message: err.message,
      reason: motivo,
    });
  });

  it('el motivo también puede venir en el cuerpo de la excepción', () => {
    const r = respuesta();

    new AllExceptionsFilter().catch(
      new ConflictException({
        message: 'Ya hay una orden con esa clave.',
        reason: 'DUPLICATE_REQUEST',
      }),
      r.host,
    );

    expect(cuerpo(r)['reason']).toBe('DUPLICATE_REQUEST');
  });

  it.each([
    ['texto libre', 'el proveedor dijo: tarjeta 4111 rechazada'],
    ['minúsculas con guiones', 'kill-switch'],
    ['demasiado largo', `A${'B'.repeat(64)}`],
    ['no es texto', 42],
  ])('un `reason` que no es un código cerrado (%s) no sale', (_caso, motivo) => {
    const r = respuesta();
    const err = new BadRequestException('Pedido inválido.');
    Object.assign(err, { reason: motivo });

    new AllExceptionsFilter().catch(err, r.host);

    expect(cuerpo(r)).not.toHaveProperty('reason');
  });

  it('el rechazo del breaker conserva su 503 y su mensaje; su motivo interno no es un código de la web', () => {
    const r = respuesta();

    new AllExceptionsFilter().catch(
      new BreakerRejectionError(
        'tbo-hotels',
        'kill-switch',
        'El proveedor tbo-hotels está temporalmente deshabilitado.',
      ),
      r.host,
    );

    expect(cuerpo(r)).toEqual({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      error: 'Service Unavailable',
      message: 'El proveedor tbo-hotels está temporalmente deshabilitado.',
    });
  });

  it('sin motivo, el cuerpo es el de siempre', () => {
    const r = respuesta();

    new AllExceptionsFilter().catch(new BadRequestException('Pedido inválido.'), r.host);

    expect(cuerpo(r)).toEqual({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      message: 'Pedido inválido.',
    });
  });

  it('una regla de la jerarquía violada en la base sale como 409 con motivo, no como 500', () => {
    const r = respuesta();
    const err = Object.assign(new Error('sólo la plataforma puede ser raíz: tenant 7970ade5'), {
      code: 'STH01',
      constraint: 'tenant_root_must_be_platform',
    });

    new AllExceptionsFilter().catch(err, r.host);

    expect(r.status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(cuerpo(r)).toEqual({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: 'Sólo la plataforma puede ser raíz: el nodo tiene que colgar de un nodo de la red.',
      reason: 'TENANT_ROOT_MUST_BE_PLATFORM',
    });
  });

  it('un error que no es HTTP sigue siendo un 500 genérico, sin motivo ni detalle', () => {
    const r = respuesta();
    const err = Object.assign(new Error('relation "orders" does not exist'), {
      reason: 'SEARCH_CONTEXT_EXPIRED',
    });

    new AllExceptionsFilter().catch(err, r.host);

    expect(cuerpo(r)).toEqual({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'Ocurrió un error inesperado. Intentá de nuevo en unos minutos.',
    });
  });
});

/**
 * RF-22: la web necesita, de un 409 de creación, la orden y las marcas que le prohíben repetir la
 * reserva, y de un 409 de revalidación, los valores nuevos. Hasta PR-4.6 el filtro los descartaba.
 */
describe('AllExceptionsFilter — marcas de conciliación y detalles publicables', () => {
  const ORDEN = '33333333-3333-4333-8333-333333333333';

  it('un 409 de clave repetida sale con la orden y las tres marcas', () => {
    const r = respuesta();

    new AllExceptionsFilter().catch(
      new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'Esta solicitud de creación ya fue recibida.',
        orderId: ORDEN,
        providerOrderId: 'CONF-1',
        duplicateRequest: true,
        retryForbidden: true,
        reconciliationRequired: true,
      }),
      r.host,
    );

    expect(cuerpo(r)).toEqual({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message: 'Esta solicitud de creación ya fue recibida.',
      orderId: ORDEN,
      duplicateRequest: true,
      retryForbidden: true,
      reconciliationRequired: true,
    });
  });

  it.each([
    ['una orden que no es un UUID', { orderId: 'orden 1; drop table' }],
    ['una marca que no es `true`', { retryForbidden: 'true', duplicateRequest: false }],
  ])('%s no sale', (_caso, extra) => {
    const r = respuesta();

    new AllExceptionsFilter().catch(
      new ConflictException({ message: 'Conflicto.', ...extra }),
      r.host,
    );

    expect(Object.keys(cuerpo(r)).sort()).toEqual(['error', 'message', 'statusCode']);
  });

  it('los `publicDetails` que declara la excepción salen como `details`, con su motivo', () => {
    const r = respuesta();
    const details = {
      outcome: 'INCREASED' as const,
      price: 'UP' as const,
      changes: [],
      acceptedTotal: { amountMinor: 32_134, currency: 'USD' },
      currentTotal: { amountMinor: 34_000, currency: 'USD' },
      prebookRef: '77777777-7777-4777-8777-777777777777',
    };

    new AllExceptionsFilter().catch(new HotelBookRepricedError('PRICE_INCREASED', details), r.host);

    expect(cuerpo(r)).toMatchObject({
      statusCode: HttpStatus.CONFLICT,
      reason: 'PRICE_INCREASED',
      details,
    });
  });

  it.each([
    ['una lista', ['a']],
    ['un texto', 'detalle'],
    ['null', null],
  ])('`publicDetails` que no es un objeto (%s) no sale', (_caso, valor) => {
    const r = respuesta();
    const err = new BadRequestException('Pedido inválido.');
    Object.assign(err, { publicDetails: valor });

    new AllExceptionsFilter().catch(err, r.host);

    expect(cuerpo(r)).not.toHaveProperty('details');
  });
});
