import { NotFoundException } from '@nestjs/common';
import type { HotelOffer, HotelSearchCriteria } from '@sales-travel/canonical';
import type {
  HotelBookRequest,
  HotelBookResult,
  HotelBookingView,
  HotelCancelRequest,
  HotelCancelResult,
  HotelPrebookRequest,
  HotelPrebookResult,
  SearchContext,
} from '@sales-travel/domain';
import { vi } from 'vitest';
import type {
  HotelProviderAdapter,
  HotelProviderCapabilities,
  HotelProviderFactory,
  HotelSearchProfile,
} from '../hotel-provider.types.js';
import type { CallPolicy, CredentialSource, TenantAdapter } from '../provider.types.js';

/**
 * Segundo proveedor de hoteles, ANÓNIMO y sólo para tests.
 *
 * Existe para demostrar el registry, el fan-out con degradación parcial, el enrutado por
 * `provider.name` y la puerta de moneda ANTES de que exista un segundo proveedor real, y sin
 * apostar por ninguno: el día que entre uno, estos tests siguen valiendo tal cual.
 */

const CAPACIDADES_PLENAS: HotelProviderCapabilities = {
  retrieve: true,
  cancel: true,
  retrieveByClientReference: true,
  reconcileByDate: true,
};

/** Busca en el espacio de ids de la plataforma, con otro límite que Despegar para distinguirlos. */
const PERFIL_POR_DEFECTO: HotelSearchProfile = {
  idSpace: 'platform',
  maxHotelsPerSearch: 100,
  catalogOrder: 'hotel_id',
};

export interface StubHotelAdapterOptions {
  /** Hoteles que devuelve la búsqueda. Por defecto, uno con un pack atribuido al stub. */
  offers?: HotelOffer[];
  /** Reemplaza por completo la búsqueda (para fallos, demoras o coordinación). */
  searchImpl?: (criteria: HotelSearchCriteria, ctx: SearchContext) => Promise<HotelOffer[]>;
  /** Moneda de la oferta por defecto: para probar la puerta de moneda. */
  currency?: string;
}

/** Adapter de hoteles completo (los cinco puertos obligatorios) con todos los métodos espiables. */
export class StubHotelAdapter implements HotelProviderAdapter {
  readonly searchAvailability: (
    criteria: HotelSearchCriteria,
    ctx: SearchContext,
  ) => Promise<HotelOffer[]>;
  readonly prebook = vi.fn((request: HotelPrebookRequest, _ctx: SearchContext) =>
    Promise.resolve<HotelPrebookResult>({
      prebookRef: `${request.offer.offerRef}-PB`,
      total: { amountMinor: 100_000, currency: 'USD' },
      rateConditions: [],
      signals: [],
      warnings: [],
    }),
  );
  readonly book = vi.fn((request: HotelBookRequest, _ctx: SearchContext) =>
    Promise.resolve<HotelBookResult>({
      outcome: 'CONFIRMED',
      providerBookingId: `${this.code}-BK`,
      bookingReference: request.bookingReference,
      warnings: [],
    }),
  );
  readonly getBooking = vi.fn((providerBookingId: string, _ctx: SearchContext) =>
    Promise.resolve<HotelBookingView>({
      found: true,
      providerBookingId,
      status: 'CONFIRMED',
      warnings: [],
    }),
  );
  readonly cancelBooking = vi.fn((_request: HotelCancelRequest, _ctx: SearchContext) =>
    Promise.resolve<HotelCancelResult>({
      success: true,
      bookingStatus: 'CANCELLED',
      warnings: [],
    }),
  );

  constructor(
    readonly code: string,
    opts: StubHotelAdapterOptions = {},
  ) {
    const impl = opts.searchImpl;
    this.searchAvailability = vi.fn((criteria: HotelSearchCriteria, ctx: SearchContext) =>
      impl
        ? impl(criteria, ctx)
        : Promise.resolve(
            opts.offers ?? [stubHotelOffer(code, { currency: opts.currency ?? 'USD' })],
          ),
    );
  }
}

