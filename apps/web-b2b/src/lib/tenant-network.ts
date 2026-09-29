/**
 * La red de Planetour vista desde el panel: qué es cada nodo, cómo se dibuja el árbol y qué se
 * puede hacer con cada uno. Sin I/O, para probarlo sin navegador.
 *
 * La jerarquía es la D4 A (db/migrations/0050): un solo nodo 'platform' (Planetour) y es la raíz;
 * bajo la plataforma, consolidadores y agencias (las sucursales incluidas); bajo un consolidador,
 * agencias; bajo una agencia, sub-agencias; máximo 4 niveles. La base y la API son la última
 * palabra: esto existe para ofrecer sólo lo que van a aceptar y para decir antes qué pasa.
 */

export const TENANT_TYPES = ['platform', 'consolidator', 'agency', 'subagency'] as const;
export type TenantType = (typeof TENANT_TYPES)[number];

/** Lo que el panel muestra: el tipo, con la sucursal aparte aunque en la base sea una agencia. */
export type NodeKind = 'platform' | 'consolidator' | 'agency' | 'branch' | 'subagency';

/** Lo que se puede crear por API. La plataforma nunca. */
export type CreatableKind = 'consolidator' | 'branch' | 'agency' | 'subagency';

/** Un nodo tal como lo devuelven `/tenants/network` y `/admin/tenants`. */
export interface NetworkNode {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly tenantType: string;
  /** Sucursal de Planetour (0050). Un API anterior no lo manda: se lee como `false`. */
  readonly isBranch?: boolean;
  readonly parentTenantId: string | null;
  readonly status: string;
  /** Nivel en el árbol: 1 es la raíz. */
  readonly depth: number;
}

/** Niveles que admite la red (0050). */
export const MAX_DEPTH = 4;

export const NODE_KIND_LABEL: Readonly<Record<NodeKind, string>> = {
  platform: 'Plataforma',
  consolidator: 'Consolidador',
  agency: 'Agencia',
  branch: 'Sucursal',
  subagency: 'Sub-agencia',
};

/**
 * El distintivo de cada tipo. Texto -700/-800 sobre fondo -50: más de 4.5:1 a 10-11px. El tipo
 * también va escrito, así que no depende sólo del color.
 */
export const NODE_KIND_BADGE: Readonly<Record<NodeKind, string>> = {
  platform: 'bg-violet-50 text-violet-700 border-violet-200',
  consolidator: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  agency: 'bg-sky-50 text-sky-700 border-sky-200',
  branch: 'bg-amber-50 text-amber-800 border-amber-200',
  subagency: 'bg-teal-50 text-teal-700 border-teal-200',
};

