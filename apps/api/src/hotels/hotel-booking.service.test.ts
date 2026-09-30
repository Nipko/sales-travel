import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { HotelFee, HotelOffer, HotelRoompack, Money } from '@sales-travel/canonical';
import type { HotelBookingRoomGuests, HotelBookingView, SearchContext } from '@sales-travel/domain';
import type { TboFetch } from '@sales-travel/tbo-hotels';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type {
  BookingPermissionsService,
  NonRefundableRatesPolicy,
} from '../booking-permissions/booking-permissions.service.js';
import type { BrandingService, SupportContact } from '../branding/branding.service.js';
import type { TenantType } from '../database/database.types.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import { memoryDb, type Row } from '../orders/__fixtures__/memory-orders-db.js';
import { RecordingQueueService } from '../queue/__fixtures__/recording-queue.service.js';
import { ExternalOrderIntentService } from '../orders/external-order-intent.service.js';
import {
  CREATE_NOT_SENT_MARKER,
  CREATE_PENDING_RECONCILIATION_MARKER,
} from '../orders/order-create-intent.store.js';
import { ORDER_EVENTS } from '../orders/order-events.js';
import {
  BookingHoldRejectedError,
  bookingHoldMessage,
  type BookingHoldPreview,
  type BookingHoldQuote,
  type BookingHoldRejection,
} from '../portfolios/booking-hold.js';
import type { BookingHoldRelease, PortfoliosService } from '../portfolios/portfolios.service.js';
import type { ApplicableRule, PricingService } from '../pricing/pricing.service.js';
import {
  currentProviderPayloadScope,
  type ProviderPayloadScope,
} from '../provider-payloads/provider-payload-scope.js';
import type {
  ProviderCredentialsService,
  ResolvedProviderAccount,
} from '../provider-credentials/provider-credentials.service.js';
import { TboHotelsProviderFactory } from '../providers-tbo/tbo-hotels.factory.js';
import {
  StubHotelProviderFactory,
  type StubHotelAdapter,
} from '../providers/__fixtures__/stub-hotel-provider.factory.js';
import type {
  HotelBookContextRequest,
  HotelBookFailure,
  HotelProviderAccountIssue,
  HotelBookWithContext,
  HotelGuestCheck,
  HotelOfferInvalidation,
  HotelPrebookContextRequest,
  HotelPrebookWithContext,
  HotelProviderAccountFingerprint,
  HotelProviderFactory,
} from '../providers/hotel-provider.types.js';
import { BreakerRejectionError, CircuitBreakerService } from '../search/circuit-breaker.service.js';
import { MemoryCacheAdapter } from '../search/memory-cache.adapter.js';
import type { SearchTelemetryService } from '../search/search-telemetry.service.js';
import {
  ProviderDisabledByPlatformError,
  type CredentialSource,
  type ProviderFlagsPort,
} from '../providers/provider.types.js';
import { apagadoPara } from '../providers/__fixtures__/provider-flags.js';
import { hotelFlags, hotelRegistry } from './__fixtures__/fake-despegar-hotels.adapter.js';
import { fakeHotelsDb } from './__fixtures__/fake-hotels-db.js';
import { MemoryVerificationStore } from './__fixtures__/memory-verification-store.js';
import type { HcnScheduled, HcnTrackingService } from './hcn-tracking.service.js';
import {
  HotelAcceptedTotalMismatchError,
  HotelAgencyContactMissingError,
  HotelAtPropertyNotAcknowledgedError,
  HotelBookIntentClosedError,
  HotelBookRepricedError,
  HotelGuestsInvalidError,
  HotelNonRefundableBlockedError,
  HotelNonRefundableNotAcknowledgedError,
  HotelPackageOnlyRateError,
  HotelPrebookExpiredError,
} from './hotel-booking-errors.js';
import { HotelBookingVerificationService } from './hotel-booking-verification.service.js';
import {
  HOTEL_BOOK_DEFAULT_SYNC_WAIT_MS,
  HotelBookingService,
  hotelBookSyncWaitMs,
  type HotelBookOptions,
} from './hotel-booking.service.js';
import { HOTEL_EVENTS } from './hotel-events.js';
import {
  HotelPrebookSnapshotStore,
  type HotelPrebookSnapshot,
} from './hotel-prebook-snapshot.store.js';
import { HotelPrebookService } from './hotel-prebook.service.js';
import { priceRoompack } from './hotel-pricing.js';
import { HotelProviderCapabilityError } from './hotel-provider-errors.js';
import {
  HotelOfferUnavailableError,
  HotelSearchAccountChangedError,
  HotelSearchContextExpiredError,
  HotelSearchContextStore,
  type HotelSearchContext,
} from './hotel-search-context.store.js';
import type { HotelBookInput, HotelDetailInput } from './hotels.schemas.js';
import { HotelsService } from './hotels.service.js';

/**
 * Saga de reserva de hotel con intent antes del Book y respuesta híbrida (docs/tbo/09 PR-4.6;
 * 08 RF-10 CA-2, RF-17, RF-18, RF-20 CA 1 a 6, RF-22 CA 1 y 2; 03 §3, §4 y §5).
 *
 * Dos bancos, como el del PreBook. El primero con el proveedor de hoteles ANÓNIMO de los tests y el
 * registry, los almacenes, el breaker, el registro de trabajo en curso y el intent de órdenes
 * REALES —éste sobre el doble de Postgres de `orders/__fixtures__`, con sus índices únicos y su
 * RLS—: prueba el orden de la saga y lo que queda en la fila, sin apostar por TBO. El segundo con
 * el factory y el ACL de TBO REALES y sólo el `fetch` como doble: prueba lo que sale por el cable.
 */

const AGENCIA = '11111111-1111-4111-8111-111111111111';
const OTRA_AGENCIA = '22222222-2222-4222-8222-222222222222';
const CONSOLIDADOR = '99999999-9999-4999-8999-999999999999';
const USUARIO = '55555555-5555-4555-8555-555555555555';
const STUB = 'stub-hotels';
const SEARCH_ID = '6110a41c-558c-405c-a0d3-6bdd3e131146';
const TARIFA = `${STUB}-S-1-REF`;
const TARIFA_C2 = `${STUB}-S-1-REF-C2`;
const PREBOOK_REF = '77777777-7777-4777-8777-777777777777';
const CLAVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REF = 'STT7K2M9QX4D8R1VZ6AB';
const CONF = 'CONF-778899';

const T0 = Date.parse('2026-09-25T15:00:00Z');
const MIN = 60_000;
const VENCE = T0 + 27 * MIN;

