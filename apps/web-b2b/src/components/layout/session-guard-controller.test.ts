import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionGuardController, SessionGuardOptions } from './session-guard-controller';
import {
  ACTIVITY_KEY,
  CLOCK_KEY,
  LOGOUT_KEY,
  PING_KEY,
  REPORTED_KEY,
  type SessionClock,
  type SessionSnapshot,
} from './session-guard-state';

/**
 * El motor de la guardia contra un "servidor" simulado que se comporta como el API: refresca
 * `last_seen_at` sólo con pings activos y si tiene más de 60 s, y corta la sesión inactiva.
 * El navegador es de mentira (window/document/localStorage/BroadcastChannel) y el tiempo, de
 * vitest: así se prueba lo que importa —cuándo avisa, cuándo cierra, qué manda— sin esperar 30 min.
 */

const MIN = 60_000;
const T0 = Date.parse('2026-09-29T15:00:00.000Z');

class FakeStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** Un BroadcastChannel que entrega a las otras instancias del mismo nombre (otras "pestañas"). */
class FakeBroadcastChannel extends EventTarget {
  static instances: FakeBroadcastChannel[] = [];
  constructor(readonly name: string) {
    super();
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(data: unknown): void {
    for (const other of FakeBroadcastChannel.instances) {
      if (other === this || other.name !== this.name) continue;
      const event = new Event('message');
      Object.assign(event, { data: structuredClone(data) });
      other.dispatchEvent(event);
    }
  }
  close(): void {
    FakeBroadcastChannel.instances = FakeBroadcastChannel.instances.filter((c) => c !== this);
  }
}

interface FakeServer {
  /** La sesión de la cookie (es una sola por navegador). */
  sessionId: string;
  lastSeen: number;
  idleSeconds: number;
  expiresAt: number;
  /** Si está, el próximo ping responde 401 con este motivo. */
  endedWith: string | null;
  /**
   * Corta la sesión inactiva al validarla, como el API (`last_seen_at <= now() - idle`). En
   * `false` simula el instante justo antes del corte: responde el estado con el plazo vencido.
   */
  cutsIdle: boolean;
  /** El estado del 2FA que manda `GET /auth/session`, si lo manda. */
  mfa: Pick<SessionSnapshot, 'mfaRequired' | 'mfaEnabled' | 'mfaVerified'> | null;
}

let server: FakeServer;
let storage: FakeStorage;
let replace: ReturnType<typeof vi.fn>;
let win: EventTarget;
let doc: EventTarget & { visibilityState: string };
const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function serverSnapshot(now: number): SessionSnapshot {
  return {
    sessionId: server.sessionId,
    idleTimeoutSeconds: server.idleSeconds,
    lastSeenAt: iso(server.lastSeen),
    expiresAt: iso(server.expiresAt),
    serverNow: iso(now),
    ...(server.mfa ?? {}),
  };
}

/** El cuerpo JSON que mandó la guardia (siempre un string). */
function bodyOf(init: unknown): Record<string, unknown> {
  const raw = (init as RequestInit | undefined)?.body;
  return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function handleFetch(url: string, init: RequestInit = {}): Response {
  const body = bodyOf(init);
  const now = Date.now();
  if (url === '/api/session/ping') {
    if (server.endedWith) return json({ ok: false, motivo: server.endedWith }, 401);
    if (now >= server.expiresAt) return json({ ok: false, motivo: 'expirada' }, 401);
    if (server.cutsIdle && now - server.lastSeen >= server.idleSeconds * 1000) {
      return json({ ok: false, motivo: 'inactividad' }, 401);
    }
    if (body['active'] === true && now - server.lastSeen > MIN) server.lastSeen = now;
    return json({ ok: true, ...serverSnapshot(now) });
  }
  if (url === '/api/session/logout') return json({ ok: true });
  return json({}, 404);
}

/** Los pings enviados, como `{ active }`. */
function pingCalls(): Array<{ active: boolean }> {
  return fetchMock.mock.calls
    .filter(([url]) => url === '/api/session/ping')
    .map(([, init]) => ({
      active: bodyOf(init)['active'] === true,
    }));
}

function logoutCalls(): unknown[] {
  return fetchMock.mock.calls
    .filter(([url]) => url === '/api/session/logout')
    .map(([, init]) => bodyOf(init));
}

async function start(overrides: Partial<SessionGuardOptions> = {}): Promise<{
  controller: SessionGuardController;
  onWarning: ReturnType<typeof vi.fn>;
  onExpiryWarning: ReturnType<typeof vi.fn>;
}> {
  const { startSessionGuard } = await import('./session-guard-controller');
  const onWarning = vi.fn();
  const onExpiryWarning = vi.fn();
  const controller = startSessionGuard({
    initial: serverSnapshot(Date.now()),
    onWarning,
    onExpiryWarning,
    ...overrides,
  });
  return { controller, onWarning, onExpiryWarning };
}

function lastWarning(onWarning: ReturnType<typeof vi.fn>): unknown {
  return onWarning.mock.calls.at(-1)?.[0];
}

function press(): void {
  win.dispatchEvent(new Event('keydown'));
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ now: T0 });
  server = {
    sessionId: 's-1',
    lastSeen: T0,
    idleSeconds: 1800,
    expiresAt: T0 + 12 * 60 * MIN,
    endedWith: null,
    cutsIdle: true,
    mfa: null,
  };
  storage = new FakeStorage();
  replace = vi.fn();
  win = Object.assign(new EventTarget(), {
    localStorage: storage,
    location: { pathname: '/reservas', search: '?id=7', replace },
    setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => globalThis.clearInterval(id),
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout> | undefined) => globalThis.clearTimeout(id),
  });
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  FakeBroadcastChannel.instances = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: RequestInit) =>
    Promise.resolve(handleFetch(url, init)),
  );
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('inactividad', () => {
  it('sin actividad: pings pasivos, aviso a los 28 min y a los 30 sale con lo que confirma el servidor', async () => {
    const { onWarning } = await start();

    await vi.advanceTimersByTimeAsync(28 * MIN - 1000);
    expect(lastWarning(onWarning)).toBeNull();
    // Un ping por minuto, y ninguno "activo": una pestaña abandonada no se mantiene viva sola.
    expect(pingCalls().length).toBeGreaterThanOrEqual(26);
    expect(pingCalls().every((c) => !c.active)).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(lastWarning(onWarning)).toBe(2 * MIN);

    await vi.advanceTimersByTimeAsync(2 * MIN);
    // El ping de confirmación (pasivo) encuentra la sesión ya cortada por el servidor con
    // `idle_timeout`: no hace falta revocarla de nuevo.
    expect(pingCalls().at(-1)).toEqual({ active: false });
    expect(logoutCalls()).toEqual([]);
    expect(replace).toHaveBeenCalledWith(
      '/api/session/end?motivo=inactividad&minutos=30&next=%2Freservas%3Fid%3D7',
    );
    const published = JSON.parse(storage.getItem(LOGOUT_KEY) ?? 'null') as { motivo: string };
    expect(published.motivo).toBe('inactividad');
  });

  it('si el servidor todavía no la cortó pero el plazo ya venció, cierra revocando con reason idle', async () => {
    server.cutsIdle = false;
    await start();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(logoutCalls()).toEqual([{ reason: 'idle' }]);
    expect(replace).toHaveBeenCalledWith(
      '/api/session/end?motivo=inactividad&minutos=30&next=%2Freservas%3Fid%3D7',
    );
  });

  it('con el API caído al llegar el plazo, sale igual pero no revoca a ciegas', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(29 * MIN);
    fetchMock.mockImplementation(() => Promise.resolve(json({ ok: false, retry: true }, 503)));
    await vi.advanceTimersByTimeAsync(MIN);
    expect(logoutCalls()).toEqual([]);
    expect(replace).toHaveBeenCalledWith(
      '/api/session/end?motivo=inactividad&minutos=30&next=%2Freservas%3Fid%3D7',
    );
    const published = JSON.parse(storage.getItem(LOGOUT_KEY) ?? 'null') as { motivo: string };
    expect(published.motivo).toBe('inactividad');
  });

  it('la actividad llega al servidor en el próximo ping y corre el plazo', async () => {
    const { onWarning } = await start();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    press();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(pingCalls().some((c) => c.active)).toBe(true);

    await vi.advanceTimersByTimeAsync(27 * MIN);
    expect(lastWarning(onWarning)).toBeNull();
    expect(replace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(typeof lastWarning(onWarning)).toBe('number');
  });

  it('"Seguir conectado" cierra el aviso y manda un ping activo ya', async () => {
    const { controller, onWarning } = await start();
    await vi.advanceTimersByTimeAsync(28 * MIN + 10_000);
    expect(typeof lastWarning(onWarning)).toBe('number');

    const before = pingCalls().length;
    controller.stay();
    expect(lastWarning(onWarning)).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    expect(pingCalls().slice(before)).toEqual([{ active: true }]);

    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(replace).not.toHaveBeenCalled();
    expect(lastWarning(onWarning)).toBeNull();
  });

  it('"Seguir conectado" con el ping del minuto en vuelo: el activo sale apenas vuelve aquél', async () => {
    const { controller, onWarning } = await start();
    await vi.advanceTimersByTimeAsync(28 * MIN + 30_000);
    expect(typeof lastWarning(onWarning)).toBe('number');

    // El ping pasivo de los 29 min tarda en volver.
    let release: () => void = () => {};
    fetchMock.mockImplementationOnce(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          release = () => resolve(handleFetch(url, init));
        }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const before = pingCalls().length;
    expect(pingCalls().at(-1)).toEqual({ active: false });

    controller.stay();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(pingCalls().slice(before)).toEqual([{ active: true }]);

    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(replace).not.toHaveBeenCalled();
  });

  it('si el ping de "Seguir conectado" no llega (503 puntual), reintenta en segundos', async () => {
    const { controller } = await start();
    await vi.advanceTimersByTimeAsync(28 * MIN + 10_000);

    fetchMock.mockImplementationOnce(() => Promise.resolve(json({ ok: false, retry: true }, 503)));
    const before = pingCalls().length;
    controller.stay();
    await vi.advanceTimersByTimeAsync(3000);
    expect(pingCalls().slice(before)).toEqual([{ active: true }, { active: true }]);

    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(replace).not.toHaveBeenCalled();
  });

  it('con el aviso abierto, una tecla cualquiera no cuenta como "seguir"', async () => {
    const { onWarning } = await start();
    await vi.advanceTimersByTimeAsync(28 * MIN + 10_000);
    press();
    await vi.advanceTimersByTimeAsync(2000);
    expect(typeof lastWarning(onWarning)).toBe('number');
  });

  it('PC suspendida: al despertar pasado el plazo cierra, y la primera tecla no la revive', async () => {
    await start();
    vi.setSystemTime(T0 + 45 * MIN);
    press();
    await vi.advanceTimersByTimeAsync(0);
    // Sólo el ping pasivo que confirma el corte: la tecla no llegó al servidor como actividad.
    expect(pingCalls().some((c) => c.active)).toBe(false);
    expect(logoutCalls()).toEqual([]);
    expect(replace).toHaveBeenCalledWith(
      '/api/session/end?motivo=inactividad&minutos=30&next=%2Freservas%3Fid%3D7',
    );
  });

  it('volver a la pestaña es actividad (si no venció) y consulta ya', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    const before = pingCalls().length;
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(pingCalls().slice(before)[0]).toEqual({ active: true });
  });
});

