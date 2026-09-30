import { describe, expect, it } from 'vitest';
import {
  AGENCY_SEARCH_THRESHOLD,
  agencyOptions,
  filterAgencies,
  hasOtherAgencies,
  isSelectable,
  matchesSearch,
  parseMemberships,
  resolveActiveMembership,
  showsAgencySearch,
  switchedMessage,
  unavailableLabel,
  type MembershipSummary,
} from './agencies';

function membership(
  overrides: Partial<MembershipSummary> & { tenantId: string },
): MembershipSummary {
  return {
    id: `m-${overrides.tenantId}`,
    role: 'vendedor',
    status: 'active',
    tenantSlug: overrides.tenantId,
    tenantName: `Agencia ${overrides.tenantId}`,
    tenantType: 'agency',
    logoUrl: null,
    operable: true,
    unavailableReason: null,
    blockedByName: null,
    isDefault: false,
    ...overrides,
  };
}

describe('parseMemberships', () => {
  it('lee la respuesta nueva de /me/memberships', () => {
    const [m] = parseMemberships([
      {
        id: 'm1',
        role: 'admin',
        status: 'active',
        tenantId: 't1',
        tenantSlug: 'andinos',
        tenantName: 'Viajes Andinos',
        tenantType: 'agency',
        logoUrl: 'https://cdn.test/a.png',
        operable: false,
        unavailableReason: 'ancestor_suspended',
        blockedByName: 'Consolidador Sur',
        isDefault: true,
      },
    ]);
    expect(m).toEqual({
      id: 'm1',
      role: 'admin',
      status: 'active',
      tenantId: 't1',
      tenantSlug: 'andinos',
      tenantName: 'Viajes Andinos',
      tenantType: 'agency',
      logoUrl: 'https://cdn.test/a.png',
      operable: false,
      unavailableReason: 'ancestor_suspended',
      blockedByName: 'Consolidador Sur',
      isDefault: true,
    });
  });

  it('una API anterior (sin los campos nuevos): opera si la membership está activa', () => {
    const [active, suspended] = parseMemberships([
      {
        id: 'a',
        role: 'vendedor',
        status: 'active',
        tenantId: 't1',
        tenantSlug: 's',
        tenantName: 'A',
      },
      {
        id: 'b',
        role: 'vendedor',
        status: 'suspended',
        tenantId: 't2',
        tenantSlug: 's',
        tenantName: 'B',
      },
    ]);
    expect(active).toMatchObject({ operable: true, isDefault: false, logoUrl: null });
    expect(suspended?.operable).toBe(false);
  });

  it('descarta filas rotas y lo que no es una lista', () => {
    expect(parseMemberships({ nope: true })).toEqual([]);
    expect(parseMemberships([null, { role: 'x' }, 'x'])).toEqual([]);
  });

  it('un motivo desconocido no se inventa', () => {
    const [m] = parseMemberships([
      { role: 'r', status: 'active', tenantId: 't', operable: false, unavailableReason: 'raro' },
    ]);
    expect(m?.unavailableReason).toBeNull();
    expect(m?.operable).toBe(false);
  });

  it('una membership no activa nunca es la por defecto', () => {
    const [m] = parseMemberships([
      { role: 'r', status: 'invited', tenantId: 't', operable: true, isDefault: true },
    ]);
    expect(m?.isDefault).toBe(false);
    expect(m?.operable).toBe(false);
  });
});

describe('resolveActiveMembership: el mismo criterio que la API', () => {
  // Orden alfabético, como llega de la API: la primera NO es la por defecto.
  const list = [
    membership({ tenantId: 'a-primera-alfabetica' }),
    membership({ tenantId: 'b-por-defecto', isDefault: true }),
    membership({ tenantId: 'c-suspendida', status: 'suspended' }),
  ];

  it('la de la cookie (el tid de la sesión) si sigue activa', () => {
    expect(resolveActiveMembership(list, 'a-primera-alfabetica')?.tenantId).toBe(
      'a-primera-alfabetica',
    );
  });

  it('sin cookie, la por defecto de la API, no la primera alfabética', () => {
    expect(resolveActiveMembership(list, null)?.tenantId).toBe('b-por-defecto');
  });

  it('una cookie de una membership suspendida o ajena cae a la por defecto', () => {
    expect(resolveActiveMembership(list, 'c-suspendida')?.tenantId).toBe('b-por-defecto');
    expect(resolveActiveMembership(list, 'otra')?.tenantId).toBe('b-por-defecto');
  });

  it('sin por defecto (API vieja), la primera activa', () => {
    const old = [membership({ tenantId: 'x', status: 'invited' }), membership({ tenantId: 'y' })];
    expect(resolveActiveMembership(old, null)?.tenantId).toBe('y');
  });

  it('sin memberships activas, ninguna', () => {
    expect(resolveActiveMembership([membership({ tenantId: 'i', status: 'invited' })], null)).toBe(
      undefined,
    );
  });
});

