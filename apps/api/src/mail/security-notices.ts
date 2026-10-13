import { requiresMfa } from '../auth/roles.js';
import type { Role } from '../database/database.types.js';
import { escapeHtml, plainText } from './mail-text.js';
import type { MailMessage } from './mailer.service.js';

/**
 * Los cambios de seguridad de los que la persona se entera por su propio correo (NIST 800-63B-4,
 * OWASP): lo que un admin le hizo a su acceso y el cambio de su propia contraseña. Enviarle el
 * enlace para restablecerla y obligarla a elegir una nueva no están: ese correo ya es el aviso.
 */
export const SECURITY_NOTICE_KINDS = [
  'mfa_reset',
  'sessions_revoked',
  'session_revoked',
  'unlocked',
  'role_changed',
  'membership_suspended',
  'membership_reactivated',
  'membership_removed',
  'account_suspended',
  'account_reactivated',
  'password_changed',
] as const;

export type SecurityNoticeKind = (typeof SECURITY_NOTICE_KINDS)[number];

/** Con qué se arma el aviso. Todo es opcional: sin un dato, el texto lo dice sin él. */
export interface SecurityNoticeDetails {
  /** El nombre de la persona, para el saludo. */
  readonly personName?: string | null;
  /** El nodo donde actuó el admin. Sin nombre legible, "la plataforma". */
  readonly nodeName?: string | null;
  /** El rol nuevo (`role_changed`). */
  readonly role?: Role | null;
}

/** La última línea de todos los avisos: quien no lo esperaba tiene a quién acudir. */
export const SECURITY_NOTICE_CLOSING =
  'Si no lo esperabas, avísale a tu administrador de inmediato.';

/**
 * Cómo se nombra cada rol en el aviso: los nombres con que Equipo lo ofrece al invitar o cambiarlo
 * (`INVITABLE_ROLES` del panel), que son los que la persona vio al recibir la invitación.
 */
const ROLE_NAMES: Readonly<Record<Role, string>> = {
  superadmin: 'Superadmin',
  platform_admin: 'Admin de plataforma',
  consolidator_admin: 'Admin de consolidador',
  tenant_admin: 'Admin',
  agency_admin: 'Admin de agencia',
  admin: 'Manager',
  vendedor: 'Vendedor',
  cliente_final: 'Cliente',
};

const BRAND = 'PlaneTour';

interface NoticeCopy {
  /** Asunto (con la marca si no la nombra) y título del correo. */
  readonly title: string;
  readonly paragraphs: readonly string[];
}

