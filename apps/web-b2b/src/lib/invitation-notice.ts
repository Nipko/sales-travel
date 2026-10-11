import { invitationExpiry } from './invitation-expiry';

/**
 * Qué se le dice al admin después de invitar o reenviar desde Equipo. Sin I/O ni reloj propio.
 *
 * El API crea la invitación aunque el correo no salga (no hay correo configurado para el nodo o el
 * envío falló) y lo dice en `emailSent`. Antes el panel mostraba "Invitación enviada" igual, y el
 * admin esperaba un correo que nunca iba a llegar.
 */

/** Lo que devuelven invitar y reenviar: cuándo vence el enlace nuevo y si el correo salió. */
export interface IssuedInvitation {
  readonly expiresAt: string;
  readonly emailSent: boolean;
}

export type InvitationKind = 'invited' | 'resent';

export interface InvitationNotice {
  readonly tone: 'success' | 'warning';
  readonly message: string;
  readonly description?: string;
}

export const INVITE_EMAIL_FAILED =
  'Creamos la invitación, pero no pudimos enviar el correo. Revisa el correo configurado para este nodo y reenvíala.';

export const RESEND_EMAIL_FAILED =
  'Generamos un enlace nuevo, pero no pudimos enviar el correo. Revisa el correo configurado para este nodo y reenvíala.';

/** `{ id, expiresAt, emailSent }` de invitar o reenviar. `undefined` si la forma no es la esperada. */
export function parseIssuedInvitation(value: unknown): IssuedInvitation | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  const expiresAt = r['expiresAt'];
  if (typeof expiresAt !== 'string') return undefined;
  // Sólo un `false` explícito es "no salió": un API anterior, sin el campo, lo mandaba siempre.
  return { expiresAt, emailSent: r['emailSent'] !== false };
}

/**
 * El aviso de una invitación emitida. Si el correo no salió es una advertencia (un éxito a medias):
 * la invitación existe, pero hay que revisar el correo del nodo y reenviarla.
 */
export function invitationNotice(
  kind: InvitationKind,
  email: string,
  issued: IssuedInvitation,
  now: Date,
): InvitationNotice {
  if (!issued.emailSent) {
    return {
      tone: 'warning',
      message: kind === 'invited' ? INVITE_EMAIL_FAILED : RESEND_EMAIL_FAILED,
    };
  }
  if (kind === 'invited') {
    return {
      tone: 'success',
      message: `Invitación enviada a ${email}. Elige su propia contraseña al aceptarla.`,
    };
  }
  const expiry = invitationExpiry(issued.expiresAt, now);
  return {
    tone: 'success',
    message: `Reenviamos la invitación a ${email}.`,
    description: `El enlace anterior ya no sirve. El nuevo ${expiry?.label ?? 'vence en 7 días'}.`,
  };
}

/** El aviso del 409 INVITATION_ALREADY_PENDING, con el correo que se intentó invitar. */
export function pendingInvitationMessage(email: string): string {
  return `Ya hay una invitación pendiente para ${email}.`;
}
