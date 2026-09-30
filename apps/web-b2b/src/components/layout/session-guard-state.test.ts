import { describe, expect, it } from 'vitest';
import {
  EXPIRY_WARNING_MS,
  IDLE_WARNING_MS,
  PING_INTERVAL_MS,
  SERVER_TOUCH_GRANULARITY_MS,
  STAY_RETRY_GAP_MS,
  URGENT_PING_GAP_MS,
  acceptClock,
  announceBucket,
  announceText,
  clockFromSnapshot,
  evaluateGuard,
  expiryWarningText,
  formatCountdown,
  isNewerForeignClock,
  loginPath,
  newerClock,
  parseClock,
  parseGuardMessage,
  parsePingResult,
  parseSessionSnapshot,
  sessionEndPath,
  type GuardInputs,
  type SessionClock,
  type SessionSnapshot,
} from './session-guard-state';

const MIN = 60_000;
const T0 = Date.parse('2026-09-29T15:00:00.000Z');

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 's-1',
    idleTimeoutSeconds: 1800,
    expiresAt: new Date(T0 + 12 * 60 * MIN).toISOString(),
    lastSeenAt: new Date(T0).toISOString(),
    serverNow: new Date(T0).toISOString(),
    ...overrides,
  };
}

function clock(overrides: Partial<SessionClock> = {}): SessionClock {
  return {
    sessionId: 's-1',
    idleTimeoutMs: 30 * MIN,
    idleDeadlineAt: T0 + 30 * MIN,
    expiresAt: T0 + 12 * 60 * MIN,
    receivedAt: T0,
    ...overrides,
  };
}

function inputs(overrides: Partial<GuardInputs> = {}): GuardInputs {
  return {
    now: T0,
    clock: clock(),
    lastActivityAt: T0,
    reportedActivityAt: T0,
    lastPingAt: T0,
    ...overrides,
  };
}

describe('parseSessionSnapshot: sólo lo que la guardia usa, y válido', () => {
  it('acepta la respuesta de GET /auth/session y descarta lo demás', () => {
    const raw = { ...snapshot(), extra: 'x', role: 'tenant_admin' };
    expect(parseSessionSnapshot(raw)).toEqual(snapshot());
  });

  it('conserva el estado del 2FA: con él la guardia se entera de que el rol pasó a exigirlo', () => {
    const raw = { ...snapshot(), mfaRequired: true, mfaEnabled: false, mfaVerified: false };
    expect(parseSessionSnapshot(raw)).toEqual({
      ...snapshot(),
      mfaRequired: true,
      mfaEnabled: false,
      mfaVerified: false,
    });
  });

  it('un estado del 2FA que no es booleano no se inventa', () => {
    const parsed = parseSessionSnapshot({ ...snapshot(), mfaRequired: 'true', mfaEnabled: 1 });
    expect(parsed).toEqual(snapshot());
    expect(parsed).not.toHaveProperty('mfaRequired');
  });

  it('sin sessionId sigue sirviendo (null)', () => {
    const { sessionId: _omit, ...rest } = snapshot();
    expect(parseSessionSnapshot(rest)?.sessionId).toBeNull();
  });

  it.each([
    ['inactividad no entera', { idleTimeoutSeconds: 1800.5 }],
    ['inactividad absurda', { idleTimeoutSeconds: 5 }],
    ['inactividad de más de un día', { idleTimeoutSeconds: 90_000 }],
    ['fecha inválida', { expiresAt: 'mañana' }],
    ['sin serverNow', { serverNow: undefined }],
    ['sessionId que no es texto', { sessionId: 42 }],
  ])('rechaza %s', (_label, patch) => {
    expect(parseSessionSnapshot({ ...snapshot(), ...patch })).toBeNull();
  });

  it('rechaza lo que no es un objeto', () => {
    expect(parseSessionSnapshot(null)).toBeNull();
    expect(parseSessionSnapshot([snapshot()])).toBeNull();
    expect(parseSessionSnapshot('ok')).toBeNull();
  });
});