const CUENTA: HotelProviderAccountFingerprint = {
  accountId: '66666666-6666-4666-8666-666666666666',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const NETO = 30_575;
const PISO = 32_134;

const USD = (amountMinor: number): Money => ({ amountMinor, currency: 'USD' });

const CARGO_EN_HOTEL: HotelFee = {
  roomIndex: 1,
  description: 'Impuesto obligatorio',
  descriptionRaw: 'mandatory_tax',
  amount: { amountMinor: 2000, currency: 'AED' },
};

const OCUPACION = [{ adults: 2, childrenAges: [7] }];

/** Datos de personas que no pueden aparecer en eventos ni logs. */
const PII = [
  'Muñoz',
  'Pérez',
  'Sofía',
  'cliente@example.com',
  'reservas@agencia.example',
  '3001234567',
];

interface Pack {
  netoMinor?: number;
  /** `null`: sin piso. */
  pisoMinor?: number | null;
  offerRef?: string;
  cargos?: HotelFee[];
  moneda?: string;
  /** Por defecto, no reembolsable con el 100 % desde el 1 de noviembre. */
  cancelacion?: HotelRoompack['cancellation'];
}

function pack(opts: Pack = {}): HotelRoompack {
  const offerRef = opts.offerRef ?? TARIFA;
  const moneda = opts.moneda ?? 'USD';
  const piso = opts.pisoMinor === undefined ? PISO : opts.pisoMinor;
  const cargos = opts.cargos ?? [CARGO_EN_HOTEL];
  return {
    id: offerRef,
    provider: { name: STUB, offerRef, raw: { searchId: SEARCH_ID } },
    board: 'RO',
    mealTypeRaw: 'Room_Only',
    rooms: [{ name: 'Doble estándar', reference: 0, bedOptions: [] }],
    cancellation: opts.cancelacion ?? {
      refundable: false,
      status: 'non_refundable',
      rules: [
        { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-11-01T00:00:00' },
      ],
      policySource: 'prebook-final',
    },
    price: {
      total: { amountMinor: opts.netoMinor ?? NETO, currency: moneda },
      taxesDetail: [],
      ...(piso === null ? {} : { minimumSellingPrice: { amountMinor: piso, currency: moneda } }),
    },
    ...(cargos.length === 0 ? {} : { atPropertyCharges: cargos }),
  };
}

function snapshot(
  overrides: Partial<HotelPrebookSnapshot> = {},
  p: Pack = {},
): HotelPrebookSnapshot {
  return {
    prebookRef: PREBOOK_REF,
    tenantId: AGENCIA,
    providerCode: STUB,
    searchId: SEARCH_ID,
    account: CUENTA,
    hotelId: 'S-1',
    offerRef: TARIFA,
    totalText: '305.75',
    currency: 'USD',
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-12',
    rooms: OCUPACION,
    guestNationality: 'AR',
    searchSentAt: T0,
    expiresAt: VENCE,
    roompack: priceRoompack(pack(p), [], AGENCIA),
    rateConditions: [
      { category: 'checkOut', text: 'CheckOut Time: 12:00 PM', raw: 'CheckOut Time: 12:00 PM' },
    ],
    signals: [],
    rateConditionsHash: 'a'.repeat(64),
    comparison: {
      stage: 'C1',
      outcome: 'UNCHANGED',
      price: 'SAME',
      changes: [],
      previousTotal: USD(NETO),
      currentTotal: USD(NETO),
    },
    createdAt: T0,
    ...overrides,
  };
}

function contexto(): HotelSearchContext {
  const seen = {
    total: USD(NETO),
    refundable: false,
    board: 'RO' as const,
    mealTypeRaw: 'Room_Only',
    atPropertyCharges: [CARGO_EN_HOTEL],
  };
  return {
    tenantId: AGENCIA,
    providerCode: STUB,
    searchId: SEARCH_ID,
    checkinDate: '2026-11-10',
    checkoutDate: '2026-11-12',
    rooms: OCUPACION,
    guestNationality: 'AR',
    searchSentAt: T0,
    expiresAt: VENCE,
    account: CUENTA,
    packs: [
      { hotelId: 'S-1', offerRef: TARIFA, totalText: '305.75', currency: 'USD', seen },
      { hotelId: 'S-1', offerRef: `${TARIFA}-2`, totalText: '305.75', currency: 'USD', seen },
    ],
  };
}

const HUESPEDES: HotelBookingRoomGuests[] = [
  {
    guests: [
      { paxType: 'ADT', title: 'Mr', firstName: 'José', lastName: 'Muñoz' },
      { paxType: 'ADT', title: 'Mrs', firstName: 'Ana', lastName: 'Pérez' },
      { paxType: 'CHD', title: 'Ms', firstName: 'Sofía', lastName: 'Muñoz' },
    ],
  },
];

const CONTACTO_HUESPED = {
  email: 'cliente@example.com',
  phone: { countryCode: '57', number: '3001234567' },
};

function pedido(overrides: Partial<HotelBookInput> = {}): HotelBookInput {
  return {
    providerCode: STUB,
    prebookRef: PREBOOK_REF,
    acceptedTotal: USD(PISO),
    atPropertyAcknowledged: true,
    // La tarifa de estos casos es no reembolsable: el vendedor lo confirmó (punto c del 2026-09-29).
    nonRefundableAcknowledged: true,
    rooms: HUESPEDES,
    contact: CONTACTO_HUESPED,
    ...overrides,
  };
}

interface Revalidada {
  netoMinor?: number;
  pisoMinor?: number | null;
  moneda?: string;
  cancelacion?: HotelRoompack['cancellation'];
  totalText?: string;
  signals?: HotelPrebookWithContext['result']['signals'];
  comparacion?: Partial<HotelPrebookWithContext['comparison']>;
}

/** El PreBook de revalidación (C2): otra referencia y otro literal que el del snapshot. */
function revalidada(opts: Revalidada = {}): HotelPrebookWithContext {
  const moneda = opts.moneda ?? 'USD';
  const total = { amountMinor: opts.netoMinor ?? NETO, currency: moneda };
  const roompack = pack({
    offerRef: TARIFA_C2,
    moneda,
    netoMinor: total.amountMinor,
    ...(opts.pisoMinor === undefined ? {} : { pisoMinor: opts.pisoMinor }),
    ...(opts.cancelacion === undefined ? {} : { cancelacion: opts.cancelacion }),
  });
  return {
    result: {
      total,
      expiresAt: new Date(VENCE).toISOString(),
      // Lo que ponga el ACL en `raw` no viaja: la saga deja sólo la clave de la búsqueda.
      roompack: {
        ...roompack,
        provider: { ...roompack.provider, raw: { leadGuest: 'Ana Pérez' } },
      },
      rateConditions: [
        { category: 'checkOut', text: 'CheckOut Time: 12:00 PM', raw: 'CheckOut Time: 12:00 PM' },
      ],
      signals: opts.signals ?? [],
      providerStatus: '200',
      warnings: [],
    },
    pack: {
      hotelId: 'S-1',
      offerRef: TARIFA_C2,
      totalText: opts.totalText ?? '305.750',
      currency: moneda,
    },
    rateConditionsHash: 'b'.repeat(64),
    comparison: {
      stage: 'C2',
      outcome: 'UNCHANGED',
      price: 'SAME',
      changes: [],
      previousTotal: USD(NETO),
      currentTotal: total,
      ...opts.comparacion,
    },
    requestId: 'req-prebook-c2',
  };
}

/** Un error que el proveedor declara rechazo definitivo o incierto, y lo que invalida. */
class RechazoError extends Error {
  constructor(
    readonly failure: HotelBookFailure,
    readonly scope?: HotelOfferInvalidation,
    readonly accountIssue?: HotelProviderAccountIssue,
  ) {
    super(`rechazo ${failure.reason}`);
    this.name = 'RechazoError';
  }
}

function confirmada(overrides: Partial<HotelBookWithContext['result']> = {}): HotelBookWithContext {
  return {
    result: {
      outcome: 'CONFIRMED',
      providerBookingId: CONF,
      bookingReference: REF,
      providerStatus: '200',
      warnings: [],
      ...overrides,
    },
    reason: 'confirmed',
    requestId: 'req-book-1',
  };
}

/** Lo que valida el proveedor: aquí, cuántos huéspedes y la transliteración a ASCII. */
function ascii(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function guestsOk(rooms: readonly HotelBookingRoomGuests[]): HotelGuestCheck {
  return {
    ok: true,
    rooms: rooms.map((room) =>
      room.guests.map((g) => ({
        title: g.title ?? 'Mr',
        firstName: ascii(g.firstName),
        lastName: ascii(g.lastName),
        paxType: g.paxType,
      })),
    ),
  };
}

interface PuertoBook {
  prebookWithContext: Mock<
    (req: HotelPrebookContextRequest, ctx: SearchContext) => Promise<HotelPrebookWithContext>
  >;
  offerInvalidatedBy: Mock<(err: unknown) => HotelOfferInvalidation | undefined>;
  newBookingReference: Mock<() => string>;
  checkBookingGuests: Mock<
    (
      rooms: readonly HotelBookingRoomGuests[],
      occupancy: readonly { adults: number; childrenAges: number[] }[],
    ) => HotelGuestCheck
  >;
  bookWithContext: Mock<
    (req: HotelBookContextRequest, ctx: SearchContext) => Promise<HotelBookWithContext>
  >;
  bookFailureOf: Mock<(err: unknown) => HotelBookFailure>;
  accountIssueOf: Mock<(err: unknown) => HotelProviderAccountIssue | undefined>;
}

function conBook(adapter: StubHotelAdapter, cuenta = CUENTA): PuertoBook {
  const puerto: PuertoBook = {
    prebookWithContext: vi.fn(() => Promise.resolve(revalidada())),
    offerInvalidatedBy: vi.fn((err: unknown) =>
      err instanceof RechazoError ? err.scope : undefined,
    ),
    newBookingReference: vi.fn(() => REF),
    checkBookingGuests: vi.fn((rooms: readonly HotelBookingRoomGuests[]) => guestsOk(rooms)),
    bookWithContext: vi.fn(() => Promise.resolve(confirmada())),
    bookFailureOf: vi.fn((err: unknown) =>
      err instanceof RechazoError
        ? err.failure
        : { outcome: 'UNCERTAIN' as const, reason: 'unexpected-error', dispatched: true },
    ),
    accountIssueOf: vi.fn((err: unknown) =>
      err instanceof RechazoError ? err.accountIssue : undefined,
    ),
  };
  Object.assign(adapter, { searchAccount: cuenta, ...puerto });
  return puerto;
}

/** La cartera de la agencia que vende, como la ve la retención (RF-23). */
interface CarteraFake {
  saldoMinor: number;
  /** El cupo que le fija quien la financia. */
  cupoMinor?: number;
  /**
   * La única moneda en que la agencia tiene cartera. Por defecto, la de la reserva. En otra moneda,
   * para la reserva es como no tener cartera: la retención no convierte.
   */
  moneda?: string;
  /**
   * Un nivel de la red que la financia (0060) no cubre la reserva aunque la cartera propia sí. La
   * cascada la decide la base; acá sólo su motivo.
   */
  red?: Extract<BookingHoldRejection, `PORTFOLIO_NETWORK_${string}`>;
}

interface Fondos {
  service: PortfoliosService;
  estado: { saldoMinor: number; retenciones: Map<string, number> };
  assertBookingHoldAffordable: Mock<
    (
      tenantId: string,
      quote: BookingHoldQuote,
      opts?: { readonly reportOrderId?: string },
    ) => Promise<void>
  >;
  holdBookingIntent: Mock<
    (tenantId: string, orderId: string, createdBy: string, expected: Money) => Promise<unknown>
  >;
  releaseFailedBookingHold: Mock<
    (tenantId: string, orderId: string, createdBy: string) => Promise<BookingHoldRelease>
  >;
  previewBookingHold: Mock<
    (tenantId: string, quote: BookingHoldQuote) => Promise<BookingHoldPreview | undefined>
  >;
}

/**
 * Doble de la cartera sobre un saldo en memoria, con las reglas de `wallet_hold_decide` (0060) para
 * la cartera propia y la red como una perilla. La transacción, el bloqueo, la cascada y la SQL los
 * prueban los tests de `portfolios/`.
 */
function carteraDe(c: CarteraFake = { saldoMinor: 10_000_000 }): Fondos {
  const estado = { saldoMinor: c.saldoMinor, retenciones: new Map<string, number>() };
  const decision = (amount: Money): BookingHoldRejection | undefined => {
    // Como la base: la cartera de la moneda de la reserva, o ninguna; después, la red.
    if ((c.moneda ?? amount.currency) !== amount.currency) return 'PORTFOLIO_CURRENCY_NOT_ENABLED';
    if (estado.saldoMinor + Math.max(c.cupoMinor ?? 0, 0) < amount.amountMinor) {
      return 'PORTFOLIO_FUNDS_INSUFFICIENT';
    }
    return c.red;
  };
  const decidir = (amount: Money): void => {
    const reason = decision(amount);
    if (reason !== undefined) {
      throw new BookingHoldRejectedError(reason, { amountCurrency: amount.currency });
    }
  };
  const fondos = {
    previewBookingHold: vi.fn((_tenantId: string, quote: BookingHoldQuote) => {
      const reason = decision(quote.amount);
      return Promise.resolve<BookingHoldPreview>(
        reason === undefined
          ? { status: 'ok', currency: quote.amount.currency }
          : {
              status: 'blocked',
              currency: quote.amount.currency,
              reason,
              message: bookingHoldMessage(reason, quote.amount.currency),
            },
      );
    }),
    assertBookingHoldAffordable: vi.fn(
      (_tenantId: string, quote: BookingHoldQuote, _opts?: { readonly reportOrderId?: string }) =>
        new Promise<void>((resolve) => {
          decidir(quote.amount);
          resolve();
        }),
    ),
    holdBookingIntent: vi.fn(
      (_tenantId: string, orderId: string, _createdBy: string, expected: Money) =>
        new Promise<unknown>((resolve) => {
          decidir(expected);
          estado.saldoMinor -= expected.amountMinor;
          estado.retenciones.set(orderId, expected.amountMinor);
          resolve({});
        }),
    ),
    releaseFailedBookingHold: vi.fn((_tenantId: string, orderId: string, _createdBy: string) => {
      const monto = estado.retenciones.get(orderId);
      if (monto === undefined) return Promise.resolve<BookingHoldRelease>('no-hold');
      estado.retenciones.delete(orderId);
      estado.saldoMinor += monto;
      return Promise.resolve<BookingHoldRelease>('released');
    }),
  };
  return { ...fondos, estado, service: fondos as unknown as PortfoliosService };
}

interface OpcionesBanco {
  reglas?: ApplicableRule[];
  retrieve?: boolean;
  soporte?: SupportContact;
  options?: HotelBookOptions | undefined;
  sinOpciones?: boolean;
  emit?: Mock;
  /** `false`: sin Redis, la cola no encola nada. */
  redis?: boolean;
  /** La cartera de la agencia (RF-23). Por defecto, con saldo de sobra. */
  cartera?: CarteraFake;
  /** De dónde salen las credenciales de la agencia. Por defecto, propias. */
  credentialSource?: CredentialSource;
  /** Dueño de la cuenta con que se reserva. */
  ownerTenantId?: string;
  /**
   * La cuenta como la ve la base al abrir el intent. Por defecto, la misma versión que vio la
   * búsqueda (`CUENTA`).
   */
  cuentaEnBase?: { updatedAt?: string; available?: boolean };
  /** Habilitación de la plataforma. Por defecto, todo encendido. */
  flags?: ProviderFlagsPort;
  /** Quien financia a la agencia le bloqueó las no reembolsables (0055). Por defecto, no. */
  noReembolsablesBloqueadas?: boolean;
}

type PermisosFake = { nonRefundableRates: Mock<BookingPermissionsService['nonRefundableRates']> };

function permisosFake(bloqueadas = false): PermisosFake {
  return {
    nonRefundableRates: vi.fn(() =>
      Promise.resolve<NonRefundableRatesPolicy>(
        bloqueadas ? { effective: 'blocked', blockedBy: 'own' } : { effective: 'allowed' },
      ),
    ),
  };
}

interface Banco {
  service: HotelBookingService;
  puerto: PuertoBook;
  adapter: StubHotelAdapter;
  memory: ReturnType<typeof memoryDb>;
  intents: ExternalOrderIntentService;
  snapshots: HotelPrebookSnapshotStore;
  contexts: HotelSearchContextStore;
  emit: Mock;
  inflight: InflightWorkRegistry;
  branding: { resolveSupportContact: Mock };
  pricing: { getApplicableRules: Mock };
  queue: RecordingQueueService;
  tracking: MemoryVerificationStore;
  verification: HotelBookingVerificationService;
  fondos: Fondos;
  /** El plan del HCN que abre la confirmación (PR-5.4). */
  hcn: HcnFake;
  /** El permiso de no reembolsables de la agencia (0055). */
  permisos: PermisosFake;
}

type HcnFake = { schedule: Mock<HcnTrackingService['schedule']> };

function hcnFake(): HcnFake {
  return {
    schedule: vi.fn(() => Promise.resolve<HcnScheduled>({ opened: true, queued: true })),
  };
}

const SOPORTE: SupportContact = { email: 'reservas@agencia.example', phone: '+57 601 555 0000' };

async function banco(opts: OpcionesBanco = {}, snap = snapshot()): Promise<Banco> {
  const stub = new StubHotelProviderFactory({
    code: STUB,
    capabilities: { retrieve: opts.retrieve ?? true },
    circuit: { accountRef: 'huella-de-la-cuenta' },
    ...(opts.credentialSource === undefined ? {} : { credentialSource: opts.credentialSource }),
    ...(opts.ownerTenantId === undefined ? {} : { accountOwnerTenantId: opts.ownerTenantId }),
  });
  const adapter = stub.adapterFor(AGENCIA);
  const puerto = conBook(adapter);
  conBook(stub.adapterFor(OTRA_AGENCIA));
  const cache = new MemoryCacheAdapter();
  const contexts = new HotelSearchContextStore(cache);
  const snapshots = new HotelPrebookSnapshotStore(cache);
  await contexts.save(contexto());
  await snapshots.save(snap);
  const memory = memoryDb({
    providerAccounts: [
      {
        id: CUENTA.accountId,
        updatedAt: opts.cuentaEnBase?.updatedAt ?? CUENTA.updatedAt,
        ...(opts.cuentaEnBase?.available === undefined
          ? {}
          : { available: opts.cuentaEnBase.available }),
      },
    ],
  });
  const intents = new ExternalOrderIntentService(memory.db);
  const emit = opts.emit ?? vi.fn(() => Promise.resolve());
  const inflight = new InflightWorkRegistry();
  const branding = { resolveSupportContact: vi.fn(() => Promise.resolve(opts.soporte ?? SOPORTE)) };
  const pricing = { getApplicableRules: vi.fn(() => Promise.resolve(opts.reglas ?? [])) };
  const registry = hotelRegistry([stub], opts.flags ?? hotelFlags(true));
  const breaker = new CircuitBreakerService();
  const audit = { emit } as unknown as AuditService;
  const queue = new RecordingQueueService(opts.redis ?? true);
  const tracking = new MemoryVerificationStore(() => memory.rows());
  const hcn = hcnFake();
  const verification = new HotelBookingVerificationService(
    registry,
    tracking.asStore(),
    intents,
    breaker,
    audit,
    queue.asService(),
    hcn as unknown as HcnTrackingService,
  );
  const fondos = carteraDe(opts.cartera);
  const permisos = permisosFake(opts.noReembolsablesBloqueadas);
  const service = new HotelBookingService(
    registry,
    snapshots,
    contexts,
    intents,
    pricing as unknown as PricingService,
    breaker,
    audit,
    branding as unknown as BrandingService,
    inflight,
    verification,
    fondos.service,
    hcn as unknown as HcnTrackingService,
    permisos as unknown as BookingPermissionsService,
    opts.sinOpciones === true ? undefined : (opts.options ?? { syncWaitMs: 5_000 }),
  );
  return {
    service,
    puerto,
    adapter,
    memory,
    intents,
    snapshots,
    contexts,
    emit,
    inflight,
    branding,
    pricing,
    queue,
    tracking,
    verification,
    fondos,
    hcn,
    permisos,
  };
}

function fila(b: Banco): Row {
  const [row] = b.memory.rows();
  if (row === undefined) throw new Error('no hay orden');
  return row;
}

function json(value: unknown): unknown {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
}

function eventos(
  b: Banco,
): { eventType: string; payload: Record<string, unknown>; aggregateId?: string }[] {
  return b.emit.mock.calls.map(
    ([e]) => e as { eventType: string; payload: Record<string, unknown>; aggregateId?: string },
  );
}

function tipos(b: Banco): string[] {
  return eventos(b).map((e) => e.eventType);
}

function evento(b: Banco, tipo: string): Record<string, unknown> {
  const found = eventos(b).find((e) => e.eventType === tipo);
  if (found === undefined) throw new Error(`no se emitió ${tipo}`);
  return found.payload;
}

async function rechazo(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('se esperaba un rechazo');
}

/** Una promesa que el test resuelve cuando quiere: un Book que tarda. */
function diferido<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  vi.stubEnv('PROVIDERS_DISABLED', '');
  vi.stubEnv('HOTEL_BOOK_SYNC_WAIT_MS', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ───────────────────────── Camino feliz (03 §5.1) ─────────────────────────

describe('RF-20: la orden existe antes del Book, y el Book sale con lo que revalidó C2', () => {
  it('orden: intent con referencia y cuenta → C2 → la orden dice lo que se reserva → Book', async () => {
    const b = await banco();
    b.puerto.prebookWithContext.mockImplementation(() => {
      // El intent ya está comprometido, con su referencia y su cuenta, antes de tocar al proveedor.
      expect(b.memory.rows()).toHaveLength(1);
      expect(fila(b)).toMatchObject({
        status: 'pending',
        provider_booking_ref: REF,
        provider_account_id: CUENTA.accountId,
        create_request_key: `c:${CLAVE}`,
        error_message: CREATE_PENDING_RECONCILIATION_MARKER,
      });
      return Promise.resolve(revalidada());
    });
    b.puerto.bookWithContext.mockImplementation(() => {
      // Y antes del Book la fila ya dice qué se reserva: el PreBook de C2 (03 §8.4).
      expect(json(fila(b)['selected_offer'])).toMatchObject({ offerRef: TARIFA_C2 });
      expect(tipos(b)).toContain(ORDER_EVENTS.createRequested);
      return Promise.resolve(confirmada());
    });

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(b.puerto.prebookWithContext).toHaveBeenCalledTimes(1);
    expect(b.puerto.bookWithContext).toHaveBeenCalledTimes(1);
  });

  it('PR-4.9: C2, el Book y la lectura de cierre salen atados a la orden en la bóveda de payloads', async () => {
    const b = await banco();
    const alcances: Record<string, ProviderPayloadScope | undefined> = {};
    b.puerto.prebookWithContext.mockImplementation(() => {
      alcances['prebook'] = currentProviderPayloadScope();
      return Promise.resolve(revalidada());
    });
    b.puerto.bookWithContext.mockImplementation(() => {
      alcances['book'] = currentProviderPayloadScope();
      return Promise.resolve(confirmada());
    });
    const lectura = b.adapter.getBooking.getMockImplementation();
    b.adapter.getBooking.mockImplementation((id: string, ctx: SearchContext) => {
      alcances['getBooking'] = currentProviderPayloadScope();
      if (lectura === undefined) throw new Error('el stub no lee');
      return lectura(id, ctx);
    });

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    const alcance = { tenantId: AGENCIA, orderId: fila(b)['id'] };
    expect(alcances).toEqual({ prebook: alcance, book: alcance, getBooking: alcance });
    // Fuera de la saga no queda nada puesto.
    expect(currentProviderPayloadScope()).toBeUndefined();
  });

  it('C2 compara contra lo aceptado en el snapshot, con la búsqueda y la ocupación del servidor', async () => {
    const b = await banco();

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    const snap = snapshot();
    expect(b.puerto.prebookWithContext).toHaveBeenCalledWith(
      {
        searchId: SEARCH_ID,
        hotelId: 'S-1',
        offerRef: TARIFA,
        searchSentAt: T0,
        rooms: OCUPACION,
        baseline: {
          stage: 'C2',
          accepted: {
            totalText: '305.75',
            roompack: snap.roompack,
            signals: [],
            rateConditionsHash: 'a'.repeat(64),
          },
        },
      },
      { tenantId: AGENCIA, requestId: fila(b)['id'] },
    );
  });

  it('RF-20 CA-6: el Book lleva la referencia y el LITERAL del total de C2, la ocupación de la búsqueda y el contacto de la agencia', async () => {
    const b = await banco();

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(b.puerto.bookWithContext).toHaveBeenCalledWith(
      {
        offerRef: TARIFA_C2,
        totalText: '305.750',
        bookingReference: REF,
        searchSentAt: T0,
        occupancy: OCUPACION,
        rooms: HUESPEDES,
        // D-TBO-23 A: el de la agencia, nunca el del huésped.
        contact: {
          email: 'reservas@agencia.example',
          phone: { countryCode: '57', number: '6015550000' },
        },
      },
      { tenantId: AGENCIA, requestId: fila(b)['id'] },
    );
  });

  it('201 con la orden confirmada, el localizador, la referencia y el precio de venta', async () => {
    const b = await banco();

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res).toEqual({
      httpStatus: 201,
      body: {
        orderId: fila(b)['id'],
        orderNumber: 1,
        status: 'confirmed',
        providerCode: STUB,
        providerBookingId: CONF,
        bookingReference: REF,
        total: USD(PISO),
        reason: 'confirmed',
        warnings: [],
      },
    });
    expect(b.adapter.getBooking).toHaveBeenCalledTimes(1);
    expect(b.adapter.getBooking).toHaveBeenCalledWith(
      CONF,
      { tenantId: AGENCIA, requestId: fila(b)['id'] },
      // La lectura de cierre va por el cupo de dinero: una ráfaga de jobs no la hace esperar (PV-41).
      { purpose: 'booking' },
    );
    // Confirmada: abre el plan del HCN (04 §6.3 fila 2; PR-5.4).
    expect(b.hcn.schedule.mock.calls).toEqual([[{ tenantId: AGENCIA, orderId: fila(b)['id'] }]]);
  });

  it('la fila: C2, huéspedes originales y enviados, contacto del huésped, lista blanca y vertical', async () => {
    const b = await banco();

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    const row = fila(b);
    expect(row).toMatchObject({
      tenant_id: AGENCIA,
      user_id: USUARIO,
      provider: STUB,
      status: 'confirmed',
      provider_order_id: CONF,
      provider_booking_ref: REF,
      provider_account_id: CUENTA.accountId,
      total_amount: PISO,
      currency: 'USD',
      error_message: null,
      // Un "confirmado" no libera la clave: el mismo formulario reenviado ve esta orden.
      create_request_key: `c:${CLAVE}`,
    });
    expect(json(row['search_criteria'])).toEqual({
      hotelId: 'S-1',
      searchId: SEARCH_ID,
      checkinDate: '2026-11-10',
      checkoutDate: '2026-11-12',
      rooms: OCUPACION,
      guestNationality: 'AR',
      vertical: 'hotels',
    });
    expect(json(row['contact_info'])).toEqual(CONTACTO_HUESPED);
    // RF-18: los originales para el voucher, y lo que salió al proveedor.
    expect(json(row['passengers'])).toEqual([
      {
        room: 0,
        guests: [
          {
            paxType: 'ADT',
            title: 'Mr',
            firstName: 'José',
            lastName: 'Muñoz',
            sent: { firstName: 'Jose', lastName: 'Munoz' },
          },
          {
            paxType: 'ADT',
            title: 'Mrs',
            firstName: 'Ana',
            lastName: 'Pérez',
            sent: { firstName: 'Ana', lastName: 'Perez' },
          },
          {
            paxType: 'CHD',
            title: 'Ms',
            firstName: 'Sofía',
            lastName: 'Muñoz',
            sent: { firstName: 'Sofia', lastName: 'Munoz' },
          },
        ],
      },
    ]);
    expect(json(row['provider_raw'])).toEqual({
      vertical: 'hotels',
      bookingReference: REF,
      reason: 'confirmed',
      phase: 'create',
      outcome: 'CONFIRMED',
    });
    const oferta = json(row['selected_offer']) as Record<string, unknown>;
    expect(oferta).toMatchObject({
      vertical: 'hotels',
      providerCode: STUB,
      hotelId: 'S-1',
      searchId: SEARCH_ID,
      prebookRef: PREBOOK_REF,
      offerRef: TARIFA_C2,
      totalText: '305.750',
      currency: 'USD',
      searchSentAt: new Date(T0).toISOString(),
      expiresAt: new Date(VENCE).toISOString(),
      signals: [],
      rateConditionsHash: 'b'.repeat(64),
      comparison: { stage: 'C2', outcome: 'UNCHANGED', price: 'SAME', changes: [] },
      pricing: { finalMinor: PISO, netMinor: NETO, totalMarkupMinor: PISO - NETO, currency: 'USD' },
    });
    // RF-08 CA-5: `raw` sólo con la clave de la búsqueda, lo ponga el proveedor o no.
    expect((oferta['roompack'] as HotelRoompack).provider.raw).toEqual({ searchId: SEARCH_ID });
  });

  it('eventos en orden, sin nombres, email, teléfono ni texto del proveedor', async () => {
    const b = await banco();

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(tipos(b)).toEqual([
      HOTEL_EVENTS.nonRefundableAcknowledged,
      ORDER_EVENTS.createRequested,
      ORDER_EVENTS.created,
      ORDER_EVENTS.verified,
    ]);
    expect(evento(b, ORDER_EVENTS.createRequested)).toEqual({
      provider: STUB,
      vertical: 'hotels',
      hotelId: 'S-1',
      bookingReference: REF,
      amountMinor: PISO,
      netMinor: NETO,
      currency: 'USD',
      rooms: 1,
      guests: 3,
      stage: 'C2',
      repriced: 'UNCHANGED',
      nonRefundable: 'declared',
    });
    expect(evento(b, ORDER_EVENTS.created)).toEqual({
      provider: STUB,
      vertical: 'hotels',
      bookingReference: REF,
      outcome: 'CONFIRMED',
      reason: 'confirmed',
      providerBookingId: CONF,
    });
    expect(evento(b, ORDER_EVENTS.verified)).toEqual({
      provider: STUB,
      vertical: 'hotels',
      bookingReference: REF,
      verified: true,
      found: true,
      status: 'CONFIRMED',
      warnings: 0,
    });
    for (const e of eventos(b)) {
      expect(e.aggregateId).toBe(fila(b)['id']);
      for (const dato of PII) expect(JSON.stringify(e)).not.toContain(dato);
    }
  });

  it('un tenant sin reglas ni piso vende al neto', async () => {
    const b = await banco({}, snapshot({}, { pisoMinor: null }));
    b.puerto.prebookWithContext.mockResolvedValue(revalidada({ pisoMinor: null }));

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido({ acceptedTotal: USD(NETO) }));

    expect(res.body).toMatchObject({ status: 'confirmed', total: USD(NETO) });
  });

  it('una búsqueda sin nacionalidad y una tarifa sin cargos en el hotel se reservan sin esos campos', async () => {
    const { guestNationality: _n, ...sinNacionalidad } = snapshot({}, { cargos: [] });
    const b = await banco({}, sinNacionalidad);

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido({ atPropertyAcknowledged: undefined }));

    expect(json(fila(b)['search_criteria'])).not.toHaveProperty('guestNationality');
    expect(fila(b)['status']).toBe('confirmed');
  });
});

// ───────────────────────── Idempotencia (RF-20 CA-1, RF-22 CA-2) ─────────────────────────

describe('RF-20 CA-1 y RF-22 CA-2: la misma clave no reserva dos veces', () => {
  it('la misma `Idempotency-Key` → 409 `duplicateRequest`, sin segundo PreBook ni segundo Book', async () => {
    const b = await banco();
    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      orderId: fila(b)['id'],
      providerOrderId: CONF,
      duplicateRequest: true,
      retryForbidden: true,
      reconciliationRequired: true,
    });
    expect(b.puerto.prebookWithContext).toHaveBeenCalledTimes(1);
    expect(b.puerto.bookWithContext).toHaveBeenCalledTimes(1);
    expect(b.memory.rows()).toHaveLength(1);
  });

  it('un doble clic simultáneo abre UN intent y hace UN Book', async () => {
    const b = await banco();

    const [primero, segundo] = await Promise.allSettled([
      b.service.book(AGENCIA, USUARIO, CLAVE, pedido()),
      b.service.book(AGENCIA, USUARIO, CLAVE, pedido()),
    ]);

    expect([primero.status, segundo.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(b.memory.rows()).toHaveLength(1);
    expect(b.puerto.bookWithContext).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['sin clave', undefined],
    ['con una clave que no es UUID', 'reserva-1'],
  ])('%s → 400 antes de tocar nada', async (_caso, clave) => {
    const b = await banco();

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, clave, pedido()));

    expect(err).toBeInstanceOf(BadRequestException);
    expect(b.memory.rows()).toHaveLength(0);
    expect(b.puerto.checkBookingGuests).not.toHaveBeenCalled();
    expect(b.puerto.prebookWithContext).not.toHaveBeenCalled();
  });
});