describe('cierres que vienen de afuera', () => {
  it('el servidor dice que la sesión se abrió en otro dispositivo: sale con ese motivo', async () => {
    await start();
    server.endedWith = 'otro-dispositivo';
    await vi.advanceTimersByTimeAsync(MIN);
    expect(replace).toHaveBeenCalledWith(
      '/api/session/end?motivo=otro-dispositivo&next=%2Freservas%3Fid%3D7',
    );
    expect(logoutCalls()).toEqual([]);
  });

  it('"cerrada" se confirma una vez: si en ese rato llegó la cookie nueva (cambio de contraseña), sigue', async () => {
    await start();
    // El ping salió con el token viejo, entre la revocación y la cookie nueva.
    server.endedWith = 'cerrada';
    await vi.advanceTimersByTimeAsync(MIN);
    expect(replace).not.toHaveBeenCalled();
    const before = pingCalls().length;

    // Llega la cookie de la sesión nueva.
    server.endedWith = null;
    server.sessionId = 's-2';
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pingCalls().length).toBe(before + 1);
    expect(replace).not.toHaveBeenCalled();
    expect(storage.getItem(LOGOUT_KEY)).toBeNull();

    // Sigue con la sesión nueva, con sus pings de siempre.
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(replace).not.toHaveBeenCalled();
    expect(pingCalls().length).toBeGreaterThan(before + 1);
  });

  it('"cerrada" confirmado: sale con ese motivo', async () => {
    await start();
    server.endedWith = 'cerrada';
    await vi.advanceTimersByTimeAsync(MIN);
    expect(replace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(replace).toHaveBeenCalledWith(
      '/api/session/end?motivo=cerrada&next=%2Freservas%3Fid%3D7',
    );
  });

  it('un fetch del panel con 401 hace preguntar ya: el puesto liberado se ve sin esperar al minuto', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(10_000);
    server.endedWith = 'liberada';
    const before = pingCalls().length;

    const { requestSessionCheck } = await import('../../lib/session-check');
    requestSessionCheck();
    await vi.advanceTimersByTimeAsync(0);

    expect(pingCalls().length).toBe(before + 1);
    expect(replace).toHaveBeenCalledWith(
      '/api/session/end?motivo=liberada&next=%2Freservas%3Fid%3D7',
    );
  });

  it('un API caído no es un cierre', async () => {
    await start();
    fetchMock.mockImplementation(() => Promise.resolve(json({ ok: false, retry: true }, 503)));
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(replace).not.toHaveBeenCalled();
  });

  it('la red caída tampoco', async () => {
    await start();
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(replace).not.toHaveBeenCalled();
  });

  it('otra pestaña cerró sesión (BroadcastChannel): ésta sale también', async () => {
    await start();
    const otherTab = new FakeBroadcastChannel('st-session');
    otherTab.postMessage({ type: 'logout', motivo: null, at: Date.now() });
    expect(replace).toHaveBeenCalledWith('/api/session/end');
  });

  it('sin BroadcastChannel, el evento storage hace de canal', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    await start();
    const event = new Event('storage');
    Object.assign(event, {
      key: LOGOUT_KEY,
      newValue: JSON.stringify({ type: 'logout', motivo: 'liberada', at: Date.now() }),
    });
    win.dispatchEvent(event);
    expect(replace).toHaveBeenCalledWith(
      '/api/session/end?motivo=liberada&next=%2Freservas%3Fid%3D7',
    );
  });

  it('la actividad de otra pestaña cierra el aviso en ésta', async () => {
    const { onWarning } = await start();
    await vi.advanceTimersByTimeAsync(28 * MIN + 10_000);
    expect(typeof lastWarning(onWarning)).toBe('number');
    const otherTab = new FakeBroadcastChannel('st-session');
    otherTab.postMessage({ type: 'activity', at: Date.now() });
    expect(lastWarning(onWarning)).toBeNull();
  });

  it('lo que publica esta pestaña le llega a las otras', async () => {
    const otherTab = new FakeBroadcastChannel('st-session');
    const received: unknown[] = [];
    otherTab.addEventListener('message', (e) => received.push((e as MessageEvent).data));
    await start();
    expect(received.some((m) => (m as { type: string }).type === 'clock')).toBe(true);
    expect(received.some((m) => (m as { type: string }).type === 'activity')).toBe(true);
  });
});

