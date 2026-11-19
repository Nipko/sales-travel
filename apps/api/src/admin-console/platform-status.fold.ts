import type { AttentionView, CatalogView, ProviderSignalsView } from './admin-overview.fold.js';
import type { PostSaleSweepView, SystemReconciliationView } from './admin-system.service.js';
import type { PendingView } from './project-pendings.js';
import type { ProviderHealth } from './provider-health.fold.js';

/**
 * Plataforma → Estado: de lo que ya leen Salud, Sistema y el Resumen a un semáforo por área, para
 * ver de un vistazo si algo está roto y adónde ir a mirarlo. No lee nada: pliega. Cada área dice su
 * nivel, una frase con el porqué y el enlace a la pantalla que tiene el detalle.
 */

export type StatusLevel = 'ok' | 'warn' | 'critical';

export type StatusAreaId =
  | 'providers'
  | 'reconciliation'
  | 'post-sale-sweep'
  | 'catalogs'
  | 'orders'
  | 'deposits';

export interface StatusArea {
  id: StatusAreaId;
  label: string;
  level: StatusLevel;
  /** Una frase: qué pasa, o que todo está bien. */
  summary: string;
  /** Hasta 5 líneas de detalle (un proveedor, un motivo). */
  details: string[];
  /** La pantalla de la consola que lo muestra entero. */
  href: string;
}

export interface PlatformStatusInputs {
  health: readonly ProviderHealth[];
  signals: ProviderSignalsView;
  sweep: PostSaleSweepView;
  reconciliation: SystemReconciliationView;
  catalogs: readonly CatalogView[];
  attention: AttentionView;
}

export interface PlatformStatusView {
  /** ISO 8601. */
  generatedAt: string;
  /** El peor nivel de las áreas. */
  overall: StatusLevel;
  areas: StatusArea[];
  /** Lo que corre: la versión desplegada y desde cuándo. */
  runtime: { version: string; startedAt: string };
  pendings: PendingView[];
}

/** Un proveedor sin búsquedas recientes cuyo último resultado es más viejo que esto: algo pasa. */
export const IDLE_STALE_RESULT_DAYS = 3;

const DAY_MS = 86_400_000;
const RANK: Record<StatusLevel, number> = { ok: 0, warn: 1, critical: 2 };
const MAX_DETAILS = 5;

export function worst(levels: readonly StatusLevel[]): StatusLevel {
  return levels.reduce<StatusLevel>((acc, l) => (RANK[l] > RANK[acc] ? l : acc), 'ok');
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function daysSince(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  return Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS);
}

/** El nombre que se muestra de un proveedor y su vertical cuando tiene más de una. */
function who(h: Pick<ProviderHealth, 'providerCode' | 'vertical'>): string {
  return `${h.providerCode} (${h.vertical})`;
}

export function foldProvidersArea(
  health: readonly ProviderHealth[],
  signals: ProviderSignalsView,
  now: Date,
): StatusArea {
  const down = health.filter((h) => h.status === 'down');
  const degraded = health.filter((h) => h.status === 'degraded');
  const idleStale = health.filter((h) => {
    if (h.status !== 'idle') return false;
    const days = daysSince(h.lastResultAt, now);
    return days === null || days >= IDLE_STALE_RESULT_DAYS;
  });
  const paused = signals.killSwitched;
  const open = signals.openCircuits;

  const details = [
    ...down.map((h) => `${who(h)}: caído. ${h.reason}`),
    ...degraded.map((h) => `${who(h)}: degradado. ${h.reason}`),
    ...idleStale.map((h) => {
      const days = daysSince(h.lastResultAt, now);
      return `${who(h)}: sin búsquedas recientes y ${days === null ? 'nunca trajo resultados' : `sin resultados hace ${plural(days, 'día', 'días')}`}.`;
    }),
    ...paused.map((k) => `${k.code}: apagado desde el panel (${k.level}).`),
    ...open.map(
      (c) => `${c.code}: circuito ${c.state} tras ${plural(c.failures, 'falla', 'fallas')}.`,
    ),
  ];

  const level: StatusLevel =
    down.length > 0
      ? 'critical'
      : degraded.length + idleStale.length + paused.length + open.length > 0
        ? 'warn'
        : 'ok';

  const working = health.filter((h) => h.status === 'ok').length;
  const summary =
    level === 'ok'
      ? health.length === 0
        ? 'Sin búsquedas en los últimos 7 días.'
        : `${plural(working, 'proveedor responde', 'proveedores responden')} con resultados.`
      : down.length > 0
        ? `${plural(down.length, 'proveedor caído', 'proveedores caídos')}: ${down.map(who).join(', ')}.`
        : `${plural(details.length, 'aviso', 'avisos')} de proveedores.`;

  return {
    id: 'providers',
    label: 'Proveedores',
    level,
    summary,
    details: details.slice(0, MAX_DETAILS),
    href: '/admin/plataforma/salud',
  };
}

