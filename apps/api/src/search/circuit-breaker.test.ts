import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { DespegarApiError } from '@sales-travel/despegar-hotels';
import { LatamApiError } from '@sales-travel/latam-ndc';
import { SabreApiError } from '@sales-travel/sabre';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BreakerRejectionError,
  CircuitBreakerService,
  type CallScope,
  type CircuitEffect,
} from './circuit-breaker.service.js';

/** Los mismos números que declara el servicio; si cambian allá, este test debe fallar. */
const FAILURE_THRESHOLD = 5;
const OPEN_MS = 30_000;

const CAÍDO = () => Promise.reject(new Error('proveedor caído'));

/** Rompe el circuito de `code` con los fallos consecutivos que exige el umbral. */
async function abrirCircuito(breaker: CircuitBreakerService, code: string): Promise<void> {
  for (let i = 0; i < FAILURE_THRESHOLD; i++) {
    await expect(breaker.execute(code, CAÍDO)).rejects.toThrow('proveedor caído');
  }
}

describe('CircuitBreakerService', () => {
  let breaker: CircuitBreakerService;
  let envGuardado: string | undefined;

  beforeEach(() => {
    envGuardado = process.env['PROVIDERS_DISABLED'];
    delete process.env['PROVIDERS_DISABLED'];
    // El servicio avisa por log en cada apertura/restablecimiento: sin esto el runner
    // escupe ruido que no distingue un fallo real de un caso de prueba esperado.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    breaker = new CircuitBreakerService();
  });

  afterEach(() => {
    if (envGuardado === undefined) delete process.env['PROVIDERS_DISABLED'];
    else process.env['PROVIDERS_DISABLED'] = envGuardado;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('apertura por fallos consecutivos', () => {
    it('deja pasar y propaga los primeros 4 fallos sin abrir el circuito', async () => {
      for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
        await expect(breaker.execute('prov-a', CAÍDO)).rejects.toThrow('proveedor caído');
      }
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'closed', failures: 4 });
    });

    it(`${FAILURE_THRESHOLD} fallos consecutivos abren el circuito`, async () => {
      await abrirCircuito(breaker, 'prov-a');
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'open', failures: 5 });
    });

    it('con el circuito abierto falla al instante SIN llamar al proveedor', async () => {
      await abrirCircuito(breaker, 'prov-a');

      const run = vi.fn(() => Promise.resolve('ok'));
      await expect(breaker.execute('prov-a', run)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(run).not.toHaveBeenCalled();
    });

    it('un éxito intercalado resetea el contador de fallos', async () => {
      for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
        await expect(breaker.execute('prov-a', CAÍDO)).rejects.toThrow('proveedor caído');
      }
      await expect(breaker.execute('prov-a', () => Promise.resolve('ok'))).resolves.toBe('ok');
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'closed', failures: 0 });
    });

    it('el circuito es POR proveedor: abrir uno no toca al otro', async () => {
      await abrirCircuito(breaker, 'prov-a');

      const run = vi.fn(() => Promise.resolve('ok'));
      await expect(breaker.execute('prov-b', run)).resolves.toBe('ok');
      expect(run).toHaveBeenCalledTimes(1);
      expect(breaker.snapshot()['prov-a']?.state).toBe('open');
      expect(breaker.snapshot()['prov-b']?.state).toBe('closed');
    });
  });

  describe(`half-open a los ${OPEN_MS / 1000} s (reloj falso)`, () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('antes de la ventana sigue rechazando sin llamar al proveedor', async () => {
      await abrirCircuito(breaker, 'prov-a');
      vi.advanceTimersByTime(OPEN_MS - 1);

      const run = vi.fn(() => Promise.resolve('ok'));
      await expect(breaker.execute('prov-a', run)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(run).not.toHaveBeenCalled();
    });

    it('cumplida la ventana deja pasar UNA sonda y, si va bien, cierra el circuito', async () => {
      await abrirCircuito(breaker, 'prov-a');
      vi.advanceTimersByTime(OPEN_MS);

      const sonda = vi.fn(() => Promise.resolve('vivo'));
      await expect(breaker.execute('prov-a', sonda)).resolves.toBe('vivo');
      expect(sonda).toHaveBeenCalledTimes(1);
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'closed', failures: 0 });
    });

    it('si la sonda falla, un solo fallo vuelve a abrir y reinicia la ventana', async () => {
      await abrirCircuito(breaker, 'prov-a');
      vi.advanceTimersByTime(OPEN_MS);

      await expect(breaker.execute('prov-a', CAÍDO)).rejects.toThrow('proveedor caído');
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'open', failures: 6 });

      // La ventana se reinició: justo antes de los 30 s nuevos sigue cerrado al tráfico.
      vi.advanceTimersByTime(OPEN_MS - 1);
      const run = vi.fn(() => Promise.resolve('ok'));
      await expect(breaker.execute('prov-a', run)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe('kill-switch PROVIDERS_DISABLED', () => {
    it('apaga sólo al proveedor nombrado y no afecta a los demás', async () => {
      process.env['PROVIDERS_DISABLED'] = 'prov-a';

      const apagado = vi.fn(() => Promise.resolve('no debería'));
      await expect(breaker.execute('prov-a', apagado)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(apagado).not.toHaveBeenCalled();

      const vivo = vi.fn(() => Promise.resolve('ok'));
      await expect(breaker.execute('prov-b', vivo)).resolves.toBe('ok');
      expect(vivo).toHaveBeenCalledTimes(1);
    });

    it('acepta lista separada por comas con espacios y entradas vacías', async () => {
      process.env['PROVIDERS_DISABLED'] = ' prov-a , ,prov-b ';

      await expect(breaker.execute('prov-a', () => Promise.resolve(1))).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(breaker.execute('prov-b', () => Promise.resolve(1))).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(breaker.execute('prov-c', () => Promise.resolve(1))).resolves.toBe(1);
    });

    it('el kill-switch no cuenta como fallo del circuito (no lo abre)', async () => {
      process.env['PROVIDERS_DISABLED'] = 'prov-a';
      for (let i = 0; i < FAILURE_THRESHOLD + 2; i++) {
        await expect(breaker.execute('prov-a', () => Promise.resolve(1))).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      }

      // El circuito ni siquiera se materializa: se corta antes de tocarlo.
      expect(breaker.snapshot()['prov-a']).toBeUndefined();

      delete process.env['PROVIDERS_DISABLED'];
      await expect(breaker.execute('prov-a', () => Promise.resolve('ok'))).resolves.toBe('ok');
    });

    it('sin la variable definida no apaga nada', async () => {
      await expect(breaker.execute('prov-a', () => Promise.resolve('ok'))).resolves.toBe('ok');
    });
  });

  describe('snapshot', () => {
    it('arranca vacío y sólo lista proveedores ya usados', async () => {
      expect(breaker.snapshot()).toEqual({});
      await expect(breaker.execute('prov-a', () => Promise.resolve('ok'))).resolves.toBe('ok');
      expect(breaker.snapshot()).toEqual({ 'prov-a': { state: 'closed', failures: 0 } });
    });
  });
});

