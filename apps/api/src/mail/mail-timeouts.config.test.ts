import { describe, expect, it } from 'vitest';
import {
  MAIL_DEFAULT_TIMEOUTS,
  MAIL_MAX_TIMEOUT_MS,
  loadMailTimeouts,
} from './mail-timeouts.config.js';

describe('loadMailTimeouts', () => {
  it('sin valores usa 5 s para conectar y saludar, 10 s de silencio y 15 s por envío', () => {
    for (const env of [
      {},
      {
        MAIL_CONNECTION_TIMEOUT_MS: '',
        MAIL_GREETING_TIMEOUT_MS: ' ',
        MAIL_SOCKET_TIMEOUT_MS: '',
        MAIL_SEND_TIMEOUT_MS: '',
      },
    ]) {
      expect(loadMailTimeouts(env)).toEqual({
        timeouts: {
          connectionTimeoutMs: 5_000,
          greetingTimeoutMs: 5_000,
          socketTimeoutMs: 10_000,
          sendTimeoutMs: 15_000,
        },
        invalidReasons: [],
      });
    }
    // Muy por debajo de los 100 s de Cloudflare, aun sumando conexión y saludo.
    const d = MAIL_DEFAULT_TIMEOUTS;
    expect(d.connectionTimeoutMs + d.greetingTimeoutMs).toBeLessThanOrEqual(d.sendTimeoutMs);
    expect(MAIL_MAX_TIMEOUT_MS).toBeLessThan(100_000);
  });

  it('acepta enteros de milisegundos entre 100 y 60000', () => {
    expect(
      loadMailTimeouts({
        MAIL_CONNECTION_TIMEOUT_MS: '100',
        MAIL_GREETING_TIMEOUT_MS: ' 2500 ',
        MAIL_SOCKET_TIMEOUT_MS: '60000',
        MAIL_SEND_TIMEOUT_MS: '12000',
      }),
    ).toEqual({
      timeouts: {
        connectionTimeoutMs: 100,
        greetingTimeoutMs: 2_500,
        socketTimeoutMs: 60_000,
        sendTimeoutMs: 12_000,
      },
      invalidReasons: [],
    });
  });

  it('un valor inválido cae al de por defecto, nombra la variable y no repite el valor', () => {
    // 0 incluido: nodemailer lo toma como "sin valor" y volvería a sus plazos de minutos.
    for (const raw of ['0', '99', '-1', '12.5', '5s', 'abc', '60001', '1e4']) {
      const config = loadMailTimeouts({
        MAIL_SEND_TIMEOUT_MS: raw,
        MAIL_SOCKET_TIMEOUT_MS: '9000',
      });

      expect(config.timeouts).toEqual({ ...MAIL_DEFAULT_TIMEOUTS, socketTimeoutMs: 9_000 });
      // El texto es fijo: nunca lleva lo que vino en el entorno.
      expect(config.invalidReasons).toEqual([
        'MAIL_SEND_TIMEOUT_MS debe ser un entero de milisegundos entre 100 y 60000; se usa 15000',
      ]);
    }
  });

  it('avisa de cada variable inválida por separado', () => {
    const config = loadMailTimeouts({
      MAIL_CONNECTION_TIMEOUT_MS: 'x',
      MAIL_GREETING_TIMEOUT_MS: '0',
    });

    expect(config.timeouts).toEqual(MAIL_DEFAULT_TIMEOUTS);
    expect(config.invalidReasons).toEqual([
      'MAIL_CONNECTION_TIMEOUT_MS debe ser un entero de milisegundos entre 100 y 60000; se usa 5000',
      'MAIL_GREETING_TIMEOUT_MS debe ser un entero de milisegundos entre 100 y 60000; se usa 5000',
    ]);
  });
});
