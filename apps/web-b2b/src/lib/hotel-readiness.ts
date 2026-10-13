import type { Route } from 'next';
import { readJson } from './read-json';

/*
 * La guía del superadmin para probar una reserva de hotel (D-TBO-H1 A): el superadmin no vende, así
 * que prueba con un vendedor de una sucursal, y esta guía le dice cuál está lista y qué le falta a
 * las demás. Acá viven la lectura desconfiada de `GET /admin/hotels/readiness`, lo que la pantalla
 * dice de cada sucursal y la llamada del navegador. Quién la puede leer (sólo superadmin) lo decide
 * el API.
 */

export type ReadinessTbo = 'enabled' | 'not-enabled' | 'platform-disabled' | 'unknown';

export type ReadinessAccount =
  | {
      readonly status: 'ok';
      readonly source: 'own' | 'inherited' | 'env';
      readonly environment: 'test' | 'live' | null;
    }
  | { readonly status: 'no-credentials' | 'incomplete' | 'not-allowed' | 'unknown' };

export interface ReadinessWallet {
  readonly currency: string;
  readonly status: string;
}

export type ReadinessGap =
  | 'tbo-not-enabled'
  | 'tbo-account'
  | 'wallet'
  | 'support-contact'
  | 'no-sellers';

/** Espejo de `HotelReadinessNode` del API. */
export interface ReadinessNode {
  readonly tenantId: string;
  readonly name: string;
  readonly isBranch: boolean;
  readonly ready: boolean;
  readonly missing: readonly ReadinessGap[];
  readonly tbo: ReadinessTbo;
  readonly account: ReadinessAccount;
  /** `null`: no se pudieron leer. */
  readonly wallets: readonly ReadinessWallet[] | null;
  readonly supportContact: 'ok' | 'missing' | 'unknown';
  /** `null`: no se pudieron leer. */
  readonly activeSellers: number | null;
}

export interface HotelReadiness {
  readonly nodes: readonly ReadinessNode[];
  /** Sucursales que quedaron fuera por el tope del API. */
  readonly omitted: number;
  /** Algún dato no se pudo leer a tiempo. */
  readonly partial: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;

const TBO_STATES: readonly ReadinessTbo[] = ['enabled', 'not-enabled', 'platform-disabled'];
const ACCOUNT_PROBLEMS = ['no-credentials', 'incomplete', 'not-allowed'] as const;
const GAPS: readonly ReadinessGap[] = [
  'tbo-not-enabled',
  'tbo-account',
  'wallet',
  'support-contact',
  'no-sellers',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((a) => a === value);
}

function accountOf(value: unknown): ReadinessAccount {
  if (!isRecord(value)) return { status: 'unknown' };
  if (value['status'] === 'ok') {
    const source = oneOf(value['source'], ['own', 'inherited', 'env'] as const);
    if (source === undefined) return { status: 'unknown' };
    const environment = oneOf(value['environment'], ['test', 'live'] as const) ?? null;
    return { status: 'ok', source, environment };
  }
  return { status: oneOf(value['status'], ACCOUNT_PROBLEMS) ?? 'unknown' };
}

function walletsOf(value: unknown): ReadinessWallet[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((w): ReadinessWallet[] =>
    isRecord(w) &&
    typeof w['currency'] === 'string' &&
    CURRENCY_RE.test(w['currency']) &&
    typeof w['status'] === 'string'
      ? [{ currency: w['currency'], status: w['status'] }]
      : [],
  );
}

function sellersOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Una sucursal, o `undefined` si le falta lo que la identifica. Un estado que la web no conoce se
 * lee como «sin revisar»: no se adivina que está bien.
 */
function nodeOf(value: unknown): ReadinessNode | undefined {
  if (!isRecord(value)) return undefined;
  const { tenantId, name } = value;
  if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) return undefined;
  if (typeof name !== 'string' || name.trim() === '') return undefined;
  const missing = Array.isArray(value['missing'])
    ? value['missing'].flatMap((m): ReadinessGap[] => {
        const gap = oneOf(m, GAPS);
        return gap === undefined ? [] : [gap];
      })
    : [];
  return {
    tenantId: tenantId.toLowerCase(),
    name,
    isBranch: value['isBranch'] === true,
    ready: value['ready'] === true,
    missing,
    tbo: oneOf(value['tbo'], TBO_STATES) ?? 'unknown',
    account: accountOf(value['account']),
    wallets: walletsOf(value['wallets']),
    supportContact: oneOf(value['supportContact'], ['ok', 'missing'] as const) ?? 'unknown',
    activeSellers: sellersOf(value['activeSellers']),
  };
}

