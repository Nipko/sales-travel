import { Logger } from '@nestjs/common';
import type { CompiledQuery, Transaction } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import type { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import type { MailerService, MailMessage } from './mailer.service.js';
import { SecurityNoticeService } from './security-notice.service.js';

const USER = '88888888-8888-4888-8888-888888888888';
const NODO = '11111111-1111-4111-8111-111111111111';
const SU_NODO = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'ana@agencia.co';

interface Banco {
  user?: { email: string; name: string | null } | undefined;
  tenant?: { name: string } | undefined;
  /** Su membership activa más antigua (el nodo de su correo). */
  mailNode?: { tenantId: string; name: string; countryCode?: string } | undefined;
  /** Lo que contesta el correo, o el error con que falla. */
  mail?: boolean | Error;
  /** La base falla en cualquier consulta. */
  dbDown?: boolean;
}

function banco(opts: Banco = {}) {
  const user = 'user' in opts ? opts.user : { email: EMAIL, name: 'Ana' };
  const tenant = 'tenant' in opts ? opts.tenant : { name: 'Agencia Norte' };
  const mailNode =
    'mailNode' in opts ? opts.mailNode : { tenantId: SU_NODO, name: 'Agencia de Ana' };
  const k = scriptedKysely((q: CompiledQuery) => {
    if (opts.dbDown) throw new Error(`la base no responde (${EMAIL})`);
    if (q.sql.startsWith('select "email", "name" from "users"')) return user ? [user] : [];
    if (q.sql.startsWith('select "name" from "tenants"')) return tenant ? [tenant] : [];
    if (q.sql.includes('from "memberships"')) return mailNode ? [mailNode] : [];
    throw new Error(`consulta no prevista: ${q.sql}`);
  });
  const contexts: Array<{ userId?: string }> = [];
  const db = {
    db: k.db,
    withRequestContext: vi.fn(
      <T>(ctx: { userId?: string }, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> => {
        contexts.push(ctx);
        return k.db.transaction().execute(fn);
      },
    ),
  };
  const mailer = {
    sendToTenant: vi.fn(
      (_tenantId: string | null, _msg: MailMessage): Promise<boolean> =>
        opts.mail instanceof Error ? Promise.reject(opts.mail) : Promise.resolve(opts.mail ?? true),
    ),
  };
  const work = new InflightWorkRegistry();
  const service = new SecurityNoticeService(
    db as unknown as DatabaseService,
    mailer as unknown as MailerService,
    work,
  );
  return { service, mailer, work, k, contexts };
}

/** Todo lo que el servicio escribió en el log, en una sola cadena. */
function logged(): string {
  return [warn, error]
    .flatMap((spy) => spy.mock.calls.map((call: unknown[]) => call.join(' ')))
    .join('\n');
}

const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

afterEach(() => {
  warn.mockClear();
  error.mockClear();
});

describe('SecurityNoticeService.send', () => {
  it('desde un nodo: sale por su correo, a la persona, nombrándolo', async () => {
    const { service, mailer, k } = banco();

    expect(await service.send('unlocked', { userId: USER, tenantId: NODO })).toBe(true);

    expect(mailer.sendToTenant).toHaveBeenCalledTimes(1);
    const [tenantId, msg] = mailer.sendToTenant.mock.calls[0]!;
    expect(tenantId).toBe(NODO);
    expect(msg.to).toBe(EMAIL);
    expect(msg.subject).toBe('Desbloqueamos tu cuenta · PlaneTour');
    expect(msg.text).toContain('Hola, Ana:');
    expect(msg.text).toContain('Un administrador de Agencia Norte levantó el bloqueo');
    // La persona y el nodo, por id: nada de buscar por correo.
    expect(k.queries[0]?.parameters).toEqual([USER]);
    expect(k.queries[1]?.sql).toBe('select "name" from "tenants" where "id" = $1');
    expect(k.queries[1]?.parameters).toEqual([NODO]);
    expect(logged()).toBe('');
  });

  it('con el nombre del nodo ya en mano no lo vuelve a leer', async () => {
    const { service, mailer, k } = banco();

    await service.send('role_changed', {
      userId: USER,
      tenantId: NODO,
      nodeName: 'Viajes Sur',
      role: 'vendedor',
    });

    expect(k.indexOf('from "tenants"')).toBe(-1);
    const msg = mailer.sendToTenant.mock.calls[0]![1];
    expect(msg.subject).toBe('Tu rol en Viajes Sur cambió · PlaneTour');
    expect(msg.text).toContain('Ahora eres Vendedor en Viajes Sur.');
  });

  it('un nodo que ya no existe no frena el aviso: dice "la plataforma"', async () => {
    const { service, mailer } = banco({ tenant: undefined });

    expect(await service.send('sessions_revoked', { userId: USER, tenantId: NODO })).toBe(true);
    expect(mailer.sendToTenant.mock.calls[0]![0]).toBe(NODO);
    expect(mailer.sendToTenant.mock.calls[0]![1].text).toContain(
      'Un administrador de la plataforma cerró tus sesiones.',
    );
  });

  it('sin nodo de por medio: sale por el correo de su membership activa más antigua, leída en SU contexto', async () => {
    const { service, mailer, contexts, k } = banco();

    expect(await service.send('password_changed', { userId: USER, tenantId: null })).toBe(true);

    expect(contexts).toEqual([{ userId: USER }]);
    const memberships = k.queries.find((q) => q.sql.includes('from "memberships"'));
    expect(memberships?.sql).toContain('"memberships"."status" = $2');
    expect(memberships?.sql).toContain('order by "memberships"."created_at"');
    expect(memberships?.parameters).toEqual([USER, 'active']);
    const [tenantId, msg] = mailer.sendToTenant.mock.calls[0]!;
    expect(tenantId).toBe(SU_NODO);
    // El nodo del correo no se nombra: no fue un admin de ese nodo.
    expect(msg.text).not.toContain('Agencia de Ana');
  });

  it('un aviso con la hora la dice en la zona del país del nodo de su correo, sin nombrarlo', async () => {
    const { service, mailer, k } = banco({
      mailNode: { tenantId: SU_NODO, name: 'Agencia de Ana', countryCode: 'BR' },
    });

    expect(
      await service.send('mfa_enabled', {
        userId: USER,
        tenantId: null,
        at: new Date('2026-10-13T15:42:00Z'),
      }),
    ).toBe(true);

    expect(k.queries.find((q) => q.sql.includes('from "memberships"'))?.sql).toContain(
      '"tenants"."country_code" as "countryCode"',
    );
    const [tenantId, msg] = mailer.sendToTenant.mock.calls[0]!;
    expect(tenantId).toBe(SU_NODO);
    expect(msg.to).toBe(EMAIL);
    expect(msg.subject).toBe('Activaste la verificación en dos pasos · PlaneTour');
    expect(msg.text).toContain('el 13 de octubre de 2026 a las 12:42 (GMT-3).');
    expect(msg.text).not.toContain('Agencia de Ana');
  });

  it('sin ninguna membership activa: el correo del sistema', async () => {
    const { service, mailer } = banco({ mailNode: undefined });

    expect(await service.send('account_suspended', { userId: USER, tenantId: null })).toBe(true);
    expect(mailer.sendToTenant.mock.calls[0]![0]).toBeNull();
  });

  it('sin nombre, el saludo es "Hola:"', async () => {
    const { service, mailer } = banco({ user: { email: EMAIL, name: null } });

    await service.send('mfa_reset', { userId: USER, tenantId: NODO });
    expect(mailer.sendToTenant.mock.calls[0]![1].text).toContain('\n\nHola:\n\n');
  });

  it('si el correo no sale: false, sin lanzar, y el log dice el tipo y la persona, nunca su correo', async () => {
    const { service } = banco({ mail: false });

    await expect(service.send('mfa_reset', { userId: USER, tenantId: NODO })).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged()).toContain('mfa_reset');
    expect(logged()).toContain(USER);
    expect(logged()).not.toContain(EMAIL);
  });

  it('si el correo o la base fallan con un error que cita el correo: false, y el log no lo repite', async () => {
    for (const b of [
      banco({ mail: new Error(`550 Recipient address rejected: <${EMAIL}>`) }),
      banco({ dbDown: true }),
    ]) {
      await expect(b.service.send('unlocked', { userId: USER, tenantId: NODO })).resolves.toBe(
        false,
      );
    }
    expect(error).toHaveBeenCalledTimes(2);
    expect(logged()).toContain('unlocked');
    expect(logged()).toContain(USER);
    expect(logged()).not.toContain(EMAIL);
  });

  it('una persona que ya no existe: false, sin correo', async () => {
    const { service, mailer } = banco({ user: undefined });

    expect(await service.send('unlocked', { userId: USER, tenantId: NODO })).toBe(false);
    expect(mailer.sendToTenant).not.toHaveBeenCalled();
    expect(logged()).toContain(USER);
  });
});

describe('SecurityNoticeService.notify', () => {
  it('no hace esperar al llamador y queda registrado para el apagado ordenado', async () => {
    const { service, mailer, work } = banco();
    let release!: (sent: boolean) => void;
    mailer.sendToTenant.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    );

    expect(service.notify('unlocked', { userId: USER, tenantId: NODO })).toBeUndefined();
    expect(work.countsByKind()).toEqual({ 'security-notice': 1 });

    await vi.waitFor(() => expect(mailer.sendToTenant).toHaveBeenCalledTimes(1));
    release(true);
    await work.whenIdle();
    expect(work.size).toBe(0);
  });

  it('un fallo nunca llega al llamador ni queda como rechazo sin atender', async () => {
    const { service, mailer, work } = banco({ mail: new Error('SMTP caído') });

    expect(() => service.notify('unlocked', { userId: USER, tenantId: NODO })).not.toThrow();
    await work.whenIdle();
    expect(mailer.sendToTenant).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
