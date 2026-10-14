import { describe, expect, it } from 'vitest';
import type { ApiResponse } from './api';
import {
  currentSessionIdOf,
  invitationActionTarget,
  invitationsListTarget,
  invitePlan,
  markCurrentSession,
  memberActionTarget,
  memberAuditTarget,
  memberDetailTarget,
  memberSessionRevokeTarget,
  membershipImpactTarget,
  membershipRolePlan,
  membershipStatusPlan,
  networkAuditTarget,
  seatPolicyPlan,
  seatReleaseTarget,
  seatsViewTarget,
  tenantAdminProxyReply,
  tenantImpactTarget,
  tenantMovePlan,
  tenantStatsTarget,
  tenantSummaryTarget,
  tenantUpdatePlan,
  userAuditQuery,
} from './tenant-admin-proxy';

const ID = '0B6F6A52-7A47-4C8E-9A3B-1A2B3C4D5E6F';
const PARENT = '11111111-2222-4333-8444-555555555555';

describe('tenantUpdatePlan: PATCH /admin/tenants/:id', () => {
  it('reconstruye el cuerpo campo por campo, con el id en minúsculas', () => {
    expect(
      tenantUpdatePlan(ID, { status: 'suspended', reason: '  Deuda vencida  ', extra: 'x' }),
    ).toEqual({
      ok: true,
      path: `/admin/tenants/${ID.toLowerCase()}`,
      body: { status: 'suspended', reason: 'Deuda vencida' },
    });
    expect(tenantUpdatePlan(ID, { isBranch: true })).toMatchObject({ body: { isBranch: true } });
    expect(tenantUpdatePlan(ID, { tenantType: 'agency' })).toMatchObject({
      body: { tenantType: 'agency' },
    });
  });

  it('un id que no es UUID no compone otra ruta del API', () => {
    expect(tenantUpdatePlan('../users/status', { status: 'active' })).toEqual({
      ok: false,
      error: 'Nodo inválido.',
    });
  });

  it('rechaza valores fuera de lo que admite el API', () => {
    expect(tenantUpdatePlan(ID, { status: 'archived' }).ok).toBe(false);
    expect(tenantUpdatePlan(ID, { isBranch: 'true' }).ok).toBe(false);
    expect(tenantUpdatePlan(ID, { tenantType: 'platform' }).ok).toBe(false);
  });

  it('sin nada que cambiar, o sin cuerpo, no viaja', () => {
    expect(tenantUpdatePlan(ID, {}).ok).toBe(false);
    expect(tenantUpdatePlan(ID, undefined).ok).toBe(false);
    expect(tenantUpdatePlan(ID, [{ status: 'active' }]).ok).toBe(false);
    // El motivo solo no es un cambio.
    expect(tenantUpdatePlan(ID, { reason: 'Deuda vencida' }).ok).toBe(false);
  });

  it('suspender sin motivo no viaja; reactivar sí, con o sin él', () => {
    expect(tenantUpdatePlan(ID, { status: 'suspended' })).toEqual({
      ok: false,
      error: 'Indica el motivo de la suspensión.',
    });
    expect(tenantUpdatePlan(ID, { status: 'suspended', reason: '   ' }).ok).toBe(false);
    expect(tenantUpdatePlan(ID, { status: 'active' })).toMatchObject({
      ok: true,
      body: { status: 'active' },
    });
    expect(tenantUpdatePlan(ID, { status: 'active', reason: '' })).toMatchObject({
      body: { status: 'active' },
    });
    expect(tenantUpdatePlan(ID, { status: 'active', reason: null })).toMatchObject({
      body: { status: 'active' },
    });
    expect(tenantUpdatePlan(ID, { status: 'active', reason: 'Pagó la deuda' })).toMatchObject({
      body: { status: 'active', reason: 'Pagó la deuda' },
    });
  });

  it('un motivo que no es texto o pasa de 500 caracteres no viaja', () => {
    expect(tenantUpdatePlan(ID, { status: 'suspended', reason: 42 })).toEqual({
      ok: false,
      error: 'El motivo no se pudo leer.',
    });
    expect(tenantUpdatePlan(ID, { status: 'suspended', reason: 'x'.repeat(501) })).toEqual({
      ok: false,
      error: 'El motivo puede tener hasta 500 caracteres.',
    });
    expect(tenantUpdatePlan(ID, { status: 'suspended', reason: 'x'.repeat(500) }).ok).toBe(true);
  });
});

