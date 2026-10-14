import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calendarDate,
  detailBadges,
  detailName,
  emailStatus,
  failedAttemptsLine,
  invitedByText,
  loadMemberAudit,
  loadMemberDetail,
  memberAuditUrl,
  memberDetailLoadError,
  memberDetailUrl,
  memberFromDetail,
  membershipLine,
  mfaLine,
  noSessionsText,
  orderedDetailSessions,
  parseMemberDetail,
  passwordChangedLine,
  pendingInvitationsText,
  revokeMemberSession,
  revokeSessionCopy,
  revokeSessionDone,
  revokeSessionError,
  revokeTenantOf,
  sentInvitationLine,
  sessionActivity,
  sessionDevice,
  supportMembership,
  syncPlatformUser,
  type MemberDetailSource,
  type MemberDetailView,
} from './member-detail';
import { apiDetail, DAY, iso, MIN, NODE, NOW, SESSION, SUB, USER } from './member-detail.fixture';
import { parsePlatformUser } from './platform-users';
import { voseoIn } from './voseo';

/*
 * La ficha de una persona: la lectura tolerante de lo que manda el API (nunca lanza, lo raro queda
 * sin dato), cómo se dice cada dato, y las llamadas a las rutas del panel con sus errores.
 */

function detail(patch: Record<string, unknown> = {}): MemberDetailView {
  const parsed = parseMemberDetail(apiDetail(patch));
  if (parsed === undefined) throw new Error('fixture inválida');
  return parsed;
}

function withUser(patch: Record<string, unknown>): MemberDetailView {
  return detail({ user: { ...(apiDetail().user as object), ...patch } });
}

function withSecurity(patch: Record<string, unknown>): MemberDetailView {
  return detail({ security: { ...(apiDetail().security as object), ...patch } });
}

const TEAM: MemberDetailSource = { kind: 'team', tenantId: NODE, userId: USER };
const PLATFORM: MemberDetailSource = { kind: 'platform', userId: USER };