describe('parsePingResult', () => {
  it('ok con el estado', () => {
    expect(parsePingResult({ ok: true, ...snapshot() })).toEqual({ ok: true, ...snapshot() });
  });

  it('cierre con motivo de la lista blanca', () => {
    expect(parsePingResult({ ok: false, motivo: 'otro-dispositivo' })).toEqual({
      ok: false,
      motivo: 'otro-dispositivo',
    });
  });

  it('un motivo inventado no es un cierre', () => {
    expect(parsePingResult({ ok: false, motivo: 'hackeado' })).toBeNull();
  });

  it('retry es "no se sabe", no un cierre', () => {
    expect(parsePingResult({ ok: false, retry: true })).toEqual({ ok: false, retry: true });
  });

  it('ok sin estado válido no sirve', () => {
    expect(parsePingResult({ ok: true })).toBeNull();
  });
});

describe('clockFromSnapshot: el plazo del SERVIDOR en el reloj del navegador', () => {
  it('sin diferencia de relojes: última actividad del servidor + inactividad', () => {
    const c = clockFromSnapshot(snapshot(), T0, false);
    expect(c.idleDeadlineAt).toBe(T0 + 30 * MIN);
    expect(c.expiresAt).toBe(T0 + 12 * 60 * MIN);
    expect(c.idleTimeoutMs).toBe(30 * MIN);
    expect(c.sessionId).toBe('s-1');
  });

  it('un reloj local corrido 5 min no corre el aviso', () => {
    const localNow = T0 + 5 * MIN;
    const c = clockFromSnapshot(snapshot(), localNow, false);
    expect(c.idleDeadlineAt).toBe(localNow + 30 * MIN);
    expect(c.expiresAt).toBe(localNow + 12 * 60 * MIN);
  });

  it('después de un ping activo, el piso es la hora del servidor menos 60 s aunque la respuesta traiga el valor viejo', () => {
    const stale = snapshot({ lastSeenAt: new Date(T0 - 10 * MIN).toISOString() });
    const passive = clockFromSnapshot(stale, T0, false);
    const active = clockFromSnapshot(stale, T0, true);
    expect(passive.idleDeadlineAt).toBe(T0 + 20 * MIN);
    expect(active.idleDeadlineAt).toBe(T0 - SERVER_TOUCH_GRANULARITY_MS + 30 * MIN);
  });

  it('si el servidor ya tiene una actividad más nueva, se respeta', () => {
    const c = clockFromSnapshot(snapshot(), T0, true);
    expect(c.idleDeadlineAt).toBe(T0 + 30 * MIN);
  });
});

describe('acceptClock: un reloj guardado por una sesión anterior no echa al usuario nuevo', () => {
  const loadedAt = T0;

  it('de la misma sesión: gana el más nuevo', () => {
    const mine = clock({ receivedAt: T0 });
    const other = clock({ receivedAt: T0 + 1000, idleDeadlineAt: T0 + 40 * MIN });
    expect(acceptClock(mine, other, 's-1', loadedAt)).toBe(other);
    expect(acceptClock(other, mine, 's-1', loadedAt)).toBe(other);
  });

  it('de otra sesión: se ignora aunque sea más nuevo', () => {
    const mine = clock();
    const stale = clock({ sessionId: 's-vieja', receivedAt: T0 + 1000, expiresAt: T0 - 1 });
    expect(acceptClock(mine, stale, 's-1', loadedAt)).toBe(mine);
  });

  it('sin saber la sesión propia: sólo uno recibido después de cargar la página', () => {
    const before = clock({ sessionId: null, receivedAt: T0 - 1 });
    const after = clock({ sessionId: null, receivedAt: T0 + 1 });
    expect(acceptClock(null, before, null, loadedAt)).toBeNull();
    expect(acceptClock(null, after, null, loadedAt)).toBe(after);
  });

  it('nada que adoptar', () => {
    expect(acceptClock(clock(), null, 's-1', loadedAt)).toEqual(clock());
  });

  it('isNewerForeignClock: otra sesión, más nueva y de después de cargar → preguntarle al servidor', () => {
    const mine = clock({ receivedAt: T0 + 1000 });
    const rotated = clock({ sessionId: 's-2', receivedAt: T0 + 5000 });
    expect(isNewerForeignClock(mine, rotated, 's-1', loadedAt)).toBe(true);
    expect(isNewerForeignClock(null, rotated, 's-1', loadedAt)).toBe(true);
  });

  it('isNewerForeignClock: la misma sesión, una más vieja o una de antes de cargar, no', () => {
    const mine = clock({ receivedAt: T0 + 5000 });
    expect(isNewerForeignClock(mine, clock({ receivedAt: T0 + 9000 }), 's-1', loadedAt)).toBe(
      false,
    );
    expect(
      isNewerForeignClock(
        mine,
        clock({ sessionId: 's-2', receivedAt: T0 + 1000 }),
        's-1',
        loadedAt,
      ),
    ).toBe(false);
    expect(
      isNewerForeignClock(null, clock({ sessionId: 's-2', receivedAt: T0 - 1 }), 's-1', loadedAt),
    ).toBe(false);
  });

  it('isNewerForeignClock: sin saber cuál es cuál no se compara', () => {
    const other = clock({ sessionId: 's-2', receivedAt: T0 + 5000 });
    expect(isNewerForeignClock(clock(), other, null, loadedAt)).toBe(false);
    expect(
      isNewerForeignClock(
        clock(),
        clock({ sessionId: null, receivedAt: T0 + 5000 }),
        's-1',
        loadedAt,
      ),
    ).toBe(false);
    expect(isNewerForeignClock(clock(), null, 's-1', loadedAt)).toBe(false);
  });

  it('newerClock con uno solo', () => {
    expect(newerClock(null, clock())).toEqual(clock());
    expect(newerClock(clock(), null)).toEqual(clock());
  });
});

