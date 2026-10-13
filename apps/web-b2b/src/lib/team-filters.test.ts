import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEAM_FILTERS,
  TEAM_CHIPS,
  applyTeamFilters,
  byRole,
  chipCounts,
  clearTeamFilters,
  hasActiveFilters,
  locked,
  matchesSearch,
  neverLoggedIn,
  nextSort,
  parseTeamFilters,
  pendingMfa,
  queryWithTeamFilters,
  queryWithTeamTenant,
  resetPending,
  roleOptions,
  shownMembersText,
  sortMembers,
  suspended,
  suspendedCount,
  type TeamFilters,
} from './team-filters';
import type { NetworkMember } from './tenant-admin-team';

const NOW = Date.parse('2026-10-13T15:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function member(patch: Partial<NetworkMember> & { userId: string }): NetworkMember {
  return {
    email: `${patch.userId}@agencia.co`,
    name: null,
    userStatus: 'active',
    role: 'vendedor',
    membershipStatus: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastLoginAt: new Date(NOW - DAY).toISOString(),
    mfaEnabled: false,
    lockedUntil: null,
    activeSessions: 0,
    passwordResetRequired: false,
    ...patch,
  };
}

/*
 * Un equipo con un caso de cada cosa que un admin tiene que atender. Ana es la única "limpia".
 */
const ANA = member({ userId: 'ana', name: 'Ana Pérez', role: 'tenant_admin', mfaEnabled: true });
const BETO = member({ userId: 'beto', name: 'Beto', role: 'tenant_admin', mfaEnabled: false });
const CARLA = member({
  userId: 'carla',
  name: 'Carla',
  lockedUntil: new Date(NOW + 10 * MIN).toISOString(),
  lastLoginAt: new Date(NOW - 3 * DAY).toISOString(),
});
const DANI = member({ userId: 'dani', name: 'Dani', lastLoginAt: null });
const ELSA = member({
  userId: 'elsa',
  name: 'Elsa',
  role: 'admin',
  passwordResetRequired: true,
  lastLoginAt: new Date(NOW - 2 * 60 * MIN).toISOString(),
});
const FER = member({
  userId: 'fer',
  name: 'Fer',
  membershipStatus: 'suspended',
  lastLoginAt: null,
});
const GABI = member({ userId: 'gabi', name: 'Gabi', userStatus: 'suspended', role: 'admin' });

const TEAM = [ANA, BETO, CARLA, DANI, ELSA, FER, GABI];

function filters(patch: Partial<TeamFilters> = {}): TeamFilters {
  return { ...DEFAULT_TEAM_FILTERS, ...patch };
}

const ids = (list: readonly NetworkMember[]) => list.map((m) => m.userId);

describe('predicados', () => {
  it('2FA pendiente: su rol lo exige y no lo activó; sin el dato no se cuenta', () => {
    expect(pendingMfa(BETO)).toBe(true);
    expect(pendingMfa(ANA)).toBe(false);
    // Un vendedor sin 2FA no está pendiente: su rol no lo exige.
    expect(pendingMfa(CARLA)).toBe(false);
    expect(pendingMfa({ role: 'tenant_admin', mfaEnabled: undefined })).toBe(false);
    expect(pendingMfa({ role: 'consolidator_admin', mfaEnabled: false })).toBe(true);
  });

  it('bloqueado: sólo con el bloqueo vigente', () => {
    expect(locked(CARLA, NOW)).toBe(true);
    expect(locked({ lockedUntil: new Date(NOW - MIN).toISOString() }, NOW)).toBe(false);
    expect(locked({ lockedUntil: null }, NOW)).toBe(false);
    expect(locked({ lockedUntil: undefined }, NOW)).toBe(false);
    expect(locked({ lockedUntil: 'no es una fecha' }, NOW)).toBe(false);
  });

  it('nunca ingresó: null, no "el API no lo dice"', () => {
    expect(neverLoggedIn(DANI)).toBe(true);
    expect(neverLoggedIn(ANA)).toBe(false);
    expect(neverLoggedIn({ lastLoginAt: undefined })).toBe(false);
  });

  it('suspendido: en este nodo o en toda la plataforma', () => {
    expect(suspended(FER)).toBe(true);
    expect(suspended(GABI)).toBe(true);
    expect(suspended(ANA)).toBe(false);
    expect(suspended({ userStatus: 'invited', membershipStatus: 'active' })).toBe(false);
  });

  it('cambio de contraseña pendiente: sólo si el API dice que sí', () => {
    expect(resetPending(ELSA)).toBe(true);
    expect(resetPending(ANA)).toBe(false);
    expect(resetPending({ passwordResetRequired: undefined })).toBe(false);
  });

  it('por rol: sin rol elegido pasan todos', () => {
    expect(byRole(ANA, null)).toBe(true);
    expect(byRole(ANA, 'tenant_admin')).toBe(true);
    expect(byRole(ANA, 'vendedor')).toBe(false);
  });

  it('búsqueda por nombre o correo, sin mayúsculas ni tildes', () => {
    expect(matchesSearch(ANA, '  perez ')).toBe(true);
    expect(matchesSearch(ANA, 'ANA@AGENCIA')).toBe(true);
    expect(matchesSearch(ANA, 'beto')).toBe(false);
    expect(matchesSearch(DANI, '')).toBe(true);
    expect(matchesSearch({ name: null, email: 'josé@agencia.co' }, 'jose')).toBe(true);
  });
});

