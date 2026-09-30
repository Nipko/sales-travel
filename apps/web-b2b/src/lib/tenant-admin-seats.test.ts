import { describe, expect, it } from 'vitest';
import {
  IDLE_OPTIONS,
  idleChoices,
  idleLabel,
  inheritIdleLabel,
  inheritSeatsLabel,
  loweredSeatsNotice,
  orderedSessions,
  parseIdle,
  parseSeats,
  parseSeatsView,
  releaseConfirm,
  seatPolicyChanged,
  seatPolicyDraftOf,
  seatPolicyPayload,
  seatPolicySavedMessage,
  seatReleaseError,
  seatUsage,
  validateSeatPolicy,
  type SeatSession,
  type SeatsView,
} from './tenant-admin-seats';

const SESSION = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  name: 'Ana Pérez',
  email: 'ana@agencia.co',
  tenantId: '33333333-3333-4333-8333-333333333333',
  tenantName: 'Agencia Norte',
  issuedAt: '2026-09-29T13:00:00.000Z',
  lastSeenAt: '2026-09-29T14:58:00.000Z',
  ip: '203.0.113.7',
  device:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
};

const RAW = {
  poolTenantId: '33333333-3333-4333-8333-333333333333',
  poolTenantName: 'Agencia Norte',
  inherited: false,
  limit: 5,
  inUse: 3,
  idleTimeoutMinutes: 30,
  idleInherited: true,
  ownSeats: 5,
  ownIdleTimeoutMinutes: null,
  sessions: [SESSION],
};

function view(patch: Partial<SeatsView> = {}): SeatsView {
  const parsed = parseSeatsView(RAW);
  if (parsed === undefined) throw new Error('fixture inválida');
  return { ...parsed, ...patch };
}

describe('parseSeatsView: GET /tenants/:id/seats', () => {
  it('lee cupo, herencia, inactividad y sesiones', () => {
    expect(parseSeatsView(RAW)).toEqual({
      ...RAW,
      sessions: [{ ...SESSION, current: false }],
    });
  });

  it('respeta la marca `current` que pone el proxy', () => {
    const parsed = parseSeatsView({ ...RAW, sessions: [{ ...SESSION, current: true }] });
    expect(parsed?.sessions[0]?.current).toBe(true);
  });

  it('sin límite: limit y ownSeats nulos', () => {
    const parsed = parseSeatsView({ ...RAW, limit: null, ownSeats: null, poolTenantId: null });
    expect(parsed).toMatchObject({ limit: null, ownSeats: null, poolTenantId: null });
  });

  it('descarta sesiones incompletas sin tumbar la vista', () => {
    const parsed = parseSeatsView({ ...RAW, sessions: [SESSION, { sessionId: 'x' }, null] });
    expect(parsed?.sessions).toHaveLength(1);
  });

  it('una forma inesperada es un error, no "nadie conectado"', () => {
    expect(parseSeatsView({ users: [] })).toBeUndefined();
    expect(parseSeatsView({ ...RAW, inUse: -1 })).toBeUndefined();
    expect(parseSeatsView({ ...RAW, sessions: 'x' })).toBeUndefined();
    expect(parseSeatsView(null)).toBeUndefined();
  });

  it('una inactividad inválida cae en el default de 30 min', () => {
    expect(parseSeatsView({ ...RAW, idleTimeoutMinutes: 0 })?.idleTimeoutMinutes).toBe(30);
  });
});

describe('seatUsage: la tarjeta de puestos', () => {
  it('"3 de 5 en uso" con la barra y los libres', () => {
    const usage = seatUsage(view());
    expect(usage).toMatchObject({
      headline: '3 de 5 en uso',
      detail: '2 puestos libres.',
      ratio: 0.6,
      tone: 'ok',
      valueText: '3 de 5 puestos en uso',
      shared: undefined,
    });
    expect(usage.idle).toBe('Se cierra tras 30 min sin actividad (heredado).');
  });

  it('cupo lleno avisa que nadie más entra; la barra no pasa del 100 %', () => {
    const usage = seatUsage(view({ inUse: 7 }));
    expect(usage.tone).toBe('full');
    expect(usage.ratio).toBe(1);
    expect(usage.detail).toMatch(/Cupo lleno/);
  });

  it('cerca del tope, en advertencia', () => {
    expect(seatUsage(view({ inUse: 4 })).tone).toBe('warn');
  });

  it('sin límite no dibuja barra', () => {
    const usage = seatUsage(view({ limit: null, ownSeats: null, poolTenantId: null, inUse: 0 }));
    expect(usage).toMatchObject({ headline: 'Sin límite', ratio: undefined, tone: 'unlimited' });
  });

  it('sin límite no da un conteo: el API no cuenta esas sesiones y manda inUse 0', () => {
    // Así llega un nodo sin cupo (seats.policy.ts, buildSeatsView), con 4 vendedores trabajando.
    const usage = seatUsage(
      view({ limit: null, ownSeats: null, poolTenantId: null, inUse: 0, sessions: [] }),
    );
    expect(usage.detail).toBe(
      'Este nodo no cuenta puestos: se puede conectar cualquier cantidad de personas.',
    );
    expect(usage.valueText).toBe('Sin límite de puestos.');
    expect(`${usage.detail} ${usage.valueText}`).not.toMatch(/\b0\b|conectadas? ahora/);
  });

  it('heredado: "Compartido con" el dueño del cupo', () => {
    const usage = seatUsage(
      view({ inherited: true, ownSeats: null, poolTenantName: 'Consolidador Andino' }),
    );
    expect(usage.shared).toBe('Compartido con Consolidador Andino');
  });

  it('inactividad en horas y propia', () => {
    expect(seatUsage(view({ idleTimeoutMinutes: 120, idleInherited: false })).idle).toBe(
      'Se cierra tras 2 h sin actividad.',
    );
  });
});

