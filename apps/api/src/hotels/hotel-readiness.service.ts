import { Injectable, Logger } from '@nestjs/common';
import { SELLING_ROLES } from '../auth/roles.js';
import { BrandingService } from '../branding/branding.service.js';
import { NetworkService, type NetworkTenant } from '../network/network.service.js';
import { PortfoliosService } from '../portfolios/portfolios.service.js';
import { ProviderEnablementStore } from '../provider-enablement/provider-enablement.store.js';
import { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import type {
  HotelAccountEnvironment,
  HotelProviderAccountProblem,
} from '../providers/hotel-provider.types.js';
import {
  isDisabledByPlatform,
  isProviderEnabled,
  type CredentialSource,
} from '../providers/provider.types.js';
import { agencyBookingContact } from './hotel-booking-contact.js';

/** El proveedor de la reserva de prueba que guía la pantalla (docs/platform/13, paso 9). */
export const READINESS_PROVIDER = 'tbo-hotels';
/** Nodos que se revisan como mucho, por nombre: cada uno resuelve su cuenta en la bóveda. */
export const READINESS_MAX_NODES = 50;
/** Nodos que se revisan a la vez. */
export const READINESS_CONCURRENCY = 4;
/** Plazo de toda la revisión: lo que no llega queda `unknown` y la pantalla lo dice. */
export const READINESS_DEADLINE_MS = 8_000;

export type HotelReadinessTbo = 'enabled' | 'not-enabled' | 'platform-disabled' | 'unknown';

export type HotelReadinessAccount =
  | {
      readonly status: 'ok';
      readonly source: CredentialSource;
      /** `null` si la cuenta no declara entorno. */
      readonly environment: HotelAccountEnvironment | null;
    }
  | { readonly status: HotelProviderAccountProblem | 'unknown' };

export interface HotelReadinessWallet {
  readonly currency: string;
  readonly status: string;
}

export type HotelReadinessContact = 'ok' | 'missing' | 'unknown';

/** Lo que le falta a un nodo, de lo que se sabe: lo que no se pudo leer no figura acá. */
export type HotelReadinessGap =
  | 'tbo-not-enabled'
  | 'tbo-account'
  | 'wallet'
  | 'support-contact'
  | 'no-sellers';

interface HotelReadinessChecks {
  readonly tbo: HotelReadinessTbo;
  readonly account: HotelReadinessAccount;
  /** Sus carteras, una por moneda. `null`: no se pudieron leer. */
  readonly wallets: readonly HotelReadinessWallet[] | null;
  readonly supportContact: HotelReadinessContact;
  /** Usuarios activos con un rol que vende, sin quien consulta. `null`: no se pudieron leer. */
  readonly activeSellers: number | null;
}

export interface HotelReadinessNode extends HotelReadinessChecks {
  readonly tenantId: string;
  readonly name: string;
  readonly isBranch: boolean;
  /** Todo lo de su lista está bien y se pudo leer. */
  readonly ready: boolean;
  readonly missing: readonly HotelReadinessGap[];
}

export interface HotelReadinessView {
  readonly provider: string;
  readonly nodes: readonly HotelReadinessNode[];
  /** Nodos que cumplían y quedaron fuera por el tope. */
  readonly omitted: number;
  /** Algún dato no se pudo leer o no llegó a tiempo: vale la pena volver a pedirlo. */
  readonly partial: boolean;
}

const LATE = Symbol('late');

const UNREAD: HotelReadinessChecks = {
  tbo: 'unknown',
  account: { status: 'unknown' },
  wallets: null,
  supportContact: 'unknown',
  activeSellers: null,
};

const SELLS: ReadonlySet<string> = new Set<string>(SELLING_ROLES);

/** El nombre de la clase del error para el log, nunca su mensaje. */
function errorNameOf(err: unknown): string {
  return err instanceof Error ? err.name.slice(0, 64) : 'UnknownError';
}

/** Con la cuenta propia del nodo la venta no retiene de ninguna cartera (0060: `exempt`). */
function needsWallet(account: HotelReadinessAccount): boolean {
  return !(account.status === 'ok' && account.source === 'own');
}

function hasUnknown(checks: HotelReadinessChecks): boolean {
  return (
    checks.tbo === 'unknown' ||
    checks.account.status === 'unknown' ||
    checks.wallets === null ||
    checks.supportContact === 'unknown' ||
    checks.activeSellers === null
  );
}

function nodeOf(node: NetworkTenant, checks: HotelReadinessChecks): HotelReadinessNode {
  const missing: HotelReadinessGap[] = [];
  if (checks.tbo !== 'enabled' && checks.tbo !== 'unknown') missing.push('tbo-not-enabled');
  if (checks.account.status !== 'ok' && checks.account.status !== 'unknown') {
    missing.push('tbo-account');
  }
  if (
    needsWallet(checks.account) &&
    checks.wallets !== null &&
    !checks.wallets.some((w) => w.status === 'active')
  ) {
    missing.push('wallet');
  }
  if (checks.supportContact === 'missing') missing.push('support-contact');
  if (checks.activeSellers === 0) missing.push('no-sellers');
  return {
    tenantId: node.id,
    name: node.name,
    isBranch: node.isBranch,
    ready: missing.length === 0 && !hasUnknown(checks),
    missing,
    ...checks,
  };
}

/**
 * Qué le falta a cada sucursal para probar una reserva de hotel con TBO, para el superadmin, que no
 * vende (D-TBO-H1 A): prueba con un vendedor de una sucursal y esta revisión le dice cuál está lista
 * y qué resolver en las demás. Es la lista «Antes de empezar» del paso 9 de docs/platform/13, leída
 * de la base.
 *
 * Revisa las sucursales activas y los nodos con TBO habilitado como excepción, hasta
 * {@link READINESS_MAX_NODES} por nombre. Por nodo: la habilitación de TBO, la cuenta que heredaría
 * (sin llamar a TBO), sus carteras, el contacto de soporte con el MISMO predicado del Book y sus
 * vendedores. De a {@link READINESS_CONCURRENCY} nodos y con un plazo total: lo que falla o no llega
 * queda `unknown`, y la respuesta sale igual.
 *
 * Sólo lee y no deja evento. La autorización (superadmin) la valida el controlador antes de llamar.
 */
@Injectable()
export class HotelReadinessService {
  private readonly logger = new Logger(HotelReadinessService.name);

  constructor(
    private readonly network: NetworkService,
    private readonly enablement: ProviderEnablementStore,
    private readonly registry: HotelProviderRegistry,
    private readonly portfolios: PortfoliosService,
    private readonly branding: BrandingService,
  ) {}

  async readiness(userId: string): Promise<HotelReadinessView> {
    const candidates = await this.candidates(userId);
    const nodes = await this.checkAll(userId, candidates.slice(0, READINESS_MAX_NODES));
    const view: HotelReadinessView = {
      provider: READINESS_PROVIDER,
      nodes,
      omitted: Math.max(0, candidates.length - READINESS_MAX_NODES),
      partial: nodes.some(hasUnknown),
    };
    this.logger.log(
      `hotels.readiness nodes=${nodes.length} ready=${nodes.filter((n) => n.ready).length} unknown=${nodes.filter(hasUnknown).length} omitted=${view.omitted}`,
    );
    return view;
  }

  /**
   * Las sucursales activas y los nodos activos con TBO habilitado como excepción, por nombre. La red
   * se lee con el usuario del request, como el resto del panel de la plataforma.
   */
  private async candidates(userId: string): Promise<NetworkTenant[]> {
    const [network, settings] = await Promise.all([
      this.network.listNetwork(userId),
      this.enablement.listRows(),
    ]);
    const enabled = new Set(
      settings.flatMap((s) =>
        s.providerCode === READINESS_PROVIDER && s.enabled && s.tenantId !== null
          ? [s.tenantId]
          : [],
      ),
    );
    return network
      .filter((t) => t.status === 'active' && (t.isBranch || enabled.has(t.id)))
      .sort((a, b) => a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id));
  }

  private async checkAll(
    userId: string,
    nodes: readonly NetworkTenant[],
  ): Promise<HotelReadinessNode[]> {
    const out: HotelReadinessNode[] = [];
    const queue = nodes.map((node, index) => ({ node, index }));
    const clock = { expired: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof LATE>((resolve) => {
      timer = setTimeout(() => {
        clock.expired = true;
        resolve(LATE);
      }, READINESS_DEADLINE_MS);
    });

    const worker = async (): Promise<void> => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        // Pasado el plazo no se empieza otro nodo: sus consultas saldrían igual a la base.
        out[item.index] = clock.expired
          ? nodeOf(item.node, UNREAD)
          : await this.check(userId, item.node, deadline);
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(READINESS_CONCURRENCY, nodes.length) }, worker),
      );
    } finally {
      clearTimeout(timer);
    }
    return out;
  }

  private async check(
    userId: string,
    node: NetworkTenant,
    deadline: Promise<typeof LATE>,
  ): Promise<HotelReadinessNode> {
    const tenantId = node.id;
    const [tbo, account, wallets, supportContact, activeSellers] = await Promise.all([
      this.read('tbo', tenantId, deadline, () => this.tboOf(tenantId)),
      this.read('account', tenantId, deadline, () => this.accountOf(tenantId)),
      this.read('wallets', tenantId, deadline, () => this.walletsOf(tenantId)),
      this.read('support_contact', tenantId, deadline, () => this.contactOf(tenantId)),
      this.read('sellers', tenantId, deadline, () => this.sellersOf(userId, tenantId)),
    ]);
    return nodeOf(node, {
      tbo: tbo ?? UNREAD.tbo,
      account: account ?? UNREAD.account,
      wallets: wallets ?? UNREAD.wallets,
      supportContact: supportContact ?? UNREAD.supportContact,
      activeSellers: activeSellers ?? UNREAD.activeSellers,
    });
  }

  /** Una consulta, o `undefined` si falla o no llega antes del plazo. */
  private async read<T>(
    check: string,
    tenantId: string,
    deadline: Promise<typeof LATE>,
    run: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      const value = await Promise.race([run(), deadline]);
      return value === LATE ? undefined : value;
    } catch (err) {
      this.logger.warn(
        `hotels.readiness.check_failed check=${check} tenant=${tenantId} error=${errorNameOf(err)}`,
      );
      return undefined;
    }
  }

  /** Lo mismo que decide la búsqueda: el ajuste de la plataforma o, sin ninguno, la política. */
  private async tboOf(tenantId: string): Promise<HotelReadinessTbo> {
    const entries = await this.registry.enablementOf(tenantId);
    const entry = entries.find((e) => e.code === READINESS_PROVIDER);
    if (entry === undefined) return 'not-enabled';
    if (isDisabledByPlatform(entry.decision)) return 'platform-disabled';
    return isProviderEnabled(entry.decision, entry.callPolicy) ? 'enabled' : 'not-enabled';
  }

  private async accountOf(tenantId: string): Promise<HotelReadinessAccount> {
    const account = await this.registry.accountStatusOf(tenantId, READINESS_PROVIDER);
    if (account.status !== 'ok') return { status: account.status };
    return { status: 'ok', source: account.source, environment: account.environment ?? null };
  }

  private async walletsOf(tenantId: string): Promise<HotelReadinessWallet[]> {
    const { portfolios } = await this.portfolios.overview(tenantId);
    return portfolios.map((w) => ({ currency: w.currency, status: w.status }));
  }

  /** El contacto de soporte con la herencia de marca y el predicado del Book (`AGENCY_CONTACT_MISSING`). */
  private async contactOf(tenantId: string): Promise<'ok' | 'missing'> {
    const contact = agencyBookingContact(await this.branding.resolveSupportContact(tenantId));
    return contact === undefined ? 'missing' : 'ok';
  }

  /**
   * Quien consulta no cuenta aunque tenga un rol que vende en el nodo: el superadmin no vende con
   * ninguna membership (`RolesGuard`), así que no es el vendedor con que va a probar.
   */
  private async sellersOf(userId: string, tenantId: string): Promise<number> {
    const users = await this.network.listTenantUsers(userId, tenantId);
    return users.filter(
      (u) =>
        u.userId !== userId &&
        u.userStatus === 'active' &&
        u.membershipStatus === 'active' &&
        SELLS.has(u.role),
    ).length;
  }
}