describe('applyTeamFilters', () => {
  it('sin filtros devuelve a todos en el orden del API', () => {
    expect(ids(applyTeamFilters(TEAM, filters(), '', NOW))).toEqual(ids(TEAM));
  });

  it('cada filtro rápido deja a quien corresponde', () => {
    const only = (chip: TeamFilters['chip']) =>
      ids(applyTeamFilters(TEAM, filters({ chip }), '', NOW));
    expect(only('mfa-pending')).toEqual(['beto']);
    expect(only('locked')).toEqual(['carla']);
    expect(only('never-logged-in')).toEqual(['dani', 'fer']);
    expect(only('reset-pending')).toEqual(['elsa']);
  });

  it('rol, ocultar suspendidos y búsqueda se suman al filtro rápido', () => {
    expect(ids(applyTeamFilters(TEAM, filters({ role: 'admin' }), '', NOW))).toEqual([
      'elsa',
      'gabi',
    ]);
    expect(
      ids(applyTeamFilters(TEAM, filters({ role: 'admin', hideSuspended: true }), '', NOW)),
    ).toEqual(['elsa']);
    expect(
      ids(
        applyTeamFilters(TEAM, filters({ chip: 'never-logged-in', hideSuspended: true }), '', NOW),
      ),
    ).toEqual(['dani']);
    expect(ids(applyTeamFilters(TEAM, filters({ chip: 'never-logged-in' }), 'fer', NOW))).toEqual([
      'fer',
    ]);
  });

  it('ordena después de filtrar', () => {
    const list = applyTeamFilters(
      TEAM,
      filters({ hideSuspended: true, sort: 'last-access-desc' }),
      '',
      NOW,
    );
    expect(ids(list)).toEqual(['elsa', 'ana', 'beto', 'carla', 'dani']);
  });

  it('no cambia la lista que recibe', () => {
    const copy = [...TEAM];
    applyTeamFilters(TEAM, filters({ sort: 'last-access-asc', chip: 'locked' }), 'a', NOW);
    expect(TEAM).toEqual(copy);
  });
});

describe('chipCounts y suspendedCount', () => {
  it('cuenta cada filtro rápido sobre todo el equipo', () => {
    expect(chipCounts(TEAM, filters(), '', NOW)).toEqual({
      'mfa-pending': 1,
      locked: 1,
      'never-logged-in': 2,
      'reset-pending': 1,
    });
    expect(suspendedCount(TEAM, filters(), '', NOW)).toBe(2);
  });

  it('el número de la chip es el de filas que deja: respeta búsqueda, rol y suspendidos', () => {
    const f = filters({ hideSuspended: true });
    const counts = chipCounts(TEAM, f, '', NOW);
    expect(counts['never-logged-in']).toBe(1);
    for (const chip of TEAM_CHIPS) {
      expect(applyTeamFilters(TEAM, { ...f, chip: chip.id }, '', NOW)).toHaveLength(
        counts[chip.id],
      );
    }
    expect(chipCounts(TEAM, filters({ role: 'tenant_admin' }), '', NOW)).toEqual({
      'mfa-pending': 1,
      locked: 0,
      'never-logged-in': 0,
      'reset-pending': 0,
    });
    expect(chipCounts(TEAM, filters(), 'carla', NOW).locked).toBe(1);
    expect(chipCounts(TEAM, filters(), 'ana', NOW).locked).toBe(0);
  });

  it('el filtro rápido elegido no cambia los números de los demás', () => {
    expect(chipCounts(TEAM, filters({ chip: 'locked' }), '', NOW)).toEqual(
      chipCounts(TEAM, filters(), '', NOW),
    );
  });

  it('los suspendidos se cuentan aunque estén ocultos, con la búsqueda y el rol puestos', () => {
    expect(suspendedCount(TEAM, filters({ hideSuspended: true }), '', NOW)).toBe(2);
    expect(suspendedCount(TEAM, filters({ role: 'admin' }), '', NOW)).toBe(1);
    expect(suspendedCount(TEAM, filters(), 'ana', NOW)).toBe(0);
  });

  it('con un filtro rápido, cuenta sólo los suspendidos que ese filtro deja: las filas que esconde', () => {
    // Fer (suspendido en el nodo) nunca ingresó; Gabi (suspendida en la plataforma) sí.
    expect(suspendedCount(TEAM, filters({ chip: 'never-logged-in' }), '', NOW)).toBe(1);
    // Ningún bloqueado está suspendido: marcar la casilla no cambiaría nada.
    expect(suspendedCount(TEAM, filters({ chip: 'locked' }), '', NOW)).toBe(0);
    for (const chip of TEAM_CHIPS) {
      const f = filters({ chip: chip.id });
      const hidden =
        applyTeamFilters(TEAM, f, '', NOW).length -
        applyTeamFilters(TEAM, { ...f, hideSuspended: true }, '', NOW).length;
      expect(suspendedCount(TEAM, f, '', NOW)).toBe(hidden);
    }
  });

  it('un bloqueo que venció deja de contar', () => {
    expect(chipCounts(TEAM, filters(), '', NOW + 11 * MIN).locked).toBe(0);
  });
});