describe('parseClock y parseGuardMessage: lo que manda otra pestaña se valida', () => {
  it('reloj válido', () => {
    expect(parseClock(clock())).toEqual(clock());
  });

  it('reloj con números rotos', () => {
    expect(parseClock({ ...clock(), idleDeadlineAt: 'x' })).toBeNull();
    expect(parseClock({ ...clock(), idleTimeoutMs: 0 })).toBeNull();
    expect(parseClock({ ...clock(), sessionId: undefined })).toBeNull();
  });

  it('mensajes conocidos', () => {
    expect(parseGuardMessage({ type: 'activity', at: T0 })).toEqual({ type: 'activity', at: T0 });
    expect(parseGuardMessage({ type: 'clock', clock: clock() })).toEqual({
      type: 'clock',
      clock: clock(),
    });
    expect(parseGuardMessage({ type: 'logout', motivo: 'inactividad', at: T0 })).toEqual({
      type: 'logout',
      motivo: 'inactividad',
      at: T0,
    });
    expect(parseGuardMessage({ type: 'logout', motivo: null, at: T0 })).toEqual({
      type: 'logout',
      motivo: null,
      at: T0,
    });
  });

  it('mensajes inválidos', () => {
    expect(parseGuardMessage({ type: 'logout', motivo: '<script>', at: T0 })).toBeNull();
    expect(parseGuardMessage({ type: 'logout', motivo: 'cerrada' })).toBeNull();
    expect(parseGuardMessage({ type: 'activity', at: 'ayer' })).toBeNull();
    expect(parseGuardMessage({ type: 'otro' })).toBeNull();
    expect(parseGuardMessage('logout')).toBeNull();
  });
});