// ───────────────────────── Puertas antes de abrir la orden ─────────────────────────

describe('las puertas: todo rechazo ocurre ANTES de abrir la orden y de llamar al proveedor', () => {
  async function sinTocarNada(b: Banco, promesa: Promise<unknown>): Promise<unknown> {
    const err = await rechazo(promesa);
    expect(b.memory.rows()).toHaveLength(0);
    expect(b.puerto.prebookWithContext).not.toHaveBeenCalled();
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
    expect(b.emit).not.toHaveBeenCalled();
    return err;
  }

  it('un proveedor sin Book por contexto (Despegar) → 400: reserva con su flujo propio', async () => {
    const b = await banco();
    for (const metodo of ['bookWithContext', 'prebookWithContext'] as const) {
      const stub = new StubHotelProviderFactory({ code: 'otro-hotels' });
      const adapter = stub.adapterFor(AGENCIA);
      conBook(adapter);
      delete (adapter as unknown as Record<string, unknown>)[metodo];
      const service = new HotelBookingService(
        hotelRegistry([stub], hotelFlags(true)),
        b.snapshots,
        b.contexts,
        b.intents,
        b.pricing as unknown as PricingService,
        new CircuitBreakerService(),
        { emit: b.emit } as unknown as AuditService,
        b.branding as unknown as BrandingService,
        b.inflight,
        b.verification,
        b.fondos.service,
        b.hcn as unknown as HcnTrackingService,
        b.permisos as unknown as BookingPermissionsService,
        { syncWaitMs: 5_000 },
      );

      const err = await sinTocarNada(
        b,
        service.book(AGENCIA, USUARIO, CLAVE, pedido({ providerCode: 'otro-hotels' })),
      );
      expect(err).toBeInstanceOf(HotelProviderCapabilityError);
    }
  });

  it('la plataforma apagó el proveedor para la agencia → 400 con su motivo, sin abrir la orden', async () => {
    const b = await banco({ flags: hotelFlags(() => apagadoPara(AGENCIA)) });

    const err = await sinTocarNada(b, b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));
    expect(err).toBeInstanceOf(ProviderDisabledByPlatformError);
    expect((err as { getStatus?: () => number }).getStatus?.()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('un proveedor que no existe → el 400 del registry', async () => {
    const b = await banco();

    const err = await sinTocarNada(
      b,
      b.service.book(AGENCIA, USUARIO, CLAVE, pedido({ providerCode: 'nadie-hotels' })),
    );
    expect((err as { getStatus?: () => number }).getStatus?.()).toBe(HttpStatus.BAD_REQUEST);
  });

  it.each([
    ['otro `prebookRef`', AGENCIA, pedido({ prebookRef: '88888888-8888-4888-8888-888888888888' })],
    ['el `prebookRef` de otro tenant', OTRA_AGENCIA, pedido()],
  ])('%s → 409 como uno vencido, sin confirmar que existe', async (_c, tenant, input) => {
    const b = await banco();

    const err = await sinTocarNada(b, b.service.book(tenant, USUARIO, CLAVE, input));

    expect(err).toBeInstanceOf(HotelPrebookExpiredError);
    expect((err as HotelPrebookExpiredError).getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it('el snapshot de otro proveedor responde igual que uno vencido', async () => {
    const b = await banco({}, snapshot({ providerCode: 'otro-hotels' }));

    expect(await sinTocarNada(b, b.service.book(AGENCIA, USUARIO, CLAVE, pedido()))).toBeInstanceOf(
      HotelPrebookExpiredError,
    );
  });

  it('RF-08 CA-3: la cuenta rotó desde el PreBook → 409, volver a buscar', async () => {
    const b = await banco(
      {},
      snapshot({ account: { ...CUENTA, updatedAt: '2026-08-01T00:00:00.000Z' } }),
    );

    expect(await sinTocarNada(b, b.service.book(AGENCIA, USUARIO, CLAVE, pedido()))).toBeInstanceOf(
      HotelSearchAccountChangedError,
    );
  });

  it('RF-29: la cuenta cambió (rotada, desactivada o fuera de la red) entre la comparación y el intent → el mismo 409, sin orden ni Book', async () => {
    for (const cuentaEnBase of [{ updatedAt: '2026-09-02T00:00:00.000Z' }, { available: false }]) {
      const b = await banco({ cuentaEnBase });

      const err = await sinTocarNada(b, b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

      expect(err).toBeInstanceOf(HotelSearchAccountChangedError);
      expect(err).toMatchObject({ reason: 'SEARCH_ACCOUNT_CHANGED' });
      // La clave quedó libre: nada se comprometió.
      expect(b.memory.log.filter((q) => q.op === 'insert')).toHaveLength(1);
    }
  });

  it('RF-09: sin margen para revalidar, la ventana ya está vencida', async () => {
    const b = await banco();
    vi.setSystemTime(VENCE - 10_000);

    expect(await sinTocarNada(b, b.service.book(AGENCIA, USUARIO, CLAVE, pedido()))).toBeInstanceOf(
      HotelPrebookExpiredError,
    );
  });

  it('RF-17: la tarifa sólo paquete no se vende suelta → 409 con mensaje de negocio', async () => {
    const b = await banco({}, snapshot({ signals: ['PACKAGE_WITH_FLIGHT_ONLY'] }));

    const err = await sinTocarNada(b, b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toBeInstanceOf(HotelPackageOnlyRateError);
    expect((err as Error).message).toContain('paquete con aéreo');
  });

  it('RF-10 CA-2: con cargos en el hotel y sin `atPropertyAcknowledged` → 400 sin llamar al proveedor', async () => {
    const b = await banco();

    const err = await sinTocarNada(
      b,
      b.service.book(AGENCIA, USUARIO, CLAVE, pedido({ atPropertyAcknowledged: false })),
    );

    expect(err).toBeInstanceOf(HotelAtPropertyNotAcknowledgedError);
    expect((err as HotelAtPropertyNotAcknowledgedError).getStatus()).toBe(HttpStatus.BAD_REQUEST);
  });

  it('un precio aceptado distinto del mostrado → 409 con el precio vigente', async () => {
    const b = await banco();

    const err = await sinTocarNada(
      b,
      b.service.book(AGENCIA, USUARIO, CLAVE, pedido({ acceptedTotal: USD(PISO + 1) })),
    );

    expect(err).toBeInstanceOf(HotelAcceptedTotalMismatchError);
    expect((err as HotelAcceptedTotalMismatchError).publicDetails).toEqual({
      currentTotal: USD(PISO),
    });
  });

  it('RF-18 CA-4: dos huéspedes idénticos → 400 que pide distinguirlos, con la lista sin valores', async () => {
    const b = await banco();
    b.puerto.checkBookingGuests.mockReturnValue({
      ok: false,
      issues: ['rooms.0.guests.1:duplicate_guest'],
    });

    const err = await sinTocarNada(b, b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toBeInstanceOf(HotelGuestsInvalidError);
    expect((err as Error).message).toContain('distinguirlos');
    expect((err as HotelGuestsInvalidError).publicDetails).toEqual({
      issues: ['rooms.0.guests.1:duplicate_guest'],
    });
    // Se validan contra la ocupación de la BÚSQUEDA, no contra lo que diga el navegador.
    expect(b.puerto.checkBookingGuests).toHaveBeenCalledWith(HUESPEDES, OCUPACION);
  });

  it('D-TBO-23 A: sin contacto operativo de la agencia no se reserva, y el del huésped no lo reemplaza', async () => {
    const b = await banco({
      soporte: { email: 'reservas@agencia.example', phone: '601 555 0000' },
    });

    const err = await sinTocarNada(b, b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toBeInstanceOf(HotelAgencyContactMissingError);
    expect((err as HotelAgencyContactMissingError).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect(b.branding.resolveSupportContact).toHaveBeenCalledWith(AGENCIA);
  });
});

// ───────────────────────── Tarifas no reembolsables (pedido del 2026-09-29) ─────────────────────────

/** Reembolsable sin cargo hasta el 5 de noviembre, hora del hotel. */
const REEMBOLSABLE: HotelRoompack['cancellation'] = {
  refundable: true,
  status: 'fully_refundable',
  rules: [
    { type: 'Percentage', penaltyPercentage: 0, fromLocalDateTime: '2026-09-20T00:00:00' },
    { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-11-05T00:00:00' },
  ],
  policySource: 'prebook-final',
  freeCancellationUntilLocal: '2026-11-05T00:00:00',
};

/**
 * Reembolsable según el proveedor, pero con el 100 % desde el 25 de septiembre a las 23:00 del
 * hotel: con T0 = 25/09 15:00 UTC, en UTC+14 ya son las 05:00 del 26. Puede estar rigiendo.
 */
const CIEN_VIGENTE: HotelRoompack['cancellation'] = {
  refundable: true,
  status: 'partially_refundable',
  rules: [
    { type: 'Percentage', penaltyPercentage: 50, fromLocalDateTime: '2026-09-20T00:00:00' },
    { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-09-25T23:00:00' },
  ],
  policySource: 'prebook-final',
};

describe('no reembolsables (b, c y e): el servidor decide y exige la confirmación', () => {
  async function sinOrden(b: Banco, promesa: Promise<unknown>): Promise<unknown> {
    const err = await rechazo(promesa);
    expect(b.memory.rows()).toHaveLength(0);
    expect(b.puerto.prebookWithContext).not.toHaveBeenCalled();
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
    expect(b.emit).not.toHaveBeenCalled();
    return err;
  }

  it('sin `nonRefundableAcknowledged` → 400 con el 100 % en el precio de venta, sin orden ni proveedor', async () => {
    const b = await banco();

    const err = await sinOrden(
      b,
      b.service.book(AGENCIA, USUARIO, CLAVE, pedido({ nonRefundableAcknowledged: false })),
    );

    expect(err).toBeInstanceOf(HotelNonRefundableNotAcknowledgedError);
    const e = err as HotelNonRefundableNotAcknowledgedError;
    expect(e.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(e.reason).toBe('NON_REFUNDABLE_NOT_ACKNOWLEDGED');
    expect(e.publicDetails).toEqual({ penalty: USD(PISO), nonRefundableReason: 'declared' });
    expect(e.message).toContain('se cobra el 100 % (321,34 USD)');
  });

  it('IsRefundable=false con tramos a 0 (contradicción de TBO) → no reembolsable: pide la confirmación', async () => {
    const contradictoria: HotelRoompack['cancellation'] = {
      refundable: false,
      status: 'non_refundable',
      rules: [
        { type: 'Fixed', penaltyAmount: USD(0), fromLocalDateTime: '2026-09-20T00:00:00' },
        { type: 'Fixed', penaltyAmount: USD(0), fromLocalDateTime: '2026-10-20T00:00:00' },
      ],
      policySource: 'prebook-final',
    };
    const b = await banco({}, snapshot({}, { cancelacion: contradictoria }));

    const err = await sinOrden(
      b,
      b.service.book(AGENCIA, USUARIO, CLAVE, pedido({ nonRefundableAcknowledged: undefined })),
    );

    expect(err).toBeInstanceOf(HotelNonRefundableNotAcknowledgedError);
  });

  it('reembolsable con el 100 % ya vigente → se trata como no reembolsable, con desde cuándo rige', async () => {
    const b = await banco({}, snapshot({}, { cancelacion: CIEN_VIGENTE }));

    const err = await sinOrden(
      b,
      b.service.book(AGENCIA, USUARIO, CLAVE, pedido({ nonRefundableAcknowledged: false })),
    );

    expect((err as HotelNonRefundableNotAcknowledgedError).publicDetails).toEqual({
      penalty: USD(PISO),
      nonRefundableReason: 'full-penalty-in-force',
      fullPenaltySinceLocal: '2026-09-25T23:00:00',
    });
  });

  it('bloqueadas por quien financia (e) → 403 aunque venga confirmada, sin orden ni proveedor', async () => {
    const b = await banco({ noReembolsablesBloqueadas: true });

    const err = await sinOrden(b, b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toBeInstanceOf(HotelNonRefundableBlockedError);
    expect((err as HotelNonRefundableBlockedError).getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect((err as HotelNonRefundableBlockedError).reason).toBe('NON_REFUNDABLE_BLOCKED');
    expect(b.permisos.nonRefundableRates).toHaveBeenCalledWith(AGENCIA);
  });

  it('una reembolsable no pide la confirmación ni lee el permiso, aunque esté bloqueado', async () => {
    const b = await banco(
      { noReembolsablesBloqueadas: true },
      snapshot({}, { cancelacion: REEMBOLSABLE }),
    );
    b.puerto.prebookWithContext.mockResolvedValue(revalidada({ cancelacion: REEMBOLSABLE }));

    const res = await b.service.book(
      AGENCIA,
      USUARIO,
      CLAVE,
      pedido({ nonRefundableAcknowledged: undefined }),
    );

    expect(res.body.status).toBe('confirmed');
    expect(b.permisos.nonRefundableRates).not.toHaveBeenCalled();
    expect(json(fila(b)['selected_offer'])).not.toHaveProperty('nonRefundable');
    expect(tipos(b)).not.toContain(HOTEL_EVENTS.nonRefundableAcknowledged);
  });

  it('la orden guarda quién aceptó, cuándo, el monto y la política; el evento lo audita sin PII', async () => {
    const b = await banco();
    b.puerto.bookWithContext.mockImplementation(() => {
      // Antes del Book: la confirmación ya está en la orden y en su rastro.
      expect(json(fila(b)['selected_offer'])).toHaveProperty('nonRefundable');
      expect(tipos(b)).toContain(HOTEL_EVENTS.nonRefundableAcknowledged);
      return Promise.resolve(confirmada());
    });

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    const oferta = json(fila(b)['selected_offer']) as Record<string, unknown>;
    expect(oferta['nonRefundable']).toEqual({
      reason: 'declared',
      penalty: USD(PISO),
      policy: {
        refundable: false,
        status: 'non_refundable',
        policySource: 'prebook-final',
        rules: [
          { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-11-01T00:00:00' },
        ],
      },
      acknowledgedBy: USUARIO,
      acknowledgedAt: new Date(T0).toISOString(),
      acknowledgedAmount: USD(PISO),
    });
    const ack = eventos(b).find((e) => e.eventType === HOTEL_EVENTS.nonRefundableAcknowledged);
    expect(ack?.aggregateId).toBe(fila(b)['id']);
    expect(b.emit.mock.calls.find(([e]) => e === ack)?.[0]).toMatchObject({
      actorUserId: USUARIO,
      aggregateType: 'order',
    });
    expect(ack?.payload).toEqual({
      vertical: 'hotels',
      provider: STUB,
      hotelId: 'S-1',
      bookingReference: REF,
      reason: 'declared',
      penaltyMinor: PISO,
      currency: 'USD',
      acknowledgedAt: new Date(T0).toISOString(),
      acknowledgedAmountMinor: PISO,
      rateConditionsHash: 'b'.repeat(64),
      policy: {
        refundableDeclared: false,
        status: 'non_refundable',
        policySource: 'prebook-final',
        rules: [{ fromLocal: '2026-11-01T00:00:00', percentage: 100 }],
      },
    });
    for (const dato of PII) expect(JSON.stringify(ack)).not.toContain(dato);
  });

  it('confirmada una reembolsable con el 100 % ya vigente: la orden y el evento dicen desde cuándo y la política entera', async () => {
    // Sin cargo hasta el 25/09 a las 23:00 del hotel, que en UTC+14 ya pasó; un tramo por
    // habitación con importe, y uno sin fecha local. Sin origen declarado de la política.
    const vencida: HotelRoompack['cancellation'] = {
      refundable: true,
      status: 'fully_refundable',
      rules: [
        {
          type: 'Fixed',
          penaltyAmount: USD(0),
          fromLocalDateTime: '2026-09-20T00:00:00',
          roomIndex: 1,
        },
        { type: 'Percentage', penaltyPercentage: 100, fromLocalDateTime: '2026-09-25T23:00:00' },
        { type: 'Percentage', penaltyPercentage: 100, fromHours: 24 },
      ],
      freeCancellationUntilLocal: '2026-09-25T23:00:00',
    };
    const b = await banco({}, snapshot({}, { cancelacion: vencida }));
    b.puerto.prebookWithContext.mockResolvedValue(revalidada({ cancelacion: vencida }));

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    const oferta = json(fila(b)['selected_offer']) as Record<string, unknown>;
    expect(oferta['nonRefundable']).toMatchObject({
      reason: 'full-penalty-in-force',
      fullPenaltySinceLocal: '2026-09-25T23:00:00',
      policy: {
        refundable: true,
        status: 'fully_refundable',
        policySource: 'undeclared',
        freeCancellationUntilLocal: '2026-09-25T23:00:00',
        rules: vencida.rules,
      },
    });
    expect(evento(b, HOTEL_EVENTS.nonRefundableAcknowledged)).toMatchObject({
      reason: 'full-penalty-in-force',
      fullPenaltySinceLocal: '2026-09-25T23:00:00',
      policy: {
        refundableDeclared: true,
        status: 'fully_refundable',
        policySource: 'undeclared',
        rules: [
          { fromLocal: '2026-09-20T00:00:00', amountMinor: 0, currency: 'USD', room: 1 },
          { fromLocal: '2026-09-25T23:00:00', percentage: 100 },
          { percentage: 100 },
        ],
      },
    });
    expect(evento(b, ORDER_EVENTS.createRequested)['nonRefundable']).toBe('full-penalty-in-force');
  });

  it('si en C2 pasa a cobrar el 100 % y no se confirmó → 400, orden cerrada sin envío y sin Book', async () => {
    const b = await banco({}, snapshot({}, { cancelacion: REEMBOLSABLE }));
    b.puerto.prebookWithContext.mockResolvedValue(revalidada({ cancelacion: CIEN_VIGENTE }));

    const err = await rechazo(
      b.service.book(AGENCIA, USUARIO, CLAVE, pedido({ nonRefundableAcknowledged: undefined })),
    );

    expect(err).toBeInstanceOf(HotelNonRefundableNotAcknowledgedError);
    expect(fila(b)).toMatchObject({
      status: 'failed',
      create_request_key: null,
      error_message: CREATE_NOT_SENT_MARKER,
    });
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
    expect(b.fondos.holdBookingIntent).not.toHaveBeenCalled();
  });

  it('si en C2 pasa a no reembolsable y la agencia las tiene bloqueadas → 403 sin Book', async () => {
    const b = await banco(
      { noReembolsablesBloqueadas: true },
      snapshot({}, { cancelacion: REEMBOLSABLE }),
    );
    b.puerto.prebookWithContext.mockResolvedValue(revalidada());

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toBeInstanceOf(HotelNonRefundableBlockedError);
    expect(fila(b)).toMatchObject({ status: 'failed', create_request_key: null });
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
  });

  it('un fallo al leer el permiso no deja reservar: sube sin abrir la orden', async () => {
    const b = await banco();
    b.permisos.nonRefundableRates.mockRejectedValueOnce(new Error('base caída'));

    const err = await sinOrden(b, b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect((err as Error).message).toBe('base caída');
  });
});

// ───────────────────────── Revalidación (C2) ─────────────────────────

describe('RF-20 y D-TBO-20 A: la revalidación de C2 antes del Book', () => {
  it('si sube el precio de venta → 409 con los valores nuevos, orden cerrada sin envío y clave libre', async () => {
    const b = await banco({ reglas: [] });
    b.puerto.prebookWithContext.mockResolvedValue(
      revalidada({
        netoMinor: 33_000,
        pisoMinor: 34_000,
        comparacion: { outcome: 'INCREASED', price: 'UP' },
      }),
    );

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toBeInstanceOf(HotelBookRepricedError);
    const details = (err as HotelBookRepricedError).publicDetails;
    expect((err as HotelBookRepricedError).reason).toBe('PRICE_INCREASED');
    expect(details).toMatchObject({
      outcome: 'INCREASED',
      price: 'UP',
      changes: [],
      acceptedTotal: USD(PISO),
      currentTotal: USD(34_000),
    });
    // La tarifa revalidada queda aceptable con otra referencia: se confirma sin otro PreBook.
    const nueva = await b.snapshots.get(AGENCIA, details.prebookRef ?? '');
    expect(nueva).toMatchObject({ offerRef: TARIFA_C2, totalText: '305.750' });
    expect(nueva?.comparison.stage).toBe('C2');
    expect(fila(b)).toMatchObject({
      status: 'failed',
      create_request_key: null,
      error_message: CREATE_NOT_SENT_MARKER,
    });
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
    expect(tipos(b)).toEqual([HOTEL_EVENTS.offerRepriced]);
    expect(evento(b, HOTEL_EVENTS.offerRepriced)).toEqual({
      vertical: 'hotels',
      provider: STUB,
      hotelId: 'S-1',
      stage: 'C2',
      outcome: 'INCREASED',
      price: 'UP',
      changes: [],
      previousTotal: USD(NETO),
      currentTotal: USD(33_000),
    });

    // La clave quedó libre: el vendedor puede aceptar el precio nuevo con la misma, y el intento
    // nuevo lleva otra referencia (RF-19 CA-2).
    b.puerto.newBookingReference.mockReturnValueOnce('STT0H3J5N7P9R1T3V5X7');
    await b.service.book(
      AGENCIA,
      USUARIO,
      CLAVE,
      pedido({ prebookRef: details.prebookRef ?? '', acceptedTotal: USD(34_000) }),
    );
    expect(b.puerto.bookWithContext).toHaveBeenCalledTimes(1);
  });

  it('si cambian las condiciones → 409 CONDITIONS_CHANGED', async () => {
    const b = await banco();
    b.puerto.prebookWithContext.mockResolvedValue(
      revalidada({ comparacion: { outcome: 'CONDITIONS_CHANGED', changes: ['CANCEL_POLICIES'] } }),
    );

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect((err as HotelBookRepricedError).reason).toBe('CONDITIONS_CHANGED');
    expect((err as HotelBookRepricedError).publicDetails.changes).toEqual(['CANCEL_POLICIES']);
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
  });

  it('RF-17: si la marca de sólo paquete aparece en C2 → 409 PACKAGE_ONLY_RATE', async () => {
    const b = await banco();
    b.puerto.prebookWithContext.mockResolvedValue(
      revalidada({ signals: ['PACKAGE_WITH_FLIGHT_ONLY'] }),
    );

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect((err as HotelBookRepricedError).reason).toBe('PACKAGE_ONLY_RATE');
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
  });

  it('si el snapshot nuevo no se puede guardar, el 409 sale igual, sin referencia', async () => {
    const b = await banco();
    b.puerto.prebookWithContext.mockResolvedValue(
      revalidada({ comparacion: { outcome: 'CONDITIONS_CHANGED', changes: ['MEAL_TYPE'] } }),
    );
    vi.spyOn(b.snapshots, 'save').mockRejectedValueOnce(new Error('caché llena'));

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect((err as HotelBookRepricedError).publicDetails).not.toHaveProperty('prebookRef');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('revalidated_snapshot_unsaved'));
  });

  it('D-TBO-20 A: si baja, se reserva con el precio nuevo y se avisa', async () => {
    const b = await banco();
    b.puerto.prebookWithContext.mockResolvedValue(
      revalidada({
        netoMinor: 30_010,
        pisoMinor: 31_500,
        totalText: '300.10',
        comparacion: { outcome: 'DECREASED', price: 'DOWN' },
      }),
    );

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body).toMatchObject({
      status: 'confirmed',
      total: USD(31_500),
      warnings: ['PRICE_DECREASED'],
    });
    expect(fila(b)['total_amount']).toBe(31_500);
    expect(b.puerto.bookWithContext.mock.calls[0]?.[0].totalText).toBe('300.10');
    expect(tipos(b)[0]).toBe(HOTEL_EVENTS.offerRepriced);
  });

  it('un error del PreBook de C2 cierra la orden sin envío, marca lo que invalida y sale tal cual', async () => {
    const b = await banco();
    const vencida = new RechazoError(
      { outcome: 'FAILED', reason: 'session-expired', dispatched: true },
      'search',
    );
    b.puerto.prebookWithContext.mockRejectedValue(vencida);

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toBe(vencida);
    expect(fila(b)).toMatchObject({ status: 'failed', create_request_key: null });
    // RF-09 CA-2: la búsqueda entera se olvida.
    await expect(b.contexts.get(AGENCIA, SEARCH_ID)).resolves.toBeUndefined();
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
  });

  it('las reglas de precio que no se pueden leer también cierran la orden sin envío', async () => {
    const b = await banco();
    b.pricing.getApplicableRules.mockRejectedValue(new Error('base caída'));

    await expect(b.service.book(AGENCIA, USUARIO, CLAVE, pedido())).rejects.toThrow('base caída');
    expect(fila(b)).toMatchObject({ status: 'failed', create_request_key: null });
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
  });

  it('si otro camino cerró la orden durante C2, no se reserva: 409 con la orden y sin reintento', async () => {
    const b = await banco();
    b.puerto.prebookWithContext.mockImplementation(() => {
      Object.assign(fila(b), { status: 'failed', provider_raw: '{"phase":"operator"}' });
      return Promise.resolve(revalidada());
    });

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toBeInstanceOf(HotelBookIntentClosedError);
    expect((err as HotelBookIntentClosedError).getResponse()).toMatchObject({
      orderId: fila(b)['id'],
      retryForbidden: true,
      reconciliationRequired: true,
    });
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
    expect(tipos(b)).not.toContain(ORDER_EVENTS.createRequested);
  });
});

// ───────────────────────── El breaker (RF-20 CA-4) ─────────────────────────

describe('RF-20 CA-4: el rechazo del breaker después del insert es un fallo previo al envío', () => {
  it('en C2: orden cerrada sin envío, clave libre, 503 y ni PreBook ni Book', async () => {
    const b = await banco();
    vi.stubEnv('PROVIDERS_DISABLED', `${STUB}:ventas`);

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toBeInstanceOf(BreakerRejectionError);
    expect(fila(b)).toMatchObject({
      status: 'failed',
      create_request_key: null,
      error_message: CREATE_NOT_SENT_MARKER,
    });
    expect(b.puerto.prebookWithContext).not.toHaveBeenCalled();
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
  });

  it('en el Book: `failed` sin envío, clave libre, `OrderCreateFailed` con `dispatched: false`', async () => {
    const b = await banco();
    b.puerto.prebookWithContext.mockImplementation(() => {
      // Operaciones apaga las ventas del proveedor mientras la revalidación estaba en vuelo.
      vi.stubEnv('PROVIDERS_DISABLED', `${STUB}:ventas`);
      return Promise.resolve(revalidada());
    });

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      httpStatus: 201,
      body: {
        status: 'failed',
        providerBookingId: null,
        reason: 'not-dispatched',
        message: `[${STUB}] El proveedor ${STUB} está temporalmente deshabilitado.`,
      },
    });
    expect(fila(b)).toMatchObject({
      status: 'failed',
      create_request_key: null,
      error_message: CREATE_NOT_SENT_MARKER,
    });
    expect(evento(b, ORDER_EVENTS.createFailed)).toEqual({
      provider: STUB,
      vertical: 'hotels',
      bookingReference: REF,
      reason: 'not-dispatched',
      errorName: 'BreakerRejectionError',
      uncertain: false,
      dispatched: false,
    });
    expect(tipos(b)).not.toContain(ORDER_EVENTS.created);
  });

  it('si la orden no se pudo cerrar, la respuesta no dice `failed`: pending, escalada y sin reintento', async () => {
    const b = await banco();
    b.puerto.prebookWithContext.mockImplementation(() => {
      vi.stubEnv('PROVIDERS_DISABLED', `${STUB}:ventas`);
      return Promise.resolve(revalidada());
    });
    // La base no respondió al cerrar: la fila conserva la clave (el lado seguro).
    vi.spyOn(b.intents, 'failExternalCreateIntent').mockResolvedValue(false);

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      httpStatus: 202,
      body: {
        status: 'pending',
        providerBookingId: null,
        reason: 'not-dispatched',
        retryForbidden: true,
        reconciliationRequired: true,
      },
    });
    expect(res.body.message).toContain('no llegó a enviarse');
    expect(fila(b)).toMatchObject({ status: 'pending', create_request_key: `c:${CLAVE}` });
    expect(evento(b, ORDER_EVENTS.escalated)).toMatchObject({
      reason: 'result-persistence-unavailable',
      outcome: 'NOT_DISPATCHED',
      dispatched: false,
      queued: false,
    });
    // Y la misma clave sigue reconociendo el envío en vez de abrir otra orden.
    await expect(b.service.book(AGENCIA, USUARIO, CLAVE, pedido())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(b.memory.rows()).toHaveLength(1);
  });

  it('un rechazo local del proveedor antes del cable (ventana vencida) también es no enviado, y olvida la búsqueda', async () => {
    const b = await banco();
    b.puerto.bookWithContext.mockRejectedValue(
      new RechazoError(
        { outcome: 'FAILED', reason: 'not-dispatched', dispatched: false },
        'search',
      ),
    );

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body).toMatchObject({ status: 'failed', reason: 'not-dispatched' });
    expect(fila(b)).toMatchObject({ status: 'failed', create_request_key: null });
    await expect(b.contexts.get(AGENCIA, SEARCH_ID)).resolves.toBeUndefined();
  });
});

// ───────────────────────── Desenlaces del Book ─────────────────────────

describe('RF-20 CA-2: un rechazo definitivo del proveedor → failed, clave libre, `OrderCreated` FAILED', () => {
  it('207: la tarifa se marca no disponible y la clave queda libre para otro intento', async () => {
    const b = await banco();
    b.puerto.bookWithContext.mockRejectedValueOnce(
      new RechazoError(
        { outcome: 'FAILED', reason: 'rate-unavailable', dispatched: true, providerStatus: '207' },
        'offer',
      ),
    );

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res).toEqual({
      httpStatus: 201,
      body: {
        orderId: fila(b)['id'],
        orderNumber: 1,
        status: 'failed',
        providerCode: STUB,
        providerBookingId: null,
        bookingReference: REF,
        total: USD(PISO),
        reason: 'rate-unavailable',
        message: `[${STUB}] rechazo rate-unavailable`,
        warnings: [],
      },
    });
    expect(fila(b)).toMatchObject({
      status: 'failed',
      create_request_key: null,
      error_message: `[${STUB}] rechazo rate-unavailable`,
    });
    expect(json(fila(b)['provider_raw'])).toEqual({
      vertical: 'hotels',
      bookingReference: REF,
      reason: 'rate-unavailable',
      providerStatus: '207',
      phase: 'create',
      outcome: 'FAILED',
    });
    expect(evento(b, ORDER_EVENTS.created)).toEqual({
      provider: STUB,
      vertical: 'hotels',
      bookingReference: REF,
      outcome: 'FAILED',
      reason: 'rate-unavailable',
      providerStatus: '207',
    });
    expect(b.adapter.getBooking).not.toHaveBeenCalled();
    expect(b.hcn.schedule).not.toHaveBeenCalled();
    await expect(
      b.contexts.resolveOffer(
        AGENCIA,
        { providerCode: STUB, searchId: SEARCH_ID, offerRef: TARIFA },
        CUENTA,
      ),
    ).rejects.toBeInstanceOf(HotelOfferUnavailableError);

    // Clave libre: la misma clave abre OTRA orden con otra referencia.
    b.puerto.newBookingReference.mockReturnValueOnce('STT0H3J5N7P9R1T3V5X7');
    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());
    expect(b.memory.rows()).toHaveLength(2);
    expect(b.memory.rows()[1]).toMatchObject({ provider_booking_ref: 'STT0H3J5N7P9R1T3V5X7' });
  });

  it('un rechazo sin código del proveedor no inventa uno', async () => {
    const b = await banco();
    b.puerto.bookWithContext.mockRejectedValue(
      new RechazoError({ outcome: 'FAILED', reason: 'invalid-request', dispatched: true }),
    );

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(json(fila(b)['provider_raw'])).not.toHaveProperty('providerStatus');
    expect(evento(b, ORDER_EVENTS.created)).not.toHaveProperty('providerStatus');
  });

  it('un proveedor que responde FAILED sin lanzar también cierra la orden', async () => {
    const b = await banco();
    b.puerto.bookWithContext.mockResolvedValue({
      result: { outcome: 'FAILED', providerStatus: '207', warnings: [] },
      reason: 'rate-unavailable',
    });

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body).toMatchObject({ status: 'failed', reason: 'rate-unavailable' });
    expect(fila(b)).toMatchObject({ status: 'failed', create_request_key: null });
  });
});

describe('RF-20 CA-3: un desenlace incierto deja la orden `pending` y a verificar, nunca reintenta', () => {
  it('timeout: pending con la clave tomada, `OrderCreateFailed` incierto y la lectura encolada a los 120 s', async () => {
    const b = await banco();
    const tf = T0 + 90_000;
    b.puerto.bookWithContext.mockImplementation(() => {
      vi.setSystemTime(tf);
      return Promise.reject(
        new RechazoError({ outcome: 'UNCERTAIN', reason: 'timeout', dispatched: true }),
      );
    });

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res).toEqual({
      httpStatus: 202,
      body: {
        orderId: fila(b)['id'],
        orderNumber: 1,
        status: 'pending',
        providerCode: STUB,
        providerBookingId: null,
        bookingReference: REF,
        total: USD(PISO),
        reason: 'timeout',
        message: `[${STUB}] rechazo timeout`,
        warnings: [],
        retryForbidden: true,
        reconciliationRequired: true,
      },
    });
    expect(fila(b)).toMatchObject({
      status: 'pending',
      provider_raw: null,
      create_request_key: `c:${CLAVE}`,
      provider_booking_ref: REF,
      error_message: CREATE_PENDING_RECONCILIATION_MARKER,
    });
    expect(evento(b, ORDER_EVENTS.createFailed)).toEqual({
      provider: STUB,
      vertical: 'hotels',
      bookingReference: REF,
      reason: 'timeout',
      errorName: 'RechazoError',
      uncertain: true,
      dispatched: true,
    });
    // Sin reserva confirmada no hay HCN: lo abre la verificación si la encuentra.
    expect(b.hcn.schedule).not.toHaveBeenCalled();
    expect(evento(b, ORDER_EVENTS.escalated)).toEqual({
      provider: STUB,
      vertical: 'hotels',
      bookingReference: REF,
      reason: 'create-uncertain',
      verifyAfter: new Date(tf + 120_000).toISOString(),
      queued: true,
      retryForbidden: true,
      reconciliationRequired: true,
    });
    // RF-21 CA-1: el primer paso sale a `tf + 120 s` contados desde el fallo, no desde el envío.
    const orderId = String(fila(b)['id']);
    expect(b.queue.jobs).toEqual([
      {
        name: 'verify-hotel-booking',
        data: { tenantId: AGENCIA, orderId, step: 0, actorUserId: USUARIO },
        jobId: `verify-hotel-booking:${orderId}:0`,
        delayMs: 120_000,
      },
    ]);
    expect(b.tracking.tracking.get(orderId)).toMatchObject({
      anchorAt: tf,
      step: 0,
      nextAt: tf + 120_000,
      subStatus: 'create-uncertain',
    });
    // Ni lectura de cierre ni un segundo Book.
    expect(b.adapter.getBooking).not.toHaveBeenCalled();
    expect(b.puerto.bookWithContext).toHaveBeenCalledTimes(1);
    // Y la tarifa no se invalida: la reserva puede existir.
    await expect(b.contexts.get(AGENCIA, SEARCH_ID)).resolves.toBeDefined();
  });

  it('sin Redis: el calendario queda escrito y `OrderEscalated` dice `queued: false` (RF-21 CA-3)', async () => {
    const b = await banco({ redis: false });
    b.puerto.bookWithContext.mockRejectedValue(
      new RechazoError({ outcome: 'UNCERTAIN', reason: 'timeout', dispatched: true }),
    );

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(evento(b, ORDER_EVENTS.escalated)).toMatchObject({
      reason: 'create-uncertain',
      queued: false,
    });
    expect(b.tracking.tracking.get(String(fila(b)['id']))).toMatchObject({ step: 0 });
  });

  it('si el calendario no se puede escribir no se encola nada: lo adopta el barrido', async () => {
    const b = await banco();
    b.tracking.fallas.startCalendar = new Error('hotel_order_tracking no disponible');
    b.puerto.bookWithContext.mockRejectedValue(
      new RechazoError({ outcome: 'UNCERTAIN', reason: 'timeout', dispatched: true }),
    );

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body.status).toBe('pending');
    expect(b.queue.jobs).toEqual([]);
    expect(evento(b, ORDER_EVENTS.escalated)).toMatchObject({ queued: false });
  });

  it('405 con código: incierto con su código', async () => {
    const b = await banco();
    b.puerto.bookWithContext.mockRejectedValue(
      new RechazoError({
        outcome: 'UNCERTAIN',
        reason: 'booking-failed',
        dispatched: true,
        providerStatus: '405',
      }),
    );

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(evento(b, ORDER_EVENTS.createFailed)).toMatchObject({
      reason: 'booking-failed',
      providerStatus: '405',
      uncertain: true,
    });
    expect(fila(b)['status']).toBe('pending');
  });

  it('un `200` sin localizador: incierto con el mensaje de verificación, sin nombre de error', async () => {
    const b = await banco();
    b.puerto.bookWithContext.mockResolvedValue({
      result: { outcome: 'UNCERTAIN', providerStatus: '200', warnings: [] },
      reason: 'missing-confirmation-number',
    });

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.httpStatus).toBe(202);
    expect(res.body.message).toContain('Estamos verificando');
    expect(evento(b, ORDER_EVENTS.createFailed)).not.toHaveProperty('errorName');
    expect(evento(b, ORDER_EVENTS.createFailed)).toMatchObject({ providerStatus: '200' });
  });

  it.each([
    ['un texto', 'boom'],
    ['null', null],
  ])('lanzar %s tampoco es un FAILED: incierto', async (_caso, lanzado) => {
    const b = await banco();
    b.puerto.bookWithContext.mockRejectedValue(lanzado);

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body.status).toBe('pending');
    expect(evento(b, ORDER_EVENTS.createFailed)).toMatchObject({
      reason: 'unexpected-error',
      errorName: 'UnknownError',
    });
  });
});

describe('la lectura de cierre por el localizador (03 §5.1)', () => {
  it('si falla, la reserva sigue confirmada y se escala', async () => {
    const b = await banco();
    b.adapter.getBooking.mockRejectedValue(new Error('lectura caída'));

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res).toMatchObject({
      httpStatus: 201,
      body: { status: 'confirmed', providerBookingId: CONF, reason: 'verification-unavailable' },
    });
    expect(res.body).not.toHaveProperty('retryForbidden');
    expect(evento(b, ORDER_EVENTS.verified)).toMatchObject({
      verified: false,
      reason: 'read-failed',
    });
    expect(evento(b, ORDER_EVENTS.escalated)).toMatchObject({
      reason: 'verification-unavailable',
      outcome: 'CONFIRMED',
      queued: false,
    });
    expect(fila(b)['status']).toBe('confirmed');
    // Sigue confirmada: el plan del HCN lee igual por el localizador (04 §6.3 fila 3).
    expect(b.hcn.schedule.mock.calls).toEqual([[{ tenantId: AGENCIA, orderId: fila(b)['id'] }]]);
  });

  it('un proveedor que no sabe leer reservas no se llama: se escala igual', async () => {
    const b = await banco({ retrieve: false });

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(b.adapter.getBooking).not.toHaveBeenCalled();
    expect(res.body.reason).toBe('verification-unavailable');
  });

  it.each([
    [{ found: false, warnings: [] }, 'verified-not-found'],
    [{ found: true, status: 'CANCELLED', warnings: [] }, 'verified-cancelled-upstream'],
    [{ found: true, status: 'UNKNOWN', warnings: [] }, 'verified-status-unexpected'],
  ] as [HotelBookingView, string][])(
    'una contradicción del proveedor devuelve la orden a pending y se escala (%#)',
    async (vista, reason) => {
      const b = await banco();
      b.adapter.getBooking.mockResolvedValue(vista);

      const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

      expect(res).toMatchObject({
        httpStatus: 202,
        body: {
          status: 'pending',
          providerBookingId: CONF,
          reason,
          retryForbidden: true,
          reconciliationRequired: true,
        },
      });
      expect(fila(b)).toMatchObject({
        status: 'pending',
        provider_order_id: CONF,
        error_message: CREATE_PENDING_RECONCILIATION_MARKER,
      });
      expect(evento(b, ORDER_EVENTS.escalated)).toMatchObject({ reason, queued: false });
      // Vuelta a pending: no hay HCN que seguir mientras una persona la mira.
      expect(b.hcn.schedule).not.toHaveBeenCalled();
    },
  );

  it('si la vuelta a pending no se puede escribir, la respuesta dice pending igual', async () => {
    const b = await banco();
    b.adapter.getBooking.mockResolvedValue({ found: false, warnings: [] });
    vi.spyOn(b.intents, 'markExternalCreatePending').mockResolvedValue(undefined);

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body.status).toBe('pending');
  });
});

describe('la consolidación con CAS: nunca pisa otro camino, nunca repite el Book', () => {
  it('confirmado pero la fila ya la cerró otro camino → pending, escalado y sin lectura', async () => {
    const b = await banco();
    b.puerto.bookWithContext.mockImplementation(() => {
      Object.assign(fila(b), { status: 'cancelled', provider_raw: '{"phase":"operator"}' });
      return Promise.resolve(confirmada());
    });

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res).toMatchObject({
      httpStatus: 202,
      body: {
        status: 'pending',
        providerBookingId: CONF,
        reason: 'result-persistence-unavailable',
        retryForbidden: true,
      },
    });
    expect(evento(b, ORDER_EVENTS.escalated)).toMatchObject({
      reason: 'result-persistence-unavailable',
      outcome: 'CONFIRMED',
      providerBookingId: CONF,
    });
    expect(b.adapter.getBooking).not.toHaveBeenCalled();
    expect(b.puerto.bookWithContext).toHaveBeenCalledTimes(1);
  });

  it('fallido pero la fila ya la cerró otro camino → pending y escalado', async () => {
    const b = await banco();
    b.puerto.bookWithContext.mockImplementation(() => {
      Object.assign(fila(b), { status: 'failed', provider_raw: '{"phase":"operator"}' });
      return Promise.reject(
        new RechazoError({ outcome: 'FAILED', reason: 'rate-unavailable', dispatched: true }),
      );
    });

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body).toMatchObject({ status: 'pending', reason: 'result-persistence-unavailable' });
    expect(evento(b, ORDER_EVENTS.escalated)).toMatchObject({ outcome: 'FAILED' });
  });

  it('si la base cae después del Book, la saga no rechaza: pending, escalado y sin reintento', async () => {
    const b = await banco();
    vi.spyOn(b.intents, 'settleExternalCreateIntent').mockRejectedValue(new Error('base caída'));

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res).toMatchObject({
      httpStatus: 202,
      body: { status: 'pending', reason: 'result-persistence-unavailable', retryForbidden: true },
    });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('hotels.book.saga_failed'));
    for (const [linea] of error.mock.calls) {
      for (const dato of PII) expect(String(linea)).not.toContain(dato);
    }
    expect(b.puerto.bookWithContext).toHaveBeenCalledTimes(1);
  });

  it('ni con el canal de auditoría caído la saga rechaza después del Book', async () => {
    // Los eventos previos al Book (la confirmación de no reembolsable y el pedido) entran.
    const emit = vi.fn((e: { eventType: string }) =>
      e.eventType === ORDER_EVENTS.createRequested ||
      e.eventType === HOTEL_EVENTS.nonRefundableAcknowledged
        ? Promise.resolve()
        : Promise.reject(new Error('auditoría caída')),
    );
    const b = await banco({ emit });

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body).toMatchObject({ status: 'pending', reason: 'result-persistence-unavailable' });
    expect(b.puerto.bookWithContext).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────── Cobro `Limit`: retención en la cartera (RF-23) ─────────────────────────

const SUBAGENCIA_HEREDADA = {
  credentialSource: 'inherited',
  ownerTenantId: CONSOLIDADOR,
} as const satisfies OpcionesBanco;

/** Lo que el aviso de cartera recibe antes de C2: la venta mostrada, el neto y la cuenta. */
function cotizacion(ventaMinor: number, netoMinor = NETO): BookingHoldQuote {
  return {
    amount: USD(ventaMinor),
    netMinor: netoMinor,
    vertical: 'hotels',
    providerCode: STUB,
    providerAccountId: CUENTA.accountId,
  };
}

function rechazoDeCuenta(issue: HotelProviderAccountIssue, code: string): RechazoError {
  return new RechazoError(
    { outcome: 'FAILED', reason: issue, dispatched: true, providerStatus: code },
    undefined,
    issue,
  );
}

describe('RF-23 CA-1 (D-TBO-21 A): sin cartera, saldo ni cupo no se reserva, y el proveedor no se entera', () => {
  it('la sub-agencia con la cuenta heredada, sin saldo ni cupo: 409, orden cerrada sin envío, ni PreBook ni Book', async () => {
    const b = await banco({
      ...SUBAGENCIA_HEREDADA,
      cartera: { saldoMinor: 0, cupoMinor: PISO - 1 },
    });

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toBeInstanceOf(BookingHoldRejectedError);
    expect(err).toMatchObject({ reason: 'PORTFOLIO_FUNDS_INSUFFICIENT' });
    expect((err as BookingHoldRejectedError).getStatus()).toBe(HttpStatus.CONFLICT);
    expect(b.fondos.assertBookingHoldAffordable).toHaveBeenCalledWith(AGENCIA, cotizacion(PISO), {
      reportOrderId: fila(b)['id'],
    });
    // La clave queda libre: con saldo cargado, el mismo formulario se puede reenviar.
    expect(fila(b)).toMatchObject({
      status: 'failed',
      create_request_key: null,
      error_message: CREATE_NOT_SENT_MARKER,
    });
    expect(b.puerto.prebookWithContext).not.toHaveBeenCalled();
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
    expect(b.fondos.holdBookingIntent).not.toHaveBeenCalled();
    expect(b.emit).not.toHaveBeenCalled();
  });

  it('D-TBO-15: una tarifa en USD sin cartera en USD no usa la de COP: 409 antes de revalidar, sin PreBook ni Book', async () => {
    // La búsqueda en USD deja reservar sólo si la agencia tiene cartera en USD: la retención no
    // convierte, y con saldo de sobra en COP igual se rechaza, diciendo a quién pedírsela.
    const b = await banco({ cartera: { saldoMinor: 10_000_000_000, moneda: 'COP' } });

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toBeInstanceOf(BookingHoldRejectedError);
    expect(err).toMatchObject({ reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED' });
    expect((err as BookingHoldRejectedError).message).toBe(
      'La agencia no tiene cartera en USD: pedile a quien te financia que la habilite.',
    );
    expect(b.fondos.assertBookingHoldAffordable).toHaveBeenCalledWith(AGENCIA, cotizacion(PISO), {
      reportOrderId: fila(b)['id'],
    });
    expect(fila(b)).toMatchObject({ status: 'failed', create_request_key: null });
    expect(b.puerto.prebookWithContext).not.toHaveBeenCalled();
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
    expect(b.fondos.holdBookingIntent).not.toHaveBeenCalled();
    expect(b.fondos.estado.saldoMinor).toBe(10_000_000_000);
  });

  it('RF-20 CA-1 intacto: un reintento con la misma clave es 409 de duplicado aunque la primera retención gastara el saldo', async () => {
    const b = await banco({ options: { syncWaitMs: 5 }, cartera: { saldoMinor: PISO } });
    const lento = diferido<HotelBookWithContext>();
    b.puerto.bookWithContext.mockReturnValue(lento.promise);

    const primera = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());
    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(primera.httpStatus).toBe(202);
    expect(b.fondos.estado.saldoMinor).toBe(0);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err).not.toBeInstanceOf(BookingHoldRejectedError);
    expect((err as ConflictException).getResponse()).toMatchObject({ duplicateRequest: true });
    expect(b.puerto.prebookWithContext).toHaveBeenCalledTimes(1);
    lento.resolve(confirmada());
    await b.inflight.whenIdle();
  });

  it('con el cupo que le fija quien la financia, la misma sub-agencia reserva con la cuenta heredada', async () => {
    const b = await banco({
      ...SUBAGENCIA_HEREDADA,
      cartera: { saldoMinor: 0, cupoMinor: PISO },
    });

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body.status).toBe('confirmed');
    expect(b.fondos.estado.saldoMinor).toBe(-PISO);
  });

  it('con la cuenta propia manda la misma cartera', async () => {
    const b = await banco({ cartera: { saldoMinor: PISO - 1 } });

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toMatchObject({ reason: 'PORTFOLIO_FUNDS_INSUFFICIENT' });
    expect(b.fondos.assertBookingHoldAffordable).toHaveBeenCalledWith(AGENCIA, cotizacion(PISO), {
      reportOrderId: fila(b)['id'],
    });
    expect(fila(b)['status']).toBe('failed');
    expect(b.puerto.prebookWithContext).not.toHaveBeenCalled();
  });

  it('la retención sale después de C2 y antes del Book, sobre la orden abierta y con el precio que ya dice', async () => {
    const b = await banco({ ...SUBAGENCIA_HEREDADA, cartera: { saldoMinor: 1_000_000 } });
    b.fondos.holdBookingIntent.mockImplementation(
      (_tenantId, orderId, _createdBy, expected: Money) => {
        // La orden ya dice lo que se va a reservar, y todavía no salió nada.
        expect(fila(b)).toMatchObject({ id: orderId, status: 'pending', provider_raw: null });
        expect(fila(b)['total_amount']).toBe(expected.amountMinor);
        expect(tipos(b)).not.toContain(ORDER_EVENTS.createRequested);
        return Promise.resolve({});
      },
    );

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(b.fondos.holdBookingIntent).toHaveBeenCalledWith(
      AGENCIA,
      fila(b)['id'],
      USUARIO,
      USD(PISO),
    );
    const [c2] = b.puerto.prebookWithContext.mock.invocationCallOrder;
    const [retencion] = b.fondos.holdBookingIntent.mock.invocationCallOrder;
    const [book] = b.puerto.bookWithContext.mock.invocationCallOrder;
    expect(c2).toBeLessThan(retencion ?? 0);
    expect(retencion).toBeLessThan(book ?? 0);
  });

  it('D-TBO-20 A: si C2 baja el precio, se retiene el nuevo, no el mostrado', async () => {
    const b = await banco({ cartera: { saldoMinor: 1_000_000 } });
    b.puerto.prebookWithContext.mockResolvedValue(
      revalidada({
        netoMinor: 30_010,
        pisoMinor: 31_500,
        totalText: '300.10',
        comparacion: { outcome: 'DECREASED', price: 'DOWN' },
      }),
    );

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(b.fondos.assertBookingHoldAffordable.mock.calls[0]?.[1]).toEqual(cotizacion(PISO));
    expect(b.fondos.holdBookingIntent.mock.calls[0]?.[3]).toEqual(USD(31_500));
    expect(b.fondos.estado.saldoMinor).toBe(1_000_000 - 31_500);
  });

  it('si la retención no alcanza después de C2 (otra reserva gastó el saldo), la orden se cierra sin envío y no hay Book', async () => {
    const b = await banco({ cartera: { saldoMinor: 1_000_000 } });
    b.fondos.holdBookingIntent.mockRejectedValueOnce(
      new BookingHoldRejectedError('PORTFOLIO_FUNDS_INSUFFICIENT', { amountCurrency: 'USD' }),
    );

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toMatchObject({ reason: 'PORTFOLIO_FUNDS_INSUFFICIENT' });
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
    expect(fila(b)).toMatchObject({
      status: 'failed',
      create_request_key: null,
      error_message: CREATE_NOT_SENT_MARKER,
    });
    expect(tipos(b)).not.toContain(ORDER_EVENTS.createRequested);
    // Cerrada la orden, se libera cualquier retención que haya quedado: aquí, ninguna.
    await expect(b.fondos.releaseFailedBookingHold.mock.results[0]?.value).resolves.toBe('no-hold');
  });

  it('0060: un nivel de la red que no cubre la reserva la frena antes de C2, aunque la cartera propia alcance', async () => {
    const b = await banco({
      ...SUBAGENCIA_HEREDADA,
      cartera: { saldoMinor: 1_000_000, red: 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE' },
    });

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toBeInstanceOf(BookingHoldRejectedError);
    expect(err).toMatchObject({
      reason: 'PORTFOLIO_NETWORK_FUNDS_UNAVAILABLE',
      message:
        'Tu red no tiene cupo disponible en USD para esta reserva. Pedile a quien te financia que lo revise.',
    });
    // Con la orden ya abierta: la base puede avisarle al nivel que bloqueó.
    expect(b.fondos.assertBookingHoldAffordable).toHaveBeenCalledWith(AGENCIA, cotizacion(PISO), {
      reportOrderId: fila(b)['id'],
    });
    expect(fila(b)).toMatchObject({
      status: 'failed',
      create_request_key: null,
      error_message: CREATE_NOT_SENT_MARKER,
    });
    expect(b.puerto.prebookWithContext).not.toHaveBeenCalled();
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
    expect(b.fondos.holdBookingIntent).not.toHaveBeenCalled();
    expect(b.fondos.estado.saldoMinor).toBe(1_000_000);
  });

  it('0060: si la red deja de cubrir entre el aviso y la retención (después de C2), no hay Book y la orden se cierra', async () => {
    const b = await banco({ ...SUBAGENCIA_HEREDADA, cartera: { saldoMinor: 1_000_000 } });
    b.fondos.holdBookingIntent.mockRejectedValueOnce(
      new BookingHoldRejectedError('PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED', {
        amountCurrency: 'USD',
      }),
    );

    const err = await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(err).toMatchObject({ reason: 'PORTFOLIO_NETWORK_CURRENCY_NOT_ENABLED' });
    expect(b.puerto.prebookWithContext).toHaveBeenCalledTimes(1);
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
    expect(fila(b)).toMatchObject({ status: 'failed', create_request_key: null });
    expect(tipos(b)).not.toContain(ORDER_EVENTS.createRequested);
    expect(b.fondos.releaseFailedBookingHold).toHaveBeenCalledWith(AGENCIA, fila(b)['id'], USUARIO);
  });

  it('una retención cuyo COMMIT se perdió no queda colgada de la orden cerrada', async () => {
    const b = await banco({ cartera: { saldoMinor: 1_000_000 } });
    b.fondos.holdBookingIntent.mockImplementationOnce((_t, orderId, _u, expected: Money) => {
      b.fondos.estado.saldoMinor -= expected.amountMinor;
      b.fondos.estado.retenciones.set(orderId, expected.amountMinor);
      return Promise.reject(new Error('Connection terminated'));
    });

    await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(fila(b)['status']).toBe('failed');
    expect(b.fondos.releaseFailedBookingHold).toHaveBeenCalledWith(AGENCIA, fila(b)['id'], USUARIO);
    expect(b.fondos.estado.saldoMinor).toBe(1_000_000);
  });
});

describe('RF-23 CA-2: la retención sigue a la orden', () => {
  it('fallo definitivo del proveedor → `failed` y retención liberada', async () => {
    const b = await banco({ cartera: { saldoMinor: 1_000_000 } });
    b.puerto.bookWithContext.mockRejectedValueOnce(
      new RechazoError(
        { outcome: 'FAILED', reason: 'rate-unavailable', dispatched: true, providerStatus: '207' },
        'offer',
      ),
    );

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body.status).toBe('failed');
    expect(b.fondos.releaseFailedBookingHold).toHaveBeenCalledWith(AGENCIA, fila(b)['id'], USUARIO);
    expect(b.fondos.estado).toEqual({ saldoMinor: 1_000_000, retenciones: new Map() });
  });

  it('no enviado (el breaker frenó el Book) → `failed` y retención liberada', async () => {
    const b = await banco({ cartera: { saldoMinor: 1_000_000 } });
    b.puerto.prebookWithContext.mockImplementation(() => {
      vi.stubEnv('PROVIDERS_DISABLED', `${STUB}:ventas`);
      return Promise.resolve(revalidada());
    });

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body).toMatchObject({ status: 'failed', reason: 'not-dispatched' });
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
    expect(b.fondos.estado.saldoMinor).toBe(1_000_000);
  });

  it('incierto → `pending` y la retención se mantiene hasta resolverlo (D-TBO-24 A)', async () => {
    const b = await banco({ cartera: { saldoMinor: 1_000_000 } });
    b.puerto.bookWithContext.mockRejectedValueOnce(
      new RechazoError({ outcome: 'UNCERTAIN', reason: 'timeout', dispatched: true }),
    );

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body.status).toBe('pending');
    expect(b.fondos.releaseFailedBookingHold).not.toHaveBeenCalled();
    expect(b.fondos.estado.saldoMinor).toBe(1_000_000 - PISO);
  });

  it('confirmada → la retención queda como cargo de la reserva', async () => {
    const b = await banco({ cartera: { saldoMinor: 1_000_000 } });

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body.status).toBe('confirmed');
    expect(b.fondos.releaseFailedBookingHold).not.toHaveBeenCalled();
    expect(b.fondos.estado.retenciones.get(String(fila(b)['id']))).toBe(PISO);
  });

  it('un fallo cuya orden no se pudo consolidar conserva la retención: la fila no dice `failed`', async () => {
    const b = await banco({ cartera: { saldoMinor: 1_000_000 } });
    b.puerto.bookWithContext.mockRejectedValueOnce(
      new RechazoError({ outcome: 'FAILED', reason: 'rate-unavailable', dispatched: true }),
    );
    vi.spyOn(b.intents, 'settleExternalCreateIntent').mockResolvedValueOnce(undefined);

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body.status).toBe('pending');
    expect(b.fondos.releaseFailedBookingHold).not.toHaveBeenCalled();
    expect(b.fondos.estado.saldoMinor).toBe(1_000_000 - PISO);
  });

  it('si la liberación falla, la saga no rechaza: la orden queda `failed` y se escala sin datos de nadie', async () => {
    const b = await banco({ cartera: { saldoMinor: 1_000_000 } });
    b.puerto.bookWithContext.mockRejectedValueOnce(
      new RechazoError({ outcome: 'FAILED', reason: 'rate-unavailable', dispatched: true }),
    );
    b.fondos.releaseFailedBookingHold.mockRejectedValueOnce(new Error('base caída'));

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body.status).toBe('failed');
    expect(fila(b)['status']).toBe('failed');
    expect(evento(b, ORDER_EVENTS.escalated)).toEqual({
      provider: STUB,
      vertical: 'hotels',
      bookingReference: REF,
      reason: 'portfolio-hold-release-failed',
      queued: false,
      errorName: 'Error',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hotels.book.hold_release_failed'));
  });

  it('ni con la auditoría caída la liberación fallida tapa el error que el vendedor tiene que ver', async () => {
    const emit = vi.fn(() => Promise.reject(new Error('auditoría caída')));
    const b = await banco({ emit, cartera: { saldoMinor: 1_000_000 } });
    const rechazada = new BookingHoldRejectedError('PORTFOLIO_FUNDS_INSUFFICIENT', {
      amountCurrency: 'USD',
    });
    b.fondos.holdBookingIntent.mockRejectedValueOnce(rechazada);
    b.fondos.releaseFailedBookingHold.mockRejectedValueOnce(new Error('base caída'));

    await expect(b.service.book(AGENCIA, USUARIO, CLAVE, pedido())).rejects.toBe(rechazada);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hotels.book.hold_release_failed'));
  });
});