describe('sortMembers', () => {
  const list = [
    member({ userId: 'ayer', lastLoginAt: new Date(NOW - DAY).toISOString() }),
    member({ userId: 'nunca-1', lastLoginAt: null }),
    member({ userId: 'recien', lastLoginAt: new Date(NOW - MIN).toISOString() }),
    member({ userId: 'nunca-2', lastLoginAt: null }),
    member({ userId: 'sin-dato', lastLoginAt: undefined }),
    member({ userId: 'semana', lastLoginAt: new Date(NOW - 7 * DAY).toISOString() }),
  ];

  it('más reciente primero; quien nunca ingresó va al final, en el orden del API', () => {
    expect(ids(sortMembers(list, 'last-access-desc'))).toEqual([
      'recien',
      'ayer',
      'semana',
      'nunca-1',
      'nunca-2',
      'sin-dato',
    ]);
  });

  it('más antiguo primero; quien nunca ingresó va al principio', () => {
    expect(ids(sortMembers(list, 'last-access-asc'))).toEqual([
      'nunca-1',
      'nunca-2',
      'sin-dato',
      'semana',
      'ayer',
      'recien',
    ]);
  });

  it('sin orden: el del API, en una copia', () => {
    const sorted = sortMembers(list, 'default');
    expect(ids(sorted)).toEqual(ids(list));
    expect(sorted).not.toBe(list);
  });

  it('el encabezado alterna reciente → antiguo → sin ordenar', () => {
    expect(nextSort('default')).toBe('last-access-desc');
    expect(nextSort('last-access-desc')).toBe('last-access-asc');
    expect(nextSort('last-access-asc')).toBe('default');
  });
});

describe('hasActiveFilters y clearTeamFilters', () => {
  it('el orden no es un filtro: no esconde a nadie', () => {
    expect(hasActiveFilters(filters())).toBe(false);
    expect(hasActiveFilters(filters({ sort: 'last-access-asc' }))).toBe(false);
    expect(hasActiveFilters(filters({ chip: 'locked' }))).toBe(true);
    expect(hasActiveFilters(filters({ role: 'admin' }))).toBe(true);
    expect(hasActiveFilters(filters({ hideSuspended: true }))).toBe(true);
  });

  it('"Quitar filtros" vuelve a mostrar a todos y conserva el orden', () => {
    const cleared = clearTeamFilters({
      chip: 'locked',
      role: 'admin',
      hideSuspended: true,
      sort: 'last-access-desc',
    });
    expect(cleared).toEqual(filters({ sort: 'last-access-desc' }));
    expect(hasActiveFilters(cleared)).toBe(false);
  });
});

describe('roleOptions', () => {
  it('los roles del nodo, del más alto al más bajo, sin repetir', () => {
    expect(roleOptions(TEAM, null)).toEqual(['tenant_admin', 'admin', 'vendedor']);
  });

  it('el elegido entra aunque nadie lo tenga, para poder verlo y quitarlo', () => {
    expect(roleOptions(TEAM, 'consolidator_admin')).toEqual([
      'consolidator_admin',
      'tenant_admin',
      'admin',
      'vendedor',
    ]);
    expect(roleOptions([], 'vendedor')).toEqual(['vendedor']);
  });

  it('un rol desconocido va al final, por nombre', () => {
    expect(roleOptions([{ role: 'zeta' }, { role: 'beta' }, { role: 'vendedor' }], null)).toEqual([
      'vendedor',
      'beta',
      'zeta',
    ]);
  });
});