export const STATUS_LABEL: Readonly<Record<string, string>> = {
  active: 'Activo',
  suspended: 'Suspendido',
  archived: 'Archivado',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function isTenantType(value: unknown): value is TenantType {
  return typeof value === 'string' && (TENANT_TYPES as readonly string[]).includes(value);
}

/** El tipo que muestra el panel; `undefined` si la API mandó uno que no conocemos. */
export function nodeKind(node: Pick<NetworkNode, 'tenantType' | 'isBranch'>): NodeKind | undefined {
  if (!isTenantType(node.tenantType)) return undefined;
  if (node.tenantType === 'agency' && node.isBranch === true) return 'branch';
  return node.tenantType;
}

export function nodeKindLabel(node: Pick<NetworkNode, 'tenantType' | 'isBranch'>): string {
  const kind = nodeKind(node);
  return kind === undefined ? 'Nodo' : NODE_KIND_LABEL[kind];
}

/** Las reglas de 0050, con el nombre con que la API las publica como `reason`. */
export type HierarchyRule =
  | 'TENANT_BRANCH_TYPE'
  | 'TENANT_PLATFORM_IS_ROOT'
  | 'TENANT_ROOT_MUST_BE_PLATFORM'
  | 'TENANT_BRANCH_PARENT'
  | 'TENANT_PARENT_TYPE';

/**
 * La regla que viola un nodo de tipo `type` (sucursal si `isBranch`) bajo un padre de tipo
 * `parentType` (`null` = raíz), o `undefined` si puede. Espejo de `tenant_hierarchy_rule` (0050),
 * en el mismo orden de comprobación.
 */
export function hierarchyRule(
  type: string,
  isBranch: boolean,
  parentType: string | null,
): HierarchyRule | undefined {
  if (isBranch && type !== 'agency') return 'TENANT_BRANCH_TYPE';
  if (type === 'platform') return parentType === null ? undefined : 'TENANT_PLATFORM_IS_ROOT';
  if (parentType === null) return 'TENANT_ROOT_MUST_BE_PLATFORM';
  if (isBranch && parentType !== 'platform') return 'TENANT_BRANCH_PARENT';
  if (parentType === 'platform' && (type === 'consolidator' || type === 'agency')) return undefined;
  if (parentType === 'consolidator' && type === 'agency') return undefined;
  if (parentType === 'agency' && type === 'subagency') return undefined;
  return 'TENANT_PARENT_TYPE';
}

/** Orden de los hermanos: lo propio de Planetour primero, después su red. */
const KIND_ORDER: Readonly<Record<NodeKind, number>> = {
  platform: 0,
  branch: 1,
  consolidator: 2,
  agency: 3,
  subagency: 4,
};

function compareNodes(a: NetworkNode, b: NetworkNode): number {
  const ka = KIND_ORDER[nodeKind(a) ?? 'subagency'];
  const kb = KIND_ORDER[nodeKind(b) ?? 'subagency'];
  if (ka !== kb) return ka - kb;
  return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' });
}

export interface Forest<T extends NetworkNode> {
  /** Los nodos cuyo padre no está en la lista. Con la red sana, sólo la plataforma. */
  readonly roots: readonly T[];
  readonly childrenOf: ReadonlyMap<string, readonly T[]>;
}

/**
 * El árbol a partir de `parentTenantId`. La raíz se reconoce por no tener padre visible, no por el
 * nombre: la plataforma va primero y después, si las hay, las raíces sueltas que quedan de antes de
 * D4 (una agencia raíz, p. ej.), que hay que mover.
 */
export function buildForest<T extends NetworkNode>(nodes: readonly T[]): Forest<T> {
  const ids = new Set(nodes.map((n) => n.id));
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const node of nodes) {
    if (node.parentTenantId !== null && ids.has(node.parentTenantId)) {
      const siblings = childrenOf.get(node.parentTenantId) ?? [];
      siblings.push(node);
      childrenOf.set(node.parentTenantId, siblings);
    } else {
      roots.push(node);
    }
  }
  roots.sort(compareNodes);
  for (const siblings of childrenOf.values()) siblings.sort(compareNodes);
  return { roots, childrenOf };
}

export interface TreeRow<T extends NetworkNode> {
  readonly node: T;
  /** 0 para una raíz. Es la sangría, no la profundidad en la base. */
  readonly level: number;
}

/** El árbol aplanado en orden de lectura: cada nodo seguido de sus hijos. */
export function flattenForest<T extends NetworkNode>(forest: Forest<T>): TreeRow<T>[] {
  const rows: TreeRow<T>[] = [];
  const seen = new Set<string>();
  const visit = (node: T, level: number) => {
    // Un ciclo no debería existir (la base lo impide); si llegara, no cuelga la pantalla.
    if (seen.has(node.id)) return;
    seen.add(node.id);
    rows.push({ node, level });
    for (const child of forest.childrenOf.get(node.id) ?? []) visit(child, level + 1);
  };
  for (const root of forest.roots) visit(root, 0);
  return rows;
}

/** El orden de lectura del árbol, como lista. */
export function treeOrder<T extends NetworkNode>(nodes: readonly T[]): T[] {
  return flattenForest(buildForest(nodes)).map((row) => row.node);
}

/**
 * La raíz de la red que ve el usuario: la plataforma si la ve; si no, su nodo más alto (el de un
 * admin de consolidador o de agencia). Antes se tomaba la primera por orden alfabético, y con una
 * agencia suelta "Amazon…" pasaba delante de "Planetour…".
 */
export function networkRoot<T extends NetworkNode>(nodes: readonly T[]): T | undefined {
  const platform = nodes.find((n) => n.tenantType === 'platform');
  if (platform !== undefined) return platform;
  const { roots } = buildForest(nodes);
  return [...roots].sort((a, b) => a.depth - b.depth || compareNodes(a, b))[0];
}

/** Las raíces que no son la plataforma: quedaron fuera de la red y no heredan nada de Planetour. */
export function nodesOutsideNetwork<T extends NetworkNode>(nodes: readonly T[]): T[] {
  if (!nodes.some((n) => n.tenantType === 'platform')) return [];
  return buildForest(nodes).roots.filter((n) => n.tenantType !== 'platform');
}

