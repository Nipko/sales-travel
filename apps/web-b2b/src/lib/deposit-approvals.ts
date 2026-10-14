import type { Route } from 'next';
import { nodeKindLabel } from './tenant-network';
import {
  formatMinor,
  isCurrencyCode,
  isUuid,
  parseDepositReport,
  type DepositReport,
  type DepositReportStatus,
  type Tone,
} from './wallets';

/**
 * Plataforma → Carteras: los depósitos que informaron las agencias de toda la red y esperan que
 * alguien los verifique contra el banco (`GET /admin/deposit-reports`). Lectura de la respuesta,
 * filtros y textos, sin I/O.
 *
 * Aprobar y rechazar no son de acá: van por las rutas de carteras de cada nodo (lib/wallet-client),
 * las mismas que usa Gestión de Agencias → nodo → Carteras.
 */

/** De quién es el dinero: lo que financia Planetour, lo que financia otro nodo de la red, o todo. */
export type FinancedByFilter = 'platform' | 'network' | 'all';

export interface QueuedNode {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly tenantType: string;
  readonly isBranch: boolean;
  readonly status: string;
}

export interface QueuedFinancier {
  readonly id: string;
  readonly name: string;
  readonly tenantType: string;
}

export interface QueuedDepositReport extends DepositReport {
  readonly tenantId: string;
  readonly tenant: QueuedNode;
  /** `null`: la raíz o un nodo legado, que sólo financia el superadmin. */
  readonly financier: QueuedFinancier | null;
  /** El dinero llegó a la cuenta de Planetour. */
  readonly financedByPlatform: boolean;
}

export interface QueueTotal {
  readonly currency: string;
  readonly exponent: number | null;
  readonly count: number;
  readonly amountMinor: number;
}

export interface DepositApprovals {
  readonly status: DepositReportStatus;
  readonly reports: readonly QueuedDepositReport[];
  readonly nextCursor: string | null;
  /** De todo lo filtrado, por moneda. */
  readonly totals: readonly QueueTotal[];
}

export interface PendingDeposits {
  readonly total: number;
  readonly platform: number;
  readonly network: number;
}

export interface ApprovalsFilters {
  readonly status: DepositReportStatus;
  readonly financedBy: FinancedByFilter;
  /** Un código ISO 4217 o `'all'`. */
  readonly currency: string;
  readonly q: string;
  /** Un nodo y su red (`?nodo=`, el enlace de la ficha de cada nodo), o `null`: toda la red. */
  readonly tenantId: string | null;
}

/** Lo primero que se mira: lo que espera a Planetour. */
export const DEFAULT_APPROVALS_FILTERS: ApprovalsFilters = {
  status: 'pending',
  financedBy: 'platform',
  currency: 'all',
  q: '',
  tenantId: null,
};

/** La pantalla: Plataforma → Carteras. */
export const PLATFORM_CARTERAS: Route = '/admin/plataforma/carteras';

export const SEARCH_MAX_LENGTH = 100;

/**
 * El evento con que la pantalla avisa que resolvió un depósito: el contador del menú se relee sin
 * esperar a la próxima navegación.
 */
export const PENDING_DEPOSITS_CHANGED = 'st:pending-deposits-changed';

// ───────────────────────────── Lectura ─────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseNode(value: unknown): QueuedNode | undefined {
  const r = asRecord(value);
  const id = r?.['id'];
  const name = str(r?.['name']);
  const slug = str(r?.['slug']);
  const tenantType = str(r?.['tenantType']);
  const status = str(r?.['status']);
  if (!isUuid(id) || name === undefined || slug === undefined || tenantType === undefined) {
    return undefined;
  }
  return {
    id: id.toLowerCase(),
    name,
    slug,
    tenantType,
    isBranch: r?.['isBranch'] === true,
    status: status ?? 'active',
  };
}

function parseFinancier(value: unknown): QueuedFinancier | null | undefined {
  if (value === null) return null;
  const r = asRecord(value);
  const id = r?.['id'];
  const name = str(r?.['name']);
  const tenantType = str(r?.['tenantType']);
  if (!isUuid(id) || name === undefined || tenantType === undefined) return undefined;
  return { id: id.toLowerCase(), name, tenantType };
}

export function parseQueuedReport(value: unknown): QueuedDepositReport | undefined {
  const base = parseDepositReport(value);
  const r = asRecord(value);
  const tenant = parseNode(r?.['tenant']);
  const financier = parseFinancier(r?.['financier']);
  const financedByPlatform = r?.['financedByPlatform'];
  if (base === undefined || tenant === undefined || financier === undefined) return undefined;
  if (typeof financedByPlatform !== 'boolean') return undefined;
  return { ...base, tenantId: tenant.id, tenant, financier, financedByPlatform };
}

