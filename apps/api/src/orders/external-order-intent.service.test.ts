import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  memoryDb,
  uniqueViolation,
  type MemoryDbOptions,
} from './__fixtures__/memory-orders-db.js';
import {
  ExternalOrderIntentInputError,
  ExternalOrderIntentService,
  ProviderBookingRefTakenError,
  type ExternalCreateOutcome,
  type OpenExternalCreateIntentInput,
} from './external-order-intent.service.js';
import {
  CREATE_NOT_SENT_MARKER,
  CREATE_PENDING_RECONCILIATION_MARKER,
  OrderCreateIntentStore,
} from './order-create-intent.store.js';
import type { OrderRow } from './orders.service.js';

/**
 * API pública del intent para verticales externas (docs/tbo/09 PR-4.4; 08 RF-19, RF-20).
 *
 * El doble de Postgres (`__fixtures__/memory-orders-db.ts`, compartido con la saga de hoteles)
 * modela lo que decide estos casos: transacciones serializadas que se deshacen enteras si fallan,
 * RLS por tenant y los tres índices únicos de `orders` con su alcance real (la clave por tenant, la
 * referencia de reserva entre tenants).
 *
 * Proveedor y referencias sintéticos: el servicio no conoce proveedores.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const QUOTATION_A = '44444444-4444-4444-8444-444444444444';
const QUOTATION_B = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const KEY_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROVIDER = 'bedbank-sintetico';
const REF_1 = 'STT7K2M9QX4D8R1VZ6AB';
const REF_2 = 'STT0H3J5N7P9R1T3V5X7';
const REF_3 = 'STT2A4C6E8G0J2K4M6P8';

const QUOTATIONS = [
  { id: QUOTATION_A, tenant_id: TENANT_A },
  { id: QUOTATION_B, tenant_id: TENANT_B },
];

function bank(options: MemoryDbOptions = {}) {
  const memory = memoryDb({ quotations: QUOTATIONS, ...options });
  return { ...memory, service: new ExternalOrderIntentService(memory.db) };
}

function input(
  overrides: Partial<OpenExternalCreateIntentInput> = {},
): OpenExternalCreateIntentInput {
  return {
    provider: PROVIDER,
    vertical: 'hotels',
    idempotencyKey: KEY_1,
    searchCriteria: { checkIn: '2026-11-02', checkOut: '2026-11-05', rooms: 1 },
    selectedOffer: { offerRef: 'offer-1', total: 34_012 },
    passengers: [{ room: 1, givenName: 'José', surname: 'Muñoz' }],
    contactInfo: { email: 'huesped@example.test', phone: '+573000000000' },
    totalAmountMinor: 34_012,
    currency: 'USD',
    providerBookingRef: REF_1,
    providerAccountId: ACCOUNT,
    ...overrides,
  };
}

const CONFIRMED: ExternalCreateOutcome = {
  status: 'confirmed',
  providerOrderId: 'CONF-778899',
  providerRaw: { ConfirmationNumber: 'CONF-778899', StatusCode: 200, BookingReferenceId: REF_1 },
};

const FAILED: ExternalCreateOutcome = {
  status: 'failed',
  providerRaw: { StatusCode: 207, BookingReferenceId: REF_1 },
  errorMessage: 'provider-status-207',
};

function conflictBody(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(ConflictException);
  return (error as ConflictException).getResponse() as Record<string, unknown>;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('se esperaba un rechazo');
}

describe('openExternalCreateIntent — el intent existe antes de llamar al proveedor', () => {
  it('compromete la fila pending con clave, referencia, cuenta y vertical en UNA sentencia de UNA transacción', async () => {
    const b = bank();

    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    expect(intent).toMatchObject({
      tenant_id: TENANT_A,
      user_id: USER,
      provider: PROVIDER,
      status: 'pending',
      provider_order_id: null,
      provider_raw: null,
      quotation_id: null,
      order_number: 1,
      total_amount: 34_012,
      currency: 'USD',
      create_request_key: `c:${KEY_1}`,
      provider_booking_ref: REF_1,
      provider_account_id: ACCOUNT,
      error_message: CREATE_PENDING_RECONCILIATION_MARKER,
    });
    expect(JSON.parse(intent.search_criteria as string)).toEqual({
      checkIn: '2026-11-02',
      checkOut: '2026-11-05',
      rooms: 1,
      vertical: 'hotels',
    });

    // Una sola transacción: lock del tenant, número y el INSERT que ya lleva la referencia. Si el
    // proceso muere justo después de volver, la recuperación encuentra la referencia en la base.
    expect(b.transactions()).toBe(1);
    const inserts = b.log.filter((s) => s.op === 'insert');
    expect(inserts).toHaveLength(1);
    const [insert] = inserts;
    expect(insert?.values).toMatchObject({
      status: 'pending',
      create_request_key: `c:${KEY_1}`,
      provider_booking_ref: REF_1,
      provider_account_id: ACCOUNT,
    });
    expect(b.log.find((s) => s.forUpdate)).toMatchObject({ tx: insert?.tx, table: 'tenants' });
    expect(b.log.filter((s) => s.op === 'update')).toEqual([]);
    expect(b.rows()).toHaveLength(1);
  });

  it('la vertical la escribe el servicio: un criterio que trae otra no la pisa', async () => {
    const b = bank();

    const intent = await b.service.openExternalCreateIntent(
      TENANT_A,
      USER,
      input({ searchCriteria: { vertical: 'flights', rooms: 2 } }),
    );

    expect(JSON.parse(intent.search_criteria as string)).toEqual({ rooms: 2, vertical: 'hotels' });
  });

  it('una vertical sin referencia ni cuenta deja las dos columnas en NULL', async () => {
    const b = bank();

    const intent = await b.service.openExternalCreateIntent(
      TENANT_A,
      USER,
      input({ vertical: 'cars', providerBookingRef: null, providerAccountId: null }),
    );

    expect(intent).toMatchObject({ provider_booking_ref: null, provider_account_id: null });
    expect(b.log.find((s) => s.op === 'insert')?.values).not.toHaveProperty('provider_booking_ref');
  });

  it('la misma clave → 409 duplicateRequest con la orden existente, sin segunda fila', async () => {
    const b = bank();
    const first = await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    const error = await rejection(
      b.service.openExternalCreateIntent(TENANT_A, USER, input({ providerBookingRef: REF_2 })),
    );

    expect(conflictBody(error)).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: expect.any(String) as string,
      orderId: first.id,
      duplicateRequest: true,
      retryForbidden: true,
      reconciliationRequired: true,
    });
    expect(b.rows()).toHaveLength(1);
    expect(b.rows()[0]).toMatchObject({ provider_booking_ref: REF_1 });
  });

  it('el 409 publica el localizador como providerOrderId, no como pnr', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    await b.service.settleExternalCreateIntent(TENANT_A, intent, CONFIRMED);

    const body = conflictBody(
      await rejection(
        b.service.openExternalCreateIntent(TENANT_A, USER, input({ providerBookingRef: REF_2 })),
      ),
    );

    expect(body).toMatchObject({ orderId: intent.id, providerOrderId: 'CONF-778899' });
    expect(body).not.toHaveProperty('pnr');
  });

  it('dos envíos concurrentes con la misma clave dejan una fila y un 409', async () => {
    const b = bank();

    const results = await Promise.allSettled([
      b.service.openExternalCreateIntent(TENANT_A, USER, input()),
      b.service.openExternalCreateIntent(TENANT_A, USER, input({ providerBookingRef: REF_2 })),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(conflictBody(rejected?.reason)).toMatchObject({ duplicateRequest: true });
    expect(b.rows()).toHaveLength(1);
  });

  it('la clave es por tenant: la misma en otro tenant abre otro intent con su propio número', async () => {
    const b = bank();

    await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    const other = await b.service.openExternalCreateIntent(
      TENANT_B,
      USER,
      input({ providerBookingRef: REF_2 }),
    );

    expect(other).toMatchObject({ tenant_id: TENANT_B, order_number: 1 });
    expect(b.rows()).toHaveLength(2);
  });

  it('dos claves distintas del mismo tenant reciben números distintos', async () => {
    const b = bank();

    await Promise.all([
      b.service.openExternalCreateIntent(TENANT_A, USER, input()),
      b.service.openExternalCreateIntent(
        TENANT_A,
        USER,
        input({ idempotencyKey: KEY_2, providerBookingRef: REF_2 }),
      ),
    ]);

    expect(b.rows().map((row) => row['order_number'])).toEqual([1, 2]);
  });

  it('una referencia ya usada por OTRO tenant se rechaza tipada y no deja fila ni toma la clave', async () => {
    const b = bank();
    await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    const error = await rejection(b.service.openExternalCreateIntent(TENANT_B, USER, input()));

    expect(error).toBeInstanceOf(ProviderBookingRefTakenError);
    expect(error).toMatchObject({ provider: PROVIDER });
    expect(b.rows().filter((row) => row['tenant_id'] === TENANT_B)).toEqual([]);
    // 409 por el nombre del índice, y no el de una venta repetida: no se abrió nada, se puede
    // volver a intentar, y por eso no lleva las marcas de conciliación.
    expect(error).toBeInstanceOf(ConflictException);
    const http = error as ConflictException;
    expect(http.getStatus()).toBe(409);
    expect(http).toMatchObject({ reason: 'BOOKING_REFERENCE_TAKEN' });
    expect(http.getResponse()).not.toMatchObject({ duplicateRequest: true });
    expect(http.getResponse()).not.toMatchObject({ retryForbidden: true });

    // La transacción se deshizo entera: la misma clave con una referencia nueva sí entra.
    const retried = await b.service.openExternalCreateIntent(
      TENANT_B,
      USER,
      input({ providerBookingRef: REF_2 }),
    );
    expect(retried).toMatchObject({ tenant_id: TENANT_B, provider_booking_ref: REF_2 });
  });

  it('la misma referencia en otro proveedor no choca', async () => {
    const b = bank();
    await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    const other = await b.service.openExternalCreateIntent(
      TENANT_A,
      USER,
      input({ provider: 'otro-bedbank', idempotencyKey: KEY_2 }),
    );

    expect(other).toMatchObject({ provider: 'otro-bedbank', provider_booking_ref: REF_1 });
  });

  it.each([
    ['un 23505 de otro índice', uniqueViolation('uq_orders_tenant_order_number')],
    [
      'una cuenta que no existe (FK)',
      Object.assign(new Error('insert or update violates foreign key constraint'), {
        code: '23503',
        constraint: 'orders_provider_account_id_fkey',
      }),
    ],
  ])(
    '%s sale tal cual: no es un reenvío ni una referencia repetida',
    async (_caso, insertError) => {
      const b = bank({ insertError });

      const error = await rejection(b.service.openExternalCreateIntent(TENANT_A, USER, input()));

      expect(error).toBe(insertError);
      expect(b.rows()).toEqual([]);
    },
  );

  it.each([
    ['sin clave', undefined],
    ['clave vacía', '   '],
    ['clave que no es UUID', 'no-es-uuid'],
  ])('%s → 400 antes de abrir una transacción', async (_caso, idempotencyKey) => {
    const b = bank();

    await expect(
      b.service.openExternalCreateIntent(TENANT_A, USER, input({ idempotencyKey })),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(b.transactions()).toBe(0);
  });

  it('la clave se normaliza: mayúsculas y espacios son el mismo envío', async () => {
    const b = bank();
    await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    const error = await rejection(
      b.service.openExternalCreateIntent(
        TENANT_A,
        USER,
        input({ idempotencyKey: ` ${KEY_1.toUpperCase()} `, providerBookingRef: REF_2 }),
      ),
    );

    expect(conflictBody(error)).toMatchObject({ duplicateRequest: true });
  });

  it('la cotización sólo vincula: la clave sigue saliendo del Idempotency-Key', async () => {
    const b = bank();

    const intent = await b.service.openExternalCreateIntent(
      TENANT_A,
      USER,
      input({ quotationId: QUOTATION_A }),
    );

    expect(intent).toMatchObject({ quotation_id: QUOTATION_A, create_request_key: `c:${KEY_1}` });
  });

  it('una cotización de otro tenant → 400 y nada escrito', async () => {
    const b = bank();

    await expect(
      b.service.openExternalCreateIntent(TENANT_A, USER, input({ quotationId: QUOTATION_B })),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(b.rows()).toEqual([]);
  });

  it.each<[string, Partial<OpenExternalCreateIntentInput>]>([
    ['referencia en blanco', { providerBookingRef: '' }],
    ['referencia con espacios', { providerBookingRef: 'José Muñoz 1' }],
    ['referencia demasiado larga', { providerBookingRef: 'A'.repeat(65) }],
    ['cuenta que no es UUID', { providerAccountId: 'cuenta-1' }],
    ['proveedor con mayúsculas', { provider: 'Bedbank' }],
    [
      'vertical de vuelos',
      { vertical: 'flights' as unknown as OpenExternalCreateIntentInput['vertical'] },
    ],
    ['monto negativo', { totalAmountMinor: -1 }],
    ['monto con decimales', { totalAmountMinor: 10.5 }],
    ['monto fuera de INTEGER', { totalAmountMinor: 2_147_483_648 }],
    ['moneda en minúsculas', { currency: 'usd' }],
    ['criterio que no es objeto', { searchCriteria: [] as unknown as Record<string, unknown> }],
    ['snapshot ausente', { selectedOffer: undefined }],
    ['cotización que no es UUID', { quotationId: 'cot-1' }],
  ])('%s → error de cableado tipado, sin transacción', async (_caso, overrides) => {
    const b = bank();

    const error = await rejection(
      b.service.openExternalCreateIntent(TENANT_A, USER, input(overrides)),
    );

    expect(error).toBeInstanceOf(ExternalOrderIntentInputError);
    expect(b.transactions()).toBe(0);
  });

  it('un campo que el contrato no declara se rechaza en vez de ignorarse', async () => {
    const b = bank();
    const withExtra = { ...input(), createRequestKey: 'c:otra' } as OpenExternalCreateIntentInput;

    await expect(
      b.service.openExternalCreateIntent(TENANT_A, USER, withExtra),
    ).rejects.toBeInstanceOf(ExternalOrderIntentInputError);
  });

  it('el mensaje del error de input lleva rutas y códigos, nunca valores', async () => {
    const b = bank();

    const error = await rejection(
      b.service.openExternalCreateIntent(
        TENANT_A,
        USER,
        input({ providerBookingRef: 'José Muñoz', currency: 'pesos' }),
      ),
    );

    const message = (error as Error).message;
    expect(message).toContain('providerBookingRef');
    expect(message).toContain('currency');
    expect(message).not.toContain('José');
    expect(message).not.toContain('pesos');
  });
});

describe('settleExternalCreateIntent — CAS sobre pending con provider_raw nulo', () => {
  it('confirmed consolida el localizador y la lista blanca, y conserva la clave', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    const settled = await b.service.settleExternalCreateIntent(TENANT_A, intent, CONFIRMED);

    expect(settled).toMatchObject({
      id: intent.id,
      status: 'confirmed',
      provider_order_id: 'CONF-778899',
      error_message: null,
      create_request_key: `c:${KEY_1}`,
      provider_booking_ref: REF_1,
      provider_account_id: ACCOUNT,
    });
    expect(JSON.parse(settled?.provider_raw as string)).toEqual({
      ConfirmationNumber: 'CONF-778899',
      StatusCode: 200,
      BookingReferenceId: REF_1,
      phase: 'create',
      outcome: 'CONFIRMED',
    });
    // Nunca se reescribe la referencia: la recuperación y la conciliación dependen de ella.
    const update = b.log.find((s) => s.op === 'update');
    expect(update?.values).not.toHaveProperty('provider_booking_ref');
    expect(update?.values).not.toHaveProperty('provider_account_id');
  });

  it('failed libera la clave: el reintento abre OTRO intent con otra referencia', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    const settled = await b.service.settleExternalCreateIntent(TENANT_A, intent, FAILED);
    const retry = await b.service.openExternalCreateIntent(
      TENANT_A,
      USER,
      input({ providerBookingRef: REF_2 }),
    );

    expect(settled).toMatchObject({
      status: 'failed',
      provider_order_id: null,
      create_request_key: null,
      error_message: 'provider-status-207',
      provider_booking_ref: REF_1,
    });
    expect(JSON.parse(settled?.provider_raw as string)).toMatchObject({
      phase: 'create',
      outcome: 'FAILED',
    });
    expect(retry).toMatchObject({ order_number: 2, provider_booking_ref: REF_2 });
    expect(b.rows()).toHaveLength(2);
  });

  it('la referencia de un intent fallido no se puede reutilizar', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    await b.service.settleExternalCreateIntent(TENANT_A, intent, FAILED);

    await expect(
      b.service.openExternalCreateIntent(TENANT_A, USER, input()),
    ).rejects.toBeInstanceOf(ProviderBookingRefTakenError);
  });

  it('el segundo cierre pierde el CAS y no toca la fila', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    await b.service.settleExternalCreateIntent(TENANT_A, intent, CONFIRMED);

    const second = await b.service.settleExternalCreateIntent(TENANT_A, intent, FAILED);

    expect(second).toBeUndefined();
    expect(b.rows()[0]).toMatchObject({
      status: 'confirmed',
      provider_order_id: 'CONF-778899',
      create_request_key: `c:${KEY_1}`,
    });
  });

  it('una fila pending que ya tiene provider_raw no se consolida', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    Object.assign(b.rows()[0] ?? {}, { provider_raw: '{"phase":"verify"}' });

    await expect(
      b.service.settleExternalCreateIntent(TENANT_A, intent, CONFIRMED),
    ).resolves.toBeUndefined();
    expect(b.rows()[0]).toMatchObject({ status: 'pending', provider_order_id: null });
  });

  it('una fila que ya no está pending no se consolida', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    Object.assign(b.rows()[0] ?? {}, { status: 'cancelled' });

    await expect(
      b.service.settleExternalCreateIntent(TENANT_A, intent, CONFIRMED),
    ).resolves.toBeUndefined();
    expect(b.rows()[0]).toMatchObject({ status: 'cancelled', provider_raw: null });
  });

  it('otro tenant no puede cerrar el intent ajeno', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    await expect(
      b.service.settleExternalCreateIntent(TENANT_B, intent, CONFIRMED),
    ).resolves.toBeUndefined();
    expect(b.rows()[0]).toMatchObject({ status: 'pending', provider_raw: null });
  });

  it('el snapshot revalidado reemplaza oferta y precio; sin él se conservan', async () => {
    const b = bank();
    const first = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    const second = await b.service.openExternalCreateIntent(
      TENANT_A,
      USER,
      input({ idempotencyKey: KEY_2, providerBookingRef: REF_2 }),
    );

    const repriced = await b.service.settleExternalCreateIntent(TENANT_A, first, {
      ...CONFIRMED,
      snapshot: {
        selectedOffer: { offerRef: 'offer-1', total: 33_500 },
        totalAmountMinor: 33_500,
        currency: 'USD',
      },
    });
    const kept = await b.service.settleExternalCreateIntent(TENANT_A, second, {
      ...CONFIRMED,
      providerOrderId: 'CONF-2',
    });

    expect(repriced).toMatchObject({ total_amount: 33_500 });
    expect(JSON.parse(repriced?.selected_offer as string)).toEqual({
      offerRef: 'offer-1',
      total: 33_500,
    });
    expect(kept).toMatchObject({ total_amount: 34_012, currency: 'USD' });
    expect(JSON.parse(kept?.selected_offer as string)).toEqual({
      offerRef: 'offer-1',
      total: 34_012,
    });
  });

  it.each<[string, unknown]>([
    ['confirmed sin localizador', { ...CONFIRMED, providerOrderId: '  ' }],
    ['confirmed con localizador nulo', { ...CONFIRMED, providerOrderId: null }],
    [
      'un volcado anidado en provider_raw',
      { ...CONFIRMED, providerRaw: { Status: { Code: 200 } } },
    ],
    [
      'texto largo del proveedor en provider_raw',
      { ...CONFIRMED, providerRaw: { Description: 'x'.repeat(201) } },
    ],
    [
      'una clave reservada en provider_raw',
      { ...CONFIRMED, providerRaw: { outcome: 'CONFIRMED' } },
    ],
    [
      'demasiadas claves en provider_raw',
      {
        ...CONFIRMED,
        providerRaw: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])),
      },
    ],
    ['un estado que no es desenlace', { ...CONFIRMED, status: 'pending' }],
    ['un campo no declarado', { ...FAILED, createRequestKey: null }],
  ])('%s → error de cableado tipado, sin escribir', async (_caso, outcome) => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    const before = b.transactions();

    await expect(
      b.service.settleExternalCreateIntent(TENANT_A, intent, outcome as ExternalCreateOutcome),
    ).rejects.toBeInstanceOf(ExternalOrderIntentInputError);

    expect(b.transactions()).toBe(before);
    expect(b.rows()[0]).toMatchObject({ status: 'pending', provider_raw: null });
  });
});

describe('failExternalCreateIntent — la llamada no salió: se libera la clave', () => {
  it('cierra como fallo previo al envío y el mismo formulario puede reintentarse', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    const closed = await b.service.failExternalCreateIntent(TENANT_A, intent);
    const retry = await b.service.openExternalCreateIntent(
      TENANT_A,
      USER,
      input({ providerBookingRef: REF_2 }),
    );

    expect(closed).toBe(true);
    expect(b.rows()[0]).toMatchObject({
      status: 'failed',
      create_request_key: null,
      error_message: CREATE_NOT_SENT_MARKER,
      provider_booking_ref: REF_1,
    });
    expect(JSON.parse(b.rows()[0]?.['provider_raw'] as string)).toEqual({
      phase: 'pre-create',
      outcome: 'FAILED',
    });
    expect(retry).toMatchObject({ status: 'pending', provider_booking_ref: REF_2 });
  });

  it('sobre un intent ya consolidado no hace nada y la clave sigue tomada', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    await b.service.settleExternalCreateIntent(TENANT_A, intent, CONFIRMED);

    await expect(b.service.failExternalCreateIntent(TENANT_A, intent)).resolves.toBe(false);

    expect(b.rows()[0]).toMatchObject({ status: 'confirmed', create_request_key: `c:${KEY_1}` });
    await expect(
      b.service.openExternalCreateIntent(TENANT_A, USER, input({ providerBookingRef: REF_3 })),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('una fila pending que ya tiene provider_raw no se libera: la llamada ya salió', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    // Así queda un cierre no definitivo (el PARTIAL de vuelos): pending, con resultado y la
    // clave tomada. Liberarla dejaría reservar otra vez algo que puede existir en el proveedor.
    const raw = '{"phase":"create","outcome":"PENDING"}';
    Object.assign(b.rows()[0] ?? {}, { provider_raw: raw });

    await expect(b.service.failExternalCreateIntent(TENANT_A, intent)).resolves.toBe(false);

    expect(b.rows()[0]).toMatchObject({
      status: 'pending',
      provider_raw: raw,
      create_request_key: `c:${KEY_1}`,
      error_message: CREATE_PENDING_RECONCILIATION_MARKER,
    });
    await expect(
      b.service.openExternalCreateIntent(TENANT_A, USER, input({ providerBookingRef: REF_2 })),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('una fila que ya no está pending no se libera, aunque no tenga provider_raw', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    Object.assign(b.rows()[0] ?? {}, { status: 'cancelled' });

    await expect(b.service.failExternalCreateIntent(TENANT_A, intent)).resolves.toBe(false);

    expect(b.rows()[0]).toMatchObject({
      status: 'cancelled',
      provider_raw: null,
      create_request_key: `c:${KEY_1}`,
    });
  });

  it('no libera una clave que ya no es la del intent', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    const closed = await b.service.failExternalCreateIntent(TENANT_A, {
      id: intent.id,
      create_request_key: `c:${KEY_2}`,
    });

    expect(closed).toBe(false);
    expect(b.rows()[0]).toMatchObject({ status: 'pending', create_request_key: `c:${KEY_1}` });
  });

  it('otro tenant no puede liberar la clave ajena', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    await expect(b.service.failExternalCreateIntent(TENANT_B, intent)).resolves.toBe(false);

    expect(b.rows()[0]).toMatchObject({ status: 'pending', create_request_key: `c:${KEY_1}` });
  });

  it('con la base caída no lanza, y el intent conserva la clave', async () => {
    const b = bank({ failUpdates: true });
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    await expect(b.service.failExternalCreateIntent(TENANT_A, intent)).resolves.toBe(false);

    expect(b.rows()[0]).toMatchObject({ status: 'pending', create_request_key: `c:${KEY_1}` });
  });
});

describe('contrato de los cierres', () => {
  it('ningún cierre escribe la referencia ni la cuenta', async () => {
    const b = bank();
    const confirmed = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    const failed = await b.service.openExternalCreateIntent(
      TENANT_A,
      USER,
      input({ idempotencyKey: KEY_2, providerBookingRef: REF_2 }),
    );

    await b.service.settleExternalCreateIntent(TENANT_A, confirmed, CONFIRMED);
    await b.service.failExternalCreateIntent(TENANT_A, failed);

    for (const statement of b.log.filter((s) => s.op === 'update')) {
      expect(Object.keys(statement.values ?? {})).not.toContain('provider_booking_ref');
      expect(Object.keys(statement.values ?? {})).not.toContain('provider_account_id');
    }
  });

  it('la fila devuelta por open es la que queda en la base', async () => {
    const b = bank();

    const intent: OrderRow = await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    expect(b.rows()[0]).toEqual(intent);
  });
});

/**
 * `markPending` sólo lo usa vuelos, pero vive en el store compartido y ninguna suite de vuelos
 * prueba su CAS: sin él, un escalado tardío devolvería a pending una orden que otro camino ya
 * canceló o confirmó.
 */