describe('RF-23: un rechazo por la cuenta avisa a su dueño, no a la agencia que vendía', () => {
  it('`300` en el Book: `ProviderAccountIssueDetected` en el consolidador, sin importes ni texto del proveedor', async () => {
    const b = await banco({ ...SUBAGENCIA_HEREDADA, cartera: { saldoMinor: 1_000_000 } });
    b.puerto.bookWithContext.mockRejectedValueOnce(rechazoDeCuenta('insufficient-balance', '300'));

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.body).toMatchObject({ status: 'failed', reason: 'insufficient-balance' });
    const avisos = b.emit.mock.calls
      .map(([e]) => e as { eventType: string; tenantId: string })
      .filter((e) => e.eventType === HOTEL_EVENTS.providerAccountIssue);
    expect(avisos).toEqual([
      {
        eventType: 'ProviderAccountIssueDetected',
        tenantId: CONSOLIDADOR,
        actorUserId: USUARIO,
        aggregateType: 'provider_account',
        aggregateId: CUENTA.accountId,
        payload: {
          provider: STUB,
          vertical: 'hotels',
          reason: 'insufficient-balance',
          stage: 'book',
          credentialSource: 'inherited',
          sellerTenantId: AGENCIA,
          providerAccountId: CUENTA.accountId,
          orderId: fila(b)['id'],
        },
      },
    ]);
    // La retención de la agencia vuelve: el proveedor no reservó nada.
    expect(b.fondos.estado.saldoMinor).toBe(1_000_000);
  });

  it('`402` en el PreBook de C2 también avisa al dueño, y la orden se cierra sin envío', async () => {
    const b = await banco(SUBAGENCIA_HEREDADA);
    b.puerto.prebookWithContext.mockRejectedValueOnce(rechazoDeCuenta('agent-blocked', '402'));

    await rechazo(b.service.book(AGENCIA, USUARIO, CLAVE, pedido()));

    expect(fila(b)['status']).toBe('failed');
    const aviso = b.emit.mock.calls
      .map(([e]) => e as { eventType: string })
      .find((e) => e.eventType === HOTEL_EVENTS.providerAccountIssue);
    expect(aviso).toMatchObject({
      tenantId: CONSOLIDADOR,
      payload: { reason: 'agent-blocked', stage: 'prebook', orderId: fila(b)['id'] },
    });
  });

  it('si el aviso no se puede escribir, el vendedor ve igual el error del proveedor', async () => {
    const emit = vi.fn((e: { eventType: string }) =>
      e.eventType === HOTEL_EVENTS.providerAccountIssue
        ? Promise.reject(new Error('auditoría caída'))
        : Promise.resolve(),
    );
    const b = await banco({ ...SUBAGENCIA_HEREDADA, emit });
    const bloqueada = rechazoDeCuenta('agent-blocked', '402');
    b.puerto.prebookWithContext.mockRejectedValueOnce(bloqueada);

    await expect(b.service.book(AGENCIA, USUARIO, CLAVE, pedido())).rejects.toBe(bloqueada);
    expect(fila(b)['status']).toBe('failed');
    expect(b.puerto.bookWithContext).not.toHaveBeenCalled();
  });

  it('un rechazo que no es de la cuenta no avisa a nadie', async () => {
    const b = await banco(SUBAGENCIA_HEREDADA);
    b.puerto.bookWithContext.mockRejectedValueOnce(
      new RechazoError({ outcome: 'FAILED', reason: 'rate-unavailable', dispatched: true }),
    );

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(tipos(b)).not.toContain(HOTEL_EVENTS.providerAccountIssue);
  });

  it('sin dueño conocido no hay aviso: nunca cae en el tenant de la agencia', async () => {
    const b = await banco({ credentialSource: 'inherited' });
    b.puerto.bookWithContext.mockRejectedValueOnce(rechazoDeCuenta('insufficient-balance', '300'));

    await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(tipos(b)).not.toContain(HOTEL_EVENTS.providerAccountIssue);
  });
});