describe('sesiones', () => {
  const s = (patch: Partial<SeatSession>): SeatSession => ({
    ...SESSION,
    current: false,
    ...patch,
  });

  it('la propia primero y después la más reciente', () => {
    const list = orderedSessions([
      s({ sessionId: 'a', lastSeenAt: '2026-09-29T14:00:00.000Z' }),
      s({ sessionId: 'b', lastSeenAt: '2026-09-29T14:30:00.000Z' }),
      s({ sessionId: 'c', lastSeenAt: '2026-09-29T13:00:00.000Z', current: true }),
    ]);
    expect(list.map((x) => x.sessionId)).toEqual(['c', 'b', 'a']);
  });

  it('la confirmación nombra a la persona y el dispositivo', () => {
    const copy = releaseConfirm(s({}));
    expect(copy.title).toBe('Desconectar a Ana Pérez');
    expect(copy.description).toContain('Chrome en Windows');
    expect(releaseConfirm(s({ name: null })).title).toBe('Desconectar a ana@agencia.co');
  });

  it('errores al desconectar', () => {
    expect(seatReleaseError(404, undefined)).toMatch(/ya se había cerrado/);
    expect(seatReleaseError(403, 'no administrás el nodo de esa sesión')).toBe(
      'No lo pudimos hacer: no administrás el nodo de esa sesión',
    );
    expect(seatReleaseError(403, '')).toMatch(/pedíselo/);
    expect(seatReleaseError(400, 'No podés liberar tu propia sesión.')).toBe(
      'No podés liberar tu propia sesión.',
    );
    expect(seatReleaseError(401, 'x')).toMatch(/sesión venció/);
    expect(seatReleaseError(502, '')).toMatch(/Probá de nuevo/);
  });
});