describe('Agencias en números: rutas del API', () => {
  it('GET /admin/tenants/stats', () => {
    expect(tenantStatsTarget()).toEqual({ ok: true, path: '/admin/tenants/stats' });
  });

  it('GET /admin/tenants/:id/impact con el id en minúsculas; otro segmento no compone otra ruta', () => {
    expect(tenantImpactTarget(ID)).toEqual({
      ok: true,
      path: `/admin/tenants/${ID.toLowerCase()}/impact`,
    });
    expect(tenantImpactTarget('stats')).toEqual({ ok: false, error: 'Nodo inválido.' });
    expect(tenantImpactTarget('../users').ok).toBe(false);
  });

  it('GET /admin/tenants/:id/summary con el id en minúsculas; otro segmento no compone otra ruta', () => {
    expect(tenantSummaryTarget(ID)).toEqual({
      ok: true,
      path: `/admin/tenants/${ID.toLowerCase()}/summary`,
    });
    expect(tenantSummaryTarget('stats')).toEqual({ ok: false, error: 'Nodo inválido.' });
    expect(tenantSummaryTarget('../users').ok).toBe(false);
  });
});

describe('tenantMovePlan: POST /admin/tenants/:id/move', () => {
  it('manda sólo el nuevo padre', () => {
    expect(tenantMovePlan(ID, { parentTenantId: PARENT.toUpperCase(), tenantType: 'x' })).toEqual({
      ok: true,
      path: `/admin/tenants/${ID.toLowerCase()}/move`,
      body: { parentTenantId: PARENT },
    });
  });

  it('sin padre válido no se mueve nada', () => {
    expect(tenantMovePlan(ID, {}).ok).toBe(false);
    expect(tenantMovePlan(ID, { parentTenantId: 'planetour' }).ok).toBe(false);
    expect(tenantMovePlan('x', { parentTenantId: PARENT }).ok).toBe(false);
  });
});

const SESSION = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const USER = '99999999-8888-4777-8666-555555555555';

describe('puestos: rutas del API', () => {
  it('GET /tenants/:id/seats con el id en minúsculas', () => {
    expect(seatsViewTarget(ID)).toEqual({ ok: true, path: `/tenants/${ID.toLowerCase()}/seats` });
    expect(seatsViewTarget('../admin').ok).toBe(false);
  });

  it('liberar una sesión: ambos ids tienen que ser UUID', () => {
    expect(seatReleaseTarget(ID, SESSION)).toEqual({
      ok: true,
      path: `/tenants/${ID.toLowerCase()}/seats/sessions/${SESSION.toLowerCase()}/release`,
    });
    expect(seatReleaseTarget(ID, '../../auth/logout')).toEqual({
      ok: false,
      error: 'Sesión inválida.',
    });
    expect(seatReleaseTarget('x', SESSION).ok).toBe(false);
  });

  it('acciones sobre un miembro', () => {
    expect(memberActionTarget(ID, USER, 'reset-mfa')).toEqual({
      ok: true,
      path: `/tenants/${ID.toLowerCase()}/members/${USER}/reset-mfa`,
    });
    expect(memberActionTarget(ID, USER, 'revoke-sessions')).toMatchObject({
      path: expect.stringMatching(/\/revoke-sessions$/),
    });
    expect(memberActionTarget(ID, 'me', 'reset-mfa')).toEqual({
      ok: false,
      error: 'Miembro inválido.',
    });
  });

  it('enviar el enlace para restablecer la contraseña, forzar el cambio y desbloquear', () => {
    expect(memberActionTarget(ID, USER, 'send-password-reset')).toEqual({
      ok: true,
      path: `/tenants/${ID.toLowerCase()}/members/${USER}/send-password-reset`,
    });
    expect(memberActionTarget(ID, USER, 'require-password-reset')).toEqual({
      ok: true,
      path: `/tenants/${ID.toLowerCase()}/members/${USER}/require-password-reset`,
    });
    expect(memberActionTarget(ID, '../unlock', 'require-password-reset')).toEqual({
      ok: false,
      error: 'Miembro inválido.',
    });
    expect(memberActionTarget(ID, USER, 'unlock')).toEqual({
      ok: true,
      path: `/tenants/${ID.toLowerCase()}/members/${USER}/unlock`,
    });
    expect(memberActionTarget(ID, '../reset-mfa', 'unlock')).toEqual({
      ok: false,
      error: 'Miembro inválido.',
    });
    expect(memberActionTarget('x', USER, 'send-password-reset')).toEqual({
      ok: false,
      error: 'Nodo inválido.',
    });
  });
});