// ─────────────────────────── PR-0.6 ───────────────────────────

/** Un error de ACL con la clasificación en `failure`, como la declara Sabre. */
function fallo(circuit: unknown, kind?: unknown): Error & { failure: unknown } {
  return Object.assign(new Error(`fallo ${String(circuit)}`), { failure: { circuit, kind } });
}

const ok = (): Promise<string> => Promise.resolve('ok');

describe('CircuitBreakerService — efecto según `failure.circuit` (PR-0.6)', () => {
  let breaker: CircuitBreakerService;

  beforeEach(() => {
    vi.stubEnv('PROVIDERS_DISABLED', '');
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    breaker = new CircuitBreakerService();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** `err` puede no ser un `Error` a propósito: el breaker tiene que aguantar lo que le tiren. */
  async function fallar(err: unknown, code = 'prov-a', accountRef?: string): Promise<void> {
    await expect(
      breaker.execute(
        code,
        () => Promise.reject(err as Error),
        accountRef ? { accountRef } : undefined,
      ),
    ).rejects.toBe(err);
  }

  describe('un error sin `failure` cuenta exactamente como hoy', () => {
    it.each([
      [
        'Despegar sin conexión',
        new DespegarApiError(0, 'fetch failed', '/hotels-api/availability'),
      ],
      [
        'Despegar con un 4xx',
        new DespegarApiError(401, 'unauthorized', '/hotels-api/availability'),
      ],
      ['LATAM con un 5xx', new LatamApiError(503, 'Service Unavailable', '/ndc/airshopping')],
      ['un Error cualquiera', new Error('socket hang up')],
      ['algo que ni es un objeto', 'texto suelto'],
    ])('%s: cinco seguidos abren el circuito', async (_caso, err) => {
      for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) await fallar(err);
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'closed', failures: 4 });

      await fallar(err);
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'open', failures: 5 });
    });

    it.each([
      ['`failure` que no es un objeto', Object.assign(new Error('x'), { failure: 'IGNORE' })],
      ['`failure: null`', Object.assign(new Error('x'), { failure: null })],
      ['un efecto que el breaker no conoce', fallo('OPEN_SOMETIMES')],
      ['un efecto en minúsculas', fallo('ignore')],
    ])('%s también cuenta como hoy', async (_caso, err) => {
      for (let i = 0; i < FAILURE_THRESHOLD; i++) await fallar(err);
      expect(breaker.snapshot()['prov-a']?.state).toBe('open');
    });
  });

  describe('IGNORE: el proveedor respondió', () => {
    it('cinco `IGNORE` no abren y la sexta llamada llega al proveedor', async () => {
      for (let i = 0; i < FAILURE_THRESHOLD; i++) await fallar(fallo('IGNORE', 'RATE_UNAVAILABLE'));
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'closed', failures: 0 });

      const run = vi.fn(ok);
      await expect(breaker.execute('prov-a', run)).resolves.toBe('ok');
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('con un SabreApiError real: cinco 404 "sin datos" no abren el circuito', async () => {
      const sinDatos = new SabreApiError(
        404,
        'Response does not contain any data',
        '/v5/offers/shop',
      );
      expect(sinDatos.failure.circuit).toBe('IGNORE');

      for (let i = 0; i < FAILURE_THRESHOLD + 2; i++) await fallar(sinDatos, 'sabre');
      expect(breaker.snapshot()['sabre']).toEqual({ state: 'closed', failures: 0 });
    });

    it('no resetea la racha: 4 caídas + 1 IGNORE + 1 caída abren igual', async () => {
      const caida = fallo('COUNT', 'UPSTREAM');
      for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) await fallar(caida);
      await fallar(fallo('IGNORE', 'CLIENT_BUG'));
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'closed', failures: 4 });

      await fallar(caida);
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'open', failures: 5 });
    });

    it('en half-open no reabre: la siguiente llamada vuelve a ser sonda', async () => {
      vi.useFakeTimers();
      for (let i = 0; i < FAILURE_THRESHOLD; i++) await fallar(fallo('COUNT'));
      vi.advanceTimersByTime(OPEN_MS);

      await fallar(fallo('IGNORE'));
      expect(breaker.snapshot()['prov-a']?.state).toBe('half-open');
      await expect(breaker.execute('prov-a', ok)).resolves.toBe('ok');
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'closed', failures: 0 });
    });
  });

  describe('COUNT y OPEN_NOW', () => {
    it('`COUNT` declarado se comporta como el fallo de siempre', async () => {
      for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) await fallar(fallo('COUNT', 'TRANSPORT'));
      expect(breaker.snapshot()['prov-a']?.state).toBe('closed');
      await fallar(fallo('COUNT', 'TRANSPORT'));
      expect(breaker.snapshot()['prov-a']?.state).toBe('open');
    });

    it('`OPEN_NOW` (un 503 de Sabre) abre al primer fallo, sin esperar al umbral', async () => {
      const caido = new SabreApiError(503, 'Service Unavailable', '/v5/offers/shop');
      expect(caido.failure.circuit).toBe('OPEN_NOW');

      await fallar(caido, 'sabre');
      expect(breaker.snapshot()['sabre']).toEqual({ state: 'open', failures: 1 });

      const run = vi.fn(ok);
      await expect(breaker.execute('sabre', run)).rejects.toBeInstanceOf(BreakerRejectionError);
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe('OPEN_ACCOUNT: circuito por cuenta', () => {
    const CUENTA_A = 'acct-3f9a1c';
    const CUENTA_B = 'acct-77be02';

    it('abre SÓLO esa cuenta: la misma cuenta no sale, otra cuenta y el código siguen', async () => {
      await fallar(fallo('OPEN_ACCOUNT', 'CREDENTIALS_INVALID'), 'prov-a', CUENTA_A);

      const mismaCuenta = vi.fn(ok);
      const err = await breaker
        .execute('prov-a', mismaCuenta, { accountRef: CUENTA_A })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BreakerRejectionError);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err).toMatchObject({ reason: 'account-circuit', providerCode: 'prov-a' });
      expect(mismaCuenta).not.toHaveBeenCalled();

      const otraCuenta = vi.fn(ok);
      await expect(breaker.execute('prov-a', otraCuenta, { accountRef: CUENTA_B })).resolves.toBe(
        'ok',
      );
      const sinCuenta = vi.fn(ok);
      await expect(breaker.execute('prov-a', sinCuenta)).resolves.toBe('ok');
      expect(otraCuenta).toHaveBeenCalledTimes(1);
      expect(sinCuenta).toHaveBeenCalledTimes(1);
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'closed', failures: 0 });
    });

    it('cinco `401` de una agencia no abren el circuito del proveedor (RNF-03)', async () => {
      // Cada uno de otra cuenta, para que ninguno quede frenado por la suspensión del anterior.
      for (let i = 0; i < FAILURE_THRESHOLD; i++) {
        await fallar(fallo('OPEN_ACCOUNT', 'CREDENTIALS_INVALID'), 'prov-a', `acct-${i}`);
      }
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'closed', failures: 0 });
      await expect(breaker.execute('prov-a', ok, { accountRef: CUENTA_B })).resolves.toBe('ok');
    });

    it('la cuenta es por código: la misma huella en otro proveedor no queda suspendida', async () => {
      await fallar(fallo('OPEN_ACCOUNT', 'CREDENTIALS_INVALID'), 'prov-a', CUENTA_A);
      await expect(breaker.execute('prov-b', ok, { accountRef: CUENTA_A })).resolves.toBe('ok');
    });

    it.each([
      ['credencial rechazada', 'CREDENTIALS_INVALID', 5],
      ['sin `kind`', undefined, 5],
      ['un `kind` que no es texto', 402, 5],
      ['un `kind` que no tiene ventana propia', 'toString', 5],
      ['cuenta bloqueada', 'ACCOUNT_BLOCKED', 15],
    ])('%s (kind %s): suspendida %i min y después vuelve a salir', async (_caso, kind, minutos) => {
      vi.useFakeTimers();
      await fallar(fallo('OPEN_ACCOUNT', kind), 'prov-a', CUENTA_A);

      vi.advanceTimersByTime(minutos * 60_000 - 1);
      await expect(breaker.execute('prov-a', ok, { accountRef: CUENTA_A })).rejects.toBeInstanceOf(
        BreakerRejectionError,
      );

      vi.advanceTimersByTime(1);
      const run = vi.fn(ok);
      await expect(breaker.execute('prov-a', run, { accountRef: CUENTA_A })).resolves.toBe('ok');
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('si al volver a salir la sigue rechazando, se suspende otra ventana completa', async () => {
      vi.useFakeTimers();
      const rechazo = fallo('OPEN_ACCOUNT', 'CREDENTIALS_INVALID');
      await fallar(rechazo, 'prov-a', CUENTA_A);
      vi.advanceTimersByTime(5 * 60_000);

      await fallar(rechazo, 'prov-a', CUENTA_A);
      vi.advanceTimersByTime(5 * 60_000 - 1);
      await expect(breaker.execute('prov-a', ok, { accountRef: CUENTA_A })).rejects.toBeInstanceOf(
        BreakerRejectionError,
      );
    });

    it('una suspensión nueva barre las vencidas: la huella de una credencial rotada no queda para siempre', async () => {
      vi.useFakeTimers();
      const rechazo = fallo('OPEN_ACCOUNT', 'CREDENTIALS_INVALID');
      await fallar(rechazo, 'prov-a', CUENTA_A);
      // La agencia rota la credencial: la huella de CUENTA_A no se vuelve a consultar nunca.
      vi.advanceTimersByTime(4 * 60_000);
      await fallar(rechazo, 'prov-a', CUENTA_B);
      vi.advanceTimersByTime(60_000);
      await fallar(rechazo, 'prov-b', CUENTA_A);

      // El mapa es memoria y no comportamiento visible: se mira por dentro a propósito.
      const suspendidas = (breaker as unknown as { suspendedAccounts: Map<string, number> })
        .suspendedAccounts;
      expect([...suspendidas.keys()]).toEqual([`prov-a@${CUENTA_B}`, `prov-b@${CUENTA_A}`]);
    });

    it('sin `accountRef` no hay cuenta que suspender: cuenta como hoy en el circuito del código', async () => {
      for (let i = 0; i < FAILURE_THRESHOLD; i++) {
        await fallar(fallo('OPEN_ACCOUNT', 'CREDENTIALS_INVALID'));
      }
      expect(breaker.snapshot()['prov-a']).toEqual({ state: 'open', failures: 5 });
    });

    it('una caída (`COUNT`) de una llamada con cuenta suma al circuito del código, no a la cuenta', async () => {
      for (let i = 0; i < FAILURE_THRESHOLD; i++) await fallar(fallo('COUNT'), 'prov-a', CUENTA_A);
      expect(breaker.snapshot()['prov-a']?.state).toBe('open');

      // Otra cuenta tampoco sale: el proveedor está caído para todos.
      const err = await breaker
        .execute('prov-a', ok, { accountRef: CUENTA_B })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ reason: 'provider-circuit' });
    });

    it('el snapshot público no lista circuitos de cuenta ni su huella', async () => {
      await fallar(fallo('OPEN_ACCOUNT', 'ACCOUNT_BLOCKED'), 'prov-a', CUENTA_A);

      expect(breaker.snapshot()).toEqual({ 'prov-a': { state: 'closed', failures: 0 } });
      expect(JSON.stringify(breaker.snapshot())).not.toContain(CUENTA_A);
    });

    it('el log de apertura nombra la huella y el `kind`, nunca otra cosa', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await fallar(fallo('OPEN_ACCOUNT', 'ACCOUNT_BLOCKED'), 'prov-a', CUENTA_A);
      expect(warn).toHaveBeenCalledWith(
        `circuito de la cuenta prov-a@${CUENTA_A} ABIERTO por ACCOUNT_BLOCKED durante 15 min`,
      );

      await fallar(fallo('OPEN_ACCOUNT'), 'prov-a', CUENTA_B);
      expect(warn).toHaveBeenLastCalledWith(
        `circuito de la cuenta prov-a@${CUENTA_B} ABIERTO por OPEN_ACCOUNT durante 5 min`,
      );
    });
  });
});