export interface StubHotelFactoryOptions extends StubHotelAdapterOptions {
  code?: string;
  capabilities?: Partial<HotelProviderCapabilities>;
  searchProfile?: Partial<HotelSearchProfile>;
  callPolicy?: CallPolicy;
  /** `callPolicy` que declara la CUENTA del tenant (`provider_accounts.config.callPolicy`). */
  accountCallPolicy?: CallPolicy;
  /** Origen de las credenciales; función para diferenciar por tenant. */
  credentialSource?: CredentialSource | ((tenantId: string) => CredentialSource);
  /** Si se define, `resolveForTenant` lanza este error. */
  failResolveWith?: Error;
  /** Si `true`, `resolveForTenant` lanza `NotFoundException`: tenant sin credenciales. */
  failResolve?: boolean;
}

export class StubHotelProviderFactory implements HotelProviderFactory {
  readonly code: string;
  readonly vertical = 'hotels' as const;
  readonly capabilities: HotelProviderCapabilities;
  readonly searchProfile: HotelSearchProfile;
  readonly defaultCallPolicy: CallPolicy;

  /** Un adapter por tenant, para poder afirmar aislamiento sin montar credenciales reales. */
  private readonly adapters = new Map<string, StubHotelAdapter>();
  /** Tenants para los que se pidió resolución, en orden. */
  readonly resolveCalls: string[] = [];

  constructor(private readonly opts: StubHotelFactoryOptions = {}) {
    this.code = opts.code ?? 'stub-hotels';
    this.capabilities = { ...CAPACIDADES_PLENAS, ...opts.capabilities };
    this.searchProfile = { ...PERFIL_POR_DEFECTO, ...opts.searchProfile };
    this.defaultCallPolicy = opts.callPolicy ?? 'always';
  }

  resolveForTenant(tenantId: string): Promise<TenantAdapter<HotelProviderAdapter>> {
    this.resolveCalls.push(tenantId);

    if (this.opts.failResolve || this.opts.failResolveWith !== undefined) {
      return Promise.reject(
        this.opts.failResolveWith ?? new NotFoundException(`sin cuenta para ${this.code}`),
      );
    }

    return Promise.resolve({
      adapter: this.adapterFor(tenantId),
      credentialSource: this.sourceFor(tenantId),
      callPolicy: this.opts.accountCallPolicy,
    });
  }

  humanizeError(err: unknown): string {
    return err instanceof Error ? `[${this.code}] ${err.message}` : String(err);
  }

  /** El adapter que este stub le entregaría al tenant, sin pasar por el registry. */
  adapterFor(tenantId: string): StubHotelAdapter {
    let adapter = this.adapters.get(tenantId);
    if (!adapter) {
      adapter = new StubHotelAdapter(this.code, this.opts);
      this.adapters.set(tenantId, adapter);
    }
    return adapter;
  }

  private sourceFor(tenantId: string): CredentialSource {
    const s = this.opts.credentialSource ?? 'own';
    return typeof s === 'function' ? s(tenantId) : s;
  }
}

export interface StubHotelOfferOptions {
  hotelId?: string;
  amountMinor?: number;
  currency?: string;
}

/**
 * Hotel con UNA tarifa atribuida al proveedor `code` (RF-40: cada tarifa dice de dónde es).
 * Valida contra `HotelOfferSchema`: un doble que no cumple el contrato probaría otra cosa.
 */
export function stubHotelOffer(code: string, opts: StubHotelOfferOptions = {}): HotelOffer {
  const hotelId = opts.hotelId ?? 'H-1';
  const amountMinor = opts.amountMinor ?? 100_000;
  const currency = opts.currency ?? 'USD';
  return {
    hotelId,
    roompacks: [
      {
        id: `${code}-${hotelId}-RP`,
        provider: { name: code, offerRef: `${code}-${hotelId}-REF` },
        board: 'RO',
        rooms: [{ name: 'Doble estándar', reference: 1, bedOptions: [] }],
        cancellation: { refundable: false, status: 'non_refundable', rules: [] },
        price: { total: { amountMinor, currency }, taxesDetail: [] },
      },
    ],
  };
}
