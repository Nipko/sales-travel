import { describe, expect, it } from 'vitest';
import {
  MAX_DEPTH,
  branchChange,
  buildForest,
  createActionLabel,
  createFields,
  creatableKinds,
  defaultParent,
  descendantIds,
  flattenForest,
  hierarchyRule,
  lineageLabel,
  matchesQuery,
  moveBlockedReason,
  moveSummary,
  moveTargets,
  networkComposition,
  networkRoot,
  newNodeLabel,
  nodeKind,
  nodeKindLabel,
  nodesOutsideNetwork,
  parentOptions,
  placementLabel,
  slugify,
  statusChange,
  subtreeHeight,
  treeOrder,
  type NetworkNode,
} from './tenant-network';

function node(
  id: string,
  name: string,
  tenantType: string,
  parentTenantId: string | null,
  depth: number,
  extra: Partial<NetworkNode> = {},
): NetworkNode {
  return {
    id,
    slug: slugify(name),
    name,
    tenantType,
    parentTenantId,
    status: 'active',
    depth,
    ...extra,
  };
}

/*
 * La red de producción al desplegar 0049: Planetour ya es la plataforma y Amazon Minimalist sigue
 * como agencia raíz suelta, a mover desde el panel. Más una red de ejemplo bajo Planetour.
 */
const planetour = node('p', 'Planetour S.A.S', 'platform', null, 1);
const amazon = node('am', 'Amazon Minimalist', 'agency', null, 1);
const bogota = node('b', 'Planetour Bogotá', 'agency', 'p', 2, { isBranch: true });
const andes = node('c', 'Consolidador Andes', 'consolidator', 'p', 2);
const norte = node('n', 'Agencia Norte', 'agency', 'c', 3);
const norteSur = node('ns', 'Norte Sur', 'subagency', 'n', 4);
const libre = node('l', 'Agencia Libre', 'agency', 'p', 2);
const libreHija = node('lh', 'Libre Hija', 'subagency', 'l', 3);

const RED: readonly NetworkNode[] = [
  amazon,
  libreHija,
  norteSur,
  norte,
  libre,
  andes,
  bogota,
  planetour,
];

describe('nodeKind: lo que muestra el panel', () => {
  it('la sucursal es una agencia marcada, y se muestra como Sucursal', () => {
    expect(nodeKind(bogota)).toBe('branch');
    expect(nodeKindLabel(bogota)).toBe('Sucursal');
    expect(nodeKindLabel(libre)).toBe('Agencia');
  });

  it('un API anterior sin isBranch se lee como agencia', () => {
    expect(nodeKind({ tenantType: 'agency' })).toBe('agency');
  });

  it('cada tipo con su nombre', () => {
    expect(nodeKindLabel(planetour)).toBe('Plataforma');
    expect(nodeKindLabel(andes)).toBe('Consolidador');
    expect(nodeKindLabel(norteSur)).toBe('Sub-agencia');
  });

  it('un tipo desconocido no se disfraza de agencia', () => {
    expect(nodeKind({ tenantType: 'reseller' })).toBeUndefined();
    expect(nodeKindLabel({ tenantType: 'reseller' })).toBe('Nodo');
  });
});

describe('hierarchyRule: espejo de tenant_hierarchy_rule (0050, D4 A)', () => {
  it.each([
    // [tipo, sucursal, tipo del padre (null = raíz), regla]
    ['platform', false, null, undefined],
    ['platform', false, 'platform', 'TENANT_PLATFORM_IS_ROOT'],
    ['agency', false, null, 'TENANT_ROOT_MUST_BE_PLATFORM'],
    ['consolidator', false, null, 'TENANT_ROOT_MUST_BE_PLATFORM'],
    ['consolidator', false, 'platform', undefined],
    ['agency', false, 'platform', undefined],
    ['subagency', false, 'platform', 'TENANT_PARENT_TYPE'],
    ['agency', false, 'consolidator', undefined],
    ['consolidator', false, 'consolidator', 'TENANT_PARENT_TYPE'],
    ['subagency', false, 'consolidator', 'TENANT_PARENT_TYPE'],
    ['subagency', false, 'agency', undefined],
    ['agency', false, 'agency', 'TENANT_PARENT_TYPE'],
    ['subagency', false, 'subagency', 'TENANT_PARENT_TYPE'],
    ['agency', true, 'platform', undefined],
    ['agency', true, 'consolidator', 'TENANT_BRANCH_PARENT'],
    ['agency', true, null, 'TENANT_ROOT_MUST_BE_PLATFORM'],
    ['consolidator', true, 'platform', 'TENANT_BRANCH_TYPE'],
    ['platform', true, null, 'TENANT_BRANCH_TYPE'],
  ] as const)('%s (sucursal: %s) bajo %s → %s', (type, isBranch, parentType, rule) => {
    expect(hierarchyRule(type, isBranch, parentType)).toBe(rule);
  });
});

