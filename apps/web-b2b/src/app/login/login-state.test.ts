import { describe, expect, it } from 'vitest';
import type { ApiResponse } from '../../lib/api';
import {
  LOGIN_MESSAGES,
  afterLogin,
  afterMfa,
  afterRelease,
  classifyAuthResponse,
  initialLoginState,
  mfaInvalidMessage,
  nextAttempt,
  normalizeRecoveryCode,
  normalizeTotpCode,
  parseSeatsFull,
  shownSeats,
  type LoginState,
  type MfaContext,
  type SeatsFull,
} from './login-state';

function json(status: number, body: unknown): ApiResponse {
  return { kind: 'json', status, body };
}

const SEATS_DETAILS = {
  tenantName: 'Viajes Andinos',
  limit: 3,
  inUse: 3,
  release: {
    token: 'release-jwt',
    sessions: [
      {
        sessionId: 's-1',
        name: 'Ana Pérez',
        email: 'ana@andinos.co',
        tenantName: 'Viajes Andinos',
        lastSeenAt: '2026-09-29T12:00:00.000Z',
        device: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0 Safari/537.36',
        ip: '190.0.0.1',
      },
    ],
  },
};

const seatsFull = (details: unknown = SEATS_DETAILS): ApiResponse =>
  json(409, { statusCode: 409, message: 'x', reason: 'SEATS_FULL', details });

describe('classifyAuthResponse: login', () => {
  it('sesión emitida, con vencimiento y equipo de confianza', () => {
    const outcome = classifyAuthResponse(
      'login',
      json(201, {
        token: 'jwt',
        userId: 'u',
        tenantId: 't-1',
        expiresAt: '2026-09-30T00:00:00.000Z',
        trustedDevice: { token: 'td', expiresAt: '2026-10-29T00:00:00.000Z' },
      }),
    );
    expect(outcome).toEqual({
      kind: 'session',
      auth: {
        token: 'jwt',
        tenantId: 't-1',
        expiresAt: '2026-09-30T00:00:00.000Z',
        trustedDevice: { token: 'td', expiresAt: '2026-10-29T00:00:00.000Z' },
      },
    });
  });

  it('una API vieja sin expiresAt ni tenant igual abre sesión', () => {
    expect(classifyAuthResponse('login', json(200, { token: 'jwt', userId: 'u' }))).toEqual({
      kind: 'session',
      auth: { token: 'jwt', tenantId: null, expiresAt: null, trustedDevice: null },
    });
  });

  it('un equipo de confianza a medias no se guarda', () => {
    const outcome = classifyAuthResponse(
      'login',
      json(200, { token: 'jwt', trustedDevice: { token: 'td' } }),
    );
    expect(outcome.kind === 'session' && outcome.auth.trustedDevice).toBeNull();
  });

  it('desafío MFA', () => {
    expect(
      classifyAuthResponse('login', json(201, { mfaRequired: true, mfaToken: 'mfa-jwt' })),
    ).toEqual({ kind: 'mfa', mfaToken: 'mfa-jwt' });
  });

  it('un desafío sin token o un 2xx sin token es inesperado, no una sesión', () => {
    expect(classifyAuthResponse('login', json(201, { mfaRequired: true })).kind).toBe('unexpected');
    expect(classifyAuthResponse('login', json(200, { ok: true })).kind).toBe('unexpected');
    expect(
      classifyAuthResponse('login', { kind: 'not-json', status: 200, message: 'html' }).kind,
    ).toBe('unexpected');
  });

  it('401 y 400 son credenciales inválidas (sin decir cuál de las dos)', () => {
    expect(classifyAuthResponse('login', json(401, { message: 'invalid credentials' }))).toEqual({
      kind: 'invalid-credentials',
    });
    expect(classifyAuthResponse('login', json(400, { message: 'email' })).kind).toBe(
      'invalid-credentials',
    );
  });

  it('429, 5xx, sin conexión y respuestas que no son JSON', () => {
    expect(classifyAuthResponse('login', json(429, {})).kind).toBe('rate-limited');
    expect(classifyAuthResponse('login', json(500, {})).kind).toBe('unavailable');
    expect(
      classifyAuthResponse('login', { kind: 'not-json', status: 502, message: 'bad gateway' }).kind,
    ).toBe('unavailable');
    expect(
      classifyAuthResponse('login', { kind: 'unreachable', status: 503, message: 'x' }).kind,
    ).toBe('unavailable');
    expect(classifyAuthResponse('login', json(403, {})).kind).toBe('unexpected');
  });

  it('cupo lleno', () => {
    const outcome = classifyAuthResponse('login', seatsFull());
    expect(outcome.kind).toBe('seats');
    if (outcome.kind !== 'seats') return;
    expect(outcome.seats.tenantName).toBe('Viajes Andinos');
    expect(outcome.seats.limit).toBe(3);
    expect(outcome.seats.release?.token).toBe('release-jwt');
    expect(outcome.seats.release?.sessions[0]?.name).toBe('Ana Pérez');
  });

  it('un 409 que no es de cupo no se confunde con uno', () => {
    expect(classifyAuthResponse('login', json(409, { reason: 'OTHER' })).kind).toBe('unexpected');
  });
});