describe('OrderCreateIntentStore.markPending — no pisa una transición concurrente', () => {
  it('baja a pending con el marcador sólo si el estado sigue siendo el leído', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    const confirmed = await b.service.settleExternalCreateIntent(TENANT_A, intent, CONFIRMED);
    const store = new OrderCreateIntentStore(b.db);
    if (confirmed === undefined) throw new Error('el cierre debía ganar el CAS');

    Object.assign(b.rows()[0] ?? {}, { status: 'cancelled' });
    await expect(store.markPending(TENANT_A, confirmed)).resolves.toBeUndefined();
    expect(b.rows()[0]).toMatchObject({ status: 'cancelled', error_message: null });

    Object.assign(b.rows()[0] ?? {}, { status: 'confirmed' });
    await expect(store.markPending(TENANT_A, confirmed)).resolves.toMatchObject({
      status: 'pending',
      error_message: CREATE_PENDING_RECONCILIATION_MARKER,
    });
  });

  it('otro tenant no la mueve y con la base caída no lanza', async () => {
    const b = bank({ failUpdates: true });
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    const store = new OrderCreateIntentStore(b.db);

    await expect(store.markPending(TENANT_A, intent)).resolves.toBeUndefined();
    expect(b.rows()[0]).toMatchObject({ status: 'pending' });

    const healthy = bank();
    const other = await healthy.service.openExternalCreateIntent(TENANT_A, USER, input());
    Object.assign(healthy.rows()[0] ?? {}, { status: 'confirmed' });
    await expect(
      new OrderCreateIntentStore(healthy.db).markPending(TENANT_B, {
        ...other,
        status: 'confirmed',
      }),
    ).resolves.toBeUndefined();
    expect(healthy.rows()[0]).toMatchObject({ status: 'confirmed' });
  });
});

