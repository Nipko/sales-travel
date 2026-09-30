import { HttpStatus, type HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  buildSeatsView,
  isWithinSubtree,
  SeatReleaseSelfError,
  SeatSessionNotFoundError,
  TenantSeatsSuperadminOnlyError,
  type PoolSessionRow,
  type SeatsViewInput,
} from './seats.policy.js';

// Paths ltree como los arma 0011: el id sin guiones de cada ancestro, separados por punto.
const PLATAFORMA = 'aaaa';
const CONS = `${PLATAFORMA}.cccc`;
const AGENCIA = `${CONS}.a111`;
const SUB = `${AGENCIA}.5555`;
const HERMANA = `${CONS}.a222`;
/** Prefijo de texto de AGENCIA sin ser su descendiente: `a111` vs `a1110`. */
const PARECIDA = `${CONS}.a1110`;

describe('isWithinSubtree: el `<@` de ltree', () => {
  it.each<[string | null, string, boolean]>([
    [AGENCIA, AGENCIA, true],
    [SUB, AGENCIA, true],
    [SUB, CONS, true],
    [CONS, AGENCIA, false],
    [HERMANA, AGENCIA, false],
    [PARECIDA, AGENCIA, false],
    [null, AGENCIA, false],
    [AGENCIA, '', false],
  ])('%s bajo %s → %s', (path, root, expected) => {
    expect(isWithinSubtree(path, root)).toBe(expected);
  });
});

function sesion(id: string, tenantId: string | null, path: string | null): PoolSessionRow {
  return {
    session_id: id,
    user_id: `u-${id}`,
    email: `${id}@test.local`,
    name: `Nombre ${id}`,
    tenant_id: tenantId,
    tenant_name: tenantId === null ? null : `Nodo ${tenantId}`,
    issued_at: new Date('2026-09-29T10:00:00Z'),
    last_seen_at: new Date('2026-09-29T10:05:00Z'),
    ip: '203.0.113.7',
    user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130',
    tenant_path: path,
  };
}

const EN_CUPO: PoolSessionRow[] = [
  sesion('s-cons', 'cons', CONS),
  sesion('s-agencia', 'agencia', AGENCIA),
  sesion('s-sub', 'sub', SUB),
  sesion('s-hermana', 'hermana', HERMANA),
  sesion('s-parecida', 'parecida', PARECIDA),
  sesion('s-sin-nodo', null, null),
];

function vista(extra: Partial<SeatsViewInput>): ReturnType<typeof buildSeatsView> {
  return buildSeatsView({
    tenantId: 'agencia',
    tenantPath: AGENCIA,
    ownSeats: null,
    ownIdleTimeoutMinutes: null,
    idleTimeoutMinutes: 30,
    pool: { id: 'cons', name: 'Consolidador', limit: 8 },
    poolSessions: EN_CUPO,
    ...extra,
  });
}

describe('buildSeatsView', () => {
  it('cupo heredado: el conteo es el del cupo entero; las sesiones, sólo las de su subárbol', () => {
    const v = vista({});

    expect(v).toMatchObject({
      poolTenantId: 'cons',
      poolTenantName: 'Consolidador',
      inherited: true,
      limit: 8,
      inUse: EN_CUPO.length,
      idleTimeoutMinutes: 30,
      idleInherited: true,
      ownSeats: null,
      ownIdleTimeoutMinutes: null,
    });
    expect(v.sessions.map((s) => s.sessionId)).toEqual(['s-agencia', 's-sub']);
  });

  it('el admin del nodo del cupo ve todas las sesiones con nodo de su red', () => {
    const v = vista({
      tenantId: 'cons',
      tenantPath: CONS,
      ownSeats: 8,
      ownIdleTimeoutMinutes: 15,
      idleTimeoutMinutes: 15,
    });

    expect(v).toMatchObject({ inherited: false, idleInherited: false, ownSeats: 8 });
    expect(v.sessions.map((s) => s.sessionId)).toEqual([
      's-cons',
      's-agencia',
      's-sub',
      's-hermana',
      's-parecida',
    ]);
  });

  it('una hermana que comparte el cupo no ve ni puede tocar las sesiones de la otra', () => {
    const v = vista({ tenantId: 'hermana', tenantPath: HERMANA });
    expect(v.sessions.map((s) => s.sessionId)).toEqual(['s-hermana']);
  });

  it('sin cupo: sin límite, nada en uso y ninguna sesión que mostrar', () => {
    const v = vista({ pool: null, ownIdleTimeoutMinutes: 60, idleTimeoutMinutes: 60 });

    expect(v).toEqual({
      poolTenantId: null,
      poolTenantName: null,
      inherited: false,
      limit: null,
      inUse: 0,
      idleTimeoutMinutes: 60,
      idleInherited: false,
      ownSeats: null,
      ownIdleTimeoutMinutes: 60,
      sessions: [],
    });
  });

  it('cada sesión sale con el formato de la API (device = user-agent crudo)', () => {
    const [primera] = vista({}).sessions;
    expect(primera).toEqual({
      sessionId: 's-agencia',
      userId: 'u-s-agencia',
      name: 'Nombre s-agencia',
      email: 's-agencia@test.local',
      tenantId: 'agencia',
      tenantName: 'Nodo agencia',
      issuedAt: new Date('2026-09-29T10:00:00Z'),
      lastSeenAt: new Date('2026-09-29T10:05:00Z'),
      ip: '203.0.113.7',
      device: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130',
      current: false,
    });
  });

  it('marca la sesión de quien mira, y sólo ésa', () => {
    const v = vista({ currentSessionId: 's-sub' });
    expect(v.sessions.filter((s) => s.current).map((s) => s.sessionId)).toEqual(['s-sub']);
    expect(vista({}).sessions.some((s) => s.current)).toBe(false);
  });
});

describe('errores con motivo máquina', () => {
  it.each<[HttpException & { reason: string }, HttpStatus, string]>([
    [new TenantSeatsSuperadminOnlyError(), HttpStatus.FORBIDDEN, 'TENANT_SEATS_SUPERADMIN_ONLY'],
    [new SeatSessionNotFoundError(), HttpStatus.NOT_FOUND, 'SEAT_SESSION_NOT_FOUND'],
    [new SeatReleaseSelfError(), HttpStatus.FORBIDDEN, 'SEAT_RELEASE_SELF'],
  ])('%s', (err, status, reason) => {
    expect(err.getStatus()).toBe(status);
    expect(err.reason).toBe(reason);
  });
});
