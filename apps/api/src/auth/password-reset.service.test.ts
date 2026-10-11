import { createHash } from 'node:crypto';
import type { CompiledQuery } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import { voseoIn } from '../__fixtures__/voseo.js';
import type { AuditService } from '../audit/audit.service.js';
import type { DatabaseService } from '../database/database.service.js';
import type { MailerService } from '../mail/mailer.service.js';
import { passwordResetEmail } from './password-reset-email.js';
import { PasswordResetService, RESET_TOKEN_TTL_MINUTES } from './password-reset.service.js';
import type { PasswordService } from './password.service.js';
import type { SessionService } from './session.service.js';

/**
 * Los enlaces para restablecer la contraseña, con la base sustituida por lo que devolvería: qué se
 * guarda (sólo el hash), qué se invalida antes y qué sale en la respuesta y en el correo. Contra
 * Postgres, member-support.integration.test.ts y auth-premium.integration.test.ts.
 */
const USER = '88888888-8888-4888-8888-888888888888';
const NODO = '11111111-1111-4111-8111-111111111111';
const LINK = 'https://app.planetour.cloud/restablecer?token=abc_DEF-123';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface Banco {
  user?: { id: string; status: string } | undefined;
  membership?: { tenant_id: string } | undefined;
  mailOk?: boolean;
}

function banco(opts: Banco = {}) {
  const user = 'user' in opts ? opts.user : { id: USER, status: 'active' };
  const membership = 'membership' in opts ? opts.membership : { tenant_id: NODO };
  const k = scriptedKysely((q: CompiledQuery) => {
    if (q.sql.includes('from "users"')) return user ? [user] : [];
    if (q.sql.includes('from "memberships"')) return membership ? [membership] : [];
    if (q.sql.includes('"password_reset_tokens"')) return [];
    throw new Error(`consulta no prevista: ${q.sql}`);
  });
  const mailer = { sendToTenant: vi.fn(() => Promise.resolve(opts.mailOk ?? true)) };
  const audit = { emit: vi.fn(() => Promise.resolve()) };
  const service = new PasswordResetService(
    { db: k.db } as unknown as DatabaseService,
    {} as PasswordService,
    mailer as unknown as MailerService,
    audit as unknown as AuditService,
    {} as SessionService,
  );
  const inserted = () => {
    const q = k.queries.find((x) => x.sql.startsWith('insert into "password_reset_tokens"'));
    return q?.parameters ?? [];
  };
  return { service, k, mailer, audit, inserted };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('issueToken', () => {
  it('guarda sólo el hash del token, con 60 minutos de vida', async () => {
    const { service, k, inserted } = banco();
    const before = Date.now();

    const { token, expiresAt } = await service.issueToken(k.db, USER, {
      invalidatePrevious: false,
    });

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inserted()).toContain(USER);
    expect(inserted()).toContain(sha256(token));
    expect(inserted()).not.toContain(token);
    const ttl = expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(RESET_TOKEN_TTL_MINUTES * 60_000);
    expect(ttl).toBeLessThan(RESET_TOKEN_TTL_MINUTES * 60_000 + 5_000);
    // Sin invalidar: los enlaces anteriores quedan como estaban.
    expect(k.indexOf('update "password_reset_tokens"')).toBe(-1);
  });

  it('con invalidatePrevious da por usados los pendientes del usuario ANTES de emitir el nuevo', async () => {
    const { service, k } = banco();

    await service.issueToken(k.db, USER, { invalidatePrevious: true });

    const invalidate = k.indexOf('update "password_reset_tokens"');
    const insert = k.indexOf('insert into "password_reset_tokens"');
    expect(invalidate).toBeGreaterThanOrEqual(0);
    expect(invalidate).toBeLessThan(insert);
    const q = k.queries[invalidate]!;
    expect(q.sql).toContain('"used_at" = $1');
    expect(q.sql).toContain('"user_id" = $2');
    expect(q.sql).toContain('"used_at" is null');
    expect(q.parameters[1]).toBe(USER);
  });

  it('dos enlaces seguidos nunca comparten token', async () => {
    const { service, k } = banco();
    const a = await service.issueToken(k.db, USER, { invalidatePrevious: true });
    const b = await service.issueToken(k.db, USER, { invalidatePrevious: true });
    expect(a.token).not.toBe(b.token);
  });
});

describe('resetLink y sendResetEmail', () => {
  it('el enlace va a /restablecer del panel, con el token codificado', () => {
    vi.stubEnv('APP_WEB_URL', 'https://panel.example');
    const { service } = banco();
    expect(service.resetLink('a+b/c')).toBe('https://panel.example/restablecer?token=a%2Bb%2Fc');
  });

  it('devuelve lo que contestó el correo, por el nodo indicado', async () => {
    const { service, mailer } = banco({ mailOk: false });

    expect(await service.sendResetEmail(NODO, 'ana@agencia.co', LINK, 'admin', 'Viajes Sur')).toBe(
      false,
    );
    expect(mailer.sendToTenant).toHaveBeenCalledWith(
      NODO,
      expect.objectContaining({
        to: 'ana@agencia.co',
        subject: 'Restablece tu contraseña · PlaneTour',
        text: expect.stringContaining(
          'Un administrador de Viajes Sur te envió este enlace',
        ) as unknown,
      }),
    );
  });
});

