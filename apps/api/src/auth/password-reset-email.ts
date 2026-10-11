import { escapeHtml, plainText } from '../mail/mail-text.js';
import type { MailMessage } from '../mail/mailer.service.js';

/**
 * Quién originó el enlace: la propia persona desde "Olvidé mi contraseña" o un admin desde Equipo.
 * El texto cambia porque quien no lo pidió tiene que saber de dónde salió y qué hacer si no lo
 * esperaba.
 */
export type ResetEmailVariant = 'self' | 'admin';

const SUBJECT = 'Restablece tu contraseña · PlaneTour';
const HEADING = 'Restablece tu contraseña';
const BUTTON = 'Elegir contraseña nueva';

interface ResetEmailCopy {
  readonly body: string;
  readonly footer: string;
}

function copyFor(variant: ResetEmailVariant, ttlMinutes: number, nodeName: string): ResetEmailCopy {
  if (variant === 'admin') {
    return {
      body: `Un administrador de ${nodeName} te envió este enlace para que elijas una contraseña nueva. Vence en ${ttlMinutes} minutos.`,
      footer:
        'Si no lo esperabas, ignora este correo: tu contraseña actual sigue funcionando. Si crees que es un error, avísale a tu administrador.',
    };
  }
  return {
    body: `Recibimos un pedido para cambiar tu contraseña. El enlace vence en ${ttlMinutes} minutos.`,
    footer: 'Si no pediste esto, ignora este correo: tu contraseña no cambia.',
  };
}

/**
 * El correo con el enlace para elegir una contraseña nueva, sin el destinatario.
 *
 * El nombre del nodo lo elige su propio admin: en el HTML va escapado y en el asunto y el texto sin
 * caracteres de control (mail-text.ts). Sin nombre legible se dice "la plataforma", como en la
 * invitación.
 */
export function passwordResetEmail(
  variant: ResetEmailVariant,
  link: string,
  ttlMinutes: number,
  nodeName?: string | null,
): Omit<MailMessage, 'to'> {
  const node = plainText(nodeName ?? '') || 'la plataforma';
  const plain = copyFor(variant, ttlMinutes, node);
  const html = copyFor(variant, ttlMinutes, escapeHtml(node));
  return {
    subject: SUBJECT,
    html: resetEmailHtml(escapeHtml(link), html),
    text: [HEADING, plain.body, `${BUTTON}: ${link}`, plain.footer].join('\n\n'),
  };
}

function resetEmailHtml(href: string, copy: ResetEmailCopy): string {
  return `<!doctype html>
<html lang="es"><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:32px">
        <tr><td>
          <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#18181b">${HEADING}</p>
          <p style="margin:0 0 24px;font-size:14px;line-height:1.5;color:#52525b">
            ${copy.body}
          </p>
          <a href="${href}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px">
            ${BUTTON}
          </a>
          <p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#71717a">
            ${copy.footer}<br>
            <span style="color:#4f46e5;word-break:break-all">${href}</span>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