// ───────────────────────── Respuesta híbrida (RF-22) ─────────────────────────

describe('RF-22: el Book no espera en la petición más que `syncWaitMs`', () => {
  it('CA-1: un Book lento responde 202 y la saga termina después, en el proceso y registrada para el apagado', async () => {
    const b = await banco({ options: { syncWaitMs: 5 } });
    const lento = diferido<HotelBookWithContext>();
    b.puerto.bookWithContext.mockReturnValue(lento.promise);

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());
    const { message, ...resto } = res.body;

    expect(res.httpStatus).toBe(202);
    expect(resto).toEqual({
      orderId: fila(b)['id'],
      orderNumber: 1,
      status: 'pending',
      providerCode: STUB,
      providerBookingId: null,
      bookingReference: REF,
      total: USD(PISO),
      reason: 'book-in-progress',
      warnings: [],
      retryForbidden: true,
      reconciliationRequired: true,
    });
    expect(message).toContain('Mis Reservas');
    expect(b.inflight.countsByKind()).toEqual({ 'hotel-book': 1 });
    expect(fila(b)['status']).toBe('pending');

    lento.resolve(confirmada());
    await b.inflight.whenIdle();

    expect(fila(b)).toMatchObject({ status: 'confirmed', provider_order_id: CONF });
    expect(b.puerto.bookWithContext).toHaveBeenCalledTimes(1);
  });

  it('`HOTEL_BOOK_SYNC_WAIT_MS` decide la espera cuando no se inyecta', async () => {
    vi.stubEnv('HOTEL_BOOK_SYNC_WAIT_MS', '0');
    const b = await banco({ sinOpciones: true });
    const lento = diferido<HotelBookWithContext>();
    b.puerto.bookWithContext.mockReturnValue(lento.promise);

    const res = await b.service.book(AGENCIA, USUARIO, CLAVE, pedido());

    expect(res.httpStatus).toBe(202);
    lento.resolve(confirmada());
    await b.inflight.whenIdle();
  });

  it('un valor mal escrito cae al de por defecto con aviso que no repite el valor', async () => {
    vi.stubEnv('HOTEL_BOOK_SYNC_WAIT_MS', 'mucho');

    await banco({ sinOpciones: true });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HOTEL_BOOK_SYNC_WAIT_MS'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('mucho'));
  });
});