/** La respuesta del API, o `undefined` si no se entiende (la pantalla lo dice y ofrece reintentar). */
export function parseHotelReadiness(value: unknown): HotelReadiness | undefined {
  if (!isRecord(value) || !Array.isArray(value['nodes'])) return undefined;
  const nodes: ReadinessNode[] = [];
  for (const raw of value['nodes']) {
    const node = nodeOf(raw);
    if (node === undefined) return undefined;
    nodes.push(node);
  }
  const omitted = value['omitted'];
  return {
    nodes,
    omitted: typeof omitted === 'number' && Number.isInteger(omitted) && omitted > 0 ? omitted : 0,
    partial: value['partial'] === true || nodes.some(hasUnknown),
  };
}

function hasUnknown(node: ReadinessNode): boolean {
  return (
    node.tbo === 'unknown' ||
    node.account.status === 'unknown' ||
    node.wallets === null ||
    node.supportContact === 'unknown' ||
    node.activeSellers === null
  );
}

// ───────────────────────── Lo que dice la pantalla ─────────────────────────

export type ReadinessCheckState = 'ok' | 'missing' | 'unknown';

export interface ReadinessAction {
  readonly label: string;
  readonly href: Route;
}

export interface ReadinessCheck {
  readonly key: 'tbo' | 'account' | 'wallet' | 'support-contact' | 'sellers';
  readonly state: ReadinessCheckState;
  readonly text: string;
  readonly action?: ReadinessAction;
}

export const READINESS_TITLE = 'Probar una reserva de hotel';
export const READINESS_INTRO =
  'Entra con un vendedor de una de estas sucursales. Para llegar a «Confirmar reserva», cada una necesita todo lo de su lista.';
export const READINESS_READY = 'Lista para probar';
export const READINESS_FOOTER =
  'Las reservas con la cuenta de prueba no son reales. Elige una tarifa con cancelación gratis y cancélala al terminar.';
/** Sin sucursales: el texto, y el enlace a Gestión de Agencias que lo sigue. */
export const READINESS_EMPTY = 'Todavía no hay sucursales.';
export const READINESS_EMPTY_ACTION = 'Crea una en Gestión de Agencias.';
export const READINESS_ERROR = 'No pudimos revisar las sucursales. Inténtalo de nuevo.';
export const READINESS_PARTIAL =
  'Algunos datos no llegaron a tiempo y quedaron sin revisar. Inténtalo de nuevo en unos segundos.';

export const CHECK_STATE_LABEL: Readonly<Record<ReadinessCheckState, string>> = {
  ok: 'Listo',
  missing: 'Falta',
  unknown: 'Sin revisar',
};

/** «USD», «USD y COP», «USD, COP y BRL». */
function joinCurrencies(currencies: readonly string[]): string {
  if (currencies.length <= 1) return currencies.join('');
  return `${currencies.slice(0, -1).join(', ')} y ${currencies.at(-1) ?? ''}`;
}

function stateOf(unknown: boolean, missing: boolean): ReadinessCheckState {
  if (unknown) return 'unknown';
  return missing ? 'missing' : 'ok';
}

function tboCheck(node: ReadinessNode): ReadinessCheck {
  const state = stateOf(node.tbo === 'unknown', node.missing.includes('tbo-not-enabled'));
  if (state === 'unknown') {
    return { key: 'tbo', state, text: 'No pudimos revisar si TBO está habilitado' };
  }
  if (state === 'ok') return { key: 'tbo', state, text: 'TBO habilitado' };
  return {
    key: 'tbo',
    state,
    text:
      node.tbo === 'platform-disabled'
        ? 'TBO está deshabilitado para esta sucursal'
        : 'TBO no está habilitado',
    action: {
      label: 'Habilitar en Proveedores',
      href: `/admin/tenants/${node.tenantId}`,
    },
  };
}

const ACCOUNT_ENVIRONMENT: Readonly<Record<'test' | 'live', string>> = {
  test: 'Prueba',
  live: 'Producción',
};

const ACCOUNT_PROBLEM_TEXT: Readonly<Record<(typeof ACCOUNT_PROBLEMS)[number], string>> = {
  'no-credentials': 'Sin cuenta TBO heredada',
  incomplete: 'La cuenta TBO que hereda está incompleta',
  'not-allowed': 'Su cuenta TBO no se admite: TBO opera sólo con la de Planetour o un consolidador',
};

