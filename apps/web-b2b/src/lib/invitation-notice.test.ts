import { describe, expect, it } from 'vitest';
import {
  INVITE_EMAIL_FAILED,
  invitationNotice,
  parseIssuedInvitation,
  pendingInvitationMessage,
  RESEND_EMAIL_FAILED,
} from './invitation-notice';
import { voseoIn } from './voseo';

const NOW = new Date('2026-10-11T15:00:00.000Z');
const IN_7_DAYS = '2026-10-18T15:00:00.000Z';

describe('parseIssuedInvitation', () => {
  it('lee el vencimiento y si el correo salió', () => {
    expect(parseIssuedInvitation({ id: 'i', expiresAt: IN_7_DAYS, emailSent: false })).toEqual({
      expiresAt: IN_7_DAYS,
      emailSent: false,
    });
    expect(parseIssuedInvitation({ id: 'i', expiresAt: IN_7_DAYS, emailSent: true })).toEqual({
      expiresAt: IN_7_DAYS,
      emailSent: true,
    });
  });

  it('sólo un false explícito es "no salió" (un API anterior no mandaba el campo)', () => {
    expect(parseIssuedInvitation({ expiresAt: IN_7_DAYS })?.emailSent).toBe(true);
  });

  it('sin vencimiento o con otra forma, no se leyó', () => {
    expect(parseIssuedInvitation({ ok: true })).toBeUndefined();
    expect(parseIssuedInvitation(null)).toBeUndefined();
    expect(parseIssuedInvitation([IN_7_DAYS])).toBeUndefined();
  });
});

describe('invitationNotice', () => {
  it('invitación nueva con el correo enviado: éxito', () => {
    expect(
      invitationNotice(
        'invited',
        'beto@agencia.co',
        { expiresAt: IN_7_DAYS, emailSent: true },
        NOW,
      ),
    ).toEqual({
      tone: 'success',
      message: 'Invitación enviada a beto@agencia.co. Elige su propia contraseña al aceptarla.',
    });
  });

  it('reenvío con el correo enviado: éxito con el vencimiento nuevo', () => {
    expect(
      invitationNotice('resent', 'beto@agencia.co', { expiresAt: IN_7_DAYS, emailSent: true }, NOW),
    ).toEqual({
      tone: 'success',
      message: 'Reenviamos la invitación a beto@agencia.co.',
      description: 'El enlace anterior ya no sirve. El nuevo vence en 7 días.',
    });
    expect(
      invitationNotice('resent', 'beto@agencia.co', { expiresAt: 'x', emailSent: true }, NOW)
        .description,
    ).toBe('El enlace anterior ya no sirve. El nuevo vence en 7 días.');
  });

  it('si el correo no salió es una advertencia, para invitar y para reenviar', () => {
    const issued = { expiresAt: IN_7_DAYS, emailSent: false };
    expect(invitationNotice('invited', 'beto@agencia.co', issued, NOW)).toEqual({
      tone: 'warning',
      message:
        'Creamos la invitación, pero no pudimos enviar el correo. Revisa el correo configurado para este nodo y reenvíala.',
    });
    expect(invitationNotice('resent', 'beto@agencia.co', issued, NOW)).toEqual({
      tone: 'warning',
      message:
        'Generamos un enlace nuevo, pero no pudimos enviar el correo. Revisa el correo configurado para este nodo y reenvíala.',
    });
  });

  it('todo en tú', () => {
    const texts = [
      INVITE_EMAIL_FAILED,
      RESEND_EMAIL_FAILED,
      pendingInvitationMessage('beto@agencia.co'),
      invitationNotice('invited', 'b@a.co', { expiresAt: IN_7_DAYS, emailSent: true }, NOW).message,
    ];
    expect(texts.flatMap(voseoIn)).toEqual([]);
  });
});

describe('pendingInvitationMessage', () => {
  it('dice para quién es la pendiente', () => {
    expect(pendingInvitationMessage('beto@agencia.co')).toBe(
      'Ya hay una invitación pendiente para beto@agencia.co.',
    );
  });
});