describe('hotelBookSyncWaitMs', () => {
  it.each([
    [undefined, HOTEL_BOOK_DEFAULT_SYNC_WAIT_MS, false],
    ['', HOTEL_BOOK_DEFAULT_SYNC_WAIT_MS, false],
    ['0', 0, false],
    ['12000', 12_000, false],
    ['60000', 60_000, false],
    ['60001', HOTEL_BOOK_DEFAULT_SYNC_WAIT_MS, true],
    ['-5', HOTEL_BOOK_DEFAULT_SYNC_WAIT_MS, true],
    ['25s', HOTEL_BOOK_DEFAULT_SYNC_WAIT_MS, true],
  ])('%s → %s', (raw, waitMs, invalido) => {
    const config = hotelBookSyncWaitMs(raw === undefined ? {} : { HOTEL_BOOK_SYNC_WAIT_MS: raw });
    expect(config.waitMs).toBe(waitMs);
    expect(config.invalidReason !== undefined).toBe(invalido);
  });
});

describe('passengers: lo que el proveedor no devolvió como enviado queda en null', () => {
  it('sin nombre enviado ni título, la orden no inventa ninguno', async () => {
    const b = await banco();
    b.puerto.checkBookingGuests.mockReturnValue({ ok: true, rooms: [[]] });

    await b.service.book(
      AGENCIA,
      USUARIO,
      CLAVE,
      pedido({
        rooms: [
          {
            guests: [
              { paxType: 'ADT', firstName: 'Juan', lastName: 'Perez' },
              { paxType: 'ADT', title: 'Mrs', firstName: 'Ana', lastName: 'Perez' },
              { paxType: 'CHD', title: 'Ms', firstName: 'Lia', lastName: 'Perez' },
            ],
          },
        ],
      }),
    );

    expect(json(fila(b)['passengers'])).toEqual([
      {
        room: 0,
        guests: [
          { paxType: 'ADT', title: null, firstName: 'Juan', lastName: 'Perez', sent: null },
          { paxType: 'ADT', title: 'Mrs', firstName: 'Ana', lastName: 'Perez', sent: null },
          { paxType: 'CHD', title: 'Ms', firstName: 'Lia', lastName: 'Perez', sent: null },
        ],
      },
    ]);
  });
});