describe('membershipImpactTarget: GET /admin/memberships/impact', () => {
  const MEMBER = '22222222-2222-4222-8222-222222222222';
  const query = (params: Record<string, string>) => new URLSearchParams(params);

  it('reconstruye la consulta con ids en minúsculas y un solo cambio', () => {
    expect(
      membershipImpactTarget(query({ tenantId: ID, userId: MEMBER, status: 'suspended', x: '1' })),
    ).toEqual({
      ok: true,
      path: `/admin/memberships/impact?userId=${MEMBER}&tenantId=${ID.toLowerCase()}&status=suspended`,
    });
    expect(membershipImpactTarget(query({ tenantId: ID, userId: MEMBER, role: 'admin' }))).toEqual({
      ok: true,
      path: `/admin/memberships/impact?userId=${MEMBER}&tenantId=${ID.toLowerCase()}&role=admin`,
    });
  });

  it.each([
    ['sin nodo', { userId: MEMBER, status: 'suspended' }],
    ['miembro que no es uuid', { tenantId: ID, userId: 'me', status: 'suspended' }],
    ['ni estado ni rol', { tenantId: ID, userId: MEMBER }],
    ['los dos', { tenantId: ID, userId: MEMBER, status: 'suspended', role: 'admin' }],
    ['estado desconocido', { tenantId: ID, userId: MEMBER, status: 'borrado' }],
    ['un rol que arma otra consulta', { tenantId: ID, userId: MEMBER, role: 'admin&status=x' }],
  ])('rechaza: %s', (_q, params) => {
    expect(membershipImpactTarget(query(params)).ok).toBe(false);
  });
});

