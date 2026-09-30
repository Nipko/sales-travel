import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, AuditService } from '../audit/audit.service.js';
import type { NetworkService } from '../network/network.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { SeatsFullError } from './auth-errors.js';
import { JwtService } from './jwt.service.js';
import {
  SeatRepository,
  type NewSession,
  type PoolInfo,
  type PoolSession,
  type RevokedSession,
  type SeatTransaction,
} from './seat.repository.js';
import { SeatService, type IssueSessionParams } from './seat.service.js';

interface FakeSession extends NewSession {
  id: string;
  revokedReason: string | null;
}

/**
 * Doble en memoria de SeatRepository: la misma interfaz que la implementación de Postgres, con las
 * reglas de seats_in_use (no revocada, del cupo, sin contar a quien entra). La herencia del cupo y la
 * inactividad son de la base (seats.integration.test.ts); acá se prueba la decisión de SeatService.
 *
 * Los advisory locks se imitan de verdad: se esperan entre transacciones y se sueltan cuando termina
 * la transacción que los tomó, como pg_advisory_xact_lock. Sin lock, dos transacciones intercalan
 * sus pasos, que es lo que pasa en Postgres en READ COMMITTED.
 */
class FakeSeats extends SeatRepository {
  readonly platformUsers = new Set<string>();
  readonly poolOf = new Map<string, string>();
  readonly pools = new Map<string, PoolInfo>();
  readonly idleMinutes = new Map<string, number>();
  readonly sessions: FakeSession[] = [];
  /** Los locks en el orden en que se obtuvieron: `user:<id>` y `pool:<id>`. */
  readonly locks: string[] = [];
  /** Los pasos de la transacción en el orden en que se llamaron. */
  readonly steps: string[] = [];
  readonly consumed = new Set<string>();
  private readonly held = new Map<string, Promise<void>>();

  seed(userId: string, tenantId: string, seat: string | null): FakeSession {
    const s: FakeSession = {
      id: randomUUID(),
      userId,
      tenantId,
      seatTenantId: seat,
      idleTimeoutSeconds: 1800,
      mfaVerified: false,
      expiresAt: new Date(Date.now() + 3600_000),
      ip: null,
      userAgent: null,
      revokedReason: null,
    };
    this.sessions.push(s);
    return s;
  }

  live(userId: string): FakeSession[] {
    return this.sessions.filter((s) => s.userId === userId && s.revokedReason === null);
  }

  /** Espera a que se suelte `key` y lo toma hasta que `release` se llame. */
  private async acquire(key: string, releases: (() => void)[]): Promise<void> {
    const previous = this.held.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    this.held.set(
      key,
      previous.then(() => mine),
    );
    await previous;
    this.locks.push(key);
    releases.push(release);
  }

  async inTransaction<T>(_userId: string, fn: (tx: SeatTransaction) => Promise<T>): Promise<T> {
    const releases: (() => void)[] = [];
    const tx: SeatTransaction = {
      isPlatformUser: (u) => {
        this.steps.push('isPlatformUser');
        return Promise.resolve(this.platformUsers.has(u));
      },
      seatPoolOf: (t) => Promise.resolve(this.poolOf.get(t) ?? null),
      idleTimeoutMinutes: (t) => Promise.resolve((t && this.idleMinutes.get(t)) || 30),
      lockUser: (u) => {
        this.steps.push('lockUser');
        return this.acquire(`user:${u}`, releases);
      },
      lockPool: (p) => {
        this.steps.push('lockPool');
        return this.acquire(`pool:${p}`, releases);
      },
      poolInfo: (p) => Promise.resolve(this.pools.get(p) ?? null),
      seatsInUse: (p, exclude) =>
        Promise.resolve(
          this.sessions.filter(
            (s) => s.seatTenantId === p && s.revokedReason === null && s.userId !== exclude,
          ).length,
        ),
      replaceSessions: (u, reason, current) => {
        this.steps.push('replaceSessions');
        const out: RevokedSession[] = [];
        for (const s of this.live(u)) {
          s.revokedReason = s.id === current?.sessionId ? current.reason : reason;
          out.push({ id: s.id, reason: s.revokedReason });
        }
        return Promise.resolve(out);
      },
      revokeOwnSession: (u, id, reason) => {
        const s = this.live(u).find((x) => x.id === id);
        if (s) s.revokedReason = reason;
        return Promise.resolve(s !== undefined);
      },
      insertSession: (n) => Promise.resolve(this.seed2(n).id),
    };
    try {
      return await fn(tx);
    } finally {
      for (const release of releases) release();
    }
  }

