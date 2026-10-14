import net from 'node:net';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';
import type { MailTimeouts } from './mail-timeouts.config.js';
import { MailerService, deliverMail, type TransportSpec } from './mailer.service.js';

/**
 * Un servidor SMTP colgado no puede tener tomado el flujo que avisa: el envío vuelve `false` dentro
 * del plazo. Servidores TCP locales de verdad, sin dobles de nodemailer.
 */

const RECIPIENT = 'ana.perez@agencia.co';

interface FakeSmtp {
  readonly port: number;
  close(): Promise<void>;
}

/** Acepta la conexión y hace lo que diga `onSocket` (por defecto, nada: nunca saluda). */
async function fakeSmtp(
  onSocket: (socket: net.Socket) => void = () => undefined,
): Promise<FakeSmtp> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Saluda bien y después contesta el EHLO de a una línea de continuación, sin terminar nunca. */
function dripAfterGreeting(socket: net.Socket): void {
  socket.write('220 fake.smtp ESMTP\r\n');
  socket.once('data', () => {
    const drip = setInterval(() => socket.write('250-sigo pensando\r\n'), 50);
    socket.on('close', () => clearInterval(drip));
  });
}

function specFor(port: number): TransportSpec {
  return {
    host: '127.0.0.1',
    port,
    secure: false,
    user: 'u',
    pass: 'p',
    from: 'sys@planetour.test',
  };
}

const message = { to: RECIPIENT, subject: 'Aviso', html: '<p>hola</p>', text: 'hola' };

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await run();
  return { value, ms: performance.now() - start };
}

const servers: FakeSmtp[] = [];
async function server(onSocket?: (socket: net.Socket) => void): Promise<FakeSmtp> {
  const s = await fakeSmtp(onSocket);
  servers.push(s);
  return s;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('deliverMail: plazos acotados', () => {
  it('un servidor que nunca saluda vuelve como plazo vencido en el greetingTimeout', async () => {
    const { port } = await server();
    const timeouts: MailTimeouts = {
      connectionTimeoutMs: 1_000,
      greetingTimeoutMs: 300,
      socketTimeoutMs: 1_000,
      sendTimeoutMs: 3_000,
    };

    const { value, ms } = await timed(() => deliverMail(specFor(port), message, timeouts));

    expect(value).toEqual({ ok: false, reason: 'Greeting never received', timedOut: true });
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(timeouts.sendTimeoutMs);
  });

  it('un servidor que gotea respuestas sin terminar corta en el tope del envío', async () => {
    // Cada 50 ms llega algo: el socketTimeout nunca se dispara y sólo el tope total lo corta.
    const { port } = await server(dripAfterGreeting);
    const timeouts: MailTimeouts = {
      connectionTimeoutMs: 1_000,
      greetingTimeoutMs: 1_000,
      socketTimeoutMs: 1_000,
      sendTimeoutMs: 600,
    };

    const { value, ms } = await timed(() => deliverMail(specFor(port), message, timeouts));

    expect(value).toEqual({ ok: false, reason: 'sin respuesta en 600 ms', timedOut: true });
    expect(ms).toBeGreaterThanOrEqual(550);
    expect(ms).toBeLessThan(1_500);
  });

  it('un rechazo que no es de plazo vuelve como fallo común', async () => {
    const { port } = await server((socket) => socket.end('554 5.7.1 no te atiendo\r\n'));
    const timeouts: MailTimeouts = {
      connectionTimeoutMs: 1_000,
      greetingTimeoutMs: 1_000,
      socketTimeoutMs: 1_000,
      sendTimeoutMs: 3_000,
    };

    const value = await deliverMail(specFor(port), message, timeouts);

    expect(value.ok).toBe(false);
    expect(value.ok === false && value.timedOut).toBe(false);
  });
});

describe('MailerService con un SMTP colgado', () => {
  function mailer(account?: { port: number }): MailerService {
    const creds = {
      resolve: () =>
        account === undefined
          ? Promise.reject(new Error('sin cuenta'))
          : Promise.resolve({
              config: { host: '127.0.0.1', port: account.port },
              credentials: { user: 'ventas@agencia.co', password: 'clave' },
            }),
    } as unknown as ProviderCredentialsService;
    return new MailerService(creds);
  }

  function stubSystemSmtp(port: number): void {
    vi.stubEnv('MAIL_HOST', '127.0.0.1');
    vi.stubEnv('MAIL_PORT', String(port));
    vi.stubEnv('MAIL_USER', 'sys@planetour.test');
    vi.stubEnv('MAIL_PASS', 'p');
    vi.stubEnv('MAIL_SECURE', 'false');
  }

  it('sendToTenant vuelve false dentro del plazo del entorno y avisa sin el destinatario', async () => {
    const { port } = await server();
    stubSystemSmtp(port);
    vi.stubEnv('MAIL_GREETING_TIMEOUT_MS', '300');
    vi.stubEnv('MAIL_SEND_TIMEOUT_MS', '2000');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const { value, ms } = await timed(() => mailer().sendToTenant('t-1', message));

    expect(value).toBe(false);
    expect(ms).toBeLessThan(2_000);
    expect(error).not.toHaveBeenCalled();
    const lines = warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([
      'mail.send.timed_out tenant=t-1 error="Greeting never received" budgetMs=2000',
    ]);
    expect(lines.join('\n')).not.toContain(RECIPIENT);
  });

  it('el tope del envío también vale para la cuenta propia del nodo (BYO-email)', async () => {
    const { port } = await server(dripAfterGreeting);
    vi.stubEnv('MAIL_SEND_TIMEOUT_MS', '500');
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const { value, ms } = await timed(() => mailer({ port }).sendToTenant('t-2', message));

    expect(value).toBe(false);
    expect(ms).toBeLessThan(1_500);
  });

  it('la prueba de correo dice que el servidor no respondió a tiempo', async () => {
    const { port } = await server();
    stubSystemSmtp(port);
    vi.stubEnv('MAIL_GREETING_TIMEOUT_MS', '300');

    const result = await mailer().sendTest('t-1', RECIPIENT);

    expect(result).toEqual({
      sent: false,
      reason:
        'El servidor de correo no respondió a tiempo (Greeting never received). Revisa el servidor, el puerto y si usa SSL.',
    });
  });

  it('un valor del entorno mal escrito avisa y usa el de por defecto', () => {
    vi.stubEnv('MAIL_SOCKET_TIMEOUT_MS', 'diez');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    mailer();

    expect(warn).toHaveBeenCalledWith(
      'MAIL_SOCKET_TIMEOUT_MS debe ser un entero de milisegundos entre 100 y 60000; se usa 10000',
    );
  });

  it('sin transporte no envía y el aviso no lleva el destinatario', async () => {
    for (const key of ['MAIL_HOST', 'MAIL_USER', 'MAIL_PASS']) vi.stubEnv(key, '');
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    expect(await mailer().sendToTenant(null, message)).toBe(false);

    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      'mail.send.skipped tenant=none reason=no_transport subject="Aviso"',
    ]);
  });
});
