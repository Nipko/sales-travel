import { describe, expect, it } from 'vitest';
import {
  assignableProfiles,
  catalogKeys,
  cellLabel,
  choicesOf,
  defaultProfileFor,
  effectiveOriginLabel,
  itemsFromChoices,
  parseCatalog,
  parseProfileItems,
  parseProfiles,
  parseRules,
  parseTenantGovernance,
  profileEditWarning,
  profileFormErrors,
  profileSummary,
  ruleChangeDialog,
  type EffectiveCell,
  type GovernanceProfile,
} from './governance';

const NODO = '10000000-0000-4000-8000-000000000002';
const PADRE = '10000000-0000-4000-8000-000000000001';
const PERFIL = '20000000-0000-4000-8000-000000000001';

const CATALOG = [
  {
    code: 'latam-ndc',
    label: 'LATAM NDC',
    vertical: 'flights',
    paymentMethods: [
      {
        code: 'payment_link',
        use: 'order-payment-link',
        label: 'Enlace de pago LATAM',
        description: 'LATAM le envía al pagador un enlace.',
        pci: 'saq-a',
      },
      {
        code: 'card',
        use: 'order-pay',
        label: 'Tarjeta digitada en la plataforma',
        description: 'El número y el CVV pasan por nuestro servidor.',
        pci: 'out-of-scope',
      },
    ],
  },
  { code: 'tbo-hotels', label: 'TBO hoteles', vertical: 'hotels', paymentMethods: [] },
];

function profile(over: Partial<GovernanceProfile> = {}): GovernanceProfile {
  return {
    id: PERFIL,
    name: 'Agencia Colombia estándar',
    description: null,
    isDefaultForNewNodes: false,
    archived: false,
    items: [],
    tenantCount: 0,
    updatedAt: '2026-11-04T12:00:00.000Z',
    ...over,
  };
}

describe('parseCatalog', () => {
  it('lee el catálogo con su alcance PCI', () => {
    const parsed = parseCatalog(CATALOG);
    expect(parsed?.[0]?.paymentMethods[1]?.pci).toBe('out-of-scope');
    expect(parsed?.[1]?.paymentMethods).toEqual([]);
  });

  it('un alcance PCI desconocido rechaza todo el catálogo', () => {
    const broken = [
      {
        ...CATALOG[0],
        paymentMethods: [{ code: 'x', use: 'a', label: 'X', description: '', pci: 'pci-dss' }],
      },
    ];
    expect(parseCatalog(broken)).toBeUndefined();
  });
});

describe('parseProfiles', () => {
  it('lee el perfil con su matriz y cuántos nodos lo usan', () => {
    const parsed = parseProfiles([
      {
        ...profile({ tenantCount: 3 }),
        id: PERFIL.toUpperCase(),
        items: [{ provider: 'latam-ndc', method: '', enabled: true }],
      },
    ]);
    expect(parsed?.[0]).toMatchObject({ id: PERFIL, tenantCount: 3 });
    expect(parsed?.[0]?.items).toEqual([{ provider: 'latam-ndc', method: '', enabled: true }]);
  });

  it('un perfil sin conteo o con fecha rota no se pinta', () => {
    expect(parseProfiles([{ ...profile(), tenantCount: '3' }])).toBeUndefined();
    expect(parseProfiles([{ ...profile(), updatedAt: 'ayer' }])).toBeUndefined();
  });
});

describe('parseRules', () => {
  it('lee reglas globales (tenantId nulo)', () => {
    expect(
      parseRules([
        {
          provider: 'latam-ndc',
          method: 'card',
          tenantId: null,
          enabled: false,
          reason: 'Fuera de SAQ-A',
          updatedAt: '2026-11-04T12:00:00.000Z',
        },
      ]),
    ).toHaveLength(1);
  });
});

describe('parseTenantGovernance', () => {
  const VIEW = {
    tenant: { id: NODO, name: 'Agencia Sur', type: 'agency' },
    profile: { id: PERFIL, name: 'Solo hoteles' },
    rules: [],
    effective: [
      {
        provider: 'latam-ndc',
        method: '',
        enabled: true,
        origin: {
          kind: 'profile',
          tenantId: PADRE,
          profileId: PERFIL,
          profileName: 'Solo hoteles',
        },
        originTenantName: 'Consolidador Norte',
      },
      {
        provider: 'latam-ndc',
        method: 'card',
        enabled: false,
        origin: { kind: 'provider-off' },
        originTenantName: null,
      },
    ],
  };

  it('lee perfil, reglas y matriz efectiva', () => {
    const parsed = parseTenantGovernance(VIEW);
    expect(parsed?.profile?.name).toBe('Solo hoteles');
    expect(parsed?.effective[0]?.origin.kind).toBe('profile');
  });

  it('una celda «apagada por defecto» que viene encendida es una matriz que se contradice', () => {
    const broken = {
      ...VIEW,
      effective: [{ ...VIEW.effective[1], enabled: true }],
    };
    expect(parseTenantGovernance(broken)).toBeUndefined();
  });

  it('un origen desconocido rechaza la vista', () => {
    const broken = { ...VIEW, effective: [{ ...VIEW.effective[0], origin: { kind: 'magia' } }] };
    expect(parseTenantGovernance(broken)).toBeUndefined();
  });
});

