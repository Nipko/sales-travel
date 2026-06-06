import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { ProviderCredentialsService } from '../provider-credentials/provider-credentials.service.js';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface TransportSpec {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/** provider_code reservado para la configuración de email/SMTP por tenant (BYO-email). */
export const EMAIL_PROVIDER_CODE = 'email';

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function buildFrom(fromEmail: string, fromName: string): string {
  return fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
}

/** Construye un TransportSpec desde una cuenta 'email' (config no-secreta + credenciales). null si incompleta. */
export function specFromAccount(
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
): TransportSpec | null {
  const host = str(config['host']);
  const user = str(credentials['user']);
  const pass = str(credentials['password'] ?? credentials['appPassword']);
  if (!host || !user || !pass) return null;
  const port = num(config['port']) ?? 587;
  const secure = typeof config['secure'] === 'boolean' ? config['secure'] : port === 465;
  const fromEmail = str(config['fromEmail']) || user;
  return { host, port, secure, user, pass, from: buildFrom(fromEmail, str(config['fromName'])) };
}

/** Construye el TransportSpec del SMTP por defecto del sistema desde el entorno. null si no configurado. */
export function specFromEnv(env: NodeJS.ProcessEnv): TransportSpec | null {
  const host = str(env['MAIL_HOST']);
  const user = str(env['MAIL_USER']);
  const pass = str(env['MAIL_PASS']);
  if (!host || !user || !pass) return null;
  const port = num(env['MAIL_PORT']) ?? 587;
  const secure = env['MAIL_SECURE'] === 'true' || port === 465;
  const fromEmail = str(env['MAIL_FROM']) || user;
  return { host, port, secure, user, pass, from: buildFrom(fromEmail, str(env['MAIL_FROM_NAME'])) };
}

/**
 * Envío de correo multi-tenant con BYO-email. Resuelve la cuenta 'email' del propio tenant o de un
 * ancestro heredable (mismo mecanismo BYOC que los proveedores); si no hay ninguna, usa el SMTP por
 * defecto del sistema (env). Best-effort: nunca lanza — devuelve false si no pudo enviar, para que
 * una notificación fallida jamás rompa la operación de negocio (p.ej. el registro).
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger('MailerService');

  constructor(private readonly creds: ProviderCredentialsService) {}

  async sendToTenant(tenantId: string | null, msg: MailMessage): Promise<boolean> {
    const spec = await this.resolveSpec(tenantId);
    if (!spec) {
      this.logger.warn(
        `no email transport (tenant=${tenantId ?? 'none'}); skipping "${msg.subject}" → ${msg.to}`,
      );
      return false;
    }
    try {
      const transporter = nodemailer.createTransport({
        host: spec.host,
        port: spec.port,
        secure: spec.secure,
        auth: { user: spec.user, pass: spec.pass },
      });
      await transporter.sendMail({
        from: spec.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      });
      return true;
    } catch (err) {
      // NUNCA loguear credenciales; sólo el mensaje del error de transporte.
      this.logger.error(`email send failed (tenant=${tenantId}): ${(err as Error).message}`);
      return false;
    }
  }

  /** Cuenta 'email' del tenant (propia/heredada) o, si no hay, el SMTP del sistema. */
  private async resolveSpec(tenantId: string | null): Promise<TransportSpec | null> {
    let spec: TransportSpec | null = null;
    if (tenantId) {
      try {
        const acc = await this.creds.resolve(tenantId, EMAIL_PROVIDER_CODE);
        spec = specFromAccount(acc.config, acc.credentials);
      } catch {
        // sin cuenta 'email' resoluble → se usa el default del sistema
      }
    }
    return spec ?? specFromEnv(process.env);
  }
}
