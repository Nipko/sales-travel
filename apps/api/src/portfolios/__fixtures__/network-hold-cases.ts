/**
 * La red de prueba de la retención en cascada (db/migrations/0060; docs/platform/12 §11) y los casos
 * de quién retiene, compartidos por los tests de integración de la base y de la API.
 *
 *   P  (plataforma, nivel 1, +5 %)
 *   ├── C  (consolidador, nivel 2, +8 %)
 *   │   └── A  (agencia, nivel 3, +10 %)
 *   │       ├── S1 (sub-agencia, nivel 4, +12 %)
 *   │       └── S2 (sub-agencia, nivel 4, +12 %)
 *   ├── B  (sucursal, nivel 2)
 *   └── A2 (agencia directa, nivel 2)
 *       └── S3 (sub-agencia, nivel 3)
 *
 * Cuentas de proveedor heredables de P, C y A, todas del mismo proveedor. En la spec §1.4 la
 * sub-agencia de A2 se llama S2; acá es S3, porque S2 es la hermana de S1 que agota el cupo de C.
 *
 * P es la raíz `platform` COMPARTIDA de la base de pruebas (`platformRootId`): en CI los tests de
 * integración corren en paralelo sobre la misma base. Por eso su regla de markup y su cuenta NO van
 * en 'hotels' ni en un proveedor real, sino en una vertical y un proveedor propios de cada corrida
 * (`cascadeVertical`, `cascadeProvider`): nadie más los resuelve, y se borran al terminar.
 */

export type NodeKey = 'P' | 'C' | 'A' | 'S1' | 'S2' | 'B' | 'A2' | 'S3';

export interface NodeSpec {
  readonly key: NodeKey;
  readonly type: 'platform' | 'consolidator' | 'agency' | 'subagency';
  readonly parent: NodeKey | null;
  readonly isBranch?: boolean;
  /** Markup porcentual del nodo en puntos básicos (500 = 5 %), como `markup_rules.value_minor`. */
  readonly markupBps?: number;
}

export const NETWORK: readonly NodeSpec[] = [
  { key: 'P', type: 'platform', parent: null, markupBps: 500 },
  { key: 'C', type: 'consolidator', parent: 'P', markupBps: 800 },
  { key: 'A', type: 'agency', parent: 'C', markupBps: 1000 },
  { key: 'S1', type: 'subagency', parent: 'A', markupBps: 1200 },
  { key: 'S2', type: 'subagency', parent: 'A', markupBps: 1200 },
  { key: 'B', type: 'agency', parent: 'P', isBranch: true },
  { key: 'A2', type: 'agency', parent: 'P' },
  { key: 'S3', type: 'subagency', parent: 'A2' },
];

/** Dueños de las cuentas de proveedor de la red (todas heredables). */
export const ACCOUNT_OWNERS = ['P', 'C', 'A'] as const;
export type AccountOwner = (typeof ACCOUNT_OWNERS)[number];

/** Neto de la tarifa en los casos: USD 1.000,00. */
export const NET_MINOR = 100_000;

export interface NetworkHoldCase {
  readonly name: string;
  /** El nodo que vende (app.current_tenant_id). */
  readonly seller: NodeKey;
  /**
   * La cuenta que la orden guarda. `null` = no guarda ninguna (vuelos, autos): el dueño es el de la
   * cuenta que la bóveda le resuelve al nodo para el proveedor o, con `envOnly`, la raíz.
   */
  readonly account: AccountOwner | null;
  /** El proveedor de la orden no tiene cuentas en la bóveda: credenciales de entorno. */
  readonly envOnly?: boolean;
  /** Quiénes retienen, en orden de depth (0 = el que vende). */
  readonly retains: readonly NodeKey[];
}

/** El dueño de la credencial que la base debe registrar para el caso, y de dónde sale. */
export function expectedOwner(c: NetworkHoldCase): {
  readonly owner: NodeKey;
  readonly source: 'account' | 'resolved' | 'root';
} {
  if (c.account !== null) return { owner: c.account, source: 'account' };
  if (c.envOnly === true) return { owner: 'P', source: 'root' };
  // resolve_provider_account: la cuenta propia o la del ancestro heredable más cercano.
  const owner = lineage(c.seller).find((k) => (ACCOUNT_OWNERS as readonly string[]).includes(k));
  if (owner === undefined) throw new Error(`nadie le resuelve una cuenta a ${c.seller}`);
  return { owner, source: 'resolved' };
}

