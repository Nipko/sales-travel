import { describe, expect, it } from 'vitest';
import { safeNextPath } from '../../lib/safe-next';
import { voseoIn } from '../../lib/voseo';
import {
  INVITATION_MESSAGES,
  invitationDetails,
  invitationHeadline,
  invitationLoginHref,
  invitationTokenFrom,
  invitationViewFor,
  isInvitationReturn,
  joinInvitationFailure,
  parseInvitationPreview,
  type InvitationPreviewData,
} from './invitation-view';

const TOKEN = 'Qm9vbS1lc3RlLWVzLXVuLXRva2VuLWRlLXBydWViYQ';
const NOW = new Date('2026-10-13T12:00:00.000Z');

function preview(over: Partial<InvitationPreviewData> = {}): Record<string, unknown> {
  return {
    valid: true,
    tenantName: 'Viajes Norte',
    role: 'agency_admin',
    inviterName: 'Laura Gómez',
    expiresAt: '2026-10-19T18:00:00.000Z',
    existingAccount: false,
    viewer: 'anonymous',
    ...over,
  };
}

const ok = (data: unknown) => ({ ok: true as const, data });
const fail = (status: number, reason?: string) => ({
  ok: false as const,
  error: { status, message: 'texto del API', ...(reason ? { reason } : {}) },
});

describe('invitationTokenFrom', () => {
  it('el token del enlace, el primero si viene repetido', () => {
    expect(invitationTokenFrom(TOKEN)).toBe(TOKEN);
    expect(invitationTokenFrom([TOKEN, 'otro-token-largo'])).toBe(TOKEN);
  });

  it('nada que no tenga forma de token', () => {
    expect(invitationTokenFrom(undefined)).toBeNull();
    expect(invitationTokenFrom('')).toBeNull();
    expect(invitationTokenFrom('corto')).toBeNull();
    expect(invitationTokenFrom('x'.repeat(513))).toBeNull();
    expect(invitationTokenFrom(`${TOKEN} extra`)).toBeNull();
    expect(invitationTokenFrom(`${TOKEN}\n`)).toBeNull();
  });
});

describe('volver a la invitación después de ingresar', () => {
  it('el login vuelve a esta misma invitación, y safeNextPath lo deja pasar tal cual', () => {
    const href = invitationLoginHref(TOKEN);
    const next = new URL(href, 'http://panel.invalid').searchParams.get('next');

    expect(next).toBe(`/invitacion?token=${TOKEN}`);
    expect(safeNextPath(next)).toBe(next);
    expect(isInvitationReturn(safeNextPath(next))).toBe(true);
  });

  it('un token con caracteres raros no sale de la ruta de la invitación', () => {
    const href = invitationLoginHref('abc&next=//evil.example/#x');
    const next = new URL(href, 'http://panel.invalid').searchParams.get('next');
    expect(safeNextPath(next)).toBe(next);
    expect(new URL(next!, 'http://panel.invalid').pathname).toBe('/invitacion');
  });

  it('el aviso del login sólo para la invitación', () => {
    expect(isInvitationReturn('/')).toBe(false);
    expect(isInvitationReturn('/reservas/9')).toBe(false);
    expect(isInvitationReturn('/invitaciones-falsas')).toBe(false);
  });
});

describe('parseInvitationPreview', () => {
  it('la vista previa válida, con los nombres sin espacios de más', () => {
    expect(parseInvitationPreview(preview({ inviterName: '  Laura  ' }))).toMatchObject({
      tenantName: 'Viajes Norte',
      role: 'agency_admin',
      inviterName: 'Laura',
      existingAccount: false,
      viewer: 'anonymous',
    });
    expect(parseInvitationPreview(preview({ inviterName: null }))?.inviterName).toBeNull();
    expect(parseInvitationPreview({ ...preview(), inviterName: '   ' })?.inviterName).toBeNull();
  });

  it('`valid: false` o una forma inesperada: null', () => {
    expect(parseInvitationPreview({ valid: false })).toBeNull();
    expect(parseInvitationPreview(null)).toBeNull();
    expect(parseInvitationPreview([preview()])).toBeNull();
    expect(parseInvitationPreview({ ...preview(), tenantName: ' ' })).toBeNull();
    expect(parseInvitationPreview({ ...preview(), existingAccount: 'sí' })).toBeNull();
    expect(parseInvitationPreview({ ...preview(), viewer: 'admin' })).toBeNull();
    expect(parseInvitationPreview({ ...preview(), valid: 'true' })).toBeNull();
  });
});

describe('invitationDetails', () => {
  it('"Te invitaron a {nodo} como {rol}", con quién y hasta cuándo', () => {
    const details = invitationDetails(parseInvitationPreview(preview())!, NOW);

    expect(invitationHeadline(details)).toBe('Te invitaron a Viajes Norte como Admin de agencia');
    expect(details.summary).toBe('Te invitó Laura Gómez. La invitación vence en 6 días.');
  });

  it('sin quién o sin vencimiento legible, lo que se sepa', () => {
    const anonymous = parseInvitationPreview(preview({ inviterName: null }))!;
    expect(invitationDetails(anonymous, NOW).summary).toBe('La invitación vence en 6 días.');
    const undated = parseInvitationPreview(preview({ inviterName: null, expiresAt: 'x' }))!;
    expect(invitationDetails(undated, NOW).summary).toBe('Acepta la invitación para empezar.');
  });
});