describe('classifyAuthResponse: MFA', () => {
  it('código incorrecto con intentos restantes', () => {
    expect(
      classifyAuthResponse(
        'mfa',
        json(401, { reason: 'MFA_CODE_INVALID', details: { attemptsLeft: 3 } }),
      ),
    ).toEqual({ kind: 'mfa-invalid', attemptsLeft: 3 });
  });

  it('código incorrecto sin detalle (API vieja)', () => {
    expect(classifyAuthResponse('mfa', json(401, { message: 'invalid mfa code' }))).toEqual({
      kind: 'mfa-invalid',
      attemptsLeft: null,
    });
  });

  it('desafío vencido', () => {
    expect(classifyAuthResponse('mfa', json(401, { reason: 'MFA_CHALLENGE_EXPIRED' }))).toEqual({
      kind: 'mfa-expired',
    });
  });

  it('cuenta bloqueada durante el código: no es un desafío vencido', () => {
    expect(classifyAuthResponse('mfa', json(401, { reason: 'MFA_ACCOUNT_LOCKED' }))).toEqual({
      kind: 'mfa-locked',
    });
  });

  it('el segundo factor también puede chocar con el cupo', () => {
    expect(classifyAuthResponse('mfa', seatsFull()).kind).toBe('seats');
  });

  it('un 2xx con mfaRequired en el paso MFA no reinicia el desafío', () => {
    expect(classifyAuthResponse('mfa', json(200, { mfaRequired: true, mfaToken: 'x' })).kind).toBe(
      'unexpected',
    );
  });
});

describe('classifyAuthResponse: liberar puesto', () => {
  it('permiso vencido o ya usado', () => {
    expect(
      classifyAuthResponse('release', json(401, { reason: 'SEAT_RELEASE_EXPIRED' })).kind,
    ).toBe('release-invalid');
    expect(classifyAuthResponse('release', json(400, {})).kind).toBe('release-invalid');
  });

  it('ya no administra el nodo', () => {
    expect(
      classifyAuthResponse('release', json(403, { reason: 'SEAT_RELEASE_FORBIDDEN' })).kind,
    ).toBe('release-forbidden');
  });

  it('la sesión elegida ya se había cerrado', () => {
    expect(classifyAuthResponse('release', json(404, { reason: 'SESSION_NOT_FOUND' })).kind).toBe(
      'release-session-gone',
    );
  });

  it('otra vez cupo lleno', () => {
    expect(classifyAuthResponse('release', seatsFull()).kind).toBe('seats');
  });
});

