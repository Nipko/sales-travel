import { describe, expect, it } from 'vitest';
import { specFromAccount, specFromEnv } from './mailer.service.js';

describe('mailer spec resolution (BYO-email)', () => {
  it('builds a transport spec from a complete email account', () => {
    const spec = specFromAccount(
      { host: 'smtp.gmail.com', port: 587, fromEmail: 'ventas@ag.com', fromName: 'Agencia Sur' },
      { user: 'ventas@ag.com', password: 'app-pass' },
    );
    expect(spec).toMatchObject({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      user: 'ventas@ag.com',
      pass: 'app-pass',
    });
    expect(spec?.from).toBe('"Agencia Sur" <ventas@ag.com>');
  });

  it('accepts appPassword as the secret and defaults port 587 + from=user', () => {
    const spec = specFromAccount({ host: 'smtp.x.com' }, { user: 'u@x.com', appPassword: 'p' });
    expect(spec).toMatchObject({ port: 587, secure: false, from: 'u@x.com', pass: 'p' });
  });

  it('infers secure=true for port 465', () => {
    const spec = specFromAccount({ host: 'h', port: 465 }, { user: 'u', password: 'p' });
    expect(spec?.secure).toBe(true);
  });

  it('returns null when the account is incomplete (missing host/user/pass)', () => {
    expect(specFromAccount({ port: 587 }, { user: 'u', password: 'p' })).toBeNull(); // sin host
    expect(specFromAccount({ host: 'h' }, { user: 'u' })).toBeNull(); // sin pass
    expect(specFromAccount({ host: 'h' }, { password: 'p' })).toBeNull(); // sin user
  });

  it('builds the system-default spec from env (and null when unset)', () => {
    expect(specFromEnv({})).toBeNull();
    const spec = specFromEnv({
      MAIL_HOST: 'h',
      MAIL_USER: 'sys@x.com',
      MAIL_PASS: 'p',
      MAIL_PORT: '465',
    });
    expect(spec).toMatchObject({ host: 'h', port: 465, secure: true, from: 'sys@x.com' });
  });
});