describe('agencyOptions', () => {
  it('sólo memberships activas, la actual primero y marcada', () => {
    const options = agencyOptions(
      [
        membership({ tenantId: 'a' }),
        membership({ tenantId: 'inv', status: 'invited' }),
        membership({ tenantId: 'b', role: 'admin', logoUrl: 'https://cdn.test/b.png' }),
      ],
      'b',
    );
    expect(options.map((o) => o.tenantId)).toEqual(['b', 'a']);
    expect(options[0]).toEqual({
      tenantId: 'b',
      name: 'Agencia b',
      slug: 'b',
      role: 'admin',
      logoUrl: 'https://cdn.test/b.png',
      current: true,
      disabledReason: null,
    });
  });

  it('orden: la actual, las elegibles (alfabético, como la API) y al final las que no operan', () => {
    const options = agencyOptions(
      [
        membership({
          tenantId: 'a-cerrada',
          operable: false,
          unavailableReason: 'tenant_suspended',
        }),
        membership({ tenantId: 'b' }),
        membership({ tenantId: 'c-actual' }),
        membership({ tenantId: 'd' }),
      ],
      'c-actual',
    );
    expect(options.map((o) => o.tenantId)).toEqual(['c-actual', 'b', 'd', 'a-cerrada']);
  });

  it('las que no operan quedan deshabilitadas con su motivo', () => {
    const [own, ancestor, unknown] = agencyOptions(
      [
        membership({ tenantId: 's', operable: false, unavailableReason: 'tenant_suspended' }),
        membership({
          tenantId: 'h',
          operable: false,
          unavailableReason: 'ancestor_suspended',
          blockedByName: 'Consolidador Sur',
        }),
        membership({ tenantId: 'u', operable: false }),
      ],
      null,
    );
    expect(own?.disabledReason).toBe('Agencia suspendida');
    expect(ancestor?.disabledReason).toBe('Suspendida: Consolidador Sur está suspendida');
    expect(unknown?.disabledReason).toBe('No disponible');
    expect([own, ancestor, unknown].some((o) => o && isSelectable(o))).toBe(false);
  });

  it('la actual no se elige (ya se opera con ella)', () => {
    const [current] = agencyOptions([membership({ tenantId: 'a' })], 'a');
    expect(current && isSelectable(current)).toBe(false);
  });

  it('hay otra agencia sólo si queda alguna además de la actual', () => {
    expect(hasOtherAgencies(agencyOptions([membership({ tenantId: 'a' })], 'a'))).toBe(false);
    expect(
      hasOtherAgencies(
        agencyOptions([membership({ tenantId: 'a' }), membership({ tenantId: 'b' })], 'a'),
      ),
    ).toBe(true);
  });
});

describe('unavailableLabel', () => {
  it('cada motivo, y el de un ancestro sin nombre', () => {
    expect(unavailableLabel('tenant_archived', null)).toBe('Agencia archivada');
    expect(unavailableLabel('ancestor_suspended', null)).toBe('Su red está suspendida');
    expect(unavailableLabel(null, null)).toBeNull();
  });
});

describe('búsqueda de agencias', () => {
  const options = agencyOptions(
    [
      membership({ tenantId: '1', tenantName: 'Viajes Perú Andino', tenantSlug: 'peru-andino' }),
      membership({ tenantId: '2', tenantName: 'Turismo Bogotá', tenantSlug: 'bog-centro' }),
      membership({ tenantId: '3', tenantName: 'São Paulo Tours', tenantSlug: 'sp-tours' }),
    ],
    null,
  );

  it('aparece con 5 agencias o más', () => {
    expect(AGENCY_SEARCH_THRESHOLD).toBe(5);
    expect(showsAgencySearch(4)).toBe(false);
    expect(showsAgencySearch(5)).toBe(true);
  });

  it('sin tildes ni mayúsculas: "peru" encuentra "Perú", "sao" encuentra "São"', () => {
    expect(filterAgencies(options, 'peru').map((o) => o.tenantId)).toEqual(['1']);
    expect(filterAgencies(options, 'SAO').map((o) => o.tenantId)).toEqual(['3']);
  });

  it('busca también por identificador y exige todas las palabras', () => {
    expect(filterAgencies(options, 'bog centro').map((o) => o.tenantId)).toEqual(['2']);
    expect(filterAgencies(options, 'bogota peru')).toEqual([]);
  });

  it('una búsqueda vacía o de espacios deja todas', () => {
    expect(filterAgencies(options, '   ')).toHaveLength(3);
    expect(matchesSearch(['x'], '')).toBe(true);
  });
});

describe('switchedMessage', () => {
  it('el aviso después de cambiar', () => {
    expect(switchedMessage('Viajes Andinos')).toBe('Ahora operás como Viajes Andinos');
  });
});
