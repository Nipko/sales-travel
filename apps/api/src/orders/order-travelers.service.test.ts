import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import {
  OrderModifyRejectedError,
  type OrderModifyResult,
  type OrderTravelersView,
} from '@sales-travel/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordingAuditService } from '../audit/__fixtures__/recording-audit.service.js';
import { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { ProviderCapabilities } from '../providers/provider.types.js';
import { StubProviderFactory } from '../providers/__fixtures__/stub-provider.factory.js';
import { ModifyTravelersSchema, type ModifyTravelersInput } from './dto.js';
import { ORDER_EVENTS } from './order-events.js';
import { TRAVELERS_MESSAGES, type TravelersOperationResult } from './order-travelers.plan.js';
import {
  FlightTravelersService,
  TRAVELERS_STALE_AFTER_MS,
  modifyRefOf,
} from './order-travelers.service.js';
import {
  TravelersClaimRefusedError,
  type OrderTravelersStore,
  type TravelersOperationRecord,
} from './order-travelers.store.js';
import type { OrderRow } from './orders.service.js';

/**
 * `FlightTravelersService` sin base (SAB-25): las compuertas, lo que llega al puerto, el desenlace
 * en la operación, en la orden y en el rastro, y lo que NUNCA sale de la petición: el número del
 * documento, el viajero frecuente y cuál servicio especial (salud, religión). El claim y la RLS
 * contra Postgres los prueba `order-travelers.integration.test.ts`.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ORDER = '33333333-3333-4333-8333-333333333333';
const AIR = 'stub-air';
const PASAPORTE = 'AB1234567';
const VIEJO = 'ZX9876543';
const VIAJERO = '55667788';

function fila(extra: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDER,
    tenant_id: TENANT,
    user_id: USER,
    quotation_id: null,
    provider: AIR,
    provider_order_id: 'ABC123',
    status: 'confirmed',
    search_criteria: {},
    selected_offer: { provider: { name: AIR, offerRef: 'R-1', source: 'ATPCO' } },
    passengers: [
      {
        paxId: 'P1',
        paxType: 'ADT',
        givenName: 'Ana',
        surname: 'Secreta',
        gender: 'F',
        birthdate: '1990-01-01',
        citizenshipCountryCode: 'CO',
        identityDoc: {
          type: 'P',
          number: VIEJO,
          issuingCountryCode: 'CO',
          expiryDate: '2027-01-01',
        },
      },
      { paxId: 'P2', paxType: 'INF', givenName: 'Leo', surname: 'Secreta', gender: 'M' },
    ],
    contact_info: {},
    total_amount: 34012,
    currency: 'USD',
    order_number: 7,
    provider_raw: null,
    error_message: null,
    create_request_key: null,
    provider_booking_ref: null,
    provider_account_id: null,
    created_at: new Date('2026-10-13T00:00:00Z'),
    updated_at: new Date('2026-10-13T00:00:00Z'),
    ...extra,
  };
}

/** El cuerpo tal como lo deja pasar el borde: normalizado por Zod. */
function cuerpo(raw: unknown): ModifyTravelersInput {
  return ModifyTravelersSchema.parse(raw);
}

const DOCUMENTO = {
  travelers: [
    {
      index: 0,
      identityDocument: {
        type: 'PASSPORT',
        number: 'ab-123.4567',
        issuingCountry: 'co',
        nationality: 'CO',
        expiryDate: '2034-05-31',
      },
    },
  ],
};

const TODO = {
  travelers: [
    {
      ...DOCUMENTO.travelers[0],
      loyalty: { carrierCode: 'av', number: VIAJERO },
      specialServices: ['DBML', 'WCHR'],
    },
  ],
};

function hecho(extra: Partial<OrderModifyResult> = {}): OrderModifyResult {
  return {
    outcome: 'MODIFIED',
    unchanged: false,
    applied: [{ index: 0, field: 'identityDocuments' }],
    pending: [],
    attempts: 1,
    issues: [],
    ...extra,
  };
}

const VISTA: OrderTravelersView = {
  travelers: [
    {
      index: 0,
      documents: [{ type: 'PASSPORT', numberLast4: '6543', issuingCountry: 'CO' }],
      loyalty: [],
      specialServices: ['WCHR'],
    },
    { index: 1, documents: [], loyalty: [], specialServices: [] },
  ],
  supported: ['identityDocuments', 'loyalty', 'specialServices'],
  warnings: [],
};

function banco(
  o: {
    capabilities?: Partial<ProviderCapabilities>;
    result?: OrderModifyResult;
    throws?: unknown;
    claim?: Error;
    pending?: boolean;
    stale?: TravelersOperationRecord[];
    closed?: boolean;
  } = {},
) {
  const factory = new StubProviderFactory({
    code: AIR,
    capabilities: { modify: true, ...o.capabilities },
  });
  const registry = new FlightProviderRegistry([factory], {
    decisionFor: () => Promise.resolve(undefined),
  });
  const adapter = factory.adapterFor(TENANT);
  const supportedModifications = vi.fn(() => ['identityDocuments', 'loyalty', 'specialServices']);
  const readTravelers = vi.fn(() => Promise.resolve(VISTA));
  const modifyTravelers = vi.fn(() =>
    o.throws === undefined
      ? Promise.resolve(o.result ?? hecho())
      : Promise.reject(o.throws instanceof Error ? o.throws : new Error('boom')),
  );
  Object.assign(adapter, { supportedModifications, readTravelers, modifyTravelers });

  const store = {
    claim: vi.fn(() =>
      o.claim === undefined
        ? Promise.resolve({ operationId: 'op-1' })
        : Promise.reject(o.claim instanceof Error ? o.claim : new Error('claim')),
    ),
    settle: vi.fn(() => Promise.resolve(o.closed ?? true)),
    pendingWrite: vi.fn(() => Promise.resolve(o.pending ?? false)),
    listStale: vi.fn(() => Promise.resolve(o.stale ?? [])),
    findOrder: vi.fn(() => Promise.resolve(fila())),
  };
  const audit = new RecordingAuditService();
  const service = new FlightTravelersService(
    store as unknown as OrderTravelersStore,
    registry,
    audit.asService(),
  );
  return { service, store, audit, readTravelers, modifyTravelers };
}

/** Lo que nunca puede salir: ni a la operación, ni al rastro, ni a la respuesta, ni al log. */
function expectSinPii(text: string): void {
  for (const secreto of [PASAPORTE, VIEJO, VIAJERO, 'DBML', 'WCHR', 'Secreta']) {
    expect(text, `aparece «${secreto}»`).not.toContain(secreto);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('la reserva como la entiende el puerto', () => {
  it('localizador, carril y pasajeros por posición, tipo, apellido y género; ni un documento', () => {
    const ref = modifyRefOf(fila());
    expect(ref).toEqual({
      orderId: 'ABC123',
      contentSource: 'ATPCO',
      passengers: [
        { paxType: 'ADT', surname: 'Secreta', gender: 'F' },
        { paxType: 'INF', surname: 'Secreta', gender: 'M' },
      ],
    });
    expect(JSON.stringify(ref)).not.toContain(VIEJO);
  });

  it('sin localizador, 404; un pasajero sin tipo legible, 400', () => {
    expect(() => modifyRefOf(fila({ provider_order_id: null }))).toThrow(NotFoundException);
    expect(() => modifyRefOf(fila({ passengers: [{ givenName: 'Ana' }] }))).toThrow(
      BadRequestException,
    );
  });
});

describe('requestModify — el cambio y su desenlace', () => {
  it('claim sin valores, el puerto con lo normalizado y el id de la operación, y la orden enmascarada', async () => {
    const b = banco({
      result: hecho({
        applied: [
          { index: 0, field: 'identityDocuments' },
          { index: 0, field: 'loyalty' },
          { index: 0, field: 'specialServices' },
        ],
      }),
    });
    const reply = await b.service.requestModify(TENANT, fila(), USER, cuerpo(TODO));

    expect(reply).toEqual({
      outcome: 'MODIFIED',
      message: TRAVELERS_MESSAGES.saved,
      operationId: 'op-1',
      unchanged: false,
      applied: [
        { index: 0, field: 'identityDocuments' },
        { index: 0, field: 'loyalty' },
        { index: 0, field: 'specialServices' },
      ],
      pending: [],
    });

    // El puerto recibe lo normalizado en el borde: mayúsculas, sin separadores.
    expect(b.modifyTravelers).toHaveBeenCalledWith(
      modifyRefOf(fila()),
      [
        {
          index: 0,
          identityDocument: {
            type: 'PASSPORT',
            number: PASAPORTE,
            issuingCountry: 'CO',
            nationality: 'CO',
            expiryDate: '2034-05-31',
          },
          loyalty: { carrierCode: 'AV', number: VIAJERO },
          specialServices: ['DBML', 'WCHR'],
        },
      ],
      { tenantId: TENANT, requestId: 'op-1' },
    );

    // La operación: campos, nunca valores.
    const [, , , claimed] = b.store.claim.mock.calls[0] as unknown as [
      string,
      string,
      string,
      TravelersOperationResult,
    ];
    expect(claimed).toMatchObject({
      kind: 'travelers',
      stage: 'sent',
      reconciliationRequired: true,
      retryForbidden: false,
      fields: [
        { index: 0, field: 'identityDocuments' },
        { index: 0, field: 'loyalty' },
        { index: 0, field: 'specialServices' },
      ],
    });
    const settleCall = b.store.settle.mock.calls[0] as unknown as [
      string,
      string,
      string,
      string,
      TravelersOperationResult,
      string | null,
      Record<string, unknown>[] | undefined,
    ];
    expect(settleCall[3]).toBe('success');
    expect(settleCall[4]).toMatchObject({ stage: 'settled', outcome: 'MODIFIED' });
    expectSinPii(JSON.stringify([claimed, settleCall[4]]));

    // La orden: el documento y el viajero frecuente nuevos, ENMASCARADOS; el número viejo se va.
    const pasajeros = settleCall[6];
    expect(pasajeros?.[0]).toMatchObject({
      citizenshipCountryCode: 'CO',
      identityDoc: {
        type: 'P',
        numberLast4: '4567',
        issuingCountryCode: 'CO',
        expiryDate: '2034-05-31',
      },
      loyaltyProgramAccount: { airlineDesigCode: 'AV', accountNumberLast4: '7788' },
    });
    // El infante no se tocó.
    expect(pasajeros?.[1]).toEqual((fila().passengers as unknown[])[1]);
    expect(JSON.stringify(pasajeros)).not.toContain(VIEJO);
    expect(JSON.stringify(pasajeros)).not.toContain(PASAPORTE);
    expect(JSON.stringify(pasajeros)).not.toContain('WCHR');

    // El rastro: pedido y hecho, con nombres de campo.
    expect(b.audit.types()).toEqual([
      ORDER_EVENTS.travelersModifyRequested,
      ORDER_EVENTS.travelersModified,
    ]);
    expect(b.audit.first(ORDER_EVENTS.travelersModified)?.payload).toEqual({
      provider: AIR,
      operationId: 'op-1',
      fields: ['identityDocuments', 'loyalty', 'specialServices'],
      travelers: 1,
      unchanged: false,
      attempts: 1,
      testContent: false,
    });
    expectSinPii(b.audit.dump());
    expectSinPii(JSON.stringify(reply));
  });

  it('el log del servicio no lleva valores', async () => {
    const logs: string[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    const b = banco({
      result: hecho({
        outcome: 'UNVERIFIED',
        applied: [],
        pending: [{ index: 0, field: 'loyalty' }],
      }),
    });
    await b.service.requestModify(TENANT, fila(), USER, cuerpo(TODO));
    expect(logs.length).toBeGreaterThan(0);
    expectSinPii(logs.join('\n'));
  });

  it('una emitida también se corrige; una cancelada o con una cancelación en curso, no (409)', async () => {
    const b = banco();
    await expect(
      b.service.requestModify(TENANT, fila({ status: 'ticketed' }), USER, cuerpo(DOCUMENTO)),
    ).resolves.toMatchObject({ outcome: 'MODIFIED' });
    for (const status of ['cancelled', 'pending', 'failed'] as const) {
      await expect(
        b.service.requestModify(TENANT, fila({ status }), USER, cuerpo(DOCUMENTO)),
      ).rejects.toBeInstanceOf(ConflictException);
    }
    expect(b.modifyTravelers).toHaveBeenCalledTimes(1);
  });

  it('la reserva ya lo tenía: se dice así y queda hecho', async () => {
    const b = banco({ result: hecho({ unchanged: true, attempts: 0 }) });
    const reply = await b.service.requestModify(TENANT, fila(), USER, cuerpo(DOCUMENTO));
    expect(reply.message).toBe(TRAVELERS_MESSAGES.unchanged);
    expect(b.audit.first(ORDER_EVENTS.travelersModified)?.payload).toMatchObject({
      unchanged: true,
    });
  });

  it('rechazado por la aerolínea: el texto del caso, se puede volver a pedir y no se escala', async () => {
    const b = banco({
      result: hecho({
        outcome: 'FAILED',
        failureReason: 'REJECTED',
        applied: [],
        pending: [{ index: 0, field: 'identityDocuments' }],
        issues: [
          {
            severity: 'ERROR',
            category: 'BAD_REQUEST',
            type: 'INVALID_VALUE',
            fieldPath: 'after.travelers[0].identityDocuments[0].documentNumber',
            fieldValue: PASAPORTE,
            message: `Bad ${PASAPORTE}`,
          },
        ],
      }),
    });
    const reply = await b.service.requestModify(TENANT, fila(), USER, cuerpo(DOCUMENTO));
    expect(reply).toMatchObject({
      outcome: 'FAILED',
      message: 'La aerolínea rechazó el cambio: revisa el número de documento.',
    });
    const settleCall = b.store.settle.mock.calls[0] as unknown as unknown[];
    expect(settleCall[3]).toBe('failed');
    expect(settleCall[5]).toBe(TRAVELERS_MESSAGES.rejectedDocument);
    expect(settleCall[6]).toBeUndefined();
    expect(b.audit.first(ORDER_EVENTS.travelersModifyFailed)?.payload).toMatchObject({
      outcome: 'FAILED',
      reason: 'REJECTED',
      retryable: true,
      reconciliationRequired: false,
      issueTypes: ['INVALID_VALUE'],
    });
    expect(b.audit.ofType(ORDER_EVENTS.escalated)).toEqual([]);
    expectSinPii(b.audit.dump() + JSON.stringify(settleCall));
  });

  it('el viajero frecuente rechazado lo dice; la reserva que cambió en el medio, también', async () => {
    const loyalty = banco({
      result: hecho({
        outcome: 'FAILED',
        failureReason: 'REJECTED',
        applied: [],
        issues: [
          {
            severity: 'ERROR',
            category: 'APPLICATION_ERROR',
            type: 'UNABLE_TO_UPDATE_RESERVATION_LOYALTY_NOT_ACCEPTED',
          },
        ],
      }),
    });
    expect((await loyalty.service.requestModify(TENANT, fila(), USER, cuerpo(TODO))).message).toBe(
      TRAVELERS_MESSAGES.rejectedLoyalty,
    );

    const concurrente = banco({
      result: hecho({ outcome: 'FAILED', failureReason: 'CONCURRENT_CHANGE', applied: [] }),
    });
    expect(
      (await concurrente.service.requestModify(TENANT, fila(), USER, cuerpo(DOCUMENTO))).message,
    ).toBe(TRAVELERS_MESSAGES.concurrent);
  });

  it('en duda con una parte aplicada: no se da por hecho, se escala y la orden sólo guarda lo que quedó', async () => {
    const b = banco({
      result: hecho({
        outcome: 'UNVERIFIED',
        applied: [{ index: 0, field: 'identityDocuments' }],
        pending: [
          { index: 0, field: 'loyalty' },
          { index: 0, field: 'specialServices' },
        ],
      }),
    });
    const reply = await b.service.requestModify(TENANT, fila(), USER, cuerpo(TODO));
    expect(reply).toMatchObject({ outcome: 'UNVERIFIED', message: TRAVELERS_MESSAGES.partial });

    const settleCall = b.store.settle.mock.calls[0] as unknown as unknown[];
    expect(settleCall[3]).toBe('failed');
    expect(settleCall[4]).toMatchObject({ outcome: 'UNVERIFIED', reconciliationRequired: true });
    const pasajeros = settleCall[6] as Record<string, unknown>[];
    expect(pasajeros[0]?.['identityDoc']).toMatchObject({ numberLast4: '4567' });
    expect(pasajeros[0]).not.toHaveProperty('loyaltyProgramAccount');

    expect(b.audit.first(ORDER_EVENTS.travelersModifyFailed)?.payload).toMatchObject({
      outcome: 'UNVERIFIED',
      reconciliationRequired: true,
      appliedFields: ['identityDocuments'],
      pendingFields: ['loyalty', 'specialServices'],
    });
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'travelers-unverified',
      operationId: 'op-1',
      reconciliationRequired: true,
    });
    expectSinPii(b.audit.dump());
  });

  it('en duda sin nada aplicado: el texto general', async () => {
    const b = banco({
      result: hecho({
        outcome: 'UNVERIFIED',
        applied: [],
        pending: [{ index: 0, field: 'identityDocuments' }],
      }),
    });
    const reply = await b.service.requestModify(TENANT, fila(), USER, cuerpo(DOCUMENTO));
    expect(reply.message).toBe(TRAVELERS_MESSAGES.unverified);
    expect((b.store.settle.mock.calls[0] as unknown as unknown[])[6]).toBeUndefined();
  });
});

describe('requestModify — lo que no sale', () => {
  it('el puerto rechaza antes de salir: la operación se cierra sin enviar y el vendedor lee el motivo', async () => {
    const b = banco({
      throws: new OrderModifyRejectedError('TRAVELER_MISMATCH', 'travelers.0.surname no casa'),
    });
    const error = await b.service
      .requestModify(TENANT, fila(), USER, cuerpo(DOCUMENTO))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe(TRAVELERS_MESSAGES.travelerMismatch);
    const settleCall = b.store.settle.mock.calls[0] as unknown as unknown[];
    expect(settleCall[3]).toBe('failed');
    expect(settleCall[4]).toMatchObject({ outcome: 'NOT_SENT', reconciliationRequired: false });
    expect(b.audit.first(ORDER_EVENTS.travelersModifyFailed)?.payload).toMatchObject({
      outcome: 'NOT_SENT',
      rejection: 'TRAVELER_MISMATCH',
      retryable: true,
    });
  });

  it('un error cualquiera del puerto se cierra sin enviar y sigue su camino', async () => {
    const b = banco({ throws: new Error('lectura caída') });
    await expect(b.service.requestModify(TENANT, fila(), USER, cuerpo(DOCUMENTO))).rejects.toThrow(
      'lectura caída',
    );
    expect((b.store.settle.mock.calls[0] as unknown as unknown[])[4]).toMatchObject({
      outcome: 'NOT_SENT',
    });
  });

  it('otra escritura en curso: 409 y el proveedor no se entera', async () => {
    for (const claim of [
      new TravelersClaimRefusedError('already-pending'),
      Object.assign(new Error('dup'), {
        code: '23505',
        constraint: 'uq_order_operations_pending_provider_write',
      }),
    ]) {
      const b = banco({ claim });
      const error = await b.service
        .requestModify(TENANT, fila(), USER, cuerpo(DOCUMENTO))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toBe(TRAVELERS_MESSAGES.alreadyPending);
      expect(b.modifyTravelers).not.toHaveBeenCalled();
    }
  });

  it('sin la capacidad, un pasajero que no está o un infante con viajero frecuente: 400 sin claim', async () => {
    const apagado = banco({ capabilities: { modify: false } });
    await expect(
      apagado.service.requestModify(TENANT, fila(), USER, cuerpo(DOCUMENTO)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(apagado.store.claim).not.toHaveBeenCalled();

    const b = banco();
    await expect(
      b.service.requestModify(
        TENANT,
        fila(),
        USER,
        cuerpo({ travelers: [{ index: 4, specialServices: [] }] }),
      ),
    ).rejects.toThrow(TRAVELERS_MESSAGES.unknownPassenger);
    await expect(
      b.service.requestModify(
        TENANT,
        fila(),
        USER,
        cuerpo({ travelers: [{ index: 1, loyalty: { carrierCode: 'AV', number: VIAJERO } }] }),
      ),
    ).rejects.toThrow(TRAVELERS_MESSAGES.infant);
    expect(b.store.claim).not.toHaveBeenCalled();
  });
});

describe('view — la reserva enmascarada para la pantalla', () => {
  it('los nombres de la orden con lo que la reserva tiene, enmascarado, y si se puede guardar', async () => {
    const b = banco();
    const view = await b.service.view(TENANT, fila());
    expect(b.readTravelers).toHaveBeenCalledWith(modifyRefOf(fila()), { tenantId: TENANT });
    expect(view).toEqual({
      kind: 'travelers',
      testContent: false,
      supported: ['identityDocuments', 'loyalty', 'specialServices'],
      blocked: null,
      travelers: [
        {
          index: 0,
          givenName: 'Ana',
          surname: 'Secreta',
          paxType: 'ADT',
          documents: [{ type: 'PASSPORT', numberLast4: '6543', issuingCountry: 'CO' }],
          loyalty: [],
          specialServices: ['WCHR'],
        },
        {
          index: 1,
          givenName: 'Leo',
          surname: 'Secreta',
          paxType: 'INF',
          documents: [],
          loyalty: [],
          specialServices: [],
        },
      ],
      warnings: [],
    });
    expect(JSON.stringify(view)).not.toContain(VIEJO);
  });

  it('con otra escritura en curso o la reserva cancelada, dice por qué no se puede guardar', async () => {
    expect((await banco({ pending: true }).service.view(TENANT, fila())).blocked).toBe(
      TRAVELERS_MESSAGES.alreadyPending,
    );
    expect((await banco().service.view(TENANT, fila({ status: 'cancelled' }))).blocked).toBe(
      TRAVELERS_MESSAGES.notModifiable,
    );
  });
});

describe('sweepTenant — lo que quedó pendiente', () => {
  it('a revisión: cerrada en duda, escalada, sin reenviar nada', async () => {
    const b = banco({
      stale: [
        {
          id: 'op-viejo',
          orderId: ORDER,
          status: 'pending',
          actorUserId: USER,
          result: {
            kind: 'travelers',
            stage: 'sent',
            requestedAt: '2026-10-14T00:00:00Z',
            testContent: false,
            fields: [
              { index: 0, field: 'identityDocuments' },
              { index: 0, field: 'raro' },
            ],
            reconciliationRequired: true,
            retryForbidden: false,
          },
        },
      ],
    });
    const now = Date.parse('2026-10-14T12:00:00Z');
    const report = await b.service.sweepTenant(TENANT, now);
    expect(report).toEqual({ examined: 1, escalated: 1, skipped: 0 });
    expect(b.store.listStale).toHaveBeenCalledWith(
      TENANT,
      new Date(now - TRAVELERS_STALE_AFTER_MS),
    );
    const settleCall = b.store.settle.mock.calls[0] as unknown as unknown[];
    expect(settleCall.slice(0, 4)).toEqual([TENANT, ORDER, 'op-viejo', 'failed']);
    expect(settleCall[4]).toMatchObject({
      outcome: 'UNVERIFIED',
      escalated: true,
      fields: [{ index: 0, field: 'identityDocuments' }],
      pending: [{ index: 0, field: 'identityDocuments' }],
    });
    expect(b.modifyTravelers).not.toHaveBeenCalled();
    expect(b.audit.first(ORDER_EVENTS.escalated)?.payload).toMatchObject({
      reason: 'travelers-stale',
      fields: ['identityDocuments'],
    });
    expect(b.audit.first(ORDER_EVENTS.travelersModifyFailed)?.payload).toMatchObject({
      source: 'stale',
      outcome: 'UNVERIFIED',
    });
  });

  it('una que otra ejecución ya cerró no se escala dos veces', async () => {
    const b = banco({
      closed: false,
      stale: [{ id: 'op-x', orderId: ORDER, status: 'pending', actorUserId: null, result: {} }],
    });
    expect(await b.service.sweepTenant(TENANT)).toEqual({ examined: 1, escalated: 0, skipped: 1 });
    expect(b.audit.events).toEqual([]);
  });
});

describe('el borde: ModifyTravelersSchema', () => {
  const base = DOCUMENTO.travelers[0] as Record<string, unknown>;
  const doc = base['identityDocument'] as Record<string, unknown>;

  it.each([
    ['un país que no existe', { ...doc, issuingCountry: 'XX' }],
    ['un país de tres letras', { ...doc, nationality: 'COL' }],
    ['vencido', { ...doc, expiryDate: '2020-01-01' }],
    ['fecha imposible', { ...doc, expiryDate: '2034-02-30' }],
    ['a más de 20 años', { ...doc, expiryDate: '2099-01-01' }],
    ['número con símbolos', { ...doc, number: 'AB#1234' }],
    ['número corto', { ...doc, number: 'A1' }],
    ['tipo que no se edita', { ...doc, type: 'VISA' }],
    ['nacimiento en el futuro', { ...doc, birthDate: '2999-01-01' }],
    ['un campo de más', { ...doc, givenName: 'Otro' }],
  ])('documento inválido: %s', (_label, identityDocument) => {
    expect(
      ModifyTravelersSchema.safeParse({ travelers: [{ index: 0, identityDocument }] }).success,
    ).toBe(false);
  });

  it.each([
    ['un SSR fuera de la lista', { index: 0, specialServices: ['XBAG'] }],
    ['texto libre', { index: 0, specialServices: ['WCHR/OSI'] }],
    ['repetido', { index: 0, specialServices: ['VGML', 'VGML'] }],
    ['aerolínea de tres letras', { index: 0, loyalty: { carrierCode: 'AVA', number: VIAJERO } }],
    ['sin cambios', { index: 0 }],
    ['pasajero fuera de rango', { index: 9, specialServices: [] }],
    ['contactInfo', { index: 0, specialServices: [], contactInfo: {} }],
  ])('pedido inválido: %s', (_label, change) => {
    expect(ModifyTravelersSchema.safeParse({ travelers: [change] }).success).toBe(false);
  });

  it('el mismo pasajero dos veces o un campo de más en la raíz, no', () => {
    expect(
      ModifyTravelersSchema.safeParse({
        travelers: [
          { index: 0, specialServices: [] },
          { index: 0, specialServices: ['WCHR'] },
        ],
      }).success,
    ).toBe(false);
    expect(
      ModifyTravelersSchema.safeParse({ travelers: [{ index: 0, specialServices: [] }], x: 1 })
        .success,
    ).toBe(false);
  });

  it('el error de validación nombra el campo, nunca el número', () => {
    const parsed = ModifyTravelersSchema.safeParse({
      travelers: [{ index: 0, identityDocument: { ...doc, number: 'AB#1234567' } }],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).not.toContain('AB#1234567');
  });
});