/**
 * La revalidación previa al envío puede fijar otra tarifa: la fila tiene que decir lo que se va a
 * reservar ANTES de llamar, porque si la respuesta no llega es lo único que queda (docs/tbo/03 §8.4).
 */
describe('reviseExternalCreateIntent — la orden dice lo que se va a reservar antes de llamar', () => {
  const REVISADA = {
    selectedOffer: { offerRef: 'offer-1-c2', total: 33_900 },
    totalAmountMinor: 33_900,
    currency: 'USD',
  };

  it('reemplaza oferta y precio del intent abierto, sin tocar clave, referencia ni cuenta', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    await expect(b.service.reviseExternalCreateIntent(TENANT_A, intent, REVISADA)).resolves.toBe(
      true,
    );

    expect(b.rows()[0]).toMatchObject({
      status: 'pending',
      provider_raw: null,
      selected_offer: JSON.stringify(REVISADA.selectedOffer),
      total_amount: 33_900,
      currency: 'USD',
      create_request_key: `c:${KEY_1}`,
      provider_booking_ref: REF_1,
      provider_account_id: ACCOUNT,
    });
    const update = b.log.filter((s) => s.op === 'update');
    expect(update).toHaveLength(1);
    expect(Object.keys(update[0]?.values ?? {}).sort()).toEqual(
      ['currency', 'selected_offer', 'total_amount'].sort(),
    );
  });

  it('una fila ya cerrada no se revisa: `false`, y quien llama no llama al proveedor', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    await b.service.failExternalCreateIntent(TENANT_A, intent);

    await expect(b.service.reviseExternalCreateIntent(TENANT_A, intent, REVISADA)).resolves.toBe(
      false,
    );
    expect(b.rows()[0]).toMatchObject({ status: 'failed', total_amount: 34_012 });
  });

  it('otro tenant no la revisa, y un snapshot sin forma no llega a la base', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());

    await expect(b.service.reviseExternalCreateIntent(TENANT_B, intent, REVISADA)).resolves.toBe(
      false,
    );
    await expect(
      b.service.reviseExternalCreateIntent(TENANT_A, intent, { ...REVISADA, currency: 'usd' }),
    ).rejects.toBeInstanceOf(ExternalOrderIntentInputError);
    expect(b.rows()[0]).toMatchObject({ total_amount: 34_012 });
  });
});

describe('markExternalCreatePending — una lectura de cierre que contradice al proveedor', () => {
  it('devuelve a pending la orden confirmada, con el marcador de conciliación', async () => {
    const b = bank();
    const intent = await b.service.openExternalCreateIntent(TENANT_A, USER, input());
    const confirmed = await b.service.settleExternalCreateIntent(TENANT_A, intent, CONFIRMED);
    if (confirmed === undefined) throw new Error('el cierre debía ganar el CAS');

    await expect(b.service.markExternalCreatePending(TENANT_A, confirmed)).resolves.toMatchObject({
      status: 'pending',
      provider_order_id: 'CONF-778899',
      error_message: CREATE_PENDING_RECONCILIATION_MARKER,
    });
  });
});