  private seed2(n: NewSession): FakeSession {
    const s: FakeSession = { ...n, id: randomUUID(), revokedReason: null };
    this.sessions.push(s);
    return s;
  }

  poolSessions(pool: string): Promise<PoolSession[]> {
    return Promise.resolve(
      this.sessions
        .filter((s) => s.seatTenantId === pool && s.revokedReason === null)
        .map((s) => ({
          sessionId: s.id,
          userId: s.userId,
          email: `${s.userId}@test.local`,
          name: `Nombre ${s.userId}`,
          tenantId: s.tenantId,
          tenantName: 'Agencia',
          issuedAt: new Date(),
          lastSeenAt: new Date('2026-09-29T12:00:00Z'),
          ip: '190.24.8.9',
          userAgent: 'Chrome en Windows',
        })),
    );
  }

  releaseSession(): Promise<boolean> {
    return Promise.resolve(true);
  }

  consumeToken(jti: string): Promise<boolean> {
    if (this.consumed.has(jti)) return Promise.resolve(false);
    this.consumed.add(jti);
    return Promise.resolve(true);
  }
}

const jwt = new JwtService();

const POOL = 'pool-cons';
const AGENCY = 'agency-1';

function setup(opts: { limit?: number; canManage?: boolean } = {}) {
  const repo = new FakeSeats();
  repo.poolOf.set(AGENCY, POOL);
  repo.pools.set(POOL, { limit: opts.limit ?? 2, tenantName: 'Consolidador Andino' });
  const events: AuditEvent[] = [];
  const audit = {
    emit: vi.fn((e: AuditEvent) => {
      events.push(e);
      return Promise.resolve();
    }),
  } as unknown as AuditService;
  const canManageTenant = vi.fn(() => Promise.resolve(opts.canManage === true));
  const network = { canManageTenant } as unknown as NetworkService;
  const service = new SeatService(repo, audit, network, jwt);
  return { repo, events, service, canManageTenant };
}

function issue(service: SeatService, params: Partial<IssueSessionParams> & { userId: string }) {
  return requestContextStorage.run({ ip: '190.24.8.9', userAgent: 'Mozilla/5.0 Firefox' }, () =>
    service.issue({
      tenantId: AGENCY,
      mfaVerified: false,
      expiresAt: new Date(Date.now() + 3600_000),
      ...params,
    }),
  );
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('se esperaba un rechazo');
}