describe('la sesión cambió en otra pestaña (cambio de contraseña, volver a ingresar)', () => {
  function clockOf(sessionId: string, now: number): SessionClock {
    return {
      sessionId,
      idleTimeoutMs: 30 * MIN,
      idleDeadlineAt: now + 30 * MIN,
      expiresAt: T0 + 12 * 60 * MIN,
      receivedAt: now,
    };
  }

  /**
   * La otra pestaña trabaja con la sesión de la cookie: pinguea activo cada 30 s (así ésta nunca
   * pinguea: el ritmo es compartido) y reporta su actividad. Con `publishClock`, además publica su
   * reloj como hace la guardia.
   */
  async function otherTabWorks(minutes: number, publishClock: boolean): Promise<void> {
    const otherTab = new FakeBroadcastChannel('st-session');
    for (let i = 0; i < minutes * 2; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      const now = Date.now();
      server.lastSeen = now;
      storage.setItem(PING_KEY, String(now));
      storage.setItem(ACTIVITY_KEY, String(now));
      storage.setItem(REPORTED_KEY, String(now));
      otherTab.postMessage({ type: 'activity', at: now });
      if (publishClock) {
        storage.setItem(CLOCK_KEY, JSON.stringify(clockOf(server.sessionId, now)));
        otherTab.postMessage({ type: 'clock', clock: clockOf(server.sessionId, now) });
      }
    }
  }

  it('llega el reloj de la sesión nueva: le pregunta al servidor y no cierra con el plazo de la vieja', async () => {
    const { onWarning } = await start();
    // La otra pestaña cambió la contraseña: la cookie ahora es s-2 y s-1 quedó revocada.
    server.sessionId = 's-2';
    await otherTabWorks(40, true);

    expect(logoutCalls()).toEqual([]);
    expect(replace).not.toHaveBeenCalled();
    expect(onWarning.mock.calls.some(([ms]) => typeof ms === 'number')).toBe(false);
  });

  it('aunque no le llegue ningún reloj, confirma con el servidor antes de revocar', async () => {
    const { onWarning } = await start();
    server.sessionId = 's-2';
    await otherTabWorks(40, false);

    // Revocar habría cerrado s-2, la sesión en la que el usuario estaba trabajando.
    expect(logoutCalls()).toEqual([]);
    expect(replace).not.toHaveBeenCalled();
    expect(lastWarning(onWarning)).toBeNull();
  });
});