function parseTotal(value: unknown): QueueTotal | undefined {
  const r = asRecord(value);
  const currency = r?.['currency'];
  const exponent = r?.['exponent'];
  const n = count(r?.['count']);
  const amountMinor = count(r?.['amountMinor']);
  if (!isCurrencyCode(currency) || n === undefined || amountMinor === undefined) return undefined;
  if (exponent !== null && (typeof exponent !== 'number' || !Number.isInteger(exponent))) {
    return undefined;
  }
  return { currency, exponent, count: n, amountMinor };
}

const STATUSES: readonly DepositReportStatus[] = ['pending', 'approved', 'rejected'];

/** La respuesta de la cola. Un informe con forma rota se descarta; la respuesta rota, entera. */
export function parseDepositApprovals(value: unknown): DepositApprovals | undefined {
  const r = asRecord(value);
  const status = r?.['status'];
  const reports = r?.['reports'];
  const totals = r?.['totals'];
  const nextCursor = r?.['nextCursor'];
  if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) {
    return undefined;
  }
  if (!Array.isArray(reports) || !Array.isArray(totals)) return undefined;
  if (nextCursor !== null && typeof nextCursor !== 'string') return undefined;
  return {
    status: status as DepositReportStatus,
    reports: reports.flatMap((item) => {
      const parsed = parseQueuedReport(item);
      return parsed === undefined ? [] : [parsed];
    }),
    nextCursor: nextCursor === null || nextCursor === '' ? null : nextCursor,
    totals: totals.flatMap((item) => {
      const parsed = parseTotal(item);
      return parsed === undefined ? [] : [parsed];
    }),
  };
}

export function parsePendingDeposits(value: unknown): PendingDeposits | undefined {
  const r = asRecord(value);
  const total = count(r?.['total']);
  const platform = count(r?.['platform']);
  const network = count(r?.['network']);
  if (total === undefined || platform === undefined || network === undefined) return undefined;
  return { total, platform, network };
}

// ───────────────────────────── Pedido ─────────────────────────────

/** La query del BFF para estos filtros: sólo lo que filtra, sin los valores por omisión. */
export function approvalsSearch(filters: ApprovalsFilters, cursor?: string | null): string {
  const params = new URLSearchParams();
  params.set('status', filters.status);
  if (filters.financedBy !== 'all') params.set('financedBy', filters.financedBy);
  if (filters.currency !== 'all' && isCurrencyCode(filters.currency)) {
    params.set('currency', filters.currency);
  }
  if (filters.tenantId !== null && isUuid(filters.tenantId)) {
    params.set('tenantId', filters.tenantId.toLowerCase());
  }
  // Un tabulador pegado en la búsqueda no rompe la lista: el API rechaza los caracteres de control.
  const q = filters.q
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .slice(0, SEARCH_MAX_LENGTH)
    .trim();
  if (q !== '') params.set('q', q);
  if (cursor !== undefined && cursor !== null && cursor !== '') params.set('cursor', cursor);
  return params.toString();
}

// ───────────────────────────── La URL de la pantalla ─────────────────────────────

/** `?estado=`: cómo va cada estado en la URL (se comparte y sobrevive a recargar). */
const STATUS_PARAM: Readonly<Record<DepositReportStatus, string>> = {
  pending: 'por-aprobar',
  approved: 'aprobados',
  rejected: 'rechazados',
};

/** `?alcance=`: de quién es el dinero. */
const SCOPE_PARAM: Readonly<Record<FinancedByFilter, string>> = {
  platform: 'planetour',
  network: 'otros-nodos',
  all: 'toda-la-red',
};

/**
 * El alcance sin `?alcance=`: lo que espera a Planetour; acotado a un nodo, todo lo de ese nodo
 * (el enlace "N depósitos por aprobar" de su ficha cuenta todos, los financie quien los financie).
 */
export function defaultFinancedBy(tenantId: string | null): FinancedByFilter {
  return tenantId === null ? 'platform' : 'all';
}

function keyOf<V extends string>(
  map: Readonly<Record<V, string>>,
  value: string | undefined,
): V | undefined {
  return (Object.keys(map) as V[]).find((k) => map[k] === value);
}

type SearchParamsLike =
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>;

function paramOf(params: SearchParamsLike, key: string): string | undefined {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const value = params[key];
  return typeof value === 'string' ? value : value?.[0];
}

/**
 * Los filtros de `?estado=&alcance=&moneda=&nodo=`. Un valor que no se conoce es el de siempre: un
 * enlace viejo o editado a mano abre la cola, no un error.
 */