describe('buildForest: el árbol se arma por tipo y padre, no por orden alfabético', () => {
  it('la plataforma va primero aunque "Amazon…" le gane por nombre', () => {
    const { roots } = buildForest(RED);
    expect(roots.map((n) => n.id)).toEqual(['p', 'am']);
  });

  it('bajo Planetour: sucursales, después consolidadores, después agencias', () => {
    const { childrenOf } = buildForest(RED);
    expect(childrenOf.get('p')?.map((n) => n.id)).toEqual(['b', 'c', 'l']);
  });

  it('se aplana en orden de lectura, con la sangría de cada nivel', () => {
    const rows = flattenForest(buildForest(RED)).map((r) => `${r.node.id}:${r.level}`);
    expect(rows).toEqual(['p:0', 'b:1', 'c:1', 'n:2', 'ns:3', 'l:1', 'lh:2', 'am:0']);
    expect(treeOrder(RED).map((n) => n.id)).toEqual(['p', 'b', 'c', 'n', 'ns', 'l', 'lh', 'am']);
  });

  it('un nodo cuyo padre no se ve es raíz de lo visible (el admin de un consolidador)', () => {
    const { roots } = buildForest([norte, andes, norteSur]);
    expect(roots.map((n) => n.id)).toEqual(['c']);
  });

  it('un ciclo en los datos no cuelga la pantalla', () => {
    const a = node('a', 'A', 'agency', 'b2', 2);
    const b = node('b2', 'B', 'agency', 'a', 2);
    expect(flattenForest(buildForest([a, b]))).toEqual([]);
  });
});

describe('networkRoot: la raíz de Mi Red', () => {
  it('es la plataforma, no el primero por nombre', () => {
    expect(networkRoot(RED)?.id).toBe('p');
  });

  it('sin la plataforma a la vista, el nodo más alto del usuario', () => {
    expect(networkRoot([norteSur, norte, andes])?.id).toBe('c');
  });

  it('sin nodos, nada', () => {
    expect(networkRoot([])).toBeUndefined();
  });
});

describe('nodesOutsideNetwork: raíces sueltas que hay que mover', () => {
  it('Amazon Minimalist quedó fuera de la red de Planetour', () => {
    expect(nodesOutsideNetwork(RED).map((n) => n.id)).toEqual(['am']);
  });

  it('sin plataforma no hay "fuera": no hay adónde moverlas todavía', () => {
    expect(nodesOutsideNetwork([amazon, libre])).toEqual([]);
  });
});

describe('creatableKinds: qué nace bajo cada padre (D4 A, G-05)', () => {
  it('bajo Planetour, el superadmin crea agencia, sucursal o consolidador', () => {
    expect(creatableKinds(planetour, { superadmin: true })).toEqual([
      'agency',
      'branch',
      'consolidator',
    ]);
  });

  it('bajo Planetour, un admin que no es superadmin sólo crea agencias', () => {
    expect(creatableKinds(planetour, { superadmin: false })).toEqual(['agency']);
  });

  it('bajo un consolidador, agencias; bajo una agencia o sucursal, sub-agencias', () => {
    expect(creatableKinds(andes, { superadmin: true })).toEqual(['agency']);
    expect(creatableKinds(norte, { superadmin: false })).toEqual(['subagency']);
    expect(creatableKinds(bogota, { superadmin: true })).toEqual(['subagency']);
  });

  it('una sub-agencia no tiene hijos, ni un nodo en el nivel 4', () => {
    expect(creatableKinds(norteSur, { superadmin: true })).toEqual([]);
    expect(creatableKinds({ ...norte, depth: MAX_DEPTH }, { superadmin: true })).toEqual([]);
  });

  it('lo que se manda coincide con la regla de la base', () => {
    for (const parent of [planetour, andes, norte, bogota]) {
      for (const kind of creatableKinds(parent, { superadmin: true })) {
        const fields = createFields(kind);
        expect(hierarchyRule(fields.tenantType, fields.isBranch === true, parent.tenantType)).toBe(
          undefined,
        );
      }
    }
  });

  it('la sucursal viaja como agencia marcada', () => {
    expect(createFields('branch')).toEqual({ tenantType: 'agency', isBranch: true });
    expect(createFields('consolidator')).toEqual({ tenantType: 'consolidator' });
    expect(createFields('agency')).toEqual({ tenantType: 'agency' });
    expect(createFields('subagency')).toEqual({ tenantType: 'subagency' });
  });

  it('los botones dicen qué se crea', () => {
    expect(createActionLabel(['subagency'])).toBe('Sub-agencia');
    expect(createActionLabel(['agency', 'branch'])).toBe('Agregar');
    expect(newNodeLabel(['agency'])).toBe('Nueva agencia');
    expect(newNodeLabel(['consolidator'])).toBe('Nuevo consolidador');
    expect(newNodeLabel(['agency', 'branch', 'consolidator'])).toBe('Nuevo nodo');
  });
});

