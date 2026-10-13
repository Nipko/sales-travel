import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountStatus,
  chipPressed,
  directoryLoadError,
  directoryMfaState,
  directorySearch,
  hasFilters,
  lastAccess,
  loadDirectoryNodes,
  loadPlatformUsers,
  loadSuspensionImpact,
  membershipChipLabel,
  membershipChips,
  parseDirectoryNodes,
  parsePlatformUser,
  parsePlatformUsersPage,
  parseSuspensionImpact,
  parseUserStatusResult,
  platformUserName,
  reactivateCopy,
  setPlatformUserStatus,
  statusChangeError,
  statusDoneMessage,
  suspendCopy,
  teamHref,
  toggleChip,
  type DirectoryFilters,
  type PlatformUser,
} from './platform-users';
import { voseoIn } from './voseo';
import { registerStepUpPrompt } from './step-up';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const NODE = '0b6f6a52-7a47-4c8e-9a3b-1a2b3c4d5e6f';
const OTHER = '1c7a7b63-8b58-4d9f-8b4c-2b3c4d5e6f70';

const RAW = {
  id: 'u-1',
  email: 'ana@agencia.co',
  name: 'Ana Pérez',
  status: 'active',
  emailVerified: true,
  mfaEnabled: false,
  lockedUntil: null,
  lastLoginAt: '2026-10-10T12:00:00Z',
  lastSeenAt: '2026-10-11T11:55:00Z',
  activeSessions: 2,
  createdAt: '2026-01-01T00:00:00Z',
  memberships: [
    {
      tenantId: NODE,
      tenantName: 'Agencia Norte',
      tenantType: 'agency',
      isBranch: false,
      role: 'tenant_admin',
      status: 'active',
    },
    {
      tenantId: OTHER,
      tenantName: 'Agencia Sur',
      tenantType: 'agency',
      isBranch: false,
      role: 'vendedor',
      status: 'suspended',
    },
  ],
};

function user(patch: Record<string, unknown> = {}): PlatformUser {
  const parsed = parsePlatformUser({ ...RAW, ...patch });
  if (parsed === undefined) throw new Error('fixture inválida');
  return parsed;
}

describe('lo que trae el API', () => {
  it('una persona con sus nodos; lo que falta se lee con un valor seguro', () => {
    expect(user()).toMatchObject({ id: 'u-1', activeSessions: 2, memberships: [{}, {}] });
    expect(
      parsePlatformUser({ id: 'u-2', email: 'b@x.co', status: 'suspended', memberships: [{}] }),
    ).toEqual({
      id: 'u-2',
      email: 'b@x.co',
      name: null,
      status: 'suspended',
      emailVerified: true,
      mfaEnabled: false,
      lockedUntil: null,
      lastLoginAt: null,
      lastSeenAt: null,
      activeSessions: 0,
      createdAt: '',
      memberships: [],
    });
    expect(parsePlatformUser({ email: 'b@x.co', status: 'active' })).toBeUndefined();
    expect(parsePlatformUser('nada')).toBeUndefined();
  });

  it('una página: personas y cursor; una forma rara es un error, no una lista vacía', () => {
    expect(parsePlatformUsersPage({ users: [RAW, { id: 'x' }], nextCursor: 'abc' })).toMatchObject({
      users: [{ id: 'u-1' }],
      nextCursor: 'abc',
    });
    expect(parsePlatformUsersPage({ users: [], nextCursor: null })).toEqual({
      users: [],
      nextCursor: null,
    });
    expect(parsePlatformUsersPage({ users: [] })).toEqual({ users: [], nextCursor: null });
    expect(parsePlatformUsersPage({ users: 'x' })).toBeUndefined();
    expect(parsePlatformUsersPage({ users: [], nextCursor: 3 })).toBeUndefined();
    expect(parsePlatformUsersPage(null)).toBeUndefined();
  });

  it('el impacto y el resultado de la suspensión', () => {
    expect(
      parseSuspensionImpact({ activeMemberships: 2, liveSessions: 1, invitationsToRevoke: 0 }),
    ).toEqual({ activeMemberships: 2, liveSessions: 1, invitationsToRevoke: 0 });
    expect(parseSuspensionImpact({ activeMemberships: 2, liveSessions: -1 })).toBeUndefined();
    expect(parseUserStatusResult({ status: 'suspended', revokedSessions: 3 })).toEqual({
      status: 'suspended',
      revokedSessions: 3,
      revokedInvitations: 0,
    });
    expect(parseUserStatusResult({ status: 'archived' })).toBeUndefined();
  });

  it('los nodos para el filtro, en el orden del árbol y con la sangría de su nivel', () => {
    const nodes = parseDirectoryNodes({
      tenants: [
        {
          id: OTHER.toUpperCase(),
          name: 'Agencia Sur',
          tenantType: 'agency',
          parentTenantId: 'P',
          depth: 2,
        },
        { id: 'P', name: 'Planetour', tenantType: 'platform', parentTenantId: null, depth: 1 },
        { name: 'sin id' },
      ],
    });
    expect(nodes?.map((n) => [n.name, n.depth])).toEqual([
      ['Planetour', 1],
      ['Agencia Sur', 2],
    ]);
    expect(nodes?.[1]?.id).toBe(OTHER);
    expect(parseDirectoryNodes({})).toBeUndefined();
  });
});