const FAILED_RUN_STATUSES = new Set(['failed', 'invalid', 'abandoned']);

export function foldReconciliationArea(reconciliation: SystemReconciliationView): StatusArea {
  const failing = reconciliation.byProvider.filter(
    (p) => p.lastStatus !== null && FAILED_RUN_STATUSES.has(p.lastStatus),
  );
  const stale = reconciliation.byProvider.filter((p) => p.stale && !failing.includes(p));
  const critical = reconciliation.byProvider.filter((p) => p.criticalItems > 0);

  const details = [
    ...failing.map(
      (p) =>
        `${p.providerCode}: la última corrida terminó «${p.lastStatus ?? ''}» (${plural(p.failedRuns, 'fallida', 'fallidas')} de ${String(p.runs)} en ${String(reconciliation.sinceDays)} días).`,
    ),
    ...stale.map((p) => `${p.providerCode}: sin una corrida terminada en 36 horas.`),
    ...critical.map(
      (p) =>
        `${p.providerCode}: ${plural(p.criticalItems, 'divergencia crítica', 'divergencias críticas')}.`,
    ),
  ];

  const level: StatusLevel =
    failing.length + stale.length > 0 ? 'critical' : critical.length > 0 ? 'warn' : 'ok';

  return {
    id: 'reconciliation',
    label: 'Conciliación diaria',
    level,
    summary:
      level === 'ok'
        ? reconciliation.byProvider.length === 0
          ? `Sin corridas en los últimos ${String(reconciliation.sinceDays)} días.`
          : 'Todas las cuentas concilian sin divergencias críticas.'
        : failing.length + stale.length > 0
          ? `${plural(failing.length + stale.length, 'proveedor no concilia', 'proveedores no concilian')}.`
          : `${plural(
              critical.reduce((n, p) => n + p.criticalItems, 0),
              'divergencia crítica',
              'divergencias críticas',
            )} por revisar.`,
    details: details.slice(0, MAX_DETAILS),
    href: '/admin/plataforma/sistema',
  };
}

export function foldSweepArea(sweep: PostSaleSweepView): StatusArea {
  const level: StatusLevel = sweep.stale ? 'critical' : sweep.failures24h > 0 ? 'warn' : 'ok';
  const details: string[] = [];
  if (sweep.failures24h > 0) {
    details.push(
      `${plural(sweep.failures24h, 'corrida fallida', 'corridas fallidas')} de ${String(sweep.runs24h)} en 24 horas.`,
    );
  }
  if (sweep.tenantsFailed !== null && sweep.tenantsFailed > 0) {
    details.push(
      `La última corrida no pudo revisar ${plural(sweep.tenantsFailed, 'nodo', 'nodos')}.`,
    );
  }
  return {
    id: 'post-sale-sweep',
    label: 'Barrido de post-venta',
    level,
    summary: sweep.stale
      ? `Sin una corrida correcta en ${String(sweep.staleAfterMinutes)} minutos: no se verifican reservas ni plazos.`
      : `Corre cada ${String(sweep.everyMinutes)} minutos.`,
    details,
    href: '/admin/plataforma/sistema',
  };
}