describe('SeatService', () => {
  beforeAll(() => {
    process.env['JWT_SECRET'] ??= 'j'.repeat(40);
    jwt.onModuleInit();
  });

  it('con cupo libre emite la sesión consumiendo del pool, bajo el lock del usuario y del cupo', async () => {
    const { repo, service } = setup();
    repo.idleMinutes.set(AGENCY, 15);
    const issued = await issue(service, { userId: 'ana', mfaVerified: true });

    expect(issued).toMatchObject({ seatTenantId: POOL, idleTimeoutSeconds: 900 });
    // Siempre en el mismo orden: primero el usuario, después el cupo. Así dos ingresos nunca se
    // esperan en cruz.
    expect(repo.locks).toEqual(['user:ana', `pool:${POOL}`]);
    const row = repo.sessions.find((s) => s.id === issued.sessionId);
    expect(row).toMatchObject({
      userId: 'ana',
      tenantId: AGENCY,
      seatTenantId: POOL,
      idleTimeoutSeconds: 900,
      mfaVerified: true,
      ip: '190.24.8.9',
      userAgent: 'Mozilla/5.0 Firefox',
    });
  });

  it('el lock del usuario va antes que todo: antes de mirar su rol, del cupo y de cerrar sus sesiones', async () => {
    const { repo, service } = setup();
    repo.seed('ana', AGENCY, POOL);

    await issue(service, { userId: 'ana' });

    expect(repo.steps[0]).toBe('lockUser');
    expect(repo.steps.indexOf('lockUser')).toBeLessThan(repo.steps.indexOf('isPlatformUser'));
    expect(repo.steps.indexOf('lockUser')).toBeLessThan(repo.steps.indexOf('lockPool'));
    expect(repo.steps.indexOf('lockUser')).toBeLessThan(repo.steps.indexOf('replaceSessions'));
  });

  it('cupo lleno: 409 SEATS_FULL, no emite ni revoca nada', async () => {
    const { repo, service, events } = setup({ limit: 2 });
    repo.seed('bruno', AGENCY, POOL);
    repo.seed('carla', AGENCY, POOL);
    const previous = repo.seed('dario', 'otra-agencia', null);

    const err = await rejection(issue(service, { userId: 'dario' }));

    expect(err).toBeInstanceOf(SeatsFullError);
    expect((err as SeatsFullError).getStatus()).toBe(409);
    expect((err as SeatsFullError).reason).toBe('SEATS_FULL');
    expect((err as SeatsFullError).publicDetails).toEqual({
      tenantName: 'Consolidador Andino',
      limit: 2,
      inUse: 2,
    });
    // Quien quedó afuera no le cierra la sesión a nadie, ni a sí mismo.
    expect(repo.sessions.every((s) => s.revokedReason === null)).toBe(true);
    expect(repo.live('dario').map((s) => s.id)).toEqual([previous.id]);
    expect(events.map((e) => e.eventType)).toEqual(['auth.seat.denied']);
    expect(events[0]).toMatchObject({ tenantId: POOL, payload: { limit: 2, inUse: 2 } });
  });

  it('no cuenta al propio usuario: su sesión anterior se reemplaza (una sesión por usuario)', async () => {
    const { repo, service, events } = setup({ limit: 1 });
    const old = repo.seed('ana', AGENCY, POOL);

    const issued = await issue(service, { userId: 'ana' });

    expect(repo.live('ana').map((s) => s.id)).toEqual([issued.sessionId]);
    expect(repo.sessions.find((s) => s.id === old.id)?.revokedReason).toBe('replaced');
    const replaced = events.find((e) => e.eventType === 'auth.session.replaced');
    expect(replaced?.payload).toMatchObject({ replacedSessionIds: [old.id] });
  });

  it('el usuario de plataforma no consume puesto ni tiene el límite de una sesión', async () => {
    const { repo, service } = setup({ limit: 1 });
    repo.platformUsers.add('root');
    repo.seed('bruno', AGENCY, POOL);
    const other = repo.seed('root', 'plataforma', null);

    const issued = await issue(service, { userId: 'root' });

    expect(issued.seatTenantId).toBeNull();
    // Sólo el del usuario (se toma siempre, antes de saber si es de plataforma); cupo, ninguno.
    expect(repo.locks).toEqual(['user:root']);
    expect(
      repo
        .live('root')
        .map((s) => s.id)
        .sort(),
    ).toEqual([other.id, issued.sessionId].sort());
  });

  it('switch-tenant: la sesión de la que sale se cierra con su propio motivo', async () => {
    const { repo, service, events } = setup({ limit: 3 });
    const current = repo.seed('ana', AGENCY, POOL);
    const elsewhere = repo.seed('ana', AGENCY, POOL);

    await issue(service, {
      userId: 'ana',
      current: { sessionId: current.id, reason: 'tenant_switched' },
    });

    expect(repo.sessions.find((s) => s.id === current.id)?.revokedReason).toBe('tenant_switched');
    expect(repo.sessions.find((s) => s.id === elsewhere.id)?.revokedReason).toBe('replaced');
    const replaced = events.find((e) => e.eventType === 'auth.session.replaced');
    expect(replaced?.payload).toMatchObject({ replacedSessionIds: [elsewhere.id] });
  });

  it('switch-tenant de un usuario de plataforma cierra sólo la sesión de la que sale', async () => {
    const { repo, service } = setup();
    repo.platformUsers.add('root');
    const current = repo.seed('root', 'plataforma', null);
    const other = repo.seed('root', 'plataforma', null);

    await issue(service, {
      userId: 'root',
      current: { sessionId: current.id, reason: 'tenant_switched' },
    });

    expect(repo.sessions.find((s) => s.id === current.id)?.revokedReason).toBe('tenant_switched');
    expect(repo.sessions.find((s) => s.id === other.id)?.revokedReason).toBeNull();
  });

  it('sin límite en la cadena no hay cupo ni su lock, pero sí una sesión por usuario', async () => {
    const { repo, service } = setup();
    const old = repo.seed('eva', 'libre', null);
    const issued = await issue(service, { userId: 'eva', tenantId: 'libre' });
    expect(issued.seatTenantId).toBeNull();
    expect(repo.locks).toEqual(['user:eva']);
    expect(repo.sessions.find((s) => s.id === old.id)?.revokedReason).toBe('replaced');
  });

  it('dos ingresos simultáneos del mismo usuario sin cupo dejan una sola sesión viva', async () => {
    const { repo, service } = setup();
    repo.seed('eva', 'libre', null);

    const [a, b] = await Promise.all([
      issue(service, { userId: 'eva', tenantId: 'libre' }),
      issue(service, { userId: 'eva', tenantId: 'libre' }),
    ]);

    expect(repo.live('eva').map((s) => s.id)).toEqual([b.sessionId]);
    expect(repo.sessions.find((s) => s.id === a.sessionId)?.revokedReason).toBe('replaced');
  });

  it('y por cupos distintos: el lock del cupo no los ordena, el del usuario sí', async () => {
    const { repo, service } = setup({ limit: 5 });
    repo.poolOf.set('otra-agencia', 'pool-otro');
    repo.pools.set('pool-otro', { limit: 5, tenantName: 'Otro consolidador' });

    await Promise.all([
      issue(service, { userId: 'ana', tenantId: AGENCY }),
      issue(service, { userId: 'ana', tenantId: 'otra-agencia' }),
    ]);

    // Una sola sesión viva, y por lo tanto un solo puesto ocupado entre los dos cupos.
    expect(repo.live('ana')).toHaveLength(1);
  });

  it('renovar el propio puesto (cambio de contraseña) no se niega aunque el cupo esté pasado', async () => {
    const { repo, service } = setup({ limit: 1 });
    repo.seed('bruno', AGENCY, POOL);
    repo.seed('carla', AGENCY, POOL);
    const issued = await issue(service, {
      userId: 'ana',
      enforceSeatLimit: false,
      replaceReason: 'password_changed',
    });
    expect(issued.seatTenantId).toBe(POOL);
  });

  it('quien administra el nodo del cupo recibe la lista y un permiso de un solo uso', async () => {
    const { repo, service, canManageTenant } = setup({ limit: 2, canManage: true });
    const bruno = repo.seed('bruno', AGENCY, POOL);
    repo.seed('carla', AGENCY, POOL);

    const err = (await rejection(
      issue(service, { userId: 'admin', mfaVerified: true, remember: true }),
    )) as SeatsFullError;

    expect(canManageTenant).toHaveBeenCalledWith('admin', POOL);
    const release = err.publicDetails.release;
    expect(release?.sessions.map((s) => s.sessionId)).toContain(bruno.id);
    expect(release?.sessions[0]).toMatchObject({
      name: 'Nombre bruno',
      email: 'bruno@test.local',
      tenantName: 'Agencia',
      lastSeenAt: '2026-09-29T12:00:00.000Z',
      device: 'Chrome en Windows',
      ip: '190.24.8.9',
    });
    const claims = await jwt.verifySeatRelease(release?.token ?? '');
    expect(claims).toMatchObject({
      userId: 'admin',
      poolTenantId: POOL,
      tenantId: AGENCY,
      mfa: true,
      remember: true,
    });
  });

  it('la lista para liberar no incluye las sesiones del propio usuario', async () => {
    const { repo, service } = setup({ limit: 1, canManage: true });
    repo.seed('bruno', AGENCY, POOL);
    // Con límite 1 y bruno adentro, el admin queda afuera aunque tenga su propia sesión vieja.
    repo.seed('admin', AGENCY, POOL);

    const err = (await rejection(issue(service, { userId: 'admin' }))) as SeatsFullError;

    expect(err.publicDetails.release?.sessions.map((s) => s.email)).toEqual(['bruno@test.local']);
  });
});