describe('parentOptions y defaultParent: Planetour es el padre por defecto', () => {
  const sa = { superadmin: true };

  it('una agencia puede colgar de Planetour o de un consolidador; por defecto, de Planetour', () => {
    expect(parentOptions(RED, 'agency', sa).map((n) => n.id)).toEqual(['p', 'c']);
    expect(defaultParent(RED, 'agency', sa)?.id).toBe('p');
  });

  it('sucursal y consolidador, sólo de Planetour', () => {
    expect(parentOptions(RED, 'branch', sa).map((n) => n.id)).toEqual(['p']);
    expect(parentOptions(RED, 'consolidator', sa).map((n) => n.id)).toEqual(['p']);
  });

  it('una sub-agencia, de una agencia (la sucursal y la raíz suelta incluidas); sin defecto', () => {
    expect(parentOptions(RED, 'subagency', sa).map((n) => n.id)).toEqual(['b', 'n', 'l', 'am']);
    expect(defaultParent(RED, 'subagency', sa)).toBeUndefined();
  });

  it('con un solo candidato, ése', () => {
    expect(defaultParent([andes, norte], 'subagency', sa)?.id).toBe('n');
  });

  it('un nodo archivado no recibe hijos', () => {
    expect(parentOptions([{ ...planetour, status: 'archived' }], 'agency', sa)).toEqual([]);
  });
});

describe('moveTargets: adónde se puede mover un nodo (D6 A)', () => {
  it('Amazon (agencia raíz suelta) va bajo Planetour o un consolidador', () => {
    expect(moveTargets(RED, 'am').map((n) => n.id)).toEqual(['p', 'c']);
  });

  it('no bajo sí mismo ni sus descendientes, ni bajo su padre actual', () => {
    const targets = moveTargets(RED, 'l').map((n) => n.id);
    expect(targets).not.toContain('l');
    expect(targets).not.toContain('lh');
    expect(targets).not.toContain('p');
    expect(targets).toEqual(['c']);
  });

  it('respeta el máximo de 4 niveles contando lo que cuelga debajo', () => {
    // Agencia Norte (con una sub-agencia debajo) bajo un consolidador de nivel 2: 2 + 1 + 1 = 4.
    expect(moveTargets(RED, 'n').map((n) => n.id)).toEqual(['p']);
    const deep = node('d', 'Consolidador Profundo', 'consolidator', 'p', 3);
    expect(moveTargets([...RED, deep], 'n').map((n) => n.id)).toEqual(['p']);
  });

  it('una sub-agencia va bajo otra agencia', () => {
    expect(moveTargets(RED, 'lh').map((n) => n.id)).toEqual(['b', 'n', 'am']);
  });

  it('la plataforma no se mueve; una sucursal no tiene otro padre posible', () => {
    expect(moveTargets(RED, 'p')).toEqual([]);
    expect(moveBlockedReason(RED, planetour)).toMatch(/raíz de la red/);
    expect(moveTargets(RED, 'b')).toEqual([]);
    expect(moveBlockedReason(RED, bogota)).toMatch(/quitale antes la marca de sucursal/);
  });

  it('con destinos no hay motivo de bloqueo', () => {
    expect(moveBlockedReason(RED, amazon)).toBeUndefined();
  });

  it('un consolidador no tiene adónde ir: sólo cuelga de la plataforma, que ya es su padre', () => {
    expect(moveTargets(RED, 'c')).toEqual([]);
    expect(moveBlockedReason(RED, andes)).toMatch(/Ningún otro nodo/);
  });

  it('descendientes y altura del subárbol', () => {
    expect([...descendantIds(RED, 'c')].sort()).toEqual(['n', 'ns']);
    expect(subtreeHeight(RED, 'c')).toBe(2);
    expect(subtreeHeight(RED, 'ns')).toBe(0);
  });
});