/** Los casos de la spec §1.4, con el resultado esperado. */
export const NETWORK_HOLD_CASES: readonly NetworkHoldCase[] = [
  { name: 'B (sucursal) con la cuenta de P', seller: 'B', account: 'P', retains: ['B'] },
  { name: 'A2 con la cuenta de P', seller: 'A2', account: 'P', retains: ['A2'] },
  { name: 'C con la cuenta de P', seller: 'C', account: 'P', retains: ['C'] },
  { name: 'A con la cuenta de P', seller: 'A', account: 'P', retains: ['A', 'C'] },
  { name: 'S1 con la cuenta de P', seller: 'S1', account: 'P', retains: ['S1', 'A', 'C'] },
  { name: 'S3 con la cuenta de P', seller: 'S3', account: 'P', retains: ['S3', 'A2'] },
  { name: 'S1 con la cuenta de C', seller: 'S1', account: 'C', retains: ['S1', 'A'] },
  { name: 'A con la cuenta de C', seller: 'A', account: 'C', retains: ['A'] },
  { name: 'S1 con una cuenta de A', seller: 'S1', account: 'A', retains: ['S1'] },
  { name: 'C con su cuenta propia (O = T)', seller: 'C', account: 'C', retains: ['C'] },
  {
    name: 'S1 con credenciales de entorno',
    seller: 'S1',
    account: null,
    envOnly: true,
    retains: ['S1', 'A', 'C'],
  },
  // Vuelos y autos no guardan la cuenta en la orden: vale la que la bóveda le resuelve al nodo.
  {
    name: 'S1 sin cuenta en la orden: la de A, que la bóveda le resuelve',
    seller: 'S1',
    account: null,
    retains: ['S1'],
  },
  {
    name: 'S3 sin cuenta en la orden: la de P, que la bóveda le resuelve',
    seller: 'S3',
    account: null,
    retains: ['S3', 'A2'],
  },
];

const byKey = new Map(NETWORK.map((n) => [n.key, n]));

function specOf(key: NodeKey): NodeSpec {
  const spec = byKey.get(key);
  if (spec === undefined) throw new Error(`nodo desconocido: ${key}`);
  return spec;
}

/** Del nodo a la raíz: [key, padre, …, P]. */
export function lineage(key: NodeKey): NodeKey[] {
  const out: NodeKey[] = [];
  for (let k: NodeKey | null = key; k !== null; k = specOf(k).parent) out.push(k);
  return out;
}

/** El nivel (`nlevel(path)`) del nodo: P es 1. */
export function levelOf(key: NodeKey): number {
  return lineage(key).length;
}

/**
 * Lo que retiene cada nodo de `c.retains` para una venta con neto `net`, calculado aparte de la
 * base: la cascada de markups de la raíz al que vende, redondeando como `applyCascade`. El que vende
 * retiene el precio de venta; cada ancestro, el neto más los markups de los niveles de arriba suyo.
 */
export function expectedHolds(c: NetworkHoldCase, net = NET_MINOR): Map<NodeKey, number> {
  const path = lineage(c.seller).reverse();
  const before = new Map<NodeKey, number>();
  let running = net;
  for (const key of path) {
    before.set(key, running);
    const bps = specOf(key).markupBps ?? 0;
    running += Math.round((running * bps) / 10_000);
  }
  const out = new Map<NodeKey, number>();
  c.retains.forEach((key, depth) => {
    out.set(key, depth === 0 ? running : (before.get(key) ?? Number.NaN));
  });
  return out;
}

/** El precio de venta de `seller` para un neto `net`. */
export function saleOf(seller: NodeKey, net = NET_MINOR): number {
  return expectedHolds({ name: 'venta', seller, account: null, retains: [seller] }, net).get(
    seller,
  )!;
}

/**
 * Letras al azar para la vertical de la corrida: `wallet_hold_preview` exige `^[a-z_]{1,32}$` y
 * `markup_rules.vertical` es VARCHAR(20).
 */
export function cascadeVertical(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let out = 'whc_';
  for (let i = 0; i < 8; i++) out += letters[Math.floor(Math.random() * letters.length)];
  return out;
}

/** Un código de proveedor que nadie más usa en la base compartida. */
export function cascadeProvider(sfx: string): string {
  return `wh-cascade-${sfx}`;
}