describe('parseSeatsFull', () => {
  it('sin release: sólo el aviso', () => {
    const seats = parseSeatsFull({ tenantName: 'Norte', limit: 1, inUse: 1 });
    expect(seats).toEqual({ tenantName: 'Norte', limit: 1, inUse: 1, release: null });
  });

  it('detalles rotos: igual hay pantalla de cupo lleno, sin números inventados', () => {
    expect(parseSeatsFull(undefined)).toEqual({
      tenantName: null,
      limit: null,
      inUse: null,
      release: null,
    });
    expect(parseSeatsFull({ tenantName: '', limit: -2, inUse: 'x' })).toEqual({
      tenantName: null,
      limit: null,
      inUse: null,
      release: null,
    });
  });

  it('descarta sesiones sin id y completa con null lo que falte', () => {
    const seats = parseSeatsFull({
      tenantName: 'Norte',
      limit: 2,
      inUse: 2,
      release: { token: 't', sessions: [{ name: 'Sin id' }, { sessionId: 's-2' }, 'basura'] },
    });
    expect(seats.release?.sessions).toEqual([
      {
        sessionId: 's-2',
        name: null,
        email: null,
        tenantName: null,
        lastSeenAt: null,
        device: null,
        ip: null,
      },
    ]);
  });

  it('un release sin token no habilita liberar', () => {
    expect(parseSeatsFull({ ...SEATS_DETAILS, release: { sessions: [] } }).release).toBeNull();
  });
});

describe('afterLogin', () => {
  const base = { attempt: 2, email: 'ana@andinos.co' };

  it('al pedir el código, "recordar este equipo" arranca marcado y en modo app', () => {
    expect(afterLogin({ kind: 'mfa', mfaToken: 'm' }, base)).toEqual({
      step: 'mfa',
      attempt: 2,
      email: 'ana@andinos.co',
      mfaToken: 'm',
      rememberDevice: true,
      mode: 'totp',
    });
  });

  it('un error conserva el email', () => {
    const state = afterLogin({ kind: 'invalid-credentials' }, base);
    expect(state).toEqual({
      step: 'credentials',
      attempt: 2,
      email: 'ana@andinos.co',
      error: { kind: 'invalid', message: LOGIN_MESSAGES.invalid },
    });
  });

  it('nunca muestra texto de la API: cada caso tiene su mensaje', () => {
    expect(afterLogin({ kind: 'rate-limited' }, base)).toMatchObject({
      error: { kind: 'rate-limited', message: LOGIN_MESSAGES.rateLimited },
    });
    expect(afterLogin({ kind: 'unavailable' }, base)).toMatchObject({
      error: { kind: 'unavailable', message: LOGIN_MESSAGES.unavailable },
    });
    expect(afterLogin({ kind: 'mfa-expired' }, base)).toMatchObject({
      error: { kind: 'unexpected', message: LOGIN_MESSAGES.unexpected },
    });
  });

  it('cupo lleno va al paso de puestos, con cuándo llegó la lista', () => {
    const seats = parseSeatsFull(SEATS_DETAILS);
    expect(afterLogin({ kind: 'seats', seats }, base, 1_000)).toEqual({
      step: 'seats',
      ...base,
      seats,
      listedAt: 1_000,
    });
  });
});

