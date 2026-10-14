import { escapeHtml, plainText } from '../mail/mail-text.js';
import type { MailMessage } from '../mail/mailer.service.js';

/**
 * Quién originó el enlace y para qué: la propia persona desde "Olvidé mi contraseña", un admin desde
 * Equipo que se lo envía (la contraseña actual sigue valiendo) o un admin que la obliga a elegir una
 * nueva antes de volver a ingresar (`required`, también el que se reenvía al intentar entrar). El
 * superadmin también la obliga, en bloque, a las cuentas que nacieron con una contraseña que eligió
 * un admin antes del alta por invitación (`legacy`, USR-14): el correo dice por qué, para que no
 * parezca un aviso falso. El texto cambia porque quien no lo pidió tiene que saber de dónde salió y
 * qué hacer.
 */
export type ResetEmailVariant = 'self' | 'admin' | 'required' | 'legacy';

const BUTTON = 'Elegir contraseña nueva';

interface ResetEmailCopy {
  readonly subject: string;
  readonly heading: string;
  readonly body: string;
  readonly footer: string;
}

const RESET_HEADING = 'Restablece tu contraseña';
const REQUIRED_HEADING = 'Elige una contraseña nueva';

function copyFor(variant: ResetEmailVariant, ttlMinutes: number, nodeName: string): ResetEmailCopy {
  if (variant === 'legacy') {
    return {
      subject: `${REQUIRED_HEADING} · PlaneTour`,
      heading: REQUIRED_HEADING,
      body: `Tu cuenta en ${nodeName} se creó con una contraseña que eligió un administrador. Para que sólo tú la conozcas, elige una nueva. Hasta que lo hagas no vas a poder ingresar. El enlace vence en ${ttlMinutes} minutos; si vence, al intentar ingresar te llega otro.`,
      footer: 'Si crees que es un error, avísale a tu administrador.',
    };
  }
  if (variant === 'required') {
    return {
      subject: `${REQUIRED_HEADING} · PlaneTour`,
      heading: REQUIRED_HEADING,
      body: `Un administrador de ${nodeName} te pidió que elijas una contraseña nueva. Hasta que lo hagas no vas a poder ingresar. El enlace vence en ${ttlMinutes} minutos; si vence, al intentar ingresar te llega otro.`,
      footer: 'Si crees que es un error, avísale a tu administrador.',
    };
  }
  if (variant === 'admin') {
    return {
      subject: `${RESET_HEADING} · PlaneTour`,
      heading: RESET_HEADING,
      body: `Un administrador de ${nodeName} te envió este enlace para que elijas una contraseña nueva. Vence en ${ttlMinutes} minutos.`,
      footer:
        'Si no lo esperabas, ignora este correo: tu contraseña actual sigue funcionando. Si crees que es un error, avísale a tu administrador.',
    };
  }
  return {
    subject: `${RESET_HEADING} · PlaneTour`,
    heading: RESET_HEADING,
    body: `Recibimos un pedido para cambiar tu contraseña. El enlace vence en ${ttlMinutes} minutos.`,
    footer: 'Si no pediste esto, ignora este correo: tu contraseña no cambia.',
  };
}

/**
 * El correo con el enlace para elegir una contraseña nueva, sin el destinatario.
 *
 * El nombre del nodo lo elige su propio admin: en el HTML va escapado y en el asunto y el texto sin
 * caracteres de control (mail-text.ts). Sin nombre legible se dice "la plataforma", como en la
 * invitación. El asunto no lleva el nombre: es fijo por variante.
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
    subject: plain.subject,
    html: resetEmailHtml(escapeHtml(link), html),
    text: [plain.heading, plain.body, `${BUTTON}: ${link}`, plain.footer].join('\n\n'),
  };
}

function resetEmailHtml(href: string, copy: ResetEmailCopy): string {
  return `<!doctype html>
<html lang="es"><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:32px">
        <tr><td>
          <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#18181b">${copy.heading}</p>
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
