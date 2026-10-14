import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { isAssignableRole } from '../auth/roles.js';
import { DatabaseService } from '../database/database.service.js';
import type { Role } from '../database/database.types.js';
import { invitationDefect } from './invitation-validity.js';
import { backingFor, invitationTokenHash } from './invitations.service.js';

/**
 * Quién abre la invitación, según la sesión con que llega (si llega con una):
 * - `anonymous`: sin sesión;
 * - `invitee`: con la sesión de la cuenta dueña del correo invitado, la que puede aceptar con
 *   `POST /invitations/join`;
 * - `other`: con la sesión de otra cuenta, que tiene que salir y entrar con la invitada.
 */
export type InvitationViewer = 'anonymous' | 'invitee' | 'other';

/**
 * Lo que ve quien abre el enlace de la invitación. Es todo lo que sale: ni ids, ni el correo
 * invitado, ni a nadie más del nodo. Lo que dice lo sabe ya quien controla ese buzón, que es lo que
 * prueba el token: a qué nodo y con qué rol lo invitan, quién (su nombre, si lo tiene), hasta
 * cuándo, y si ese correo ya tiene una cuenta.
 */
export type InvitationPreview =
  | {
      valid: true;
      tenantName: string;
      role: Role;
      inviterName: string | null;
      expiresAt: string;
      existingAccount: boolean;
      viewer: InvitationViewer;
    }
  | { valid: false };

interface PreviewRow {
  invitation_id: string;
  tenant_name: string;
  role: Role;
  inviter_name: string | null;
  expires_at: Date;
  invitee_user_id: string | null;
}

const INVALID: InvitationPreview = { valid: false };

/**
 * Vista previa de una invitación por su token (`POST /invitations/preview`, USR-17), antes de
 * aceptarla. Es pública: corre antes de la sesión, con preview_pending_invitation() (0068), que como
 * máximo devuelve una fila por hash de token y sólo lee: mirarla no la gasta.
 *
 * Neutral: un token que no existe, ya se usó, se revocó o venció, uno con un rol que no se asigna, y
 * una invitación que su invitador ya no podría emitir o cuyo nodo no opera (la misma revalidación del
 * canje) dan la misma respuesta, `{ valid: false }`. Nada distingue cuál fue.
 */
@Injectable()
export class InvitationPreviewService {
  constructor(private readonly db: DatabaseService) {}

  async preview(token: string, viewerUserId: string | undefined): Promise<InvitationPreview> {
    return this.db.db.transaction().execute(async (trx) => {
      const found = await sql<PreviewRow>`
        SELECT * FROM preview_pending_invitation(${invitationTokenHash(token)})
      `.execute(trx);
      const row = found.rows[0];
      if (row === undefined || !isAssignableRole(row.role)) return INVALID;

      const [backing] = await backingFor(trx, [row.invitation_id]);
      if (backing === undefined || invitationDefect(backing) !== undefined) return INVALID;

      return {
        valid: true,
        tenantName: row.tenant_name,
        role: row.role,
        inviterName: row.inviter_name,
        expiresAt: new Date(row.expires_at).toISOString(),
        existingAccount: row.invitee_user_id !== null,
        viewer: viewerOf(viewerUserId, row.invitee_user_id),
      };
    });
  }
}

function viewerOf(
  viewerUserId: string | undefined,
  inviteeUserId: string | null,
): InvitationViewer {
  if (viewerUserId === undefined) return 'anonymous';
  return inviteeUserId !== null && viewerUserId.toLowerCase() === inviteeUserId.toLowerCase()
    ? 'invitee'
    : 'other';
}