describe('parseMemberDetail: la lectura tolerante de la ficha', () => {
  it('lee la ficha completa del API', () => {
    const d = detail();
    expect(d.user).toMatchObject({
      id: USER,
      email: 'ana@agencia.co',
      name: 'Ana Pérez',
      status: 'active',
      emailVerified: true,
      passwordResetRequired: false,
    });
    expect(d.security).toEqual({
      mfaEnabled: true,
      mfaEnabledAt: '2026-06-12T10:00:00.000Z',
      recoveryCodesLeft: 8,
      trustedDevices: 2,
      lockedUntil: null,
      failedLoginAttempts: 0,
    });
    expect(d.memberships.map((m) => m.tenantName)).toEqual(['Agencia Norte', 'Sucursal Sur']);
    expect(d.sessions[0]).toMatchObject({ id: SESSION, ip: '203.0.113.7', current: false });
    expect(d.invitedBy).toEqual({ email: 'jefa@agencia.co', at: iso(NOW - 40 * DAY) });
    expect(d.invitationsSent.pending).toBe(1);
    expect(d.invitationsSent.items[0]?.email).toBe('nuevo@gmail.com');
  });

  it('sin a quién (id y correo) no hay ficha: es un error, no una ficha vacía', () => {
    for (const raw of [
      null,
      undefined,
      'texto',
      [],
      {},
      { user: null },
      { user: { id: USER } },
      { user: { email: 'ana@agencia.co' } },
      { user: { id: '', email: 'ana@agencia.co' } },
      { user: { id: 7, email: 'ana@agencia.co' } },
    ]) {
      expect(parseMemberDetail(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });

  it('con sólo id y correo, todo lo demás queda sin dato: nada inventado', () => {
    const d = parseMemberDetail({ user: { id: USER, email: 'ana@agencia.co' } });
    expect(d).toEqual({
      user: {
        id: USER,
        email: 'ana@agencia.co',
        name: null,
        status: 'active',
        createdAt: null,
        emailVerified: null,
        lastLoginAt: null,
        passwordChangedAt: null,
        passwordResetRequired: false,
      },
      security: {
        mfaEnabled: null,
        mfaEnabledAt: null,
        recoveryCodesLeft: null,
        trustedDevices: null,
        lockedUntil: null,
        failedLoginAttempts: 0,
      },
      memberships: [],
      sessions: [],
      invitedBy: null,
      invitationsSent: { pending: 0, items: [] },
    });
  });

  it('tipos raros quedan sin dato: conteos negativos o con coma, fechas que no son fechas', () => {
    const d = detail({
      user: { ...(apiDetail().user as object), lastLoginAt: 'ayer', emailVerified: 'sí' },
      security: {
        mfaEnabled: 'true',
        recoveryCodesLeft: -1,
        trustedDevices: 1.5,
        lockedUntil: 'pronto',
        failedLoginAttempts: '3',
      },
    });
    expect(d.user.lastLoginAt).toBeNull();
    expect(d.user.emailVerified).toBeNull();
    expect(d.security).toEqual({
      mfaEnabled: null,
      mfaEnabledAt: null,
      recoveryCodesLeft: null,
      trustedDevices: null,
      lockedUntil: null,
      failedLoginAttempts: 0,
    });
  });

  it('descarta las filas incompletas en vez de tumbar la ficha', () => {
    const d = detail({
      memberships: [
        { tenantId: NODE, tenantName: 'Agencia Norte', role: 'vendedor', status: 'active' },
        { tenantId: NODE, role: 'vendedor', status: 'active' },
        'nodo',
      ],
      sessions: [
        { id: SESSION, lastSeenAt: iso(NOW) },
        { id: 'sin-fecha' },
        { id: 'fecha-rara', lastSeenAt: 'hace un rato' },
        null,
      ],
      invitationsSent: {
        pending: 'muchas',
        items: [{ id: 'i1', email: 'a@b.co', role: 'vendedor' }, { id: 'i2' }],
      },
    });
    expect(d.memberships).toHaveLength(1);
    expect(d.memberships[0]?.tenantType).toBe('');
    expect(d.sessions.map((s) => s.id)).toEqual([SESSION]);
    expect(d.sessions[0]).toMatchObject({ tenantId: null, ip: null, userAgent: null });
    // Un total que no se puede leer no dice "0 pendientes" con una en la lista.
    expect(d.invitationsSent).toMatchObject({ pending: 1 });
    expect(d.invitationsSent.items[0]).toMatchObject({ tenantName: '', expiresAt: '' });
  });

  it('invitedBy sin fecha legible es "no sabemos quién lo invitó"; sin correo, un usuario eliminado', () => {
    expect(detail({ invitedBy: { email: 'x@y.co' } }).invitedBy).toBeNull();
    expect(detail({ invitedBy: { email: null, at: iso(NOW - DAY) } }).invitedBy).toEqual({
      email: null,
      at: iso(NOW - DAY),
    });
  });
});

describe('cómo se dice cada dato', () => {
  it('el nombre, o el correo si no puso nombre', () => {
    expect(detailName(detail().user)).toBe('Ana Pérez');
    expect(detailName(withUser({ name: '   ' }).user)).toBe('ana@agencia.co');
  });

  it('las marcas de la cabecera, de lo más grave a lo menos; sin nada, "Activo"', () => {
    expect(detailBadges(detail(), NOW, NODE)).toEqual([{ label: 'Activo', tone: 'ok' }]);
    const everything = detail({
      user: {
        ...(apiDetail().user as object),
        status: 'suspended',
        passwordResetRequired: true,
      },
      security: {
        ...(apiDetail().security as object),
        mfaEnabled: false,
        lockedUntil: iso(NOW + 10 * MIN),
      },
    });
    expect(detailBadges(everything, NOW).map((b) => b.label)).toEqual([
      'Cuenta suspendida',
      'Bloqueado',
      'Cambio de contraseña pendiente',
      '2FA pendiente',
    ]);
    // Desde Equipo, su acceso suspendido en el nodo que se mira también (sin importar mayúsculas).
    expect(detailBadges(detail(), NOW, SUB.toUpperCase())).toEqual([
      { label: 'Suspendido en este nodo', tone: 'danger' },
    ]);
  });

  it('un bloqueo vencido no se marca; "2FA pendiente" sólo si un acceso activo lo exige', () => {
    expect(
      detailBadges(withSecurity({ lockedUntil: iso(NOW - MIN) }), NOW).map((b) => b.label),
    ).toEqual(['Activo']);
    const seller = detail({
      security: { ...(apiDetail().security as object), mfaEnabled: false },
      memberships: [
        { tenantId: NODE, tenantName: 'Agencia Norte', role: 'vendedor', status: 'active' },
        // Un rol que lo exige, pero con el acceso suspendido, no cuenta.
        { tenantId: SUB, tenantName: 'Sucursal Sur', role: 'tenant_admin', status: 'suspended' },
      ],
    });
    expect(detailBadges(seller, NOW).map((b) => b.label)).toEqual(['Activo']);
    // Sin saber si tiene 2FA, no se afirma que falte.
    expect(detailBadges(withSecurity({ mfaEnabled: undefined }), NOW)[0]?.label).toBe('Activo');
  });

  it('el perfil: correo, quién lo invitó y hace cuánto', () => {
    expect(emailStatus(true)).toBe('Verificado');
    expect(emailStatus(false)).toBe('Sin verificar');
    expect(emailStatus(null)).toBeUndefined();
    expect(invitedByText({ email: 'jefa@agencia.co', at: iso(NOW - 2 * DAY) }, NOW)).toBe(
      'jefa@agencia.co · hace 2 días',
    );
    expect(invitedByText({ email: null, at: 'no' }, NOW)).toBe('un usuario eliminado');
  });

  it('nodos y roles: "Nodo · Rol · Estado"', () => {
    const [norte, sur] = detail().memberships;
    expect(membershipLine(norte!)).toBe('Agencia Norte · Admin · Activo');
    expect(membershipLine(sur!)).toBe('Sucursal Sur · Vendedor · Suspendido');
  });

  it('seguridad: 2FA, códigos, contraseña y bloqueo', () => {
    // Según la versión de ICU: "12 jun 2026" o "12 de jun de 2026".
    expect(mfaLine(detail())).toMatch(/^2FA activo desde el 12 (de )?jun\.?( de)? 2026$/);
    expect(mfaLine(withSecurity({ mfaEnabledAt: null }))).toBe('2FA activo');
    expect(mfaLine(withSecurity({ mfaEnabled: false }))).toBe(
      'Sin 2FA: su rol lo exige y tiene que activarlo al próximo ingreso',
    );
    const seller = detail({
      security: { ...(apiDetail().security as object), mfaEnabled: false },
      memberships: [
        { tenantId: NODE, tenantName: 'Agencia Norte', role: 'vendedor', status: 'active' },
      ],
    });
    expect(mfaLine(seller)).toBe('Sin 2FA');
    expect(mfaLine(withSecurity({ mfaEnabled: null }))).toBeUndefined();
    expect(passwordChangedLine(iso(NOW - 2 * DAY), NOW)).toBe('Contraseña cambiada hace 2 días');
    expect(passwordChangedLine(null, NOW)).toBeUndefined();
    expect(failedAttemptsLine(0)).toBeUndefined();
    expect(failedAttemptsLine(1)).toBe('1 intento fallido de ingreso');
    expect(failedAttemptsLine(4)).toBe('4 intentos fallidos de ingreso');
    expect(calendarDate('no')).toBeUndefined();
  });

  it('sesiones: el equipo legible como en Puestos, la actividad y el orden', () => {
    const [s] = detail().sessions;
    expect(sessionDevice(s!)).toBe('Chrome en Windows');
    expect(sessionDevice({ userAgent: null })).toBe('Dispositivo desconocido');
    expect(sessionActivity(s!, NOW)).toBe('Activa hace 3 min');
    const ordered = orderedDetailSessions([
      { ...s!, id: 'vieja', lastSeenAt: iso(NOW - DAY) },
      { ...s!, id: 'nueva', lastSeenAt: iso(NOW - MIN) },
      { ...s!, id: 'propia', lastSeenAt: iso(NOW - 2 * DAY), current: true },
    ]);
    expect(ordered.map((x) => x.id)).toEqual(['propia', 'nueva', 'vieja']);
    expect(noSessionsText('team')).toBe('No tiene sesiones abiertas en los nodos que administras.');
    expect(noSessionsText('platform')).toBe('No tiene sesiones abiertas.');
  });

  it('cerrar una sesión: por el nodo de la ruta en Equipo, por el de la sesión en el directorio', () => {
    expect(revokeTenantOf(TEAM, { tenantId: SUB })).toBe(NODE);
    expect(revokeTenantOf(PLATFORM, { tenantId: SUB })).toBe(SUB);
    expect(revokeTenantOf(PLATFORM, { tenantId: null })).toBeNull();
    expect(revokeSessionCopy('Ana')).toEqual({
      title: 'Cerrar esta sesión de Ana',
      description:
        'Se cierra la sesión en ese equipo. Si estaba trabajando, pierde lo que no haya guardado.',
      confirmLabel: 'Cerrar sesión',
    });
    expect(revokeSessionDone('Ana')).toBe('Cerramos esa sesión de Ana.');
  });

  it('invitaciones que envió: rol, nodo y vencimiento', () => {
    const [i] = detail().invitationsSent.items;
    expect(sentInvitationLine(i!, NOW)).toBe('Vendedor · Agencia Norte · vence en 5 días');
    expect(sentInvitationLine({ ...i!, expiresAt: iso(NOW - MIN), tenantName: '' }, NOW)).toBe(
      'Vendedor · venció',
    );
    expect(sentInvitationLine({ ...i!, expiresAt: '' }, NOW)).toBe('Vendedor · Agencia Norte');
    expect(pendingInvitationsText(0)).toBe('No tiene invitaciones pendientes.');
    expect(pendingInvitationsText(1)).toBe('1 pendiente');
    expect(pendingInvitationsText(3)).toBe('3 pendientes');
  });

  it('errores de carga en tú: sesión, permiso, ya no está y servidor', () => {
    expect(memberDetailLoadError(401, undefined, 'team')).toBe(
      'Tu sesión venció. Vuelve a iniciar sesión.',
    );
    expect(memberDetailLoadError(403, 'No administras este nodo.', 'team')).toBe(
      'No puedes ver esta ficha: No administras este nodo.',
    );
    expect(memberDetailLoadError(403, undefined, 'team')).toBe(
      'No administras este nodo: no puedes ver la ficha de esta persona.',
    );
    expect(memberDetailLoadError(403, 'x', 'platform')).toBe(
      'Esta ficha es sólo para el superadmin.',
    );
    expect(memberDetailLoadError(404, 'Cannot GET', 'team')).toBe(
      'Esta persona ya no está en este nodo. Cierra la ficha y recarga la lista.',
    );
    expect(memberDetailLoadError(404, undefined, 'platform')).toBe('No encontramos esta cuenta.');
    expect(memberDetailLoadError(500, 'boom', 'team')).toBe(
      'No pudimos cargar la ficha. Inténtalo de nuevo.',
    );
    expect(memberDetailLoadError(400, 'Miembro inválido.', 'team')).toBe('Miembro inválido.');
    expect(revokeSessionError(404, undefined)).toBe('Esa sesión ya no está abierta.');
    expect(revokeSessionError(403, 'No puedes cerrar la sesión de alguien de tu rango.')).toBe(
      'No lo pudimos hacer: No puedes cerrar la sesión de alguien de tu rango.',
    );
    expect(revokeSessionError(403, undefined)).toMatch(/^No puedes cerrar esa sesión/);
    expect(revokeSessionError(401, undefined)).toBe('Tu sesión venció. Vuelve a iniciar sesión.');
    expect(revokeSessionError(502, '')).toBe('No pudimos cerrar esa sesión. Inténtalo de nuevo.');
    expect(revokeSessionError(409, 'Otro motivo.')).toBe('Otro motivo.');
  });

  it('nada de lo que se dice va en vos', () => {
    const d = detail();
    const texts = [
      ...detailBadges(d, NOW),
      { label: mfaLine(withSecurity({ mfaEnabled: false })) ?? '' },
      { label: noSessionsText('team') },
      { label: revokeSessionCopy('Ana').description },
      { label: memberDetailLoadError(404, undefined, 'team') },
      { label: memberDetailLoadError(403, undefined, 'team') },
      { label: revokeSessionError(403, undefined) },
      { label: pendingInvitationsText(0) },
    ].map((t) => t.label);
    expect(voseoIn(texts.join('\n'))).toEqual([]);
  });
});

describe('para actuar desde la ficha del directorio', () => {
  it('el nodo de soporte es el primer acceso activo; si no hay, el primero', () => {
    expect(supportMembership(detail())?.tenantId).toBe(NODE);
    const onlySuspended = detail({
      memberships: [
        { tenantId: SUB, tenantName: 'Sucursal Sur', role: 'vendedor', status: 'suspended' },
      ],
    });
    expect(supportMembership(onlySuspended)?.tenantId).toBe(SUB);
    expect(supportMembership(detail({ memberships: [] }))).toBeUndefined();
  });

  it('la persona como miembro de ese nodo, para el menú y los textos de Equipo', () => {
    const d = withSecurity({ lockedUntil: iso(NOW + MIN) });
    const member = memberFromDetail(d, d.memberships[1]!);
    expect(member).toEqual({
      userId: USER,
      email: 'ana@agencia.co',
      name: 'Ana Pérez',
      userStatus: 'active',
      role: 'vendedor',
      membershipStatus: 'suspended',
      createdAt: d.user.createdAt,
      lastLoginAt: d.user.lastLoginAt,
      mfaEnabled: true,
      lockedUntil: iso(NOW + MIN),
      activeSessions: 1,
      passwordResetRequired: false,
    });
    const unknown = memberFromDetail(withSecurity({ mfaEnabled: null }), d.memberships[0]!);
    expect(unknown.mfaEnabled).toBeUndefined();
  });

  it('la fila del directorio se pone al día con la ficha; otra persona no se toca', () => {
    const row = parsePlatformUser({
      id: USER.toUpperCase(),
      email: 'ana@agencia.co',
      name: 'Ana',
      status: 'active',
      emailVerified: false,
      mfaEnabled: false,
      lockedUntil: iso(NOW + MIN),
      lastLoginAt: null,
      lastSeenAt: null,
      activeSessions: 4,
      createdAt: '',
      memberships: [],
    });
    if (row === undefined) throw new Error('fixture inválida');
    const synced = syncPlatformUser(row, detail());
    expect(synced).toMatchObject({
      name: 'Ana Pérez',
      status: 'active',
      emailVerified: true,
      mfaEnabled: true,
      lockedUntil: null,
      activeSessions: 1,
    });
    expect(synced.lastLoginAt).toBe(detail().user.lastLoginAt);
    const other = { ...row, id: 'otro' };
    expect(syncPlatformUser(other, detail())).toBe(other);
    // Lo que la ficha no sabe, la fila lo conserva.
    const vague = withUser({ emailVerified: undefined, lastLoginAt: null });
    expect(syncPlatformUser(row, vague)).toMatchObject({ emailVerified: false, lastLoginAt: null });
  });
});

describe('las llamadas del navegador', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status: number, body: unknown, raw = false) {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        raw
          ? new Response(String(body), { status })
          : new Response(JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json' },
            }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('las rutas del panel: Equipo por el nodo, el directorio por la cuenta', () => {
    expect(memberDetailUrl(TEAM)).toBe(`/api/tenants/${NODE}/members/${USER}`);
    expect(memberDetailUrl(PLATFORM)).toBe(`/api/admin/users/${USER}`);
    expect(memberAuditUrl(TEAM)).toBe(`/api/tenants/${NODE}/members/${USER}/audit`);
    expect(memberAuditUrl(PLATFORM, 'abc_-1')).toBe(`/api/admin/users/${USER}/audit?before=abc_-1`);
    expect(memberDetailUrl({ kind: 'platform', userId: '../x' })).toBe('/api/admin/users/..%2Fx');
  });

  it('la ficha leída, o el error dicho en tú; nunca lanza', async () => {
    const ok = stubFetch(200, apiDetail());
    const loaded = await loadMemberDetail(TEAM);
    expect(ok).toHaveBeenCalledWith(`/api/tenants/${NODE}/members/${USER}`, { cache: 'no-store' });
    expect(loaded.ok && loaded.data.user.email).toBe('ana@agencia.co');

    stubFetch(404, { error: 'Ese miembro no está en este nodo.' });
    expect(await loadMemberDetail(TEAM)).toEqual({
      ok: false,
      message: 'Esta persona ya no está en este nodo. Cierra la ficha y recarga la lista.',
    });

    stubFetch(200, { user: {} });
    expect(await loadMemberDetail(PLATFORM)).toEqual({
      ok: false,
      message: 'El servidor respondió algo que no pudimos leer. Recarga la página.',
    });

    stubFetch(200, '<html>', true);
    expect((await loadMemberDetail(PLATFORM)).ok).toBe(false);

    stubFetch(502, '<!doctype html>', true);
    expect(await loadMemberDetail(PLATFORM)).toEqual({
      ok: false,
      message: 'No pudimos cargar la ficha. Inténtalo de nuevo.',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    const offline = await loadMemberDetail(TEAM);
    expect(offline.ok).toBe(false);
    expect(!offline.ok && offline.message).toMatch(/^No pudimos conectar con el servidor/);
  });

  it('el historial: la página leída, o el motivo', async () => {
    stubFetch(200, {
      events: [
        { id: 'e1', eventType: 'auth.login.success', occurredAt: iso(NOW), payload: {} },
        { id: 'roto' },
      ],
      nextBefore: 'c2',
    });
    const page = await loadMemberAudit(TEAM, 'c1');
    expect(page.ok && page.data.events.map((e) => e.id)).toEqual(['e1']);
    expect(page.ok && page.data.nextBefore).toBe('c2');

    stubFetch(403, { error: 'No administras este nodo.' });
    expect(await loadMemberAudit(TEAM)).toEqual({
      ok: false,
      message: 'No administras este nodo.',
    });

    stubFetch(200, 'no', true);
    expect((await loadMemberAudit(TEAM)).ok).toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    const offline = await loadMemberAudit(PLATFORM);
    expect(!offline.ok && offline.message).toMatch(/Revisa tu conexión/);
  });

  it('cerrar una sesión: POST a la ruta del nodo; un 404 es que ya no estaba', async () => {
    const ok = stubFetch(200, { ok: true });
    expect(await revokeMemberSession(NODE, USER, SESSION)).toEqual({ ok: true });
    expect(ok).toHaveBeenCalledWith(
      `/api/tenants/${NODE}/members/${USER}/sessions/${SESSION}/revoke`,
      { cache: 'no-store', method: 'POST' },
    );

    stubFetch(404, { error: 'Esa sesión ya no está abierta.', reason: 'SESSION_NOT_FOUND' });
    expect(await revokeMemberSession(NODE, USER, SESSION)).toEqual({
      ok: false,
      message: 'Esa sesión ya no está abierta.',
      gone: true,
    });

    stubFetch(403, { error: 'No puedes cerrar la sesión de alguien de tu rango.' });
    expect(await revokeMemberSession(NODE, USER, SESSION)).toEqual({
      ok: false,
      message: 'No lo pudimos hacer: No puedes cerrar la sesión de alguien de tu rango.',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    expect((await revokeMemberSession(NODE, USER, SESSION)).ok).toBe(false);
  });
});