describe('evaluateGuard', () => {
  it('recién cargado: todo bien, sin ping', () => {
    expect(evaluateGuard(inputs())).toEqual({
      phase: 'active',
      remainingMs: 30 * MIN,
      ping: 'none',
      expiryWarning: false,
    });
  });

  it('al minuto: ping pasivo si no hubo actividad', () => {
    const d = evaluateGuard(inputs({ now: T0 + PING_INTERVAL_MS }));
    expect(d.ping).toBe('passive');
  });

  it('al minuto: ping activo si hubo actividad que el servidor no conoce', () => {
    const d = evaluateGuard(inputs({ now: T0 + PING_INTERVAL_MS, lastActivityAt: T0 + 30_000 }));
    expect(d.ping).toBe('active');
  });

  it('sin política todavía: sólo el ping del minuto', () => {
    expect(evaluateGuard(inputs({ clock: null }))).toEqual({
      phase: 'active',
      remainingMs: null,
      ping: 'none',
      expiryWarning: false,
    });
    expect(evaluateGuard(inputs({ clock: null, now: T0 + PING_INTERVAL_MS })).ping).toBe('passive');
  });

  it('faltan 2 minutos sin actividad: aviso', () => {
    const d = evaluateGuard(inputs({ now: T0 + 28 * MIN }));
    expect(d.phase).toBe('warning');
    expect(d.remainingMs).toBe(IDLE_WARNING_MS);
  });

  it('faltan 2:01: todavía no', () => {
    expect(evaluateGuard(inputs({ now: T0 + 28 * MIN - 1000 })).phase).toBe('active');
  });

  it('venció la inactividad: cerrar', () => {
    const d = evaluateGuard(inputs({ now: T0 + 30 * MIN }));
    expect(d.phase).toBe('idle-expired');
    expect(d.remainingMs).toBe(0);
  });

  it('PC suspendida 2 h: al despertar el primer tick cierra, no avisa', () => {
    expect(evaluateGuard(inputs({ now: T0 + 120 * MIN })).phase).toBe('idle-expired');
  });

  it('actividad que todavía no llegó al servidor corre el plazo proyectado y pide ping urgente', () => {
    const now = T0 + 27 * MIN;
    const d = evaluateGuard(inputs({ now, lastActivityAt: now - 1000, lastPingAt: now - 20_000 }));
    expect(d.phase).toBe('active');
    expect(d.ping).toBe('active');
    expect(d.remainingMs).toBe(now - 1000 + 30 * MIN - SERVER_TOUCH_GRANULARITY_MS - now);
  });

  it('el ping urgente respeta una pausa mínima', () => {
    const now = T0 + 27 * MIN;
    const d = evaluateGuard(inputs({ now, lastActivityAt: now - 1000, lastPingAt: now - 2000 }));
    expect(d.ping).toBe('none');
  });

  it('"Seguir conectado" que no llegó al servidor se reintenta a los pocos segundos, no a los 10', () => {
    const now = T0 + 29 * MIN;
    const base = { now, lastActivityAt: now - 3000, reportedActivityAt: T0 };
    expect(evaluateGuard(inputs({ ...base, lastPingAt: now - STAY_RETRY_GAP_MS })).ping).toBe(
      'none',
    );
    expect(
      evaluateGuard(
        inputs({ ...base, lastPingAt: now - STAY_RETRY_GAP_MS, stayActivityAt: now - 3000 }),
      ).ping,
    ).toBe('active');
    expect(
      evaluateGuard(inputs({ ...base, lastPingAt: now - 1000, stayActivityAt: now - 3000 })).ping,
    ).toBe('none');
  });

  it('el reintento rápido termina cuando el clic llegó o cuando el servidor ya cortó', () => {
    const now = T0 + 29 * MIN;
    const reported = evaluateGuard(
      inputs({
        now,
        lastActivityAt: now - 1000,
        reportedActivityAt: now - 3000,
        stayActivityAt: now - 3000,
        lastPingAt: now - STAY_RETRY_GAP_MS,
      }),
    );
    expect(reported.ping).toBe('none');

    const late = T0 + 30 * MIN + 1000;
    const afterDeadline = evaluateGuard(
      inputs({
        now: late,
        lastActivityAt: late - 10_000,
        stayActivityAt: late - 10_000,
        lastPingAt: late - STAY_RETRY_GAP_MS,
      }),
    );
    expect(afterDeadline.ping).toBe('none');
    expect(
      evaluateGuard(
        inputs({
          now: late,
          lastActivityAt: late - 10_000,
          stayActivityAt: late - 10_000,
          lastPingAt: late - URGENT_PING_GAP_MS,
        }),
      ).ping,
    ).toBe('active');
  });

  it('actividad pendiente lejos del plazo: espera al ping del minuto', () => {
    const now = T0 + 5 * MIN;
    const d = evaluateGuard(inputs({ now, lastActivityAt: now - 1000, lastPingAt: now - 20_000 }));
    expect(d.ping).toBe('none');
  });

  it('actividad vieja pendiente no revive una sesión vencida', () => {
    const d = evaluateGuard(
      inputs({ now: T0 + 31 * MIN, lastActivityAt: T0 + 30_000, reportedActivityAt: T0 }),
    );
    expect(d.phase).toBe('idle-expired');
  });

  it('vencimiento absoluto: aviso 10 min antes y cierre al llegar', () => {
    const c = clock({ expiresAt: T0 + 20 * MIN, idleDeadlineAt: T0 + 60 * MIN });
    expect(
      evaluateGuard(inputs({ clock: c, now: T0 + 20 * MIN - EXPIRY_WARNING_MS - 1 })).expiryWarning,
    ).toBe(false);
    expect(
      evaluateGuard(inputs({ clock: c, now: T0 + 20 * MIN - EXPIRY_WARNING_MS })).expiryWarning,
    ).toBe(true);
    expect(evaluateGuard(inputs({ clock: c, now: T0 + 20 * MIN })).phase).toBe('expired');
  });
});