describe('shownMembersText', () => {
  it('dice cuántos se ven y de cuántos', () => {
    expect(shownMembersText(7, 7)).toBe('Se muestran los 7 miembros.');
    expect(shownMembersText(1, 1)).toBe('Se muestra el único miembro.');
    expect(shownMembersText(3, 7)).toBe('Se muestran 3 de 7 miembros.');
    expect(shownMembersText(1, 7)).toBe('Se muestra 1 de 7 miembros.');
    expect(shownMembersText(0, 7)).toBe('Ningún miembro coincide.');
  });
});

describe('la URL', () => {
  it('ida y vuelta: lo que se escribe se lee igual', () => {
    const all: TeamFilters[] = [
      filters(),
      filters({ chip: 'mfa-pending' }),
      filters({ chip: 'locked', role: 'vendedor' }),
      filters({ chip: 'never-logged-in', hideSuspended: true }),
      filters({ chip: 'reset-pending', sort: 'last-access-asc' }),
      { chip: 'locked', role: 'consolidator_admin', hideSuspended: true, sort: 'last-access-desc' },
    ];
    for (const f of all) {
      expect(parseTeamFilters(queryWithTeamFilters('', f))).toEqual(f);
    }
  });

  it('nombres legibles en el enlace', () => {
    expect(
      queryWithTeamFilters('', {
        chip: 'never-logged-in',
        role: 'admin',
        hideSuspended: true,
        sort: 'last-access-desc',
      }),
    ).toBe('?filtro=nunca-ingresaron&rol=admin&suspendidos=ocultos&orden=acceso-reciente');
    expect(queryWithTeamFilters('', filters({ chip: 'mfa-pending' }))).toBe(
      '?filtro=2fa-pendiente',
    );
    expect(queryWithTeamFilters('', filters({ chip: 'reset-pending' }))).toBe(
      '?filtro=cambio-de-contrasena',
    );
    expect(queryWithTeamFilters('', filters({ sort: 'last-access-asc' }))).toBe(
      '?orden=acceso-antiguo',
    );
  });

  it('lo que está por defecto no se escribe y se borra lo que había', () => {
    expect(queryWithTeamFilters('', filters())).toBe('');
    expect(
      queryWithTeamFilters(
        '?filtro=bloqueados&rol=admin&suspendidos=ocultos&orden=acceso-antiguo',
        filters(),
      ),
    ).toBe('');
  });

  it('no toca el nodo ni otros parámetros', () => {
    const tenant = '33333333-3333-4333-8333-333333333333';
    expect(queryWithTeamFilters(`?tenant=${tenant}`, filters({ chip: 'locked' }))).toBe(
      `?tenant=${tenant}&filtro=bloqueados`,
    );
    expect(queryWithTeamFilters(`?tenant=${tenant}&filtro=bloqueados`, filters())).toBe(
      `?tenant=${tenant}`,
    );
    expect(parseTeamFilters(`?tenant=${tenant}&filtro=bloqueados`)).toEqual(
      filters({ chip: 'locked' }),
    );
  });

  it('un valor desconocido o malformado se ignora', () => {
    expect(parseTeamFilters('?filtro=todo&rol=Admin%20X&suspendidos=si&orden=alfabetico')).toEqual(
      filters(),
    );
    expect(parseTeamFilters('?rol=<script>')).toEqual(filters());
    expect(parseTeamFilters(`?rol=${'a'.repeat(41)}`)).toEqual(filters());
    expect(parseTeamFilters('')).toEqual(filters());
    // Un rol que no está en la base pero tiene la forma de uno: el selector lo muestra y se quita.
    expect(parseTeamFilters('?rol=gerente').role).toBe('gerente');
  });

  it('un rol malformado no se escribe', () => {
    expect(queryWithTeamFilters('', filters({ role: 'Admin X' }))).toBe('');
  });

  it('el nodo elegido se escribe sin tocar los filtros', () => {
    expect(queryWithTeamTenant('?filtro=bloqueados', 'abc')).toBe('?filtro=bloqueados&tenant=abc');
    expect(queryWithTeamTenant('?tenant=viejo&filtro=bloqueados', 'nuevo')).toBe(
      '?tenant=nuevo&filtro=bloqueados',
    );
    expect(queryWithTeamTenant('?tenant=viejo', '')).toBe('');
  });
});