describe('CircuitBreakerService — kill-switch en dos niveles (PR-0.6)', () => {
  let breaker: CircuitBreakerService;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    breaker = new CircuitBreakerService();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function frenada(code: string, scope?: CallScope): Promise<boolean> {
    const run = vi.fn(ok);
    const res = await breaker
      .execute(code, run, scope === undefined ? undefined : { scope })
      .then(() => false)
      .catch((e: unknown) => {
        expect(e).toBeInstanceOf(BreakerRejectionError);
        return true;
      });
    expect(run).toHaveBeenCalledTimes(res ? 0 : 1);
    return res;
  }

  it('`código:ventas` frena las ventas y NO las lecturas ni cancelaciones de post-venta', async () => {
    vi.stubEnv('PROVIDERS_DISABLED', 'prov-a:ventas');

    expect(await frenada('prov-a', 'sales')).toBe(true);
    expect(await frenada('prov-a', 'post-sale')).toBe(false);
  });

  it('una llamada que no declara su alcance cuenta como venta', async () => {
    vi.stubEnv('PROVIDERS_DISABLED', 'prov-a:ventas');
    expect(await frenada('prov-a')).toBe(true);
  });

  it('`código` a secas apaga todo, como antes: también la post-venta', async () => {
    vi.stubEnv('PROVIDERS_DISABLED', 'prov-a');

    expect(await frenada('prov-a', 'sales')).toBe(true);
    expect(await frenada('prov-a', 'post-sale')).toBe(true);
  });

  it.each([
    ['el apagado total gana si el código aparece dos veces', 'prov-a:ventas, prov-a'],
    ['en cualquier orden', 'prov-a,prov-a:ventas'],
    ['un nivel explícito `todo`', 'prov-a:todo'],
    ['un nivel mal escrito apaga todo', 'prov-a:venats'],
    ['un sufijo vacío apaga todo', 'prov-a:'],
    ['un nivel con otro sufijo detrás apaga todo', 'prov-a:ventas:post-venta'],
  ])('%s', async (_caso, env) => {
    vi.stubEnv('PROVIDERS_DISABLED', env);
    expect(await frenada('prov-a', 'post-sale')).toBe(true);
  });

  it('acepta espacios y mayúsculas en el nivel', async () => {
    vi.stubEnv('PROVIDERS_DISABLED', ' prov-a : Ventas ');

    expect(await frenada('prov-a', 'sales')).toBe(true);
    expect(await frenada('prov-a', 'post-sale')).toBe(false);
  });

  it('no toca a otros proveedores', async () => {
    vi.stubEnv('PROVIDERS_DISABLED', 'prov-a:ventas,prov-b');
    expect(await frenada('prov-c', 'sales')).toBe(false);
    expect(await frenada('prov-c', 'post-sale')).toBe(false);
  });

  it('apaga también las cuentas del proveedor, aunque ninguna tenga el circuito abierto', async () => {
    vi.stubEnv('PROVIDERS_DISABLED', 'prov-a');
    const err = await breaker
      .execute('prov-a', ok, { accountRef: 'acct-1', scope: 'post-sale' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'kill-switch' });
  });
});