describe('textos de la cuenta regresiva', () => {
  it('m:ss', () => {
    expect(formatCountdown(120_000)).toBe('2:00');
    expect(formatCountdown(119_000)).toBe('1:59');
    expect(formatCountdown(118_200)).toBe('1:59');
    expect(formatCountdown(5_000)).toBe('0:05');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-3000)).toBe('0:00');
  });

  it('el tramo de 15 s cambia justo en los múltiplos de 15', () => {
    expect(announceBucket(120_000)).toBe(120);
    expect(announceBucket(106_000)).toBe(120);
    expect(announceBucket(105_000)).toBe(105);
    expect(announceBucket(104_000)).toBe(105);
    expect(announceBucket(90_000)).toBe(90);
    expect(announceBucket(1_000)).toBe(15);
    expect(announceBucket(0)).toBe(0);
  });

  it('en ciento veinte segundos cambia 8 veces, no 120', () => {
    const buckets = new Set<number>();
    for (let ms = 120_000; ms > 0; ms -= 1000) buckets.add(announceBucket(ms));
    expect(buckets.size).toBe(8);
  });

  it('anuncio en castellano', () => {
    expect(announceText(120)).toBe('Quedan 2 minutos.');
    expect(announceText(105)).toBe('Quedan 1 minuto y 45 segundos.');
    expect(announceText(60)).toBe('Queda 1 minuto.');
    expect(announceText(15)).toBe('Quedan 15 segundos.');
  });

  it('aviso de vencimiento con la hora local', () => {
    expect(expiryWarningText(Date.parse('2026-09-29T18:40:00Z'), 'UTC')).toBe(
      'Tu sesión vence a las 18:40; guardá tu trabajo.',
    );
    expect(expiryWarningText(Date.parse('2026-09-29T18:40:00Z'), 'America/Bogota')).toBe(
      'Tu sesión vence a las 13:40; guardá tu trabajo.',
    );
  });
});

describe('a dónde se va al terminar', () => {
  it('cierre a mano: sin aviso ni vuelta', () => {
    expect(sessionEndPath(null, '/clientes')).toBe('/api/session/end');
    expect(loginPath(null, '/clientes')).toBe('/login');
  });

  it('con motivo: aviso y vuelta a la pantalla donde estaba', () => {
    expect(sessionEndPath('inactividad', '/reservas?id=7')).toBe(
      '/api/session/end?motivo=inactividad&next=%2Freservas%3Fid%3D7',
    );
    expect(loginPath('otro-dispositivo', '/reservas')).toBe(
      '/login?motivo=otro-dispositivo&next=%2Freservas',
    );
  });

  it('con inactividad, los minutos del tope para que el aviso diga cuántos', () => {
    expect(sessionEndPath('inactividad', '/reservas', 30)).toBe(
      '/api/session/end?motivo=inactividad&minutos=30&next=%2Freservas',
    );
    expect(loginPath('inactividad', null, '45')).toBe('/login?motivo=inactividad&minutos=45');
    // Fuera del rango que admite un nodo, o con otro motivo, no se agregan.
    expect(loginPath('inactividad', null, 1)).toBe('/login?motivo=inactividad');
    expect(loginPath('inactividad', null, 481)).toBe('/login?motivo=inactividad');
    expect(loginPath('inactividad', null, 'x')).toBe('/login?motivo=inactividad');
    expect(loginPath('liberada', null, 30)).toBe('/login?motivo=liberada');
  });

  it('un next externo o el inicio no se agregan', () => {
    expect(sessionEndPath('expirada', '//evil.example')).toBe('/api/session/end?motivo=expirada');
    expect(loginPath('expirada', 'https://evil.example')).toBe('/login?motivo=expirada');
    expect(loginPath('cerrada', '/')).toBe('/login?motivo=cerrada');
    expect(loginPath('cerrada', '/login?motivo=x')).toBe('/login?motivo=cerrada');
  });
});
