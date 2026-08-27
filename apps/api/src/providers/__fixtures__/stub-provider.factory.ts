import { NotFoundException } from '@nestjs/common';
import type { Offer } from '@sales-travel/canonical';
import type {
  FlightSearchCriteria,
  OfferPriceResult,
  OrderCancelResult,
  OrderCreateRequest,
  OrderCreateResult,
  OrderPayRequest,
  OrderPayResult,
  OrderReshopRequest,
  OrderReshopResult,
  OrderView,
  SearchContext,
  ServiceListRequest,
  ServiceListResult,
} from '@sales-travel/domain';
import { vi } from 'vitest';
import type {
  CallPolicy,
  CredentialSource,
  FlightProviderAdapter,
  ProviderCapabilities,
  ProviderVertical,
  TenantAdapter,
  TenantProviderFactory,
} from '../provider.types.js';

/**
 * Segundo proveedor de vuelos, ANÓNIMO y sólo para tests.
 *
 * Existe para poder demostrar el fan-out multi-proveedor, el enrutado por `provider.name` y
 * la degradación parcial ANTES de que haya un segundo proveedor real, y sin apostar por
 * ninguno en concreto: el día que entre uno, estos tests siguen valiendo tal cual.
 */

const CAPACIDADES_PLENAS: ProviderCapabilities = {
  retrieve: true,
  cancel: true,
  pay: true,
  services: true,
  reshop: true,
};

export interface StubAdapterOptions {
  /** Ofertas que devuelve `search`. Por defecto, una con `provider.name` = el code del stub. */
  offers?: Offer[];
  /** Reemplaza por completo el cuerpo de `search` (para fallos, demoras o coordinación). */
  searchImpl?: (criteria: FlightSearchCriteria, ctx: SearchContext) => Promise<Offer[]>;
}

/** Adapter de vuelos completo (los cuatro ports) con todos los métodos espiables. */
export class StubFlightAdapter implements FlightProviderAdapter {
  readonly search: (criteria: FlightSearchCriteria, ctx: SearchContext) => Promise<Offer[]>;
  readonly priceOffer = vi.fn(
    (offer: Offer, _criteria: FlightSearchCriteria, _ctx: SearchContext) =>
      Promise.resolve<OfferPriceResult>({ offer, priceChanged: false, warnings: [] }),
  );
  readonly createOrder = vi.fn((_req: OrderCreateRequest, _ctx: SearchContext) =>
    Promise.resolve<OrderCreateResult>({
      outcome: 'CONFIRMED',
      pnr: `${this.code}-PNR`,
      items: [{ kind: 'flight', status: 'CONFIRMED' }],
      issues: [],
    }),
  );
  readonly retrieveForDisplay = vi.fn((orderId: string, _ctx: SearchContext) =>
    Promise.resolve<OrderView>({ found: true, orderId, airlineLocators: [], warnings: [] }),
  );
  readonly cancelOrder = vi.fn((_orderId: string, _ctx: SearchContext) =>
    Promise.resolve<OrderCancelResult>({ success: true, warnings: [] }),
  );
  readonly cancelBnplOrder = vi.fn((_orderId: string, _ctx: SearchContext) =>
    Promise.resolve<OrderCancelResult>({ success: true, warnings: [] }),
  );
  readonly payOrder = vi.fn((req: OrderPayRequest, _ctx: SearchContext) =>
    Promise.resolve<OrderPayResult>({ success: true, orderId: req.orderId, warnings: [] }),
  );
  readonly listServices = vi.fn((_req: ServiceListRequest, _ctx: SearchContext) =>
    Promise.resolve<ServiceListResult>({ services: [], warnings: [] }),
  );
  readonly reshopWithTickets = vi.fn((_req: OrderReshopRequest, _ctx: SearchContext) =>
    Promise.resolve<OrderReshopResult>({
      success: true,
      amountDue: { amount: 0, currency: 'USD' },
      isResidualValue: false,
      warnings: [],
    }),
  );