describe('seatPolicyPlan: PATCH /admin/tenants/:id/seats', () => {
  it('manda los dos campos, con null para heredar, y nada más', () => {
    expect(seatPolicyPlan(ID, { concurrentSeats: 5, idleTimeoutMinutes: null, extra: 1 })).toEqual({
      ok: true,
      path: `/admin/tenants/${ID.toLowerCase()}/seats`,
      body: { concurrentSeats: 5, idleTimeoutMinutes: null },
    });
    expect(seatPolicyPlan(ID, { concurrentSeats: null, idleTimeoutMinutes: 480 })).toMatchObject({
      body: { concurrentSeats: null, idleTimeoutMinutes: 480 },
    });
  });

  it('fuera de rango, no entero o ausente no viaja', () => {
    expect(seatPolicyPlan(ID, { concurrentSeats: 0, idleTimeoutMinutes: null }).ok).toBe(false);
    expect(seatPolicyPlan(ID, { concurrentSeats: 10_001, idleTimeoutMinutes: null }).ok).toBe(
      false,
    );
    expect(seatPolicyPlan(ID, { concurrentSeats: 2.5, idleTimeoutMinutes: null }).ok).toBe(false);
    expect(seatPolicyPlan(ID, { concurrentSeats: '5', idleTimeoutMinutes: null }).ok).toBe(false);
    expect(seatPolicyPlan(ID, { concurrentSeats: 5, idleTimeoutMinutes: 4 }).ok).toBe(false);
    expect(seatPolicyPlan(ID, { concurrentSeats: 5, idleTimeoutMinutes: 481 }).ok).toBe(false);
    expect(seatPolicyPlan(ID, { concurrentSeats: 5 }).ok).toBe(false);
    expect(seatPolicyPlan(ID, undefined).ok).toBe(false);
    expect(seatPolicyPlan('x', { concurrentSeats: 5, idleTimeoutMinutes: null }).ok).toBe(false);
  });
});

describe('tenantAdminProxyReply', () => {
  const json = (status: number, body: unknown): ApiResponse => ({ kind: 'json', status, body });

  it('éxito: el cuerpo tal cual', () => {
    expect(tenantAdminProxyReply(json(200, { ok: true }))).toEqual({
      status: 200,
      body: { ok: true },
    });
  });

  it('error: mensaje y motivo máquina, nunca el cuerpo crudo', () => {
    expect(
      tenantAdminProxyReply(
        json(403, {
          statusCode: 403,
          message: 'No administras todos los nodos de este usuario.',
          reason: 'MEMBER_OUTSIDE_SCOPE',
          details: { secret: 'x' },
        }),
      ),
    ).toEqual({
      status: 403,
      body: {
        error: 'No administras todos los nodos de este usuario.',
        reason: 'MEMBER_OUTSIDE_SCOPE',
      },
    });
    expect(tenantAdminProxyReply(json(400, { message: ['a', 'b'], reason: 'no es' }))).toEqual({
      status: 400,
      body: { error: 'a. b' },
    });
  });

  it('de los details, sólo el id de la invitación pendiente (en minúsculas)', () => {
    const pending = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
    expect(
      tenantAdminProxyReply(
        json(409, {
          message: 'Ya hay una invitación pendiente para ese correo en este nodo: reenvíala.',
          reason: 'INVITATION_ALREADY_PENDING',
          details: { invitationId: pending, email: 'beto@agencia.co' },
        }),
      ),
    ).toEqual({
      status: 409,
      body: {
        error: 'Ya hay una invitación pendiente para ese correo en este nodo: reenvíala.',
        reason: 'INVITATION_ALREADY_PENDING',
        details: { invitationId: pending.toLowerCase() },
      },
    });
    expect(
      tenantAdminProxyReply(json(409, { message: 'x', details: { invitationId: '../x' } })).body,
    ).toEqual({ error: 'x' });
  });

  it('sin JSON: el mensaje que ya armó apiWithStatus', () => {
    expect(
      tenantAdminProxyReply({ kind: 'unreachable', status: 503, message: 'Sin conexión' }),
    ).toEqual({ status: 503, body: { error: 'Sin conexión' } });
  });

  it('una acción 2xx sin cuerpo salió bien (y nunca un 204 con cuerpo)', () => {
    expect(tenantAdminProxyReply({ kind: 'not-json', status: 204, message: 'x' })).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(tenantAdminProxyReply({ kind: 'not-json', status: 201, message: 'x' })).toEqual({
      status: 200,
      body: { ok: true },
    });
  });
});