function copyFor(kind: SecurityNoticeKind, node: string, role: Role | null): NoticeCopy {
  switch (kind) {
    case 'mfa_reset':
      return {
        title: 'Restablecimos tu verificación en dos pasos',
        paragraphs: [
          `Un administrador de ${node} restableció tu verificación en dos pasos. Al próximo ingreso puedes configurarla de nuevo.`,
          'Tus códigos de recuperación y tus equipos de confianza ya no sirven, y cerramos tus sesiones abiertas.',
        ],
      };
    case 'sessions_revoked':
      return {
        title: 'Cerramos tus sesiones abiertas',
        paragraphs: [
          `Un administrador de ${node} cerró tus sesiones. Puedes volver a ingresar con tu contraseña.`,
        ],
      };
    case 'session_revoked':
      return {
        title: 'Cerramos una de tus sesiones',
        paragraphs: [
          `Un administrador de ${node} cerró una de tus sesiones; las demás siguen abiertas. Puedes volver a ingresar con tu contraseña.`,
        ],
      };
    case 'unlocked':
      return {
        title: 'Desbloqueamos tu cuenta',
        paragraphs: [
          `Un administrador de ${node} levantó el bloqueo por intentos fallidos. Ya puedes volver a ingresar.`,
        ],
      };
    case 'role_changed':
      return {
        title: `Tu rol en ${node} cambió`,
        paragraphs:
          role === null
            ? [`Un administrador cambió tu rol en ${node}.`]
            : [
                `Un administrador cambió tu rol. Ahora eres ${ROLE_NAMES[role]} en ${node}.`,
                ...(requiresMfa(role)
                  ? [
                      'Este rol exige verificación en dos pasos: si todavía no la tienes, te la pediremos al ingresar.',
                    ]
                  : []),
              ],
      };
    case 'membership_suspended':
      return {
        title: `Tu acceso a ${node} fue suspendido`,
        paragraphs: [
          `Un administrador suspendió tu acceso a ${node} y cerramos las sesiones que tenías abiertas ahí. Si trabajas en otros nodos, tu acceso a ellos no cambia.`,
        ],
      };
    case 'membership_reactivated':
      return {
        title: `Tu acceso a ${node} fue reactivado`,
        paragraphs: [
          `Un administrador reactivó tu acceso a ${node}. Puedes volver a ingresar con tu contraseña.`,
        ],
      };
    case 'membership_removed':
      return {
        title: `Ya no formas parte de ${node}`,
        paragraphs: [
          `Un administrador te quitó de ${node}. Tu historial se conserva; para volver, necesitas una invitación nueva.`,
        ],
      };
    case 'account_suspended':
      return {
        title: `Tu cuenta de ${BRAND} fue suspendida`,
        paragraphs: [
          'Un administrador de la plataforma suspendió tu cuenta: no puedes ingresar y cerramos todas tus sesiones.',
        ],
      };
    case 'account_reactivated':
      return {
        title: `Tu cuenta de ${BRAND} fue reactivada`,
        paragraphs: [
          'Un administrador de la plataforma reactivó tu cuenta. Puedes volver a ingresar con tu contraseña.',
        ],
      };
    case 'password_changed':
      return {
        title: 'Tu contraseña cambió',
        paragraphs: [
          `La contraseña de tu cuenta de ${BRAND} cambió y cerramos las sesiones que tenías abiertas con la anterior.`,
          'Si no fuiste tú, elige una nueva desde «Olvidé mi contraseña» en la pantalla de ingreso.',
        ],
      };
  }
}

/**
 * El aviso de un cambio de seguridad, sin el destinatario. Nunca lleva enlaces ni tokens: un aviso
 * de seguridad con un botón para "revisar tu cuenta" es justo lo que imita el phishing.
 *
 * El nombre del nodo lo elige su propio admin y el de la persona, ella misma: en el asunto y el texto
 * van sin caracteres de control, y en el HTML todo el párrafo va escapado (mail-text.ts). Sin nombre
 * de nodo legible se dice "la plataforma", como el correo del enlace.
 */
export function securityNoticeEmail(
  kind: SecurityNoticeKind,
  details: SecurityNoticeDetails = {},
): Required<Omit<MailMessage, 'to'>> {
  const node = plainText(details.nodeName ?? '') || 'la plataforma';
  const person = plainText(details.personName ?? '');
  const copy = copyFor(kind, node, details.role ?? null);
  const greeting = person ? `Hola, ${person}:` : 'Hola:';
  const subject = copy.title.includes(BRAND) ? copy.title : `${copy.title} · ${BRAND}`;
  return {
    subject,
    html: noticeHtml(copy.title, greeting, copy.paragraphs),
    text: [copy.title, greeting, ...copy.paragraphs, SECURITY_NOTICE_CLOSING].join('\n\n'),
  };
}

function noticeHtml(title: string, greeting: string, paragraphs: readonly string[]): string {
  const body = paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#52525b">${escapeHtml(p)}</p>`,
    )
    .join('\n          ');
  return `<!doctype html>
<html lang="es"><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:32px">
        <tr><td>
          <p style="margin:0 0 16px;font-size:16px;font-weight:600;color:#18181b">${escapeHtml(title)}</p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#52525b">${escapeHtml(greeting)}</p>
          ${body}
          <p style="margin:8px 0 0;font-size:14px;line-height:1.5;font-weight:600;color:#18181b">${escapeHtml(SECURITY_NOTICE_CLOSING)}</p>
          <p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#71717a">
            Es un aviso de seguridad de ${BRAND}: no trae enlaces ni te pide datos.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