describe('filtros', () => {
  it('la consulta para la ruta del panel, sólo con lo puesto', () => {
    expect(directorySearch({ q: '  ' })).toBe('');
    expect(
      directorySearch(
        {
          q: ' ana ',
          status: 'active',
          role: 'vendedor',
          tenantId: NODE,
          withoutMfa: true,
          locked: true,
          neverLoggedIn: true,
        },
        'cur',
      ),
    ).toBe(
      `q=ana&status=active&role=vendedor&tenantId=${NODE}&mfa=off&locked=true&neverLoggedIn=true&cursor=cur`,
    );
    expect(hasFilters({ q: 'ana' })).toBe(false);
    expect(hasFilters({ q: '', locked: true })).toBe(true);
  });

  it('"Activos" y "Suspendidos" se excluyen; los demás se prenden y apagan', () => {
    let f = toggleChip<Omit<DirectoryFilters, 'q'>>({}, 'active');
    expect(chipPressed(f, 'active')).toBe(true);
    f = toggleChip(f, 'suspended');
    expect(chipPressed(f, 'active')).toBe(false);
    expect(chipPressed(f, 'suspended')).toBe(true);
    f = toggleChip(f, 'suspended');
    expect(f.status).toBeUndefined();
    f = toggleChip(f, 'withoutMfa');
    expect(chipPressed(f, 'withoutMfa')).toBe(true);
    expect(chipPressed(toggleChip(f, 'withoutMfa'), 'withoutMfa')).toBe(false);
  });
});

describe('cómo se dice cada dato', () => {
  it('el nombre, o el correo si no lo puso', () => {
    expect(platformUserName(user())).toBe('Ana Pérez');
    expect(platformUserName(user({ name: '  ' }))).toBe('ana@agencia.co');
  });

  it('estado: suspendida en la plataforma pesa más que un bloqueo; un bloqueo vencido no cuenta', () => {
    expect(accountStatus(user(), NOW)).toEqual({ label: 'Activo', tone: 'ok' });
    const locked = accountStatus(user({ lockedUntil: '2026-10-11T12:30:00Z' }), NOW);
    expect(locked.tone).toBe('warn');
    expect(locked.label).toMatch(/^Bloqueado hasta las /);
    expect(accountStatus(user({ lockedUntil: '2026-10-11T11:00:00Z' }), NOW).label).toBe('Activo');
    expect(
      accountStatus(user({ status: 'suspended', lockedUntil: '2026-10-11T12:30:00Z' }), NOW),
    ).toEqual({ label: 'Suspendido en toda la plataforma', tone: 'danger' });
  });

  it('último acceso: la actividad más reciente o el ingreso; "En línea" con sesiones vivas', () => {
    expect(lastAccess(user(), NOW)).toEqual({
      label: 'hace 5 min',
      at: '2026-10-11T11:55:00Z',
      online: true,
    });
    expect(lastAccess(user({ lastSeenAt: null, activeSessions: 0 }), NOW)).toEqual({
      label: 'hace 1 día',
      at: '2026-10-10T12:00:00Z',
      online: false,
    });
    expect(lastAccess(user({ lastSeenAt: null, lastLoginAt: null }), NOW).label).toBe(
      'Nunca ingresó',
    );
  });

  it('2FA pendiente sólo si un acceso activo tiene un rol que lo exige', () => {
    expect(directoryMfaState(user())).toBe('pending');
    expect(directoryMfaState(user({ mfaEnabled: true }))).toBe('active');
    expect(
      directoryMfaState(
        user({
          memberships: [{ ...RAW.memberships[0], status: 'suspended' }, RAW.memberships[1]],
        }),
      ),
    ).toBe('not-required');
  });

  it('chips "Nodo · Rol": dos y "+N"', () => {
    const many = user({
      memberships: [
        ...RAW.memberships,
        { ...RAW.memberships[1], tenantId: 'x', tenantName: 'Agencia Este' },
      ],
    });
    const chips = membershipChips(many);
    expect(chips.shown.map((m) => m.tenantName)).toEqual(['Agencia Norte', 'Agencia Sur']);
    expect(chips.more).toBe(1);
    expect(membershipChips(user()).more).toBe(0);
    expect(
      membershipChipLabel(RAW.memberships[0]!, (r) => (r === 'tenant_admin' ? 'Admin' : r)),
    ).toBe('Agencia Norte · Admin');
  });

  it('"Ver en Equipo" abre el primer nodo; sin nodos no hay a dónde ir', () => {
    expect(teamHref(user())).toBe(`/admin/usuarios?tenant=${NODE}`);
    expect(teamHref(user({ memberships: [] }))).toBeUndefined();
  });
});