describe('sesión propia en la vista de puestos', () => {
  const body = {
    limit: 3,
    sessions: [{ sessionId: SESSION.toLowerCase() }, { sessionId: 'otra' }, 'basura'],
  };

  it('marca current sólo en la propia', () => {
    expect(markCurrentSession(body, SESSION)).toEqual({
      limit: 3,
      sessions: [
        { sessionId: SESSION.toLowerCase(), current: true },
        { sessionId: 'otra', current: false },
        'basura',
      ],
    });
  });

  it('sin id de sesión o sin sesiones, sale como vino', () => {
    expect(markCurrentSession(body, undefined)).toBe(body);
    expect(markCurrentSession({ error: 'x' }, SESSION)).toEqual({ error: 'x' });
  });

  it('el id sale de GET /auth/session sólo si es un UUID de una respuesta sana', () => {
    expect(currentSessionIdOf({ kind: 'json', status: 200, body: { sessionId: SESSION } })).toBe(
      SESSION,
    );
    expect(
      currentSessionIdOf({ kind: 'json', status: 401, body: { sessionId: SESSION } }),
    ).toBeUndefined();
    expect(
      currentSessionIdOf({ kind: 'json', status: 200, body: { sessionId: 'x' } }),
    ).toBeUndefined();
  });
});

describe('invitaciones: rutas y cuerpo del API', () => {
  const INVITATION = '44444444-4444-4444-8444-444444444444';

  it('invitePlan reconstruye el cuerpo: correo recortado, nodo en minúsculas y sin campos de más', () => {
    expect(
      invitePlan({ email: '  Beto@Agencia.co ', tenantId: ID, role: 'vendedor', isAdmin: true }),
    ).toEqual({
      ok: true,
      path: '/invitations',
      body: { email: 'Beto@Agencia.co', tenantId: ID.toLowerCase(), role: 'vendedor' },
    });
  });

  it('invitePlan rechaza un cuerpo ilegible, un correo sin forma, un nodo raro o un rol con otra forma', () => {
    expect(invitePlan(undefined)).toEqual({ ok: false, error: 'La invitación no se pudo leer.' });
    expect(invitePlan([])).toMatchObject({ ok: false });
    const base = { email: 'beto@agencia.co', tenantId: ID, role: 'vendedor' };
    expect(invitePlan({ ...base, email: 'beto' })).toEqual({
      ok: false,
      error: 'Escribe un correo válido.',
    });
    expect(invitePlan({ ...base, email: 'a b@c.co' }).ok).toBe(false);
    expect(invitePlan({ ...base, email: `${'a'.repeat(250)}@c.co` }).ok).toBe(false);
    expect(invitePlan({ ...base, email: 42 }).ok).toBe(false);
    expect(invitePlan({ ...base, tenantId: '../admin' })).toEqual({
      ok: false,
      error: 'Nodo inválido.',
    });
    expect(invitePlan({ ...base, role: 'Super Admin' })).toEqual({
      ok: false,
      error: 'Elige el rol de la invitación.',
    });
    expect(invitePlan({ ...base, role: undefined }).ok).toBe(false);
  });

  it('invitationsListTarget: el nodo validado y en la consulta', () => {
    expect(invitationsListTarget(ID)).toEqual({
      ok: true,
      path: `/invitations?tenantId=${ID.toLowerCase()}`,
    });
    expect(invitationsListTarget('x&role=superadmin')).toEqual({
      ok: false,
      error: 'Nodo inválido.',
    });
  });

  it('invitationActionTarget: reenviar y revocar, sólo con ids que no componen otra ruta', () => {
    expect(invitationActionTarget(INVITATION.toUpperCase(), ID, 'resend')).toEqual({
      ok: true,
      path: `/invitations/${INVITATION}/resend?tenantId=${ID.toLowerCase()}`,
    });
    expect(invitationActionTarget(INVITATION, ID, 'revoke')).toMatchObject({
      path: `/invitations/${INVITATION}/revoke?tenantId=${ID.toLowerCase()}`,
    });
    expect(invitationActionTarget('../../admin', ID, 'revoke')).toEqual({
      ok: false,
      error: 'Invitación inválida.',
    });
    expect(invitationActionTarget(INVITATION, '', 'resend')).toEqual({
      ok: false,
      error: 'Nodo inválido.',
    });
  });
});

