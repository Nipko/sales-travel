import type { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { Role } from '../database/database.types.js';
import type { NetworkService } from '../network/network.service.js';
import { MemberSupportService } from './member-support.service.js';

const ACTOR = '99999999-9999-4999-8999-999999999999';
const TARGET = '88888888-8888-4888-8888-888888888888';
const NODO = '11111111-1111-4111-8111-111111111111';
const OTRA_RED = '33333333-3333-4333-8333-333333333333';

/**
 * El orden de la autorización con dobles: qué se decide sin leer nada, qué se lee con quién en el
 * contexto y que la acción no corre si la regla dice que no. La regla en sí está en
 * tenant-admin.policy.test.ts; contra Postgres, en seats.integration.test.ts.
 */
interface Banco {
  routeRole?: Role | undefined;
  inRoute?: { tenant_id: string; role: Role } | undefined;
  active?: Array<{ tenant_id: string; role: Role }>;
  actorRoles?: Array<[string, Role]>;
}

function banco(opts: Banco = {}) {
  // `in` y no defaults de destructuring: pasar `undefined` a propósito es parte de los casos.
  const routeRole = 'routeRole' in opts ? opts.routeRole : 'tenant_admin';
  const inRoute = 'inRoute' in opts ? opts.inRoute : { tenant_id: NODO, role: 'vendedor' };
  const active = opts.active ?? [{ tenant_id: NODO, role: 'vendedor' }];
  const actorRoles = opts.actorRoles ?? [[NODO, 'tenant_admin']];
  const network = {
    roleOver: vi.fn(() => Promise.resolve(routeRole)),
    rolesOver: vi.fn(() => Promise.resolve(new Map(actorRoles))),
  };
  // 1ª lectura: la membership en el nodo de la ruta; 2ª: las activas del objetivo; 3ª: la acción.
  const db = {
    withRequestContext: vi
      .fn()
      .mockResolvedValueOnce(inRoute)
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(0),
  };
  const service = new MemberSupportService(
    db as unknown as DatabaseService,
    network as unknown as NetworkService,
    { emitWithin: vi.fn() } as unknown as AuditService,
  );
  return { service, network, db };
}

async function motivo(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    const http = err as HttpException & { reason?: string };
    return `${http.getStatus()}/${http.reason ?? '?'}`;
  }
}

describe('MemberSupportService: el orden de la autorización', () => {
  it('sobre uno mismo es 403 sin consultar nada', async () => {
    const { service, network, db } = banco();

    expect(await motivo(service.resetMfa(ACTOR, NODO, ACTOR))).toBe('403/MEMBER_SELF_ACTION');
    expect(await motivo(service.revokeSessions(ACTOR, NODO, ACTOR))).toBe('403/MEMBER_SELF_ACTION');
    expect(network.roleOver).not.toHaveBeenCalled();
    expect(db.withRequestContext).not.toHaveBeenCalled();
  });

  it('quien no administra el nodo de la ruta recibe 403 antes de saber si el usuario es miembro', async () => {
    const { service, db } = banco({ routeRole: undefined });

    expect(await motivo(service.resetMfa(ACTOR, NODO, TARGET))).toBe('403/TENANT_NOT_MANAGED');
    expect(await motivo(service.revokeSessions(ACTOR, NODO, TARGET))).toBe(
      '403/TENANT_NOT_MANAGED',
    );
    expect(db.withRequestContext).not.toHaveBeenCalled();
  });

  it('un usuario que no es miembro del nodo es 404', async () => {
    const { service, db } = banco({ inRoute: undefined });

    expect(await motivo(service.resetMfa(ACTOR, NODO, TARGET))).toBe('404/MEMBER_NOT_FOUND');
    expect(db.withRequestContext).toHaveBeenCalledTimes(1);
    expect(db.withRequestContext).toHaveBeenCalledWith(
      { userId: ACTOR, tenantId: NODO },
      expect.any(Function),
    );
  });

  it('las memberships activas se leen con el OBJETIVO en el contexto (todas sus redes)', async () => {
    const { service, db, network } = banco();

    expect(await motivo(service.resetMfa(ACTOR, NODO, TARGET))).toBe('ok');
    expect(db.withRequestContext).toHaveBeenNthCalledWith(
      2,
      { userId: TARGET },
      expect.any(Function),
    );
    expect(network.rolesOver).toHaveBeenCalledWith(ACTOR, [NODO]);
    // La acción corre con el actor en el contexto.
    expect(db.withRequestContext).toHaveBeenNthCalledWith(
      3,
      { userId: ACTOR },
      expect.any(Function),
    );
  });

  it('si también trabaja en otra red: 403 y la acción no corre', async () => {
    const { service, db, network } = banco({
      active: [
        { tenant_id: NODO, role: 'vendedor' },
        { tenant_id: OTRA_RED, role: 'vendedor' },
      ],
    });

    expect(await motivo(service.revokeSessions(ACTOR, NODO, TARGET))).toBe(
      '403/MEMBER_OUTSIDE_NETWORK',
    );
    expect(network.rolesOver).toHaveBeenCalledWith(ACTOR, [NODO, OTRA_RED]);
    expect(db.withRequestContext).toHaveBeenCalledTimes(2);
  });

  it('la membership del nodo de la ruta cuenta aunque esté suspendida', async () => {
    const { service, db } = banco({
      inRoute: { tenant_id: NODO, role: 'tenant_admin' },
      active: [],
    });

    expect(await motivo(service.resetMfa(ACTOR, NODO, TARGET))).toBe('403/ROLE_NOT_GRANTABLE');
    expect(db.withRequestContext).toHaveBeenCalledTimes(2);
  });

  it('el superadmin pasa aunque el usuario esté en otra red', async () => {
    const { service, db } = banco({
      routeRole: 'superadmin',
      active: [
        { tenant_id: NODO, role: 'vendedor' },
        { tenant_id: OTRA_RED, role: 'consolidator_admin' },
      ],
      actorRoles: [],
    });

    expect(await motivo(service.revokeSessions(ACTOR, NODO, TARGET))).toBe('ok');
    expect(db.withRequestContext).toHaveBeenCalledTimes(3);
  });
});