describe('confirmaciones y avisos, en tú', () => {
  it('suspender: el título, el botón y lo que pierde, con números', () => {
    const copy = suspendCopy(user(), {
      activeMemberships: 3,
      liveSessions: 2,
      invitationsToRevoke: 4,
    });
    expect(copy).toEqual({
      title: 'Suspender a Ana Pérez en toda la plataforma',
      confirmLabel: 'Suspender en toda la plataforma',
      description:
        'Pierde el acceso a sus 3 nodos de inmediato: se cierran sus 2 sesiones y se revocan 4 invitaciones que envió. Puedes reactivarlo después; sus sesiones e invitaciones no vuelven.',
    });
  });

  it('suspender: singulares, nada que cortar y sin poder saberlo', () => {
    expect(
      suspendCopy(user(), { activeMemberships: 1, liveSessions: 1, invitationsToRevoke: 1 })
        .description,
    ).toBe(
      'Pierde el acceso a su nodo de inmediato: se cierra su sesión abierta y se revoca 1 invitación que envió. Puedes reactivarlo después; sus sesiones e invitaciones no vuelven.',
    );
    expect(
      suspendCopy(user(), { activeMemberships: 0, liveSessions: 0, invitationsToRevoke: 0 })
        .description,
    ).toBe('Pierde el acceso a la plataforma de inmediato. Puedes reactivarlo después.');
    expect(suspendCopy(user(), null).description).toBe(
      'Pierde el acceso a todos sus nodos de inmediato: se cierran sus sesiones y se revocan las invitaciones que envió. Puedes reactivarlo después; sus sesiones e invitaciones no vuelven.',
    );
  });

  it('reactivar', () => {
    expect(reactivateCopy(user())).toEqual({
      title: 'Reactivar la cuenta de Ana Pérez',
      description:
        'Vuelve a poder ingresar a los nodos donde su acceso esté activo. Los accesos suspendidos por nodo siguen suspendidos.',
      confirmLabel: 'Reactivar',
    });
  });

  it('el aviso de éxito dice lo que cortó', () => {
    expect(
      statusDoneMessage(user(), { status: 'suspended', revokedSessions: 2, revokedInvitations: 1 }),
    ).toBe(
      'Ana Pérez quedó suspendido en toda la plataforma. Se cerraron 2 sesiones y se revocó 1 invitación.',
    );
    expect(
      statusDoneMessage(user(), { status: 'suspended', revokedSessions: 1, revokedInvitations: 3 }),
    ).toBe(
      'Ana Pérez quedó suspendido en toda la plataforma. Se cerró 1 sesión y se revocaron 3 invitaciones.',
    );
    expect(
      statusDoneMessage(user(), { status: 'suspended', revokedSessions: 0, revokedInvitations: 0 }),
    ).toBe('Ana Pérez quedó suspendido en toda la plataforma.');
    expect(
      statusDoneMessage(user(), { status: 'active', revokedSessions: 0, revokedInvitations: 0 }),
    ).toBe('Reactivamos la cuenta de Ana Pérez.');
  });

  it('los errores distinguen sesión, permiso y servidor', () => {
    expect(directoryLoadError(401, 'x')).toBe('Tu sesión venció. Vuelve a iniciar sesión.');
    expect(directoryLoadError(403, 'x')).toBe('Esta pantalla es sólo para el superadmin.');
    expect(directoryLoadError(502, undefined)).toMatch(/el servidor no respondió/);
    expect(directoryLoadError(400, 'Los filtros del directorio no son válidos.')).toBe(
      'Los filtros del directorio no son válidos.',
    );
    expect(directoryLoadError(404, undefined)).toBe(
      'No pudimos cargar los usuarios. Inténtalo de nuevo.',
    );

    expect(statusChangeError(401, undefined, true)).toBe(
      'Tu sesión venció. Vuelve a iniciar sesión.',
    );
    expect(
      statusChangeError(409, 'Es el último superadmin activo: no se puede suspender.', true),
    ).toBe('Es el último superadmin activo: no se puede suspender.');
    expect(statusChangeError(403, undefined, true)).toBe('Esta acción es sólo para el superadmin.');
    expect(statusChangeError(500, 'stack', false)).toBe(
      'No pudimos reactivar la cuenta: el servidor no respondió. Inténtalo de nuevo.',
    );
    expect(statusChangeError(404, '', true)).toBe('No pudimos suspender la cuenta.');
  });

  it('ningún texto usa voseo', () => {
    const texts = [
      suspendCopy(user(), null),
      suspendCopy(user(), { activeMemberships: 2, liveSessions: 2, invitationsToRevoke: 2 }),
      reactivateCopy(user()),
    ].flatMap((c) => [c.title, c.description, c.confirmLabel]);
    texts.push(
      directoryLoadError(401, undefined),
      directoryLoadError(403, undefined),
      directoryLoadError(500, undefined),
      statusChangeError(500, undefined, true),
      statusDoneMessage(user(), { status: 'suspended', revokedSessions: 2, revokedInvitations: 2 }),
    );
    expect(texts.flatMap(voseoIn)).toEqual([]);
  });
});