/**
 * Qué se puede crear bajo `parent`. Consolidador y sucursal, sólo el superadmin y bajo la
 * plataforma (G-05); el resto lo decide el tipo del padre.
 */
export function creatableKinds(
  parent: NetworkNode,
  opts: { readonly superadmin: boolean },
): CreatableKind[] {
  if (parent.depth >= MAX_DEPTH) return [];
  switch (parent.tenantType) {
    case 'platform':
      return opts.superadmin ? ['agency', 'branch', 'consolidator'] : ['agency'];
    case 'consolidator':
      return ['agency'];
    case 'agency':
      return ['subagency'];
    default:
      return [];
  }
}

export const CREATABLE_KIND_LABEL: Readonly<Record<CreatableKind, string>> = {
  agency: 'Agencia',
  branch: 'Sucursal',
  consolidator: 'Consolidador',
  subagency: 'Sub-agencia',
};

const NEW_KIND_LABEL: Readonly<Record<CreatableKind, string>> = {
  agency: 'Nueva agencia',
  branch: 'Nueva sucursal',
  consolidator: 'Nuevo consolidador',
  subagency: 'Nueva sub-agencia',
};

/** El botón de alta bajo un nodo: el tipo si hay uno solo, "Agregar" si hay que elegir. */
export function createActionLabel(kinds: readonly CreatableKind[]): string {
  return kinds.length === 1 ? CREATABLE_KIND_LABEL[kinds[0]!] : 'Agregar';
}

/** El botón de alta de la cabecera: "Nueva agencia", o "Nuevo nodo" si hay que elegir el tipo. */
export function newNodeLabel(kinds: readonly CreatableKind[]): string {
  return kinds.length === 1 ? NEW_KIND_LABEL[kinds[0]!] : 'Nuevo nodo';
}

/** Para qué sirve cada tipo, dicho para quien lo va a crear. */
export const CREATABLE_KIND_HINT: Readonly<Record<CreatableKind, string>> = {
  agency: 'Vende a nombre de su padre y hereda sus credenciales, reglas y marca.',
  branch:
    'Planetour vende a nombre propio con los vendedores de la sucursal. Cuelga de la plataforma.',
  consolidator: 'Trae credenciales propias y provee a su red de agencias. Cuelga de la plataforma.',
  subagency: 'Cuelga de una agencia y vende con lo que ella hereda.',
};

/** Lo que va en el alta para pedir ese tipo. La API lo valida contra el padre. */
export function createFields(kind: CreatableKind): {
  tenantType: 'consolidator' | 'agency' | 'subagency';
  isBranch?: true;
} {
  switch (kind) {
    case 'branch':
      return { tenantType: 'agency', isBranch: true };
    case 'consolidator':
      return { tenantType: 'consolidator' };
    case 'agency':
      return { tenantType: 'agency' };
    case 'subagency':
      return { tenantType: 'subagency' };
  }
}

/** Los nodos que pueden ser padre de uno nuevo de tipo `kind`, en orden del árbol. */
export function parentOptions<T extends NetworkNode>(
  nodes: readonly T[],
  kind: CreatableKind,
  opts: { readonly superadmin: boolean },
): T[] {
  return treeOrder(nodes).filter(
    (n) => n.status !== 'archived' && creatableKinds(n, opts).includes(kind),
  );
}

/** El padre propuesto: la plataforma si puede serlo; si hay un solo candidato, ése. */
export function defaultParent<T extends NetworkNode>(
  nodes: readonly T[],
  kind: CreatableKind,
  opts: { readonly superadmin: boolean },
): T | undefined {
  const options = parentOptions(nodes, kind, opts);
  return (
    options.find((n) => n.tenantType === 'platform') ??
    (options.length === 1 ? options[0] : undefined)
  );
}

/** Los descendientes de `id` (sin él). */
export function descendantIds(nodes: readonly NetworkNode[], id: string): Set<string> {
  const { childrenOf } = buildForest(nodes);
  const out = new Set<string>();
  const stack = [...(childrenOf.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (out.has(next.id) || next.id === id) continue;
    out.add(next.id);
    stack.push(...(childrenOf.get(next.id) ?? []));
  }
  return out;
}

/** Cuántos niveles cuelgan bajo `id`: 0 si no tiene hijos. */
export function subtreeHeight(nodes: readonly NetworkNode[], id: string): number {
  const self = nodes.find((n) => n.id === id);
  if (self === undefined) return 0;
  const below = descendantIds(nodes, id);
  return nodes.reduce((max, n) => (below.has(n.id) ? Math.max(max, n.depth - self.depth) : max), 0);
}

/** Los ancestros de `id` y él mismo, de la raíz hacia abajo. */
export function lineage<T extends NetworkNode>(nodes: readonly T[], id: string): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const chain: T[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentTenantId === null ? undefined : byId.get(current.parentTenantId);
  }
  return chain;
}