  constructor(
    readonly code: string,
    opts: StubAdapterOptions = {},
  ) {
    const impl = opts.searchImpl;
    this.search = vi.fn((criteria: FlightSearchCriteria, ctx: SearchContext) =>
      impl ? impl(criteria, ctx) : Promise.resolve(opts.offers ?? [stubOffer(code, ctx.tenantId)]),
    );
  }
}

export interface StubFactoryOptions extends StubAdapterOptions {
  code?: string;
  vertical?: ProviderVertical;
  capabilities?: Partial<ProviderCapabilities>;
  callPolicy?: CallPolicy;
  /** Origen de las credenciales; función para diferenciar por tenant. */
  credentialSource?: CredentialSource | ((tenantId: string) => CredentialSource);
  /** Si se define, `resolveForTenant` lanza este error. */
  failResolveWith?: Error;
  /** Si `true`, `resolveForTenant` lanza `NotFoundException`: tenant sin credenciales. */
  failResolve?: boolean;
}

export class StubProviderFactory implements TenantProviderFactory<FlightProviderAdapter> {
  readonly code: string;
  readonly vertical: ProviderVertical;
  readonly capabilities: ProviderCapabilities;
  readonly defaultCallPolicy: CallPolicy;

  /** Un adapter por tenant, para poder afirmar aislamiento sin montar credenciales reales. */
  private readonly adapters = new Map<string, StubFlightAdapter>();
  /** Tenants para los que se pidió resolución, en orden. */
  readonly resolveCalls: string[] = [];

  constructor(private readonly opts: StubFactoryOptions = {}) {
    this.code = opts.code ?? 'stub-air';
    this.vertical = opts.vertical ?? 'flights';
    this.capabilities = { ...CAPACIDADES_PLENAS, ...opts.capabilities };
    this.defaultCallPolicy = opts.callPolicy ?? 'always';
  }

  async forTenant(tenantId: string): Promise<FlightProviderAdapter> {
    return (await this.resolveForTenant(tenantId)).adapter;
  }

  resolveForTenant(tenantId: string): Promise<TenantAdapter<FlightProviderAdapter>> {
    this.resolveCalls.push(tenantId);

    if (this.opts.failResolve || this.opts.failResolveWith !== undefined) {
      return Promise.reject(
        this.opts.failResolveWith ?? new NotFoundException(`sin cuenta para ${this.code}`),
      );
    }

    return Promise.resolve({
      adapter: this.adapterFor(tenantId),
      credentialSource: this.sourceFor(tenantId),
    });
  }

  humanizeError(err: unknown): string {
    return err instanceof Error ? `[${this.code}] ${err.message}` : String(err);
  }

  /** El adapter que este stub le entregaría al tenant, sin pasar por el registry. */
  adapterFor(tenantId: string): StubFlightAdapter {
    let adapter = this.adapters.get(tenantId);
    if (!adapter) {
      adapter = new StubFlightAdapter(this.code, this.opts);
      this.adapters.set(tenantId, adapter);
    }
    return adapter;
  }

  private sourceFor(tenantId: string): CredentialSource {
    const s = this.opts.credentialSource ?? 'own';
    return typeof s === 'function' ? s(tenantId) : s;
  }
}

/** Oferta canónica mínima atribuida al proveedor `code`. */
export function stubOffer(code: string, tenantId: string, amountMinor = 100_000): Offer {
  return {
    id: `${code}-offer-${amountMinor}`,
    tenantId,
    products: ['flight'],
    provider: { name: code, offerRef: `${code}-REF` },
    total: { amountMinor, currency: 'USD' },
    baseFare: { amountMinor: Math.round(amountMinor * 0.8), currency: 'USD' },
    taxes: { amountMinor: Math.round(amountMinor * 0.2), currency: 'USD' },
    fetchedAt: '2026-08-26T12:00:00.000Z',
    expiresAt: '2026-08-26T12:30:00.000Z',
  };
}