describe('política de puestos (superadmin)', () => {
  it('parseSeats: sólo enteros dentro de 1-10000', () => {
    expect(parseSeats('5')).toBe(5);
    expect(parseSeats(' 10000 ')).toBe(10_000);
    expect(parseSeats('0')).toBeUndefined();
    expect(parseSeats('10001')).toBeUndefined();
    expect(parseSeats('2.5')).toBeUndefined();
    expect(parseSeats('-3')).toBeUndefined();
    expect(parseSeats('')).toBeUndefined();
  });

  it('parseIdle: enteros en el rango del API (5-480), no sólo los de la lista', () => {
    expect(parseIdle('30')).toBe(30);
    expect(parseIdle('480')).toBe(480);
    expect(parseIdle('5')).toBe(5);
    expect(parseIdle('45')).toBe(45);
    expect(parseIdle('4')).toBeUndefined();
    expect(parseIdle('481')).toBeUndefined();
    expect(parseIdle('600')).toBeUndefined();
    expect(parseIdle('7.5')).toBeUndefined();
    expect(parseIdle('')).toBeUndefined();
  });

  it('idleChoices: la lista del panel más el valor guardado si no está en ella', () => {
    expect(idleChoices(null)).toEqual(IDLE_OPTIONS);
    expect(idleChoices(30)).toEqual(IDLE_OPTIONS);
    expect(idleChoices(45)).toEqual([5, 10, 15, 30, 45, 60, 120, 240, 480]);
    expect(idleChoices(999)).toEqual(IDLE_OPTIONS);
  });

  it('un nodo con una inactividad fuera de la lista (45 min, puesta por el API) se puede guardar', () => {
    const custom = view({ ownIdleTimeoutMinutes: 45 });
    const draft = seatPolicyDraftOf(custom);
    expect(draft.idle).toBe('45');
    expect(validateSeatPolicy(draft)).toEqual({});
    expect(seatPolicyChanged(draft, custom)).toBe(false);
    expect(seatPolicyPayload({ ...draft, seats: '6' })).toEqual({
      concurrentSeats: 6,
      idleTimeoutMinutes: 45,
    });
  });

  it('el borrador sale de lo propio del nodo', () => {
    expect(seatPolicyDraftOf(view())).toEqual({ seatsMode: 'own', seats: '5', idle: '' });
    expect(seatPolicyDraftOf(view({ ownSeats: null, ownIdleTimeoutMinutes: 60 }))).toEqual({
      seatsMode: 'inherit',
      seats: '',
      idle: '60',
    });
  });

  it('cupo propio vacío o fuera de rango no se envía', () => {
    expect(validateSeatPolicy({ seatsMode: 'own', seats: '', idle: '' }).seats).toMatch(
      /Indicá cuántos/,
    );
    expect(validateSeatPolicy({ seatsMode: 'own', seats: '20000', idle: '' }).seats).toMatch(
      /entre 1 y/,
    );
    expect(seatPolicyPayload({ seatsMode: 'own', seats: '', idle: '' })).toBeUndefined();
  });

  it('heredar manda null; lo propio, el número', () => {
    expect(seatPolicyPayload({ seatsMode: 'inherit', seats: '9', idle: '' })).toEqual({
      concurrentSeats: null,
      idleTimeoutMinutes: null,
    });
    expect(seatPolicyPayload({ seatsMode: 'own', seats: '8', idle: '15' })).toEqual({
      concurrentSeats: 8,
      idleTimeoutMinutes: 15,
    });
  });

  it('detecta si hay cambios', () => {
    expect(seatPolicyChanged({ seatsMode: 'own', seats: '5', idle: '' }, view())).toBe(false);
    expect(seatPolicyChanged({ seatsMode: 'own', seats: '6', idle: '' }, view())).toBe(true);
    expect(seatPolicyChanged({ seatsMode: 'inherit', seats: '5', idle: '' }, view())).toBe(true);
  });

  it('bajar el cupo propio por debajo de los conectados avisa que nadie se desconecta', () => {
    // view(): cupo propio de 5 con 3 en uso.
    expect(loweredSeatsNotice({ seatsMode: 'own', seats: '2', idle: '' }, view())).toMatch(
      /Hoy hay 3 personas conectadas. Nadie se desconecta/,
    );
    expect(loweredSeatsNotice({ seatsMode: 'own', seats: '3', idle: '' }, view())).toBeUndefined();
    expect(
      loweredSeatsNotice({ seatsMode: 'inherit', seats: '1', idle: '' }, view()),
    ).toBeUndefined();
  });

  it('pasar de heredar a cupo propio no avisa: el cupo nuevo arranca vacío', () => {
    // Sur hereda los 20 de Andino, con 15 en uso en toda la red: esas sesiones siguen contando
    // para Andino (seat_tenant_id se fija al ingresar), así que 5 propios arrancan en 0.
    const inheriting = view({
      inherited: true,
      ownSeats: null,
      limit: 20,
      inUse: 15,
      poolTenantName: 'Consolidador Andino',
    });
    expect(loweredSeatsNotice({ seatsMode: 'own', seats: '5', idle: '' }, inheriting)).toBe(
      undefined,
    );
    const unlimited = view({ ownSeats: null, limit: null, poolTenantId: null, inUse: 0 });
    expect(loweredSeatsNotice({ seatsMode: 'own', seats: '1', idle: '' }, unlimited)).toBe(
      undefined,
    );
  });

  it('las opciones "Heredar" dicen de quién y, si se sabe, cuánto', () => {
    const inheriting = view({
      ownSeats: null,
      inherited: true,
      limit: 20,
      poolTenantName: 'Consolidador Andino',
    });
    expect(inheritSeatsLabel(inheriting, 'Agencia Norte')).toBe(
      'Heredar de Agencia Norte (hoy comparte los 20 de Consolidador Andino)',
    );
    expect(inheritSeatsLabel(view(), 'Agencia Norte')).toBe('Heredar de Agencia Norte');
    expect(inheritSeatsLabel(view({ ownSeats: null, limit: null }), 'Planetour')).toBe(
      'Heredar de Planetour (hoy sin límite)',
    );
    expect(inheritSeatsLabel(view(), null)).toMatch(/Sin límite/);
    expect(inheritIdleLabel(view(), 'Planetour')).toBe('Heredar de Planetour (hoy 30 min)');
    expect(inheritIdleLabel(view({ ownIdleTimeoutMinutes: 60 }), 'Planetour')).toBe(
      'Heredar de Planetour',
    );
    expect(inheritIdleLabel(view(), null)).toBe('Por defecto (30 min)');
  });

  it('el aviso al guardar', () => {
    expect(seatPolicySavedMessage({ concurrentSeats: 1, idleTimeoutMinutes: 480 }, 'Norte')).toBe(
      'Norte tiene 1 puesto y cierra tras 8 h sin actividad.',
    );
    expect(
      seatPolicySavedMessage({ concurrentSeats: null, idleTimeoutMinutes: null }, 'Norte'),
    ).toBe('Norte hereda los puestos y hereda la inactividad.');
  });

  it('idleLabel', () => {
    expect(idleLabel(5)).toBe('5 min');
    expect(idleLabel(60)).toBe('1 h');
    expect(idleLabel(90)).toBe('90 min');
  });
});