/**
 * Los padres a los que se puede mover `nodeId` con su subárbol (D6 A): ni él ni sus descendientes
 * (ciclo), ni su padre actual, sólo combinaciones que admite D4 y sin pasar de 4 niveles contando
 * lo que cuelga debajo. La plataforma no se mueve. Las reservas abiertas las mira la base al mover.
 */
export function moveTargets<T extends NetworkNode>(nodes: readonly T[], nodeId: string): T[] {
  const node = nodes.find((n) => n.id === nodeId);
  if (node === undefined || node.tenantType === 'platform') return [];
  const blocked = descendantIds(nodes, nodeId);
  blocked.add(nodeId);
  if (node.parentTenantId !== null) blocked.add(node.parentTenantId);
  const height = subtreeHeight(nodes, nodeId);
  return treeOrder(nodes).filter(
    (candidate) =>
      !blocked.has(candidate.id) &&
      candidate.status !== 'archived' &&
      hierarchyRule(node.tenantType, node.isBranch === true, candidate.tenantType) === undefined &&
      candidate.depth + 1 + height <= MAX_DEPTH,
  );
}

/**
 * Por qué un nodo no tiene adónde moverse, para decirlo en vez de mostrar una lista vacía.
 * `undefined` si tiene destinos.
 */
export function moveBlockedReason(
  nodes: readonly NetworkNode[],
  node: NetworkNode,
): string | undefined {
  if (node.tenantType === 'platform') return 'La plataforma es la raíz de la red: no se mueve.';
  if (moveTargets(nodes, node.id).length > 0) return undefined;
  if (node.isBranch === true) {
    return 'Una sucursal cuelga siempre de la plataforma. Para moverla, quitale antes la marca de sucursal.';
  }
  return 'Ningún otro nodo puede recibirlo sin romper las reglas de la red: el tipo de su padre o el máximo de 4 niveles.';
}

/** El camino de un nodo, para leer de dónde cuelga: "Planetour S.A.S › Agencia Norte". */
export function lineageLabel(nodes: readonly NetworkNode[], id: string): string {
  return lineage(nodes, id)
    .map((n) => n.name)
    .join(' › ');
}

/** Dónde está hoy un nodo: su camino desde la raíz, o que quedó suelto fuera de la red. */
export function placementLabel(nodes: readonly NetworkNode[], node: NetworkNode): string {
  if (node.parentTenantId === null) {
    return node.tenantType === 'platform'
      ? node.name
      : `${node.name} (raíz suelta, fuera de la red)`;
  }
  // Un padre fuera de la lista (no debería pasarle al superadmin, que ve toda la red) no se inventa.
  const parent = lineageLabel(nodes, node.parentTenantId) || '…';
  return `${parent} › ${node.name}`;
}