describe('request: "Olvidé mi contraseña" no enumera cuentas', () => {
  it('un email desconocido responde {sent:true} sin emitir enlace ni correo', async () => {
    const { service, k, mailer, audit } = banco({ user: undefined });

    expect(await service.request('nadie@example.com')).toEqual({ sent: true });
    expect(k.indexOf('password_reset_tokens')).toBe(-1);
    expect(mailer.sendToTenant).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('una cuenta suspendida responde lo mismo, sin enlace', async () => {
    const { service, k, mailer } = banco({ user: { id: USER, status: 'suspended' } });

    expect(await service.request('ana@agencia.co')).toEqual({ sent: true });
    expect(k.indexOf('password_reset_tokens')).toBe(-1);
    expect(mailer.sendToTenant).not.toHaveBeenCalled();
  });

  it('una cuenta activa recibe el enlace por el correo de su nodo; la respuesta no lo trae', async () => {
    vi.stubEnv('APP_WEB_URL', 'https://panel.example');
    const { service, k, mailer, audit, inserted } = banco();

    const res = await service.request('ana@agencia.co');

    expect(res).toEqual({ sent: true });
    expect(JSON.stringify(res)).not.toMatch(/token|restablecer/);
    // No invalida los anteriores: pedir otro no le corta a nadie el enlace que ya recibió.
    expect(k.indexOf('update "password_reset_tokens"')).toBe(-1);

    expect(mailer.sendToTenant).toHaveBeenCalledTimes(1);
    const [tenantId, mail] = mailer.sendToTenant.mock.calls[0] as unknown as [
      string,
      { to: string; text: string; html: string },
    ];
    expect(tenantId).toBe(NODO);
    expect(mail.to).toBe('ana@agencia.co');
    expect(mail.text).toContain('Recibimos un pedido para cambiar tu contraseña');
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.text)![1]!);
    expect(mail.text).toContain('https://panel.example/restablecer?token=');
    // El token del correo es el que se guardó hasheado.
    expect(inserted()).toContain(sha256(token));

    expect(audit.emit).toHaveBeenCalledTimes(1);
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'auth.password_reset.requested', aggregateId: USER }),
    );
  });

  it('sin nodo activo sale por el correo del sistema', async () => {
    const { service, mailer } = banco({ membership: undefined });
    await service.request('ana@agencia.co');
    expect(mailer.sendToTenant).toHaveBeenCalledWith(null, expect.anything());
  });

  it('si el correo no sale, igual responde {sent:true} y el fallo queda auditado', async () => {
    const { service, audit } = banco({ mailOk: false });

    expect(await service.request('ana@agencia.co')).toEqual({ sent: true });
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'auth.password_reset.email_failed',
        payload: { targetUserId: USER, via: 'self' },
      }),
    );
  });
});

describe('correo para restablecer la contraseña', () => {
  const HOSTIL = 'Viajes <a href="https://evil.example/login">Verifica tu cuenta</a>\r\nBcc: x@y.z';

  it('el nombre del nodo sale como texto, no como markup', () => {
    const { html, text, subject } = passwordResetEmail('admin', LINK, 60, HOSTIL);

    expect(html).not.toContain('<a href="https://evil.example');
    expect(html).toContain(
      'Un administrador de Viajes &lt;a href=&quot;https://evil.example/login&quot;&gt;Verifica tu cuenta&lt;/a&gt; Bcc: x@y.z te envió',
    );
    // El único enlace del correo es el de restablecer.
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(`href="${LINK}"`);
    // Ni el asunto ni el texto plano llevan saltos del nombre (inyección de cabeceras).
    expect(subject).toBe('Restablece tu contraseña · PlaneTour');
    expect(text).toContain('Un administrador de Viajes <a href=');
    expect(text).not.toContain('\r');
  });

  it('un enlace con comillas no cierra el atributo', () => {
    const { html } = passwordResetEmail('self', 'https://x.example/?t="><img src=x>', 60);
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://x.example/?t=&quot;&gt;&lt;img src=x&gt;"');
  });

  it('enviado por un admin: de qué nodo viene, que vence y que la actual sigue', () => {
    const { html, text } = passwordResetEmail('admin', LINK, 60, 'Viajes Sur');
    for (const body of [html, text]) {
      expect(body).toContain('Restablece tu contraseña');
      expect(body).toContain(
        'Un administrador de Viajes Sur te envió este enlace para que elijas una contraseña nueva. Vence en 60 minutos.',
      );
      expect(body).toContain('Elegir contraseña nueva');
      expect(body).toContain(
        'Si no lo esperabas, ignora este correo: tu contraseña actual sigue funcionando. Si crees que es un error, avísale a tu administrador.',
      );
    }
  });

  it('sin nombre legible del nodo dice "la plataforma"', () => {
    expect(passwordResetEmail('admin', LINK, 60, ' \u0000 ').text).toContain(
      'Un administrador de la plataforma te envió',
    );
    expect(passwordResetEmail('admin', LINK, 60).text).toContain('de la plataforma');
  });

  it('pedido por la persona: el texto de siempre', () => {
    const { html, text } = passwordResetEmail('self', LINK, 60);
    for (const body of [html, text]) {
      expect(body).toContain(
        'Recibimos un pedido para cambiar tu contraseña. El enlace vence en 60 minutos.',
      );
      expect(body).toContain('Si no pediste esto, ignora este correo: tu contraseña no cambia.');
      expect(body).not.toContain('administrador');
    }
  });

  it('los dos van en tú', () => {
    for (const variant of ['self', 'admin'] as const) {
      const { html, text, subject } = passwordResetEmail(variant, LINK, 60, 'Viajes Sur');
      expect(voseoIn(`${subject}\n${html}\n${text}`)).toEqual([]);
    }
  });
});