describe('las llamadas del navegador', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function respond(status: number, body: unknown) {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('el directorio pide la ruta del panel con los filtros y lee la página', async () => {
    const fetchMock = respond(200, { users: [RAW], nextCursor: null });
    const res = await loadPlatformUsers({ q: 'ana', locked: true }, 'cur');
    expect(res).toMatchObject({ ok: true, data: { users: [{ id: 'u-1' }], nextCursor: null } });
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/users?q=ana&locked=true&cursor=cur', {
      cache: 'no-store',
    });
  });

  it('sin filtros, la ruta sola; un 403 llega como el mensaje de permiso', async () => {
    const fetchMock = respond(403, { error: 'Esta acción es sólo para el superadmin.' });
    await expect(loadPlatformUsers({ q: '' })).resolves.toEqual({
      ok: false,
      message: 'Esta pantalla es sólo para el superadmin.',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/users', { cache: 'no-store' });
  });

  it('sin conexión o con una respuesta que no se entiende, un mensaje y no una excepción', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await expect(loadPlatformUsers({ q: '' })).resolves.toEqual({
      ok: false,
      message: 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
    });
    respond(200, { nada: true });
    await expect(loadPlatformUsers({ q: '' })).resolves.toEqual({
      ok: false,
      message: 'El servidor respondió algo que no pudimos leer. Recarga la página.',
    });
  });

  it('los nodos, el impacto y la suspensión', async () => {
    respond(200, {
      tenants: [{ id: NODE, name: 'Agencia Norte', depth: 1, parentTenantId: null }],
    });
    await expect(loadDirectoryNodes()).resolves.toMatchObject({
      ok: true,
      data: [{ id: NODE, name: 'Agencia Norte' }],
    });
    respond(500, {});
    await expect(loadDirectoryNodes()).resolves.toEqual({
      ok: false,
      message: 'No pudimos cargar los nodos de la red.',
    });

    const impact = respond(200, { activeMemberships: 1, liveSessions: 0, invitationsToRevoke: 2 });
    await expect(loadSuspensionImpact(NODE)).resolves.toEqual({
      ok: true,
      data: { activeMemberships: 1, liveSessions: 0, invitationsToRevoke: 2 },
    });
    expect(impact).toHaveBeenCalledWith(`/api/admin/users/${NODE}/impact`, { cache: 'no-store' });

    const patch = respond(200, {
      id: NODE,
      status: 'suspended',
      revokedSessions: 1,
      revokedInvitations: 0,
    });
    await expect(setPlatformUserStatus(NODE, 'suspended')).resolves.toEqual({
      ok: true,
      data: { status: 'suspended', revokedSessions: 1, revokedInvitations: 0 },
    });
    expect(patch).toHaveBeenCalledWith('/api/admin/users/status', {
      cache: 'no-store',
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: NODE, status: 'suspended' }),
    });

    respond(409, { error: 'Es el último superadmin activo: no se puede suspender.' });
    await expect(setPlatformUserStatus(NODE, 'suspended')).resolves.toEqual({
      ok: false,
      message: 'Es el último superadmin activo: no se puede suspender.',
    });
  });

  it('suspender en toda la plataforma pide el código del 2FA y se repite una vez (USR-13)', async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'Confirma con tu código de verificación en dos pasos para seguir.',
            reason: 'MFA_RECENT_REQUIRED',
          }),
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: NODE,
            status: 'suspended',
            revokedSessions: 0,
            revokedInvitations: 0,
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const prompt = vi.fn(() => Promise.resolve(true));
    const unregister = registerStepUpPrompt(prompt);
    try {
      await expect(setPlatformUserStatus(NODE, 'suspended')).resolves.toEqual({
        ok: true,
        data: { status: 'suspended', revokedSessions: 0, revokedInvitations: 0 },
      });
    } finally {
      unregister();
    }
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