function accountCheck(node: ReadinessNode): ReadinessCheck {
  const { account } = node;
  if (account.status === 'unknown') {
    return { key: 'account', state: 'unknown', text: 'No pudimos revisar la cuenta TBO' };
  }
  if (account.status === 'ok') {
    const base = account.source === 'own' ? 'Cuenta TBO propia activa' : 'Cuenta TBO activa';
    const environment =
      account.environment === null ? '' : ACCOUNT_ENVIRONMENT[account.environment];
    return {
      key: 'account',
      state: 'ok',
      text: environment === '' ? base : `${base} · ${environment}`,
    };
  }
  return {
    key: 'account',
    state: 'missing',
    text: ACCOUNT_PROBLEM_TEXT[account.status],
    action: { label: 'Ir a Proveedores (GDS)', href: '/admin/proveedores' },
  };
}

function walletCheck(node: ReadinessNode): ReadinessCheck {
  if (node.wallets === null) {
    return { key: 'wallet', state: 'unknown', text: 'No pudimos revisar sus carteras' };
  }
  if (node.missing.includes('wallet')) {
    return {
      key: 'wallet',
      state: 'missing',
      text: 'Sin cartera activa',
      action: {
        label: 'Habilitar una cartera',
        href: `/admin/tenants/${node.tenantId}/carteras`,
      },
    };
  }
  const active = node.wallets.filter((w) => w.status === 'active').map((w) => w.currency);
  if (active.length === 0) {
    // Lo único que exime de cartera: la venta con la cuenta propia del nodo no retiene.
    return { key: 'wallet', state: 'ok', text: 'Con cuenta TBO propia no usa cartera' };
  }
  return {
    key: 'wallet',
    state: 'ok',
    text:
      active.length === 1
        ? `Cartera en ${joinCurrencies(active)} activa`
        : `Carteras en ${joinCurrencies(active)} activas`,
  };
}

function contactCheck(node: ReadinessNode): ReadinessCheck {
  const state = stateOf(
    node.supportContact === 'unknown',
    node.missing.includes('support-contact'),
  );
  const text: Readonly<Record<ReadinessCheckState, string>> = {
    ok: 'Contacto de soporte',
    missing:
      'Falta el contacto de soporte: lo completa el admin de la sucursal en Mi Agencia → Marca, o lo hereda de Planetour',
    unknown: 'No pudimos revisar el contacto de soporte',
  };
  return { key: 'support-contact', state, text: text[state] };
}

function sellersCheck(node: ReadinessNode): ReadinessCheck {
  const count = node.activeSellers;
  if (count === null) {
    return { key: 'sellers', state: 'unknown', text: 'No pudimos revisar sus vendedores' };
  }
  if (node.missing.includes('no-sellers')) {
    return {
      key: 'sellers',
      state: 'missing',
      text: 'Sin vendedores',
      action: {
        label: 'Invitar un vendedor',
        href: `/admin/usuarios?tenant=${encodeURIComponent(node.tenantId)}`,
      },
    };
  }
  return {
    key: 'sellers',
    state: 'ok',
    text: count === 1 ? '1 vendedor activo' : `${count} vendedores activos`,
  };
}

/** La lista de una sucursal, en el orden en que se resuelve: TBO, cuenta, cartera, contacto, vendedores. */
export function readinessChecks(node: ReadinessNode): ReadinessCheck[] {
  return [
    tboCheck(node),
    accountCheck(node),
    walletCheck(node),
    contactCheck(node),
    sellersCheck(node),
  ];
}

/** «Sucursal», o nada: un nodo con TBO habilitado como excepción no es una sucursal. */
export function nodeKindOf(node: ReadinessNode): string | undefined {
  return node.isBranch ? undefined : 'Con TBO habilitado';
}

/** Cuántas sucursales quedaron fuera de la lista (el API revisa un tope, por nombre). */
export function omittedLine(omitted: number): string | undefined {
  if (omitted <= 0) return undefined;
  return omitted === 1
    ? 'Hay 1 sucursal más que no entra en esta lista.'
    : `Hay ${omitted} sucursales más que no entran en esta lista.`;
}

// ───────────────────────── La llamada del navegador ─────────────────────────

/** La revisión, o `undefined` si no se pudo traer o no se entiende: la pantalla ofrece reintentar. */
export async function loadHotelReadiness(): Promise<HotelReadiness | undefined> {
  let res: Response;
  try {
    res = await fetch('/api/admin/hotels/readiness', { cache: 'no-store' });
  } catch {
    return undefined;
  }
  const read = await readJson<unknown>(res);
  if (!read.ok || !res.ok) return undefined;
  return parseHotelReadiness(read.data);
}