export function filtersFromSearchParams(params: SearchParamsLike): ApprovalsFilters {
  const nodo = paramOf(params, 'nodo');
  const tenantId = isUuid(nodo) ? nodo.toLowerCase() : null;
  const moneda = paramOf(params, 'moneda')?.trim().toUpperCase();
  return {
    status: keyOf(STATUS_PARAM, paramOf(params, 'estado')) ?? 'pending',
    financedBy: keyOf(SCOPE_PARAM, paramOf(params, 'alcance')) ?? defaultFinancedBy(tenantId),
    currency: moneda !== undefined && isCurrencyCode(moneda) ? moneda : 'all',
    q: '',
    tenantId,
  };
}

/** La URL de la pantalla con estos filtros: sólo lo que se aparta de lo de siempre. */
export function carterasHref(filters: ApprovalsFilters): Route {
  const params = new URLSearchParams();
  if (filters.status !== 'pending') params.set('estado', STATUS_PARAM[filters.status]);
  if (filters.financedBy !== defaultFinancedBy(filters.tenantId)) {
    params.set('alcance', SCOPE_PARAM[filters.financedBy]);
  }
  if (filters.currency !== 'all' && isCurrencyCode(filters.currency)) {
    params.set('moneda', filters.currency);
  }
  if (filters.tenantId !== null && isUuid(filters.tenantId)) params.set('nodo', filters.tenantId);
  const query = params.toString();
  return query === '' ? PLATFORM_CARTERAS : `${PLATFORM_CARTERAS}?${query}`;
}

/**
 * Agrega una página a la lista sin repetir: si entre página y página alguien resolvió uno, el
 * cursor puede devolver una fila que ya se ve.
 */
export function appendPage(
  current: readonly QueuedDepositReport[],
  next: readonly QueuedDepositReport[],
): QueuedDepositReport[] {
  const seen = new Set(current.map((r) => r.id));
  return [...current, ...next.filter((r) => !seen.has(r.id))];
}

/**
 * La vista sin un informe que se acaba de resolver, con sus totales descontados. Así la lista no
 * vuelve a la primera página cada vez que se aprueba uno de la tercera.
 */
export function withoutReport(
  view: DepositApprovals,
  report: Pick<QueuedDepositReport, 'id' | 'currency' | 'amountMinor'>,
): DepositApprovals {
  if (!view.reports.some((r) => r.id === report.id)) return view;
  return {
    ...view,
    reports: view.reports.filter((r) => r.id !== report.id),
    totals: view.totals.flatMap((t) => {
      if (t.currency !== report.currency) return [t];
      const left = t.count - 1;
      return left <= 0
        ? []
        : [{ ...t, count: left, amountMinor: Math.max(0, t.amountMinor - report.amountMinor) }];
    }),
  };
}

/**
 * ¿Sacar este informe deja la lista vacía con páginas por cargar? Entonces hay que releer desde el
 * principio: el vacío diría "no hay depósitos por aprobar" con otros esperando detrás de "Cargar más".
 */
export function emptiesLoadedPage(view: DepositApprovals, reportId: string): boolean {
  return view.nextCursor !== null && view.reports.every((r) => r.id === reportId);
}

// ───────────────────────────── Textos ─────────────────────────────

export const STATUS_TABS: readonly {
  readonly value: DepositReportStatus;
  readonly label: string;
}[] = [
  { value: 'pending', label: 'Por aprobar' },
  { value: 'approved', label: 'Aprobados' },
  { value: 'rejected', label: 'Rechazados' },
];

export interface ScopeOption {
  readonly value: FinancedByFilter;
  readonly label: string;
  /** Cuántos esperan en ese alcance, si se sabe. */
  readonly count: number | undefined;
}

/** Los alcances, con cuántos depósitos esperan en cada uno (sólo en la cola de pendientes). */
export function scopeOptions(counts: PendingDeposits | null, showCounts: boolean): ScopeOption[] {
  const n = (value: number | undefined) => (showCounts && counts !== null ? value : undefined);
  return [
    { value: 'platform', label: 'Planetour', count: n(counts?.platform) },
    { value: 'network', label: 'Otros nodos', count: n(counts?.network) },
    { value: 'all', label: 'Toda la red', count: n(counts?.total) },
  ];
}

export const SCOPE_HINT: Readonly<Record<FinancedByFilter, string>> = {
  platform:
    'Agencias, consolidadores y sucursales que financia Planetour: el dinero llegó a su cuenta.',
  network:
    'Agencias que financia un consolidador o una agencia de la red: el dinero llegó a la cuenta de ese nodo y lo aprueba él. Aquí sólo los ves.',
  all: 'Todos los depósitos informados de la red. Apruebas los que financia Planetour.',
};

/** Quién financia a la agencia: a la cuenta de quién llegó el dinero. */
export function financierLabel(
  report: Pick<QueuedDepositReport, 'financier' | 'financedByPlatform'>,
): string {
  if (report.financedByPlatform || report.financier === null) return 'Lo financia Planetour';
  return `Lo financia ${report.financier.name} (${nodeKindLabel(report.financier).toLowerCase()})`;
}