describe('memberships: rol y estado', () => {
  const MEMBER = '99999999-8888-4777-8666-555555555555';

  it('membershipRolePlan reconstruye el cuerpo y valida ids y la forma del rol', () => {
    expect(
      membershipRolePlan({ userId: MEMBER.toUpperCase(), tenantId: ID, role: 'admin', x: 1 }),
    ).toEqual({
      ok: true,
      path: '/admin/memberships/role',
      body: { userId: MEMBER, tenantId: ID.toLowerCase(), role: 'admin' },
    });
    expect(membershipRolePlan(null)).toEqual({ ok: false, error: 'El cambio no se pudo leer.' });
    expect(membershipRolePlan({ userId: MEMBER, tenantId: 'x', role: 'admin' })).toEqual({
      ok: false,
      error: 'Nodo inválido.',
    });
    expect(membershipRolePlan({ userId: 'x', tenantId: ID, role: 'admin' })).toEqual({
      ok: false,
      error: 'Miembro inválido.',
    });
    expect(membershipRolePlan({ userId: MEMBER, tenantId: ID, role: 'ADMIN' })).toEqual({
      ok: false,
      error: 'Elige el rol nuevo.',
    });
  });

  it('membershipStatusPlan sólo admite activo o suspendido', () => {
    expect(membershipStatusPlan({ userId: MEMBER, tenantId: ID, status: 'suspended' })).toEqual({
      ok: true,
      path: '/admin/memberships/status',
      body: { userId: MEMBER, tenantId: ID.toLowerCase(), status: 'suspended' },
    });
    expect(membershipStatusPlan({ userId: MEMBER, tenantId: ID, status: 'invited' })).toEqual({
      ok: false,
      error: 'El estado tiene que ser activo o suspendido.',
    });
    expect(membershipStatusPlan('suspended')).toMatchObject({ ok: false });
    expect(membershipStatusPlan({ userId: MEMBER, status: 'active' })).toEqual({
      ok: false,
      error: 'Nodo inválido.',
    });
  });
});

describe('networkAuditTarget: GET /tenants/network/audit', () => {
  const q = (params: Record<string, string> | [string, string][]) => new URLSearchParams(params);
  const CURSOR = 'eyJvY2N1cnJlZEF0IjoiMjAyNi0xMC0xM1QxMjowMDowMFoifQ';

  it('reconstruye la consulta parámetro por parámetro, con los ids en minúsculas', () => {
    expect(networkAuditTarget(q({ tenantId: ID }))).toEqual({
      ok: true,
      path: `/tenants/network/audit?tenantId=${ID.toLowerCase()}`,
    });
    expect(
      networkAuditTarget(
        q({ tenantId: ID, limit: '50', before: CURSOR, category: 'users', actorUserId: PARENT }),
      ),
    ).toEqual({
      ok: true,
      path:
        `/tenants/network/audit?tenantId=${ID.toLowerCase()}&limit=50&before=${CURSOR}` +
        `&category=users&actorUserId=${PARENT}`,
    });
  });

  it('sin nodo o con un nodo que no es UUID: no sale', () => {
    expect(networkAuditTarget(q({}))).toEqual({ ok: false, error: 'Nodo inválido.' });
    expect(networkAuditTarget(q({ tenantId: '../admin' }))).toEqual({
      ok: false,
      error: 'Nodo inválido.',
    });
  });

  it('un parámetro desconocido, repetido o fuera de forma no lo armó el panel', () => {
    for (const params of [
      { tenantId: ID, extra: '1' } as Record<string, string>,
      { tenantId: ID, limit: '0' },
      { tenantId: ID, limit: '201' },
      { tenantId: ID, limit: '5.5' },
      { tenantId: ID, before: 'con espacio' },
      { tenantId: ID, before: 'x'.repeat(201) },
      { tenantId: ID, category: 'orders' },
    ]) {
      expect(networkAuditTarget(q(params)).ok, JSON.stringify(params)).toBe(false);
    }
    expect(
      networkAuditTarget(
        q([
          ['tenantId', ID],
          ['category', 'users'],
          ['category', 'pricing'],
        ]),
      ).ok,
    ).toBe(false);
    expect(networkAuditTarget(q({ tenantId: ID, actorUserId: 'ana' }))).toEqual({
      ok: false,
      error: 'Persona inválida.',
    });
  });
});