describe('2FA que pasa a ser obligatorio en plena sesión', () => {
  it('el rol ahora lo exige y no lo tiene: pide recargar una sola vez para mostrar el enrolamiento', async () => {
    const onMfaEnrollmentRequired = vi.fn();
    await start({ onMfaEnrollmentRequired });
    await vi.advanceTimersByTimeAsync(MIN);
    expect(onMfaEnrollmentRequired).not.toHaveBeenCalled();

    server.mfa = { mfaRequired: true, mfaEnabled: false, mfaVerified: false };
    await vi.advanceTimersByTimeAsync(MIN);
    expect(onMfaEnrollmentRequired).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(onMfaEnrollmentRequired).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('con el enrolamiento ya en pantalla no recarga', async () => {
    const onMfaEnrollmentRequired = vi.fn();
    server.mfa = { mfaRequired: true, mfaEnabled: false, mfaVerified: false };
    await start({ onMfaEnrollmentRequired, mfaEnrollmentGate: true });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(onMfaEnrollmentRequired).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('lo tiene pero ESTA sesión no pasó el código: sale para volver a ingresar con él', async () => {
    await start();
    server.mfa = { mfaRequired: true, mfaEnabled: true, mfaVerified: false };
    await vi.advanceTimersByTimeAsync(MIN);
    expect(replace).toHaveBeenCalledWith(
      '/api/session/end?motivo=cerrada&next=%2Freservas%3Fid%3D7',
    );
  });

  it('sin el dato (API vieja) no hace nada', async () => {
    const onMfaEnrollmentRequired = vi.fn();
    await start({ onMfaEnrollmentRequired });
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(onMfaEnrollmentRequired).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('vencimiento absoluto', () => {
  it('avisa una vez 10 min antes y al llegar termina con motivo expirada', async () => {
    server.idleSeconds = 8 * 60 * 60;
    server.expiresAt = T0 + 15 * MIN;
    const { onExpiryWarning } = await start();

    await vi.advanceTimersByTimeAsync(5 * MIN - 1000);
    expect(onExpiryWarning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onExpiryWarning).toHaveBeenCalledTimes(1);
    expect(onExpiryWarning).toHaveBeenCalledWith(T0 + 15 * MIN);

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(onExpiryWarning).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(replace).toHaveBeenCalledWith(
      '/api/session/end?motivo=expirada&next=%2Freservas%3Fid%3D7',
    );
  });
});

describe('estado que dejó una sesión anterior', () => {
  const staleClock = {
    sessionId: 's-vieja',
    idleTimeoutMs: 30 * MIN,
    idleDeadlineAt: T0 - 60 * MIN,
    expiresAt: T0 - 30 * MIN,
    receivedAt: T0 - 90 * MIN,
  };

  it('un reloj vencido de otra sesión no echa al que acaba de ingresar', async () => {
    storage.setItem(CLOCK_KEY, JSON.stringify(staleClock));
    await start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(replace).not.toHaveBeenCalled();
  });

  it('tampoco sin el estado del layout: pregunta al servidor antes de decidir', async () => {
    storage.setItem(CLOCK_KEY, JSON.stringify({ ...staleClock, sessionId: null }));
    await start({ initial: null });
    await vi.advanceTimersByTimeAsync(5000);
    expect(replace).not.toHaveBeenCalled();
    expect(pingCalls()[0]).toEqual({ active: true });
  });
});

describe('stop', () => {
  it('deja de escuchar y de consultar', async () => {
    const { controller } = await start();
    controller.stop();
    const before = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(40 * MIN);
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(replace).not.toHaveBeenCalled();
  });
});