describe('afterMfa', () => {
  const ctx: MfaContext = {
    attempt: 3,
    email: 'ana@andinos.co',
    mfaToken: 'm',
    rememberDevice: false,
    mode: 'totp',
  };

  it('código incorrecto: se queda, con los intentos que quedan y lo que eligió', () => {
    expect(afterMfa({ kind: 'mfa-invalid', attemptsLeft: 2 }, ctx)).toEqual({
      step: 'mfa',
      ...ctx,
      error: 'El código no es correcto. Te quedan 2 intentos.',
    });
  });

  // Cada código fallido suma al bloqueo de la cuenta: agotar el desafío es quedar bloqueado. Decir
  // "venció, ingresá la contraseña" hacía que la contraseña correcta pareciera incorrecta 15 min.
  it('sin intentos, vuelve a la contraseña avisando del bloqueo (no hay bucle)', () => {
    expect(afterMfa({ kind: 'mfa-invalid', attemptsLeft: 0 }, ctx)).toEqual({
      step: 'credentials',
      attempt: 3,
      email: 'ana@andinos.co',
      notice: LOGIN_MESSAGES.mfaLocked,
      offerPasswordReset: true,
    });
  });

  it('cuenta bloqueada: aviso del bloqueo con la salida de restablecer la contraseña', () => {
    const state = afterMfa({ kind: 'mfa-locked' }, ctx);
    expect(state).toEqual({
      step: 'credentials',
      attempt: 3,
      email: 'ana@andinos.co',
      notice: LOGIN_MESSAGES.mfaLocked,
      offerPasswordReset: true,
    });
    expect(LOGIN_MESSAGES.mfaLocked).toContain('bloqueamos la cuenta por 15 minutos');
    expect(LOGIN_MESSAGES.mfaLocked).not.toContain('venció');
  });

  it('desafío vencido: vuelve a la contraseña con aviso, sin ofrecer restablecerla', () => {
    expect(afterMfa({ kind: 'mfa-expired' }, ctx)).toEqual({
      step: 'credentials',
      attempt: 3,
      email: 'ana@andinos.co',
      notice: LOGIN_MESSAGES.mfaExpired,
    });
  });

  it('429 y errores del servidor se quedan en el código, con el desafío vivo', () => {
    expect(afterMfa({ kind: 'rate-limited' }, ctx)).toMatchObject({
      step: 'mfa',
      mfaToken: 'm',
      error: LOGIN_MESSAGES.rateLimited,
    });
    expect(afterMfa({ kind: 'unavailable' }, { ...ctx, mode: 'recovery' })).toMatchObject({
      step: 'mfa',
      mode: 'recovery',
      error: LOGIN_MESSAGES.unavailable,
    });
  });

  it('cupo lleno después del código', () => {
    const seats = parseSeatsFull(SEATS_DETAILS);
    expect(afterMfa({ kind: 'seats', seats }, ctx, 2_000)).toEqual({
      step: 'seats',
      attempt: 3,
      email: 'ana@andinos.co',
      seats,
      listedAt: 2_000,
    });
  });
});

describe('afterRelease', () => {
  const seats: SeatsFull = parseSeatsFull(SEATS_DETAILS);
  const ctx = { attempt: 4, email: 'ana@andinos.co', seats, listedAt: 1_000 };

  it('permiso vencido: vuelve a la contraseña', () => {
    expect(afterRelease({ kind: 'release-invalid' }, ctx)).toEqual({
      step: 'credentials',
      attempt: 4,
      email: 'ana@andinos.co',
      notice: LOGIN_MESSAGES.releaseExpired,
    });
  });

  it('la sesión ya se había cerrado: vuelve a la contraseña, puede haber lugar', () => {
    expect(afterRelease({ kind: 'release-session-gone' }, ctx)).toMatchObject({
      step: 'credentials',
      notice: LOGIN_MESSAGES.releaseSessionGone,
    });
  });

  it('ya no administra el nodo: se queda sin la opción de liberar', () => {
    const state = afterRelease({ kind: 'release-forbidden' }, ctx);
    expect(state).toMatchObject({ step: 'seats', error: LOGIN_MESSAGES.releaseForbidden });
    expect(state.step === 'seats' && state.seats.release).toBeNull();
  });

  // "Activo hace X" se mide contra cuándo llegó la lista: con la lista nueva medida contra la vieja,
  // quien estuvo activo en el medio salía "Activo ahora" y el resto con menos inactividad.
  it('otra vez lleno: lista nueva, con su propio momento, y aviso', () => {
    const fresh = parseSeatsFull({ ...SEATS_DETAILS, inUse: 3 });
    expect(afterRelease({ kind: 'seats', seats: fresh }, ctx, 241_000)).toEqual({
      step: 'seats',
      attempt: 4,
      email: 'ana@andinos.co',
      seats: fresh,
      listedAt: 241_000,
      notice: LOGIN_MESSAGES.seatsTakenAgain,
    });
  });

  it('un error del servidor conserva la lista para reintentar, medida contra cuando llegó', () => {
    expect(afterRelease({ kind: 'unavailable' }, ctx, 241_000)).toEqual({
      step: 'seats',
      attempt: 4,
      email: 'ana@andinos.co',
      seats,
      listedAt: 1_000,
      error: LOGIN_MESSAGES.unavailable,
    });
    const forbidden = afterRelease({ kind: 'release-forbidden' }, ctx, 241_000);
    expect(forbidden.step === 'seats' && forbidden.listedAt).toBe(1_000);
  });
});