describe('invitationViewFor: qué pantalla corresponde', () => {
  it('sin cuenta: crearla (y si hay sesión de otra cuenta, avisarlo)', () => {
    expect(invitationViewFor(ok(preview()), TOKEN, NOW)).toMatchObject({
      kind: 'create',
      signedInElsewhere: false,
      details: { tenantName: 'Viajes Norte', roleLabel: 'Admin de agencia' },
    });
    expect(invitationViewFor(ok(preview({ viewer: 'other' })), TOKEN, NOW)).toMatchObject({
      kind: 'create',
      signedInElsewhere: true,
    });
  });

  it('con cuenta y sin sesión: ingresar y volver; nunca pedir una contraseña nueva', () => {
    const view = invitationViewFor(ok(preview({ existingAccount: true })), TOKEN, NOW);
    expect(view).toEqual({
      kind: 'sign-in',
      details: expect.any(Object) as unknown,
      loginHref: invitationLoginHref(TOKEN),
    });
  });

  it('con cuenta y una cookie que el API no aceptó: pasa por borrarla antes del login', () => {
    const view = invitationViewFor(ok(preview({ existingAccount: true })), TOKEN, NOW, {
      sessionCookie: true,
    });
    expect(view.kind).toBe('sign-in');
    const href = (view as { loginHref: string }).loginHref;
    const url = new URL(href, 'http://panel.invalid');
    expect(url.pathname).toBe('/api/session/end');
    expect(url.searchParams.get('motivo')).toBe('expirada');
    expect(url.searchParams.get('next')).toBe(`/invitacion?token=${TOKEN}`);
  });

  it('con la sesión de la cuenta invitada: aceptar; con la de otra: salir de ella', () => {
    expect(
      invitationViewFor(ok(preview({ existingAccount: true, viewer: 'invitee' })), TOKEN, NOW).kind,
    ).toBe('join');
    expect(
      invitationViewFor(ok(preview({ existingAccount: true, viewer: 'other' })), TOKEN, NOW).kind,
    ).toBe('wrong-account');
  });

  it('inválida, vencida, usada o con forma inesperada: la misma pantalla', () => {
    expect(invitationViewFor(ok({ valid: false }), TOKEN, NOW)).toEqual({ kind: 'invalid' });
    expect(invitationViewFor(ok({ hola: 1 }), TOKEN, NOW)).toEqual({ kind: 'invalid' });
    expect(invitationViewFor(fail(400), TOKEN, NOW)).toEqual({ kind: 'invalid' });
  });

  it('sin servidor o con demasiados intentos: no dice que la invitación no vale', () => {
    expect(invitationViewFor(fail(503), TOKEN, NOW)).toEqual({
      kind: 'unavailable',
      message: INVITATION_MESSAGES.unavailable,
    });
    expect(invitationViewFor(fail(429), TOKEN, NOW)).toEqual({
      kind: 'unavailable',
      message: INVITATION_MESSAGES.rateLimited,
    });
  });
});

describe('joinInvitationFailure', () => {
  it('la sesión murió: volver a ingresar con el motivo y de vuelta a la invitación', () => {
    const failure = joinInvitationFailure({ status: 401, reason: 'SESSION_REPLACED' }, TOKEN);
    expect(failure.message).toBe(INVITATION_MESSAGES.sessionEnded);
    const url = new URL(failure.signInHref!, 'http://panel.invalid');
    expect(url.pathname).toBe('/api/session/end');
    expect(url.searchParams.get('motivo')).toBe('otro-dispositivo');
    expect(url.searchParams.get('next')).toBe(`/invitacion?token=${TOKEN}`);
  });

  it('por estado y motivo, nunca por el texto del API', () => {
    expect(
      joinInvitationFailure({ status: 403, reason: 'INVITATION_ACCOUNT_MISMATCH' }, TOKEN),
    ).toEqual({ message: INVITATION_MESSAGES.wrongAccount, switchAccount: true });
    expect(
      joinInvitationFailure({ status: 403, reason: 'MFA_ENROLLMENT_REQUIRED' }, TOKEN),
    ).toEqual({ message: INVITATION_MESSAGES.mfaEnrollment });
    expect(joinInvitationFailure({ status: 409, reason: 'ALREADY_MEMBER' }, TOKEN)).toEqual({
      message: INVITATION_MESSAGES.alreadyMember,
    });
    expect(
      joinInvitationFailure({ status: 400, reason: 'INVITATION_NO_LONGER_VALID' }, TOKEN),
    ).toEqual({ message: INVITATION_MESSAGES.noLongerValid });
    expect(joinInvitationFailure({ status: 400 }, TOKEN)).toEqual({
      message: INVITATION_MESSAGES.usedOrExpired,
    });
    expect(joinInvitationFailure({ status: 429 }, TOKEN)).toEqual({
      message: INVITATION_MESSAGES.rateLimited,
    });
    expect(joinInvitationFailure({ status: 503 }, TOKEN)).toEqual({
      message: INVITATION_MESSAGES.unavailable,
    });
    expect(joinInvitationFailure({ status: 403 }, TOKEN)).toEqual({
      message: INVITATION_MESSAGES.unexpected,
    });
  });

  it('los textos van en tú', () => {
    for (const text of Object.values(INVITATION_MESSAGES)) expect(voseoIn(text)).toEqual([]);
  });
});