describe('la ficha de un miembro: GET, historial y cerrar una sesión', () => {
  const MEMBER = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
  const SESSION = 'FFFFFFFF-1111-4222-8333-444444444444';
  const CURSOR = 'eyJvY2N1cnJlZEF0IjoiMjAyNi0xMC0xM1QxMjowMDowMFoifQ';
  const base = `/tenants/${ID.toLowerCase()}/members/${MEMBER.toLowerCase()}`;

  it('GET de la ficha con los ids en minúsculas; un id raro no compone otra ruta', () => {
    expect(memberDetailTarget(ID, MEMBER)).toEqual({ ok: true, path: base });
    expect(memberDetailTarget('../admin', MEMBER)).toEqual({ ok: false, error: 'Nodo inválido.' });
    expect(memberDetailTarget(ID, 'users/status')).toEqual({
      ok: false,
      error: 'Miembro inválido.',
    });
  });

  it('cerrar una sesión: los tres ids tienen que ser UUID', () => {
    expect(memberSessionRevokeTarget(ID, MEMBER, SESSION)).toEqual({
      ok: true,
      path: `${base}/sessions/${SESSION.toLowerCase()}/revoke`,
    });
    expect(memberSessionRevokeTarget(ID, MEMBER, '../../unlock')).toEqual({
      ok: false,
      error: 'Sesión inválida.',
    });
    expect(memberSessionRevokeTarget(ID, 'x', SESSION).ok).toBe(false);
    expect(memberSessionRevokeTarget('x', MEMBER, SESSION).ok).toBe(false);
  });

  it('el historial reconstruye el cursor y el tamaño, y nada más', () => {
    const q = (params: Record<string, string> | [string, string][]) => new URLSearchParams(params);
    expect(memberAuditTarget(ID, MEMBER, q({}))).toEqual({ ok: true, path: `${base}/audit` });
    expect(memberAuditTarget(ID, MEMBER, q({ limit: '030', before: CURSOR }))).toEqual({
      ok: true,
      path: `${base}/audit?before=${CURSOR}&limit=30`,
    });
    for (const params of [
      { extra: '1' } as Record<string, string>,
      { limit: '0' },
      { limit: '101' },
      { limit: '5.5' },
      { before: 'con espacio' },
      { before: 'x'.repeat(201) },
      { tenantId: ID },
    ]) {
      expect(memberAuditTarget(ID, MEMBER, q(params)), JSON.stringify(params)).toEqual({
        ok: false,
        error: 'La consulta del historial no es válida. Recarga la página.',
      });
    }
    expect(
      memberAuditTarget(
        ID,
        MEMBER,
        q([
          ['before', CURSOR],
          ['before', 'otro'],
        ]),
      ).ok,
    ).toBe(false);
    expect(memberAuditTarget(ID, 'ana', q({}))).toEqual({ ok: false, error: 'Miembro inválido.' });
  });

  it('userAuditQuery: vacío es "sin parámetros", lo que no se entiende es undefined', () => {
    expect(userAuditQuery(new URLSearchParams())).toBe('');
    expect(userAuditQuery(new URLSearchParams({ limit: '100' }))).toBe('limit=100');
    expect(userAuditQuery(new URLSearchParams({ q: 'x' }))).toBeUndefined();
  });
});