describe('CircuitBreakerService — el rechazo local es tipado y previo al envío (PR-0.6)', () => {
  let breaker: CircuitBreakerService;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    breaker = new CircuitBreakerService();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('kill-switch: 503 con el mismo mensaje de siempre, `sentToProvider: false`', async () => {
    vi.stubEnv('PROVIDERS_DISABLED', 'prov-a');
    const err = await breaker.execute('prov-a', ok).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err).toMatchObject({
      name: 'BreakerRejectionError',
      providerCode: 'prov-a',
      reason: 'kill-switch',
      sentToProvider: false,
      message: 'El proveedor prov-a está temporalmente deshabilitado.',
    });
    expect((err as BreakerRejectionError).getStatus()).toBe(503);
  });

  it('circuito abierto: 503 con el mismo mensaje de siempre, `sentToProvider: false`', async () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await breaker.execute('prov-a', CAÍDO).catch(() => undefined);
    }
    const err = await breaker.execute('prov-a', ok).catch((e: unknown) => e);

    expect(err).toMatchObject({
      reason: 'provider-circuit',
      sentToProvider: false,
      message: 'prov-a no está respondiendo. Reintentá en unos segundos.',
    });
  });

  it('un error del proveedor que cruza el breaker sale intacto y sin la marca', async () => {
    const delProveedor = new Error('timeout de lectura');
    const err = await breaker
      .execute('prov-a', () => Promise.reject(delProveedor))
      .catch((e: unknown) => e);
    expect(err).toBe(delProveedor);
    expect(err).not.toHaveProperty('sentToProvider');
  });
});

