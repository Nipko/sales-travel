import { describe, expect, it } from 'vitest';
import type { ApiResponse } from './api';
import {
  currentSessionIdOf,
  markCurrentSession,
  memberActionTarget,
  membershipImpactTarget,
  seatPolicyPlan,
  seatReleaseTarget,
  seatsViewTarget,
  tenantAdminProxyReply,
  tenantMovePlan,
  tenantUpdatePlan,
} from './tenant-admin-proxy';

const ID = '0B6F6A52-7A47-4C8E-9A3B-1A2B3C4D5E6F';
const PARENT = '11111111-2222-4333-8444-555555555555';

describe('tenantUpdatePlan: PATCH /admin/tenants/:id', () => {
  it('reconstruye el cuerpo campo por campo, con el id en minúsculas', () => {
    expect(tenantUpdatePlan(ID, { status: 'suspended', extra: 'x' })).toEqual({
      ok: true,
      path: `/admin/tenants/${ID.toLowerCase()}`,
      body: { status: 'suspended' },
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
          message: 'No administrás todos los nodos de este usuario.',
          reason: 'MEMBER_OUTSIDE_SCOPE',
          details: { secret: 'x' },
        }),
      ),
    ).toEqual({
      status: 403,
      body: {
        error: 'No administrás todos los nodos de este usuario.',
        reason: 'MEMBER_OUTSIDE_SCOPE',
      },
    });
    expect(tenantAdminProxyReply(json(400, { message: ['a', 'b'], reason: 'no es' }))).toEqual({
      status: 400,
      body: { error: 'a. b' },
    });
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