export function foldCatalogsArea(catalogs: readonly CatalogView[]): StatusArea {
  const stale = catalogs.filter((c) => c.stale);
  const failing = catalogs.filter((c) => c.failedCities > 0);
  const details = [
    ...stale.map((c) => `${c.providerCode}: sin sincronizar en más de 48 horas.`),
    ...failing.map(
      (c) =>
        `${c.providerCode}: ${plural(c.failedCities, 'ciudad', 'ciudades')} con error en el último sync.`,
    ),
  ];
  return {
    id: 'catalogs',
    label: 'Catálogos de hoteles',
    level: details.length > 0 ? 'warn' : 'ok',
    summary:
      details.length > 0
        ? `${plural(new Set([...stale, ...failing]).size, 'catálogo atrasado o con errores', 'catálogos atrasados o con errores')}.`
        : 'Al día.',
    details: details.slice(0, MAX_DETAILS),
    href: '/admin/plataforma/sistema',
  };
}

/** Los motivos con plata trabada o una cancelación que no salió: no pueden esperar. */
const URGENT_REASONS = ['hold-orphan', 'hold-conflict', 'cancel-failed'] as const;

const REASON_LABEL: Record<string, string> = {
  'hold-orphan': 'retención de cartera sin orden abierta',
  'hold-conflict': 'retención de cartera en conflicto',
  'cancel-failed': 'cancelación fallida',
  review: 'para revisar',
  'create-stuck': 'creación trabada',
  reconciliation: 'divergencia de conciliación',
  'hcn-missing': 'sin número de confirmación del hotel',
  'verifying-long': 'verificación larga',
};

export function foldOrdersArea(attention: AttentionView): StatusArea {
  const { orders, postSale } = attention;
  const urgent = URGENT_REASONS.reduce((n, r) => n + orders.byReason[r], 0);
  const details = Object.entries(orders.byReason)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([reason, n]) => `${plural(n, 'reserva', 'reservas')}: ${REASON_LABEL[reason] ?? reason}.`,
    );
  if (postSale.failed > 0) {
    details.push(
      `${plural(postSale.failed, 'operación de post-venta falló', 'operaciones de post-venta fallaron')}.`,
    );
  }
  if (postSale.stuck > 0) {
    details.push(
      `${plural(postSale.stuck, 'operación de post-venta trabada', 'operaciones de post-venta trabadas')}.`,
    );
  }
  const level: StatusLevel =
    urgent > 0 ? 'critical' : orders.total + postSale.failed + postSale.stuck > 0 ? 'warn' : 'ok';
  return {
    id: 'orders',
    label: 'Reservas',
    level,
    summary:
      orders.total === 0
        ? 'Ninguna reserva espera a una persona.'
        : `${plural(orders.total, 'reserva espera', 'reservas esperan')} a una persona.`,
    details: details.slice(0, MAX_DETAILS),
    href: '/admin/plataforma/reservas',
  };
}

export function foldDepositsArea(attention: AttentionView): StatusArea {
  const { platform, network } = attention.depositReports;
  return {
    id: 'deposits',
    label: 'Depósitos por aprobar',
    level: platform > 0 ? 'warn' : 'ok',
    summary:
      platform > 0
        ? `${plural(platform, 'depósito espera', 'depósitos esperan')} que la plataforma lo apruebe.`
        : 'Ninguno espera a la plataforma.',
    details:
      network > 0
        ? [
            `${plural(network, 'depósito espera', 'depósitos esperan')} a un consolidador o agencia de la red.`,
          ]
        : [],
    href: '/admin/plataforma/carteras',
  };
}

export function foldPlatformStatus(
  inputs: PlatformStatusInputs,
  extra: { now: Date; version: string; startedAt: Date; pendings: PendingView[] },
): PlatformStatusView {
  const areas = [
    foldProvidersArea(inputs.health, inputs.signals, extra.now),
    foldReconciliationArea(inputs.reconciliation),
    foldOrdersArea(inputs.attention),
    foldSweepArea(inputs.sweep),
    foldCatalogsArea(inputs.catalogs),
    foldDepositsArea(inputs.attention),
  ];
  return {
    generatedAt: extra.now.toISOString(),
    overall: worst(areas.map((a) => a.level)),
    areas,
    runtime: { version: extra.version, startedAt: extra.startedAt.toISOString() },
    pendings: extra.pendings,
  };
}