describe('invalidación: si la marca falla se pierde la marca, no el error', () => {
  it('un olvido de la búsqueda que falla deja un aviso sin la clave y el error original sale igual', async () => {
    const b = await banco();
    const vencida = new RechazoError(
      { outcome: 'FAILED', reason: 'session-expired', dispatched: true },
      'search',
    );
    b.puerto.prebookWithContext.mockRejectedValue(vencida);
    vi.spyOn(b.contexts, 'forget').mockRejectedValue(new Error(`clave ${AGENCIA}`));

    await expect(b.service.book(AGENCIA, USUARIO, CLAVE, pedido())).rejects.toBe(vencida);
    expect(warn).toHaveBeenCalledWith(
      `hotels.book.invalidation_failed provider=${STUB} scope=search`,
    );
  });
});

// ───────────────────────── TBO de punta a punta ─────────────────────────

const TBO = 'tbo-hotels';
const RAIZ = join(__dirname, '..', '..', '..', '..');
const FIXTURES_TBO = join(RAIZ, 'providers', 'tbo-hotels', 'src', '__fixtures__');
const BC_4 = '1120548!TB!4!TB!9a47646b-1bba-4746-91d5-969149db1185';

const DETALLE_TBO: HotelDetailInput = {
  provider: TBO,
  hotelId: '1120548',
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-11',
  rooms: [
    { adults: 2, childrenAges: [] },
    { adults: 2, childrenAges: [] },
  ],
  guestNationality: 'CO',
};

function fixture(ruta: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_TBO, ruta), 'utf8')) as Record<string, unknown>;
}

/**
 * El PreBook de p. 28 sin la frase de "sólo con aéreo" (una tarifa que se puede vender suelta) y,
 * opcionalmente, con otro `TotalFare`.
 */
function prebookVendible(totalFare?: number): Record<string, unknown> {
  const base = fixture('pdf/prebook-limit-multi-room.p28.json') as {
    HotelResult: { Rooms: Record<string, unknown>[]; RateConditions: string[] }[];
  };
  const [hotel] = base.HotelResult;
  if (hotel !== undefined) {
    hotel.RateConditions = hotel.RateConditions.filter((c) => !c.includes('airline ticket'));
    const [room] = hotel.Rooms;
    if (room !== undefined && totalFare !== undefined) room['TotalFare'] = totalFare;
  }
  return base;
}

/**
 * El limitador del ACL cuenta en una ventana de 1 s sobre `Date.now()`, que aquí está congelado:
 * cada llamada corre el reloj para que la siguiente no espere una ventana que nunca pasa.
 */
function avanzarReloj(): void {
  vi.setSystemTime(Date.now() + 1_100);
}

function respuesta(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function boveda(): ProviderCredentialsService {
  const resolve = (tenantId: string, providerCode: string): Promise<ResolvedProviderAccount> => {
    if (tenantId !== CONSOLIDADOR && tenantId !== AGENCIA) {
      return Promise.reject(new NotFoundException('sin cuenta'));
    }
    return Promise.resolve({
      id: CUENTA.accountId,
      ownerTenantId: CONSOLIDADOR,
      providerCode,
      label: 'default',
      config: { environment: 'test' },
      credentials: { username: 'consolidador-demo', password: 'Pa55w0rd' },
      inherited: tenantId !== CONSOLIDADOR,
      updatedAt: new Date(CUENTA.updatedAt),
    });
  };
  // La cuenta con que se hizo la orden, que sigue en la red del tenant: la misma del consolidador.
  const resolveForOrder = (tenantId: string): Promise<ResolvedProviderAccount> =>
    resolve(tenantId, 'tbo-hotels');
  const ownerTenantType = (id: string): Promise<TenantType | undefined> =>
    Promise.resolve(id === CONSOLIDADOR ? 'consolidator' : 'agency');
  return { resolve, resolveForOrder, ownerTenantType } as unknown as ProviderCredentialsService;
}

/** El cliente del ACL siempre manda texto. */
function textoDe(body: unknown): string {
  if (typeof body !== 'string') throw new Error('el cliente no mandó un body de texto');
  return body;
}

/** La búsqueda de TBO que emitió el `BookingCode` del detalle. */
function busquedaDe(oferta: HotelOffer): string {
  const searchId = oferta.roompacks.find((p) => p.provider.offerRef === BC_4)?.provider.raw?.[
    'searchId'
  ];
  if (typeof searchId !== 'string') throw new Error('la tarifa no trae su búsqueda');
  return searchId;
}

/** El cuerpo de cada llamada a un path de TBO. */
function cuerpos(fetch: Mock<TboFetch>, path: string): Record<string, unknown>[] {
  return fetch.mock.calls
    .filter(([url]) => String(url).endsWith(path))
    .map(([, init]) => JSON.parse(textoDe(init?.body)) as Record<string, unknown>);
}

interface BancoTbo {
  hotels: HotelsService;
  prebooks: HotelPrebookService;
  bookings: HotelBookingService;
  fetch: Mock<TboFetch>;
  memory: ReturnType<typeof memoryDb>;
  queue: RecordingQueueService;
  tracking: MemoryVerificationStore;
  verification: HotelBookingVerificationService;
  emit: Mock;
  fondos: Fondos;
}

function bancoTbo(
  prebookC2: () => unknown = () => prebookVendible(),
  cartera?: CarteraFake,
): BancoTbo {
  let prebooks = 0;
  const fetch = vi.fn<TboFetch>((url, init) => {
    avanzarReloj();
    const path = String(url);
    if (path.endsWith('/PreBook')) {
      prebooks += 1;
      return Promise.resolve(respuesta(prebooks === 1 ? prebookVendible() : prebookC2()));
    }
    if (path.endsWith('/Book')) {
      const enviado = JSON.parse(textoDe(init?.body)) as { ClientReferenceId: string };
      return Promise.resolve(
        respuesta({
          Status: { Code: 200, Description: 'Successful' },
          ClientReferenceId: enviado.ClientReferenceId,
          ConfirmationNumber: 'YOSUR8',
        }),
      );
    }
    if (path.endsWith('/BookingDetail')) {
      return Promise.resolve(respuesta(fixture('pdf/booking-detail.p49.json')));
    }
    return Promise.resolve(respuesta(fixture('pdf/search-multi-room.p16.json')));
  });
  const factories: HotelProviderFactory[] = [new TboHotelsProviderFactory(boveda(), fetch)];
  const registry = hotelRegistry(factories, hotelFlags(true));
  const cache = new MemoryCacheAdapter();
  const contexts = new HotelSearchContextStore(cache);
  const snapshots = new HotelPrebookSnapshotStore(cache);
  const pricing = {
    getApplicableRules: () =>
      Promise.resolve<ApplicableRule[]>([
        {
          tenantId: CONSOLIDADOR,
          tenantName: 'C',
          level: 1,
          ruleType: 'percentage',
          valueMinor: 300,
        },
        { tenantId: AGENCIA, tenantName: 'A', level: 2, ruleType: 'percentage', valueMinor: 100 },
      ]),
  } as unknown as PricingService;
  const breaker = new CircuitBreakerService();
  const emit = vi.fn(() => Promise.resolve());
  const audit = { emit } as unknown as AuditService;
  const memory = memoryDb({
    providerAccounts: [{ id: CUENTA.accountId, updatedAt: CUENTA.updatedAt }],
  });
  const intents = new ExternalOrderIntentService(memory.db);
  const queue = new RecordingQueueService();
  const tracking = new MemoryVerificationStore(() => memory.rows());
  const hcn = hcnFake();
  const verification = new HotelBookingVerificationService(
    registry,
    tracking.asStore(),
    intents,
    breaker,
    audit,
    queue.asService(),
    hcn as unknown as HcnTrackingService,
  );
  const fondos = carteraDe(cartera);
  const hotels = new HotelsService(
    registry,
    fakeHotelsDb().service,
    pricing,
    {} as unknown as SearchTelemetryService,
    breaker,
    contexts,
  );
  const permisos = permisosFake() as unknown as BookingPermissionsService;
  const prebookService = new HotelPrebookService(
    registry,
    contexts,
    snapshots,
    pricing,
    breaker,
    audit,
    fondos.service,
    permisos,
  );
  const bookings = new HotelBookingService(
    registry,
    snapshots,
    contexts,
    intents,
    pricing,
    breaker,
    audit,
    { resolveSupportContact: () => Promise.resolve(SOPORTE) } as unknown as BrandingService,
    new InflightWorkRegistry(),
    verification,
    fondos.service,
    hcn as unknown as HcnTrackingService,
    permisos,
    { syncWaitMs: 5_000 },
  );
  return {
    hotels,
    prebooks: prebookService,
    bookings,
    fetch,
    memory,
    queue,
    tracking,
    verification,
    emit,
    fondos,
  };
}

const HUESPEDES_TBO: HotelBookingRoomGuests[] = [
  {
    guests: [
      { paxType: 'ADT', title: 'Mr', firstName: 'José', lastName: 'Muñoz' },
      { paxType: 'ADT', title: 'Mrs', firstName: 'Ana', lastName: 'Muñoz' },
    ],
  },
  {
    guests: [
      { paxType: 'ADT', title: 'Ms', firstName: 'Lucía', lastName: 'Pérez' },
      { paxType: 'ADT', title: 'Mr', firstName: 'Tomás', lastName: 'Pérez' },
    ],
  },
];

async function prebookTbo(
  b: BancoTbo,
): Promise<{ prebookRef: string; total: Money; funding?: BookingHoldPreview }> {
  const searchId = busquedaDe(await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO));
  const res = await b.prebooks.prebook(
    AGENCIA,
    { providerCode: TBO, searchId, offerRef: BC_4 },
    USUARIO,
  );
  return {
    prebookRef: res.prebookRef,
    total: {
      amountMinor: res.roompack.pricing?.finalMinor ?? res.roompack.price.total.amountMinor,
      currency: res.roompack.price.total.currency,
    },
    ...(res.funding === undefined ? {} : { funding: res.funding }),
  };
}