describe('la matriz de tres posiciones', () => {
  const catalog = parseCatalog(CATALOG) ?? [];

  it('recorre el proveedor y después sus formas de pago', () => {
    expect(catalogKeys(catalog).map((k) => `${k.provider}:${k.method}`)).toEqual([
      'latam-ndc:',
      'latam-ndc:payment_link',
      'latam-ndc:card',
      'tbo-hotels:',
    ]);
  });

  it('«No decide» no viaja: sólo lo explícito, en el orden del catálogo', () => {
    const choices = choicesOf([
      { provider: 'tbo-hotels', method: '', enabled: true },
      { provider: 'latam-ndc', method: 'card', enabled: false },
    ]);
    expect(itemsFromChoices(catalog, choices)).toEqual([
      { provider: 'latam-ndc', method: 'card', enabled: false },
      { provider: 'tbo-hotels', method: '', enabled: true },
    ]);
  });

  it('nombra una celda con el proveedor y la forma de pago', () => {
    expect(cellLabel(catalog, { provider: 'latam-ndc', method: 'payment_link' })).toBe(
      'LATAM NDC · Enlace de pago LATAM',
    );
    expect(cellLabel(catalog, { provider: 'tbo-hotels', method: '' })).toBe('TBO hoteles');
  });
});

describe('parseProfileItems (borde del proxy)', () => {
  it('rearma cada elemento y completa el método vacío', () => {
    expect(parseProfileItems([{ provider: 'tbo-hotels', enabled: true, extra: 'x' }])).toEqual([
      { provider: 'tbo-hotels', method: '', enabled: true },
    ]);
  });

  it('rechaza códigos raros y repetidos', () => {
    expect(
      parseProfileItems([{ provider: '../users', method: '', enabled: true }]),
    ).toBeUndefined();
    expect(
      parseProfileItems([
        { provider: 'sabre', method: 'cash', enabled: true },
        { provider: 'sabre', method: 'cash', enabled: false },
      ]),
    ).toBeUndefined();
  });
});

describe('effectiveOriginLabel', () => {
  function cell(origin: EffectiveCell['origin'], name: string | null = null, enabled = true) {
    return { provider: 'latam-ndc', method: '', enabled, origin, originTenantName: name };
  }

  it('dice de qué perfil y de qué nodo sale', () => {
    expect(
      effectiveOriginLabel(
        cell(
          { kind: 'profile', tenantId: PADRE, profileId: PERFIL, profileName: 'Solo hoteles' },
          'Consolidador Norte',
        ),
        NODO,
      ),
    ).toBe('Perfil «Solo hoteles» en Consolidador Norte');
  });

  it('una regla del propio nodo es «en este nodo»; la global, «Regla global»', () => {
    expect(effectiveOriginLabel(cell({ kind: 'rule', tenantId: NODO }, 'Agencia Sur'), NODO)).toBe(
      'Regla a mano en este nodo',
    );
    expect(effectiveOriginLabel(cell({ kind: 'rule', tenantId: null }))).toBe('Regla global');
  });

  it('explica los dos apagados', () => {
    expect(effectiveOriginLabel(cell({ kind: 'default' }, null, false))).toBe(
      'Apagado: nadie lo habilitó',
    );
    expect(effectiveOriginLabel(cell({ kind: 'provider-off' }, null, false))).toBe(
      'Apagado: el proveedor está apagado',
    );
  });
});

describe('perfiles', () => {
  it('avisa a cuántos nodos cambia editar un perfil enlazado', () => {
    expect(profileEditWarning(0)).toBeNull();
    expect(profileEditWarning(1)).toMatch(/^Cambia a 1 nodo que usa este perfil/);
    expect(profileEditWarning(4)).toMatch(/^Cambia a 4 nodos que usan este perfil/);
  });

  it('propone el predeterminado vigente, nunca uno archivado', () => {
    expect(defaultProfileFor([profile({ isDefaultForNewNodes: true })])).toBe(PERFIL);
    expect(defaultProfileFor([profile({ isDefaultForNewNodes: true, archived: true })])).toBe('');
  });

  it('ofrece los vigentes y conserva el actual aunque esté archivado', () => {
    const archived = profile({ id: 'x', name: 'Viejo', archived: true });
    expect(assignableProfiles([archived, profile()]).map((p) => p.name)).toEqual([
      'Agencia Colombia estándar',
    ]);
    expect(assignableProfiles([archived, profile()], 'x')).toHaveLength(2);
  });

  it('resume la matriz y valida el formulario', () => {
    expect(profileSummary(profile())).toMatch(/No decide nada/);
    expect(
      profileSummary(
        profile({
          items: [
            { provider: 'sabre', method: '', enabled: true },
            { provider: 'sabre', method: 'cash', enabled: false },
          ],
        }),
      ),
    ).toBe('1 encendido · 1 apagado');
    expect(profileFormErrors({ name: ' a ', description: '' })?.name).toMatch(/entre 2 y 80/);
    expect(profileFormErrors({ name: 'Solo hoteles', description: '' })).toBeUndefined();
  });
});

describe('ruleChangeDialog', () => {
  it('apagar se confirma como destructivo y pide motivo', () => {
    const d = ruleChangeDialog({ label: 'LATAM NDC', tenantName: null, from: 'unset', to: 'off' });
    expect(d).toMatchObject({ destructive: true, withReason: true, confirmLabel: 'Apagar' });
    expect(d.title).toBe('¿Apagar LATAM NDC para toda la plataforma?');
  });

  it('quitar la regla de un nodo no pide motivo y dice qué pasa después', () => {
    const d = ruleChangeDialog({
      label: 'TBO hoteles',
      tenantName: 'Agencia Sur',
      from: 'on',
      to: 'unset',
    });
    expect(d.withReason).toBe(false);
    expect(d.description).toMatch(/vuelve a seguir su perfil/);
  });
});