describe('CircuitBreakerService — efecto declarado por el proveedor (`effectOf`, PR-2.1)', () => {
  let breaker: CircuitBreakerService;

  beforeEach(() => {
    vi.stubEnv('PROVIDERS_DISABLED', '');
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    breaker = new CircuitBreakerService();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Un rechazo LOCAL del ACL: sin `failure`, así que por su forma contaría como caída. */
  const local = (): Error => new Error('request rechazada antes del envío');
  const soloLocales = (err: unknown): CircuitEffect | undefined =>
    err instanceof Error && err.message.startsWith('request rechazada') ? 'IGNORE' : undefined;

  it('lo que el proveedor declara `IGNORE` no suma: cinco rechazos locales no abren', async () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await expect(
        breaker.execute('prov-a', () => Promise.reject(local()), { effectOf: soloLocales }),
      ).rejects.toThrow('request rechazada');
    }

    const run = vi.fn(ok);
    await expect(breaker.execute('prov-a', run, { effectOf: soloLocales })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
    expect(breaker.snapshot()['prov-a']).toEqual({ state: 'closed', failures: 0 });
  });

  it('`undefined` = el proveedor no opina y manda la forma del error', async () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await breaker.execute('prov-a', CAÍDO, { effectOf: soloLocales }).catch(() => undefined);
    }
    expect(breaker.snapshot()['prov-a']?.state).toBe('open');
  });

  it('lo declarado gana sobre `failure.circuit`', async () => {
    const siempreIgnora = (): CircuitEffect => 'IGNORE';
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await breaker
        .execute('prov-a', () => Promise.reject(fallo('COUNT')), { effectOf: siempreIgnora })
        .catch(() => undefined);
    }
    expect(breaker.snapshot()['prov-a']).toEqual({ state: 'closed', failures: 0 });
  });

  it('declarar `OPEN_ACCOUNT` suspende la cuenta con la ventana del `kind` del error', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const abreCuenta = (): CircuitEffect => 'OPEN_ACCOUNT';

    await breaker
      .execute('prov-a', () => Promise.reject(fallo('IGNORE', 'ACCOUNT_BLOCKED')), {
        accountRef: 'acct-1',
        effectOf: abreCuenta,
      })
      .catch(() => undefined);

    expect(warn).toHaveBeenLastCalledWith(
      'circuito de la cuenta prov-a@acct-1 ABIERTO por ACCOUNT_BLOCKED durante 15 min',
    );
    const err = await breaker
      .execute('prov-a', ok, { accountRef: 'acct-1' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'account-circuit' });
  });
});