describe('TBO de punta a punta: búsqueda de p. 16, PreBook de p. 28, Book y BookingDetail de p. 49', () => {
  it('por el cable sale el Book con `Limit`, la referencia persistida, el total de C2 y el contacto de la agencia', async () => {
    // C2 devuelve otro `TotalFare` más bajo; el piso (321.34) sostiene el mismo precio de venta.
    const b = bancoTbo(() => prebookVendible(300.1));
    const { prebookRef, total } = await prebookTbo(b);

    const res = await b.bookings.book(AGENCIA, USUARIO, CLAVE, {
      providerCode: TBO,
      prebookRef,
      acceptedTotal: total,
      atPropertyAcknowledged: true,
      nonRefundableAcknowledged: true,
      rooms: HUESPEDES_TBO,
      contact: CONTACTO_HUESPED,
    });

    const [book] = cuerpos(b.fetch, '/Book');
    const [row] = b.memory.rows();
    expect(cuerpos(b.fetch, '/Book')).toHaveLength(1);
    expect(book).toEqual({
      BookingCode: BC_4,
      CustomerDetails: [
        {
          CustomerNames: [
            { Title: 'Mr', FirstName: 'Jose', LastName: 'Munoz', Type: 'Adult' },
            { Title: 'Mrs', FirstName: 'Ana', LastName: 'Munoz', Type: 'Adult' },
          ],
        },
        {
          CustomerNames: [
            { Title: 'Ms', FirstName: 'Lucia', LastName: 'Perez', Type: 'Adult' },
            { Title: 'Mr', FirstName: 'Tomas', LastName: 'Perez', Type: 'Adult' },
          ],
        },
      ],
      ClientReferenceId: row?.['provider_booking_ref'],
      BookingReferenceId: row?.['provider_booking_ref'],
      // RF-20 CA-6 y CK-11: el `TotalFare` del PreBook de C2, no el de la búsqueda ni el de C1.
      TotalFare: 300.1,
      EmailId: 'reservas@agencia.example',
      PhoneNumber: '576015550000',
      BookingType: 'Voucher',
      PaymentMode: 'Limit',
    });
    expect(String(row?.['provider_booking_ref'])).toMatch(/^STT[0-9A-HJKMNP-TV-Z]{17}$/);
    expect(JSON.stringify(book)).not.toContain('PaymentInfo');
    expect(cuerpos(b.fetch, '/BookingDetail')).toEqual([
      { ConfirmationNumber: 'YOSUR8', PaymentMode: 'Limit' },
    ]);
    expect(res).toMatchObject({
      httpStatus: 201,
      body: { status: 'confirmed', providerCode: TBO, providerBookingId: 'YOSUR8', total },
    });
    expect(row).toMatchObject({
      provider: TBO,
      status: 'confirmed',
      provider_order_id: 'YOSUR8',
      provider_account_id: CUENTA.accountId,
    });
  });

  it('RF-23: sin cartera en la moneda de la tarifa, el PreBook lo avisa y el Book se rechaza sin salir a TBO', async () => {
    // Con saldo de sobra en COP: la tarifa es en USD y la retención no convierte.
    const b = bancoTbo(undefined, { saldoMinor: 10_000_000_000, moneda: 'COP' });
    const { prebookRef, total, funding } = await prebookTbo(b);
    expect(total.currency).toBe('USD');
    expect(funding).toEqual({
      status: 'blocked',
      currency: 'USD',
      reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED',
      message: 'La agencia no tiene cartera en USD: pedile a quien te financia que la habilite.',
    });
    const prebooksDelVendedor = cuerpos(b.fetch, '/PreBook').length;

    const err: unknown = await b.bookings
      .book(AGENCIA, USUARIO, CLAVE, {
        providerCode: TBO,
        prebookRef,
        acceptedTotal: total,
        atPropertyAcknowledged: true,
        nonRefundableAcknowledged: true,
        rooms: HUESPEDES_TBO,
        contact: CONTACTO_HUESPED,
      })
      .catch((e: unknown) => e);

    // El mismo motivo y el mismo texto que el aviso: el vendedor no ve dos versiones.
    expect(err).toBeInstanceOf(BookingHoldRejectedError);
    expect(err).toMatchObject({
      reason: 'PORTFOLIO_CURRENCY_NOT_ENABLED',
      message: 'La agencia no tiene cartera en USD: pedile a quien te financia que la habilite.',
    });
    // Ni el PreBook de C2 ni el Book salieron: TBO no se enteró.
    expect(cuerpos(b.fetch, '/PreBook')).toHaveLength(prebooksDelVendedor);
    expect(cuerpos(b.fetch, '/Book')).toHaveLength(0);
    expect(b.fondos.holdBookingIntent).not.toHaveBeenCalled();
    expect(b.memory.rows()[0]).toMatchObject({ status: 'failed', create_request_key: null });
  });

  it('un 207 del Book: la orden queda `failed` con la clave libre y el mensaje de TBO en español', async () => {
    const b = bancoTbo();
    const { prebookRef, total } = await prebookTbo(b);
    b.fetch.mockImplementation((url) => {
      avanzarReloj();
      return Promise.resolve(
        respuesta(
          String(url).endsWith('/Book')
            ? (
                fixture('envelope/83-207-rate-unavailable.json') as {
                  response: { bodyJson: unknown };
                }
              ).response.bodyJson
            : prebookVendible(),
        ),
      );
    });

    const res = await b.bookings.book(AGENCIA, USUARIO, CLAVE, {
      providerCode: TBO,
      prebookRef,
      acceptedTotal: total,
      atPropertyAcknowledged: true,
      nonRefundableAcknowledged: true,
      rooms: HUESPEDES_TBO,
      contact: CONTACTO_HUESPED,
    });

    expect(res.body).toMatchObject({ status: 'failed', reason: 'rate-unavailable' });
    expect(res.body.message).toContain('ya no está disponible');
    expect(b.memory.rows()[0]).toMatchObject({ status: 'failed', create_request_key: null });
    expect(cuerpos(b.fetch, '/Book')).toHaveLength(1);
    expect(cuerpos(b.fetch, '/BookingDetail')).toHaveLength(0);
  });

  it('RF-23: un 300 con la cuenta del consolidador avisa al consolidador; la agencia no ve su saldo', async () => {
    const b = bancoTbo();
    const { prebookRef, total } = await prebookTbo(b);
    // TBO no publica un ejemplo de 300 (H-10): si la descripción trajera el saldo, no puede salir.
    const trescientos = {
      Status: {
        Code: 300,
        Description:
          'Agency has Insufficient Funds for requested booking. Available balance USD 1234.56',
      },
    };
    b.fetch.mockImplementation((url) => {
      avanzarReloj();
      return Promise.resolve(
        respuesta(String(url).endsWith('/Book') ? trescientos : prebookVendible()),
      );
    });

    const res = await b.bookings.book(AGENCIA, USUARIO, CLAVE, {
      providerCode: TBO,
      prebookRef,
      acceptedTotal: total,
      atPropertyAcknowledged: true,
      nonRefundableAcknowledged: true,
      rooms: HUESPEDES_TBO,
      contact: CONTACTO_HUESPED,
    });

    const avisoAlVendedor =
      'La cuenta de TBO del consolidador no tiene saldo suficiente para esta reserva. Avisale al consolidador.';
    expect(res.body).toMatchObject({
      status: 'failed',
      reason: 'insufficient-balance',
      message: avisoAlVendedor,
    });
    expect(b.memory.rows()[0]).toMatchObject({
      status: 'failed',
      create_request_key: null,
      error_message: avisoAlVendedor,
    });
    const eventos = b.emit.mock.calls.map(
      ([e]) => e as { eventType: string; tenantId?: string; payload: Record<string, unknown> },
    );
    const avisos = eventos.filter((e) => e.eventType === HOTEL_EVENTS.providerAccountIssue);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({
      tenantId: CONSOLIDADOR,
      aggregateId: CUENTA.accountId,
      payload: {
        provider: TBO,
        reason: 'insufficient-balance',
        stage: 'book',
        credentialSource: 'inherited',
        sellerTenantId: AGENCIA,
      },
    });
    const todo = JSON.stringify([res.body, b.memory.rows(), eventos]);
    expect(todo).not.toContain('1234.56');
    expect(todo).not.toMatch(/insufficient funds|available balance/i);
    expect(cuerpos(b.fetch, '/Book')).toHaveLength(1);
    // Sin reserva del otro lado, la retención de la agencia vuelve.
    expect(b.fondos.estado.retenciones.size).toBe(0);
    expect(b.fondos.releaseFailedBookingHold).toHaveBeenCalledTimes(1);
  });

  it('RF-17: la tarifa del ejemplo del PDF, sólo con aéreo, no se reserva: el PreBook la marca y el Book no sale', async () => {
    const b = bancoTbo();
    const searchId = busquedaDe(await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO));
    b.fetch.mockImplementation(() => {
      avanzarReloj();
      return Promise.resolve(respuesta(fixture('pdf/prebook-limit-multi-room.p28.json')));
    });
    const res = await b.prebooks.prebook(
      AGENCIA,
      { providerCode: TBO, searchId, offerRef: BC_4 },
      USUARIO,
    );

    const err = await rechazo(
      b.bookings.book(AGENCIA, USUARIO, CLAVE, {
        providerCode: TBO,
        prebookRef: res.prebookRef,
        acceptedTotal: {
          amountMinor: res.roompack.pricing?.finalMinor ?? 0,
          currency: 'USD',
        },
        atPropertyAcknowledged: true,
        nonRefundableAcknowledged: true,
        rooms: HUESPEDES_TBO,
        contact: CONTACTO_HUESPED,
      }),
    );

    expect(err).toBeInstanceOf(HotelPackageOnlyRateError);
    expect(cuerpos(b.fetch, '/Book')).toHaveLength(0);
    expect(b.memory.rows()).toHaveLength(0);
  });

  it('RF-09: con la ventana de la búsqueda vencida no hay Book (ni orden)', async () => {
    const b = bancoTbo();
    const { prebookRef, total } = await prebookTbo(b);
    vi.setSystemTime(T0 + 27 * MIN - 5_000);

    const err = await rechazo(
      b.bookings.book(AGENCIA, USUARIO, CLAVE, {
        providerCode: TBO,
        prebookRef,
        acceptedTotal: total,
        atPropertyAcknowledged: true,
        nonRefundableAcknowledged: true,
        rooms: HUESPEDES_TBO,
        contact: CONTACTO_HUESPED,
      }),
    );

    expect(err).toBeInstanceOf(HotelPrebookExpiredError);
    expect(cuerpos(b.fetch, '/Book')).toHaveLength(0);
  });

  it('otro tenant, aunque herede la MISMA cuenta, no reserva el PreBook de la agencia', async () => {
    const b = bancoTbo();
    const { prebookRef, total } = await prebookTbo(b);

    await expect(
      b.bookings.book(CONSOLIDADOR, USUARIO, CLAVE, {
        providerCode: TBO,
        prebookRef,
        acceptedTotal: total,
        atPropertyAcknowledged: true,
        nonRefundableAcknowledged: true,
        rooms: HUESPEDES_TBO,
        contact: CONTACTO_HUESPED,
      }),
    ).rejects.toBeInstanceOf(HotelPrebookExpiredError);
    expect(cuerpos(b.fetch, '/Book')).toHaveLength(0);
  });

  it('los nombres fuera de las reglas de TBO → 400 antes de abrir la orden', async () => {
    const b = bancoTbo();
    const { prebookRef, total } = await prebookTbo(b);

    const err = await rechazo(
      b.bookings.book(AGENCIA, USUARIO, CLAVE, {
        providerCode: TBO,
        prebookRef,
        acceptedTotal: total,
        atPropertyAcknowledged: true,
        nonRefundableAcknowledged: true,
        rooms: [HUESPEDES_TBO[0] ?? { guests: [] }],
        contact: CONTACTO_HUESPED,
      }),
    );

    expect(err).toBeInstanceOf(HotelGuestsInvalidError);
    expect((err as HotelGuestsInvalidError).publicDetails.issues).toContain('rooms:count_mismatch');
    expect(b.memory.rows()).toHaveLength(0);
  });

  it('RF-09 CA-2: un 315 en C2 cierra la orden sin envío y olvida la búsqueda', async () => {
    const b = bancoTbo(
      () =>
        (fixture('envelope/83-315-bookingcode-expired.json') as { response: { bodyJson: unknown } })
          .response.bodyJson,
    );
    const searchId = busquedaDe(await b.hotels.getHotelDetail(AGENCIA, DETALLE_TBO));
    const res = await b.prebooks.prebook(
      AGENCIA,
      { providerCode: TBO, searchId, offerRef: BC_4 },
      USUARIO,
    );

    await expect(
      b.bookings.book(AGENCIA, USUARIO, CLAVE, {
        providerCode: TBO,
        prebookRef: res.prebookRef,
        acceptedTotal: {
          amountMinor: res.roompack.pricing?.finalMinor ?? 0,
          currency: 'USD',
        },
        atPropertyAcknowledged: true,
        nonRefundableAcknowledged: true,
        rooms: HUESPEDES_TBO,
        contact: CONTACTO_HUESPED,
      }),
    ).rejects.toMatchObject({ kind: 'OFFER_EXPIRED' });

    expect(cuerpos(b.fetch, '/Book')).toHaveLength(0);
    expect(b.memory.rows()[0]).toMatchObject({ status: 'failed', create_request_key: null });
    await expect(
      b.prebooks.prebook(AGENCIA, { providerCode: TBO, searchId, offerRef: BC_4 }, USUARIO),
    ).rejects.toBeInstanceOf(HotelSearchContextExpiredError);
  });
});

describe('RF-21 con TBO: el Book incierto se lee por la referencia a los 120 s y nunca se repite', () => {
  function envelope(nombre: string): unknown {
    return (fixture(`envelope/${nombre}`) as { response: { bodyJson: unknown } }).response.bodyJson;
  }

  /** Un Book que responde `405` y, después, lo que diga `detalle` en cada BookingDetail. */
  async function reservaIncierta(detalle: () => unknown): Promise<BancoTbo & { orderId: string }> {
    const b = bancoTbo();
    const { prebookRef, total } = await prebookTbo(b);
    b.fetch.mockImplementation((url) => {
      avanzarReloj();
      const path = String(url);
      if (path.endsWith('/Book'))
        return Promise.resolve(respuesta(envelope('83-405-booking-fail.json')));
      if (path.endsWith('/BookingDetail')) return Promise.resolve(respuesta(detalle()));
      return Promise.resolve(respuesta(prebookVendible()));
    });
    const res = await b.bookings.book(AGENCIA, USUARIO, CLAVE, {
      providerCode: TBO,
      prebookRef,
      acceptedTotal: total,
      atPropertyAcknowledged: true,
      nonRefundableAcknowledged: true,
      rooms: HUESPEDES_TBO,
      contact: CONTACTO_HUESPED,
    });
    expect(res).toMatchObject({ httpStatus: 202, body: { status: 'pending' } });
    return { ...b, orderId: res.body.orderId };
  }

  function tipoDeEventos(b: BancoTbo): { eventType: string; payload: Record<string, unknown> }[] {
    return b.emit.mock.calls.map(
      ([e]) => e as unknown as { eventType: string; payload: Record<string, unknown> },
    );
  }

  it('la encuentra confirmada: consolida con el localizador de BookingDetail y un solo Book', async () => {
    const b = await reservaIncierta(() => fixture('pdf/booking-detail.p49.json'));
    const [row] = b.memory.rows();
    const ref = String(row?.['provider_booking_ref']);
    const [job] = b.queue.hotelVerifications;
    const tf = b.tracking.tracking.get(b.orderId)?.anchorAt ?? 0;

    // Nada lee antes de su hora: el job lleva el retardo, y el Book no se reintentó.
    expect(b.queue.jobs[0]).toMatchObject({
      jobId: `verify-hotel-booking:${b.orderId}:0`,
      delayMs: 120_000,
    });
    expect(cuerpos(b.fetch, '/BookingDetail')).toEqual([]);

    vi.setSystemTime(tf + 120_000);
    await b.verification.runJob(job, { final: false });

    expect(cuerpos(b.fetch, '/BookingDetail')).toEqual([
      { BookingReferenceId: ref, PaymentMode: 'Limit' },
    ]);
    expect(b.memory.rows()[0]).toMatchObject({
      status: 'confirmed',
      provider_order_id: 'YOSUR8',
      error_message: null,
    });
    expect(json(b.memory.rows()[0]?.['provider_raw'])).toEqual({
      vertical: 'hotels',
      bookingReference: ref,
      reason: 'recovered-by-reference',
      providerStatus: 'Confirmed',
      recoveredBy: 'booking-reference',
      phase: 'create',
      outcome: 'CONFIRMED',
    });
    expect(
      tipoDeEventos(b).find((e) => e.eventType === ORDER_EVENTS.verified)?.payload,
    ).toMatchObject({ recoveredBy: 'booking-reference', providerBookingId: 'YOSUR8', step: 0 });
    // RF-21 CA-4: cero Book después del fallo.
    expect(cuerpos(b.fetch, '/Book')).toHaveLength(1);
  });

  it('no aparece en ningún paso: sigue `pending` y bloqueada, sin un segundo Book (D-TBO-24 A)', async () => {
    const b = await reservaIncierta(() => envelope('83-201-no-availability-prebook.json'));
    const tf = b.tracking.tracking.get(b.orderId)?.anchorAt ?? 0;

    for (const [paso, offset] of [
      [0, 120_000],
      [1, 5 * MIN],
      [2, 15 * MIN],
      [3, 60 * MIN],
    ] as const) {
      const job = b.queue.hotelVerifications[paso];
      expect(job).toMatchObject({ orderId: b.orderId, step: paso });
      vi.setSystemTime(tf + offset);
      await b.verification.runJob(job, { final: false });
    }

    expect(cuerpos(b.fetch, '/BookingDetail')).toHaveLength(4);
    expect(b.queue.hotelVerifications).toHaveLength(4);
    expect(b.memory.rows()[0]).toMatchObject({
      status: 'pending',
      provider_raw: null,
      create_request_key: `c:${CLAVE}`,
    });
    expect(b.tracking.tracking.get(b.orderId)).toMatchObject({
      subStatus: 'create-not-found-yet',
      nextAt: null,
    });
    expect(
      tipoDeEventos(b)
        .filter((e) => e.eventType === ORDER_EVENTS.escalated)
        .map((e) => e.payload['reason']),
    ).toEqual(['create-uncertain', 'create-not-found']);
    expect(cuerpos(b.fetch, '/Book')).toHaveLength(1);
  });
});