describe('shownSeats', () => {
  const seats: SeatsFull = parseSeatsFull(SEATS_DETAILS);
  const shown = (listedAt: unknown): LoginState =>
    ({ step: 'seats', attempt: 1, email: 'ana@andinos.co', seats, listedAt }) as LoginState;

  it('la lista que se mostraba y cuándo llegó', () => {
    expect(shownSeats(shown(1_000), 5_000)).toEqual({ seats, listedAt: 1_000 });
  });

  it('otro paso no tiene lista', () => {
    expect(shownSeats(initialLoginState('ana@andinos.co'), 5_000)).toBeNull();
  });

  it('un momento que no se puede creer (lo manda el navegador) pasa a ser ahora', () => {
    for (const bad of [undefined, 'x', Number.NaN, Number.POSITIVE_INFINITY, 9_000]) {
      expect(shownSeats(shown(bad), 5_000)?.listedAt).toBe(5_000);
    }
  });
});

describe('códigos', () => {
  it('TOTP: 6 dígitos, se aceptan espacios', () => {
    expect(normalizeTotpCode('123456')).toBe('123456');
    expect(normalizeTotpCode(' 123 456 ')).toBe('123456');
    expect(normalizeTotpCode('12345')).toBeNull();
    expect(normalizeTotpCode('1234567')).toBeNull();
    expect(normalizeTotpCode('12a456')).toBeNull();
    expect(normalizeTotpCode('')).toBeNull();
  });

  it('recuperación: 10 hex, con guion o espacios, en mayúsculas y sin guion', () => {
    expect(normalizeRecoveryCode('a1b2c-3d4e5')).toBe('A1B2C3D4E5');
    expect(normalizeRecoveryCode(' A1B2C 3D4E5 ')).toBe('A1B2C3D4E5');
    expect(normalizeRecoveryCode('A1B2C3D4E5')).toBe('A1B2C3D4E5');
    expect(normalizeRecoveryCode('A1B2C-3D4E')).toBeNull();
    expect(normalizeRecoveryCode('G1B2C-3D4E5')).toBeNull();
    // Un TOTP no tiene forma de código de recuperación.
    expect(normalizeRecoveryCode('123456')).toBeNull();
  });

  it('intentos restantes en singular y plural', () => {
    expect(mfaInvalidMessage(1)).toBe('El código no es correcto. Te queda 1 intento.');
    expect(mfaInvalidMessage(4)).toBe('El código no es correcto. Te quedan 4 intentos.');
    expect(mfaInvalidMessage(null)).toBe('El código no es correcto. Probá de nuevo.');
  });
});

describe('estado inicial e intento', () => {
  it('arranca en las credenciales, con el email si se vuelve atrás', () => {
    expect(initialLoginState()).toEqual({ step: 'credentials', attempt: 0, email: '' });
    expect(initialLoginState('ana@andinos.co', 'aviso')).toEqual({
      step: 'credentials',
      attempt: 0,
      email: 'ana@andinos.co',
      notice: 'aviso',
    });
  });

  it('el intento sale del estado anterior, que manda el navegador: se sanea', () => {
    expect(nextAttempt({ attempt: 2 })).toBe(3);
    expect(nextAttempt({ attempt: -1 })).toBe(1);
    expect(nextAttempt({ attempt: 1.5 })).toBe(1);
    expect(nextAttempt({ attempt: Number.MAX_SAFE_INTEGER + 10 })).toBe(1);
    expect(nextAttempt(null)).toBe(1);
    expect(nextAttempt('x')).toBe(1);
  });
});