export interface MoveSummary {
  readonly title: string;
  /** Dónde está hoy. */
  readonly before: string;
  /** Dónde queda. */
  readonly after: string;
  /** Qué cambia y qué no, en el orden en que importa. */
  readonly consequences: readonly string[];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Lo que dice la confirmación de un movimiento: D6 A dicho para quien lo va a hacer. */
export function moveSummary(
  nodes: readonly NetworkNode[],
  node: NetworkNode,
  target: NetworkNode,
): MoveSummary {
  const dependents = descendantIds(nodes, node.id).size;
  const consequences = [
    `Desde el cambio rigen las credenciales, las reglas de precio y la marca de ${target.name}.`,
    'Lo histórico queda como está: sus reservas y movimientos de cartera no cambian.',
    'Si el nodo o su red tiene reservas abiertas pagadas con cartera, o hechas con credenciales que dejaría de heredar, el movimiento se rechaza: primero hay que cerrarlas o cancelarlas.',
  ];
  if (dependents > 0) {
    consequences.unshift(
      `Se mueve con ${plural(dependents, 'nodo que depende', 'nodos que dependen')} de él.`,
    );
  }
  return {
    title: `Mover ${node.name}`,
    before: placementLabel(nodes, node),
    after: `${lineageLabel(nodes, target.id)} › ${node.name}`,
    consequences,
  };
}

export interface StatusChange {
  readonly next: 'active' | 'suspended';
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly destructive: boolean;
}

/**
 * Suspender o reactivar un nodo. La plataforma no se suspende (dejaría sin acceso a toda la red,
 * superadmin incluido) y un nodo archivado no se toca desde acá.
 */
export function statusChange(
  nodes: readonly NetworkNode[],
  node: NetworkNode,
): StatusChange | undefined {
  if (node.tenantType === 'platform' || node.status === 'archived') return undefined;
  const dependents = descendantIds(nodes, node.id).size;
  const who =
    dependents > 0 ? `${node.name} y ${plural(dependents, 'nodo', 'nodos')} de su red` : node.name;
  if (node.status === 'active') {
    return {
      next: 'suspended',
      label: 'Suspender',
      title: `Suspender ${node.name}`,
      description: `${who} ${dependents > 0 ? 'dejan' : 'deja'} de operar en el acto: sus usuarios pierden el acceso. Las reservas hechas no se tocan. Podés reactivarlo cuando quieras.`,
      confirmLabel: 'Suspender',
      destructive: true,
    };
  }
  const suspendedAncestor = lineage(nodes, node.id)
    .slice(0, -1)
    .find((a) => a.status !== 'active');
  return {
    next: 'active',
    label: 'Activar',
    title: `Activar ${node.name}`,
    description:
      suspendedAncestor === undefined
        ? `${who} ${dependents > 0 ? 'vuelven' : 'vuelve'} a operar: sus usuarios recuperan el acceso.`
        : `${node.name} queda activo, pero no opera mientras ${suspendedAncestor.name} siga suspendido.`,
    confirmLabel: 'Activar',
    destructive: false,
  };
}

export interface BranchChange {
  readonly isBranch: boolean;
  readonly label: string;
  readonly title: string;
  readonly description: string;
}

/**
 * Marcar o desmarcar una sucursal. Sólo una agencia que cuelga directo de la plataforma puede
 * serlo (0050). En esta etapa no cambia ni el precio ni la cartera por serlo.
 */
export function branchChange(
  nodes: readonly NetworkNode[],
  node: NetworkNode,
): BranchChange | undefined {
  if (node.isBranch === true) {
    return {
      isBranch: false,
      label: 'Quitar sucursal',
      title: `${node.name} deja de ser sucursal`,
      description: `Sigue siendo una agencia bajo la plataforma, con sus usuarios, credenciales y reglas. Deja de mostrarse como sucursal de Planetour.`,
    };
  }
  const parent = nodes.find((n) => n.id === node.parentTenantId);
  if (node.tenantType !== 'agency' || parent?.tenantType !== 'platform') return undefined;
  return {
    isBranch: true,
    label: 'Marcar como sucursal',
    title: `${node.name} pasa a ser sucursal`,
    description: `Planetour vende a nombre propio por sus sucursales, con los vendedores de cada una. No cambian sus precios, su cartera ni sus credenciales.`,
  };
}

const KIND_COUNT_LABEL: Readonly<Record<NodeKind, readonly [one: string, many: string]>> = {
  platform: ['plataforma', 'plataformas'],
  branch: ['sucursal', 'sucursales'],
  consolidator: ['consolidador', 'consolidadores'],
  agency: ['agencia', 'agencias'],
  subagency: ['sub-agencia', 'sub-agencias'],
};

/** La composición de la red en una línea: "1 plataforma · 2 sucursales · 3 agencias". */
export function networkComposition(nodes: readonly NetworkNode[]): string {
  const counts = new Map<NodeKind, number>();
  for (const node of nodes) {
    const kind = nodeKind(node);
    if (kind !== undefined) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return (Object.keys(KIND_ORDER) as NodeKind[])
    .filter((kind) => (counts.get(kind) ?? 0) > 0)
    .map((kind) => {
      const n = counts.get(kind)!;
      const [one, many] = KIND_COUNT_LABEL[kind];
      return `${n} ${n === 1 ? one : many}`;
    })
    .join(' · ');
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** ¿El nodo coincide con la búsqueda? Por nombre o slug, sin mayúsculas ni tildes. */
export function matchesQuery(node: Pick<NetworkNode, 'name' | 'slug'>, query: string): boolean {
  const q = fold(query.trim());
  if (q === '') return true;
  return fold(node.name).includes(q) || fold(node.slug).includes(q);
}

/** Slug a partir del nombre, como lo acepta la API (minúsculas, dígitos y guiones). */
export function slugify(name: string): string {
  return fold(name)
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);
}