/**
 * ¿Lo resuelve el superadmin desde la cola? Sólo lo que financia Planetour: lo que financia otro nodo
 * llegó a la cuenta de ese nodo, que es quien puede verificarlo contra su extracto. Se ve, pero no se
 * aprueba ni se rechaza desde aquí.
 */
export function canResolveReport(
  report: Pick<QueuedDepositReport, 'financier' | 'financedByPlatform'>,
): boolean {
  return report.financedByPlatform || report.financier === null;
}

/** Quién lo aprueba cuando no es Planetour ("Lo aprueba Consolidador Andino"); si no, vacío. */
export function approverLabel(
  report: Pick<QueuedDepositReport, 'financier' | 'financedByPlatform'>,
): string {
  return canResolveReport(report) || report.financier === null
    ? ''
    : `Lo aprueba ${report.financier.name}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Desde cuándo espera un depósito, en palabras ("hace 3 horas", "ayer", "hace 4 días"). */
export function sinceLabel(iso: string, now: number): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '';
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return 'hace un momento';
  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
  if (elapsed < HOUR) return rtf.format(-Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return rtf.format(-Math.floor(elapsed / HOUR), 'hour');
  return rtf.format(-Math.floor(elapsed / DAY), 'day');
}

/** Pasadas 48 horas un depósito sin revisar es una agencia que no puede reservar: se resalta. */
export const STALE_AFTER_MS = 2 * DAY;

export function waitingTone(iso: string, now: number): Tone {
  const at = new Date(iso).getTime();
  return !Number.isNaN(at) && now - at >= STALE_AFTER_MS ? 'warning' : 'neutral';
}

/** "2 depósitos · $ 750.000" por moneda: nunca se suman monedas distintas. */
export function totalLabel(total: QueueTotal): string {
  const what = total.count === 1 ? '1 depósito' : `${total.count} depósitos`;
  return `${what} · ${formatMinor(total.amountMinor, total.currency, total.exponent)}`;
}

/** El texto del contador del menú para un lector de pantalla. */
export function pendingBadgeLabel(n: number): string {
  return n === 1 ? '1 depósito por aprobar' : `${n} depósitos por aprobar`;
}

export interface EmptyCopy {
  readonly title: string;
  readonly text: string;
}

export function emptyCopy(filters: ApprovalsFilters): EmptyCopy {
  if (filters.q.trim() !== '' || filters.currency !== 'all') {
    return {
      title: 'No encontramos depósitos con esos filtros.',
      text: 'Prueba con otra referencia, otra agencia u otra moneda.',
    };
  }
  if (filters.tenantId !== null) {
    return {
      title: 'No hay depósitos en esta lista.',
      text: 'Este nodo y su red no tienen depósitos con estos filtros. Mira toda la red para ver los demás.',
    };
  }
  if (filters.status === 'approved') {
    return {
      title: 'Todavía no hay depósitos aprobados.',
      text: 'Cuando apruebes uno, queda aquí con quién lo aprobó y cuándo.',
    };
  }
  if (filters.status === 'rejected') {
    return {
      title: 'No hay depósitos rechazados.',
      text: 'Cuando rechaces uno, queda aquí con el motivo que vio la agencia.',
    };
  }
  if (filters.financedBy === 'network') {
    return {
      title: 'Ningún depósito espera a otro nodo.',
      text: 'Los consolidadores y agencias de la red tienen sus depósitos al día.',
    };
  }
  return {
    title: 'No hay depósitos por aprobar. Todo al día.',
    text: 'Cuando una agencia informe una transferencia, aparece aquí para que la verifiques contra el extracto.',
  };
}

/** El mensaje de un pedido a la cola que falló, si el BFF no trajo el suyo. */
export function approvalsErrorMessage(status: number): string {
  if (status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión.';
  if (status === 403) return 'Sólo el superadmin de la plataforma ve los depósitos de toda la red.';
  if (status === 400) return 'Revisa los filtros: alguno no es válido.';
  return 'No pudimos cargar los depósitos. Reintenta en unos segundos.';
}

/** Otro lo resolvió mientras lo mirabas (409 DEPOSIT_REPORT_NOT_PENDING): la lista se relee. */
export const ALREADY_RESOLVED_MESSAGE = 'Otra persona ya lo resolvió. Actualizamos la lista.';

/** El aviso al resolver uno. */
export function resolvedMessage(
  kind: 'approve' | 'reject',
  report: Pick<QueuedDepositReport, 'amountMinor' | 'currency' | 'exponent' | 'tenant'>,
): string {
  const amount = formatMinor(report.amountMinor, report.currency, report.exponent);
  return kind === 'approve'
    ? `Depósito aprobado: se acreditaron ${amount} a ${report.tenant.name}.`
    : `Depósito de ${amount} rechazado: ${report.tenant.name} ve el motivo.`;
}
