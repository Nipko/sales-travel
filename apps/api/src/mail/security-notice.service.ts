import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { Role } from '../database/database.types.js';
import { InflightWorkRegistry } from '../lifecycle/inflight-work.registry.js';
import { mailNodeOf, type MailNode } from './mail-node.js';
import { MailerService } from './mailer.service.js';
import { securityNoticeEmail, type SecurityNoticeKind } from './security-notices.js';

/** A quién se avisa y desde qué nodo. */
export interface SecurityNoticeTarget {
  readonly userId: string;
  /**
   * El nodo donde actuó el admin: el aviso lo nombra y sale por su correo (propio o heredado).
   * `null` cuando no hay un nodo de por medio (su propia contraseña, su cuenta en toda la
   * plataforma): sale por el correo de su membership activa más antigua, o el del sistema.
   */
  readonly tenantId: string | null;
  /** El nombre del nodo si el llamador ya lo tiene; si no, se lee. */
  readonly nodeName?: string | null;
  /** El rol nuevo (`role_changed`). */
  readonly role?: Role;
}

/**
 * Le avisa a la persona, en su propio buzón, de cada cambio de seguridad sobre su acceso (ver
 * security-notices.ts).
 *
 * Se llama DESPUÉS del commit del cambio, nunca dentro de su transacción: un aviso de algo que se
 * deshizo sería falso, y un SMTP lento no puede tener tomada la fila del usuario. La respuesta al
 * admin tampoco lo espera (`notify`): el aviso es para la persona y el resultado no cambia nada de lo
 * que el admin ve. Queda en InflightWorkRegistry para que un apagado ordenado lo deje salir.
 *
 * Best-effort: nunca lanza. Si no sale, queda en el log con el tipo y el id de la persona, nunca su
 * correo.
 */
@Injectable()
export class SecurityNoticeService {
  private readonly logger = new Logger('SecurityNoticeService');

  constructor(
    private readonly db: DatabaseService,
    private readonly mailer: MailerService,
    private readonly work: InflightWorkRegistry,
  ) {}

  /** Envía el aviso sin que el llamador lo espere. */
  notify(kind: SecurityNoticeKind, target: SecurityNoticeTarget): void {
    void this.work.track('security-notice', this.send(kind, target));
  }

  /** El envío en sí: si salió. Nunca lanza. */
  async send(kind: SecurityNoticeKind, target: SecurityNoticeTarget): Promise<boolean> {
    try {
      const person = await this.db.db
        .selectFrom('users')
        .select(['email', 'name'])
        .where('id', '=', target.userId)
        .executeTakeFirst();
      if (person === undefined) {
        this.logger.warn(`security notice ${kind} skipped: no such user (user=${target.userId})`);
        return false;
      }

      const node = await this.nodeFor(target);
      const sent = await this.mailer.sendToTenant(node?.tenantId ?? null, {
        to: person.email,
        ...securityNoticeEmail(kind, {
          personName: person.name,
          nodeName: target.tenantId === null ? null : (node?.name ?? null),
          role: target.role ?? null,
        }),
      });
      if (!sent) this.logger.warn(`security notice ${kind} not sent (user=${target.userId})`);
      return sent;
    } catch {
      // Sin el error: el de la base o el del SMTP puede traer el correo de la persona.
      this.logger.error(`security notice ${kind} failed (user=${target.userId})`);
      return false;
    }
  }

  /** El nodo de la ruta con su nombre, o el del correo de la persona si no hay uno. */
  private async nodeFor(target: SecurityNoticeTarget): Promise<MailNode | undefined> {
    if (target.tenantId === null) return mailNodeOf(this.db, target.userId);
    if (target.nodeName !== undefined && target.nodeName !== null) {
      return { tenantId: target.tenantId, name: target.nodeName };
    }
    const tenant = await this.db.db
      .selectFrom('tenants')
      .select('name')
      .where('id', '=', target.tenantId)
      .executeTakeFirst();
    return { tenantId: target.tenantId, name: tenant?.name ?? '' };
  }
}