describe('moveSummary: la confirmación dice D6 A antes de mover', () => {
  it('Amazon bajo Planetour: dónde está, dónde queda y qué cambia', () => {
    const summary = moveSummary(RED, amazon, planetour);
    expect(summary.title).toBe('Mover Amazon Minimalist');
    expect(summary.before).toBe('Amazon Minimalist (raíz suelta, fuera de la red)');
    expect(summary.after).toBe('Planetour S.A.S › Amazon Minimalist');
    expect(summary.consequences.join(' ')).toContain(
      'rigen las credenciales, las reglas de precio y la marca de Planetour S.A.S',
    );
    expect(summary.consequences.join(' ')).toContain('Lo histórico queda como está');
    expect(summary.consequences.join(' ')).toContain('reservas abiertas pagadas con cartera');
  });

  it('dice con cuántos nodos se mueve', () => {
    const summary = moveSummary(RED, libre, andes);
    expect(summary.before).toBe('Planetour S.A.S › Agencia Libre');
    expect(summary.after).toBe('Planetour S.A.S › Consolidador Andes › Agencia Libre');
    expect(summary.consequences[0]).toBe('Se mueve con 1 nodo que depende de él.');
  });

  it('dónde está hoy un nodo', () => {
    expect(placementLabel(RED, planetour)).toBe('Planetour S.A.S');
    expect(placementLabel(RED, amazon)).toBe('Amazon Minimalist (raíz suelta, fuera de la red)');
    expect(placementLabel(RED, norte)).toBe('Planetour S.A.S › Consolidador Andes › Agencia Norte');
    // Un padre que el usuario no ve no se inventa.
    expect(placementLabel([norte], norte)).toBe('… › Agencia Norte');
  });

  it('el camino de un nodo', () => {
    expect(lineageLabel(RED, 'ns')).toBe(
      'Planetour S.A.S › Consolidador Andes › Agencia Norte › Norte Sur',
    );
  });
});

describe('statusChange: suspender y reactivar', () => {
  it('la plataforma no se suspende', () => {
    expect(statusChange(RED, planetour)).toBeUndefined();
  });

  it('suspender dice a cuántos nodos corta y es destructivo', () => {
    const change = statusChange(RED, andes);
    expect(change?.next).toBe('suspended');
    expect(change?.label).toBe('Suspender');
    expect(change?.destructive).toBe(true);
    expect(change?.description).toMatch(/^Consolidador Andes y 2 nodos de su red dejan de operar/);
  });

  it('un nodo sin red, en singular', () => {
    expect(statusChange(RED, norteSur)?.description).toMatch(/^Norte Sur deja de operar/);
  });

  it('activar un suspendido', () => {
    const change = statusChange(RED, { ...libreHija, status: 'suspended' });
    expect(change?.next).toBe('active');
    expect(change?.destructive).toBe(false);
    expect(change?.description).toBe(
      'Libre Hija vuelve a operar: sus usuarios recuperan el acceso.',
    );
  });

  it('avisa si un ancestro sigue suspendido', () => {
    const red = RED.map((n) => (n.id === 'l' ? { ...n, status: 'suspended' } : n));
    const hija = { ...libreHija, status: 'suspended' };
    expect(statusChange(red, hija)?.description).toMatch(/mientras Agencia Libre siga suspendido/);
  });

  it('un archivado no se toca desde acá', () => {
    expect(statusChange(RED, { ...libre, status: 'archived' })).toBeUndefined();
  });
});

describe('branchChange: marcar y desmarcar sucursal', () => {
  it('una agencia bajo Planetour se puede marcar', () => {
    expect(branchChange(RED, libre)).toMatchObject({
      isBranch: true,
      label: 'Marcar como sucursal',
    });
  });

  it('una sucursal se puede desmarcar', () => {
    expect(branchChange(RED, bogota)).toMatchObject({ isBranch: false, label: 'Quitar sucursal' });
  });

  it('no bajo un consolidador, ni una raíz suelta, ni otro tipo', () => {
    expect(branchChange(RED, norte)).toBeUndefined();
    expect(branchChange(RED, amazon)).toBeUndefined();
    expect(branchChange(RED, andes)).toBeUndefined();
    expect(branchChange(RED, planetour)).toBeUndefined();
  });
});

describe('búsqueda, slug y composición', () => {
  it('busca por nombre o slug, sin tildes ni mayúsculas', () => {
    expect(matchesQuery(bogota, 'bogota')).toBe(true);
    expect(matchesQuery(bogota, 'PLANETOUR-BOG')).toBe(true);
    expect(matchesQuery(bogota, 'andes')).toBe(false);
    expect(matchesQuery(bogota, '  ')).toBe(true);
  });

  it('el slug es el que acepta la API', () => {
    expect(slugify('Planetour Bogotá Norte')).toBe('planetour-bogota-norte');
    expect(slugify('  Viajes  & Más  ')).toBe('viajes-mas');
    expect(slugify('x'.repeat(80))).toHaveLength(50);
  });

  it('la composición de la red, en plural cuando corresponde', () => {
    expect(networkComposition(RED)).toBe(
      '1 plataforma · 1 sucursal · 1 consolidador · 3 agencias · 2 sub-agencias',
    );
  });
});
