import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service.js';
import { canGrantRole, highestRole, PLATFORM_ROLES } from '../auth/roles.js';
import { DatabaseService } from '../database/database.service.js';
import type {
  DB,
  MembershipStatus,
  Role,
  TenantType,
  UserStatus,
} from '../database/database.types.js';
import { SecurityNoticeService } from '../mail/security-notice.service.js';
import { NetworkService } from '../network/network.service.js';
import { currentContext } from '../request-context/request-context.js';
import {
  AdminSessionNotFoundError,
  OWN_SESSIONS_MESSAGE,
  SuperadminOnlyError,
} from './member-detail.errors.js';
import { REVOKED_BY_ADMIN_REASON } from './member-support.service.js';
import { UserNotFoundError } from './platform-users.errors.js';
import {
  MemberNotFoundError,
  MemberSelfActionError,
  RoleNotGrantableError,
  TenantNotManagedError,
} from './tenant-admin.policy.js';

/** Cuántas invitaciones pendientes que envió trae la ficha (el total va aparte). */
export const INVITATIONS_SENT_LIMIT = 20;

export interface MemberDetailUser {
  id: string;
  email: string;
  name: string | null;
  /** El de la cuenta en toda la plataforma; el de cada nodo va en `memberships`. */
  status: UserStatus;
  createdAt: string;
  emailVerified: boolean;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  /** Un admin le pidió elegir una contraseña nueva y todavía no lo hizo: no puede ingresar. */
  passwordResetRequired: boolean;
}

export interface MemberDetailSecurity {
  mfaEnabled: boolean;
  mfaEnabledAt: string | null;
  /** Códigos de recuperación sin usar. */
  recoveryCodesLeft: number;
  /** Equipos de confianza que todavía le ahorran el segundo factor. */
  trustedDevices: number;
  /** Sólo mientras el bloqueo por intentos fallidos siga vigente. */
  lockedUntil: string | null;
  failedLoginAttempts: number;
}

export interface MemberDetailMembership {
  tenantId: string;
  tenantName: string;
  tenantType: TenantType;
  role: Role;
  status: MembershipStatus;
  createdAt: string;
}

export interface MemberDetailSession {
  id: string;
  /**
   * `null` sólo en la ficha del superadmin: una sesión de plataforma sin nodo activo. Ésa no se
   * cierra de a una (el cierre va por el nodo de la sesión); sí con "Cerrar todas sus sesiones".
   */
  tenantId: string | null;
  tenantName: string | null;
  issuedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  /** User-agent crudo: la web lo resume ("Chrome en Windows"), como en Puestos. */
  userAgent: string | null;
  /** La sesión pasó el segundo factor. */
  mfaVerified: boolean;
  /** Nodo del cupo de puestos que ocupa; `null` = no ocupa puesto. */
  seatTenantId: string | null;
  /** Es la sesión de quien mira (su propia ficha): la web no le ofrece cerrarla desde acá. */
  current: boolean;
}

export interface MemberDetailInvitation {
  id: string;
  email: string;
  role: Role;
  tenantName: string;
  /** Una vencida sigue pendiente: se reenvía (doc 14). */
  expiresAt: string;
}

/** `GET /tenants/:id/members/:userId` y `GET /admin/users/:userId`. */
export interface MemberDetail {
  user: MemberDetailUser;
  security: MemberDetailSecurity;
  /** Sus nodos que administra quien mira (todos, para el superadmin). */
  memberships: MemberDetailMembership[];
  /** Sus sesiones abiertas en el subárbol del nodo de la ruta (todas, para el superadmin). */
  sessions: MemberDetailSession[];
  /** Quién lo invitó: la última invitación aceptada para su correo que quien mira alcanza a ver. */
  invitedBy: { email: string | null; at: string } | null;
  /** Las invitaciones pendientes que envió (ni aceptadas ni revocadas, venzan o no). */
  invitationsSent: { pending: number; items: MemberDetailInvitation[] };
}

/** Hasta dónde mira la ficha: el subárbol de un nodo, o toda la plataforma (superadmin). */
interface Scope {
  readonly rootTenantId: string | null;
}

interface SecurityRow {
  mfa_enabled_at: Date | null;
  recovery_codes_left: number | string;
  trusted_devices_active: number | string;
  password_changed_at: Date | null;
  failed_login_attempts: number | string;
  locked_until: Date | null;
}

interface SessionRow {
  id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  issued_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  ip: string | null;
  user_agent: string | null;
  mfa_verified: boolean;
  seat_tenant_id: string | null;
}

function iso(value: Date | string): string;
function iso(value: Date | string | null | undefined): string | null;
function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * `column <@` el `path` del nodo raíz: el nodo y todo lo que cuelga de él. Sin raíz (la ficha del
 * superadmin), cualquier nodo.
 */
function withinRoot(column: string, rootTenantId: string | null) {
  if (rootTenantId === null) return sql<boolean>`true`;
  return sql<boolean>`${sql.ref(column)} OPERATOR(public.<@) (SELECT r.path FROM tenants r WHERE r.id = ${rootTenantId}::uuid)`;
}

/**
 * La ficha de una persona para quien la administra: perfil, seguridad, nodos y roles, sesiones
 * abiertas, quién la invitó y las invitaciones que envió; y cerrar UNA de sus sesiones.
 *
 * Dos alcances:
 *
 *   - desde Equipo (`detail`): quien administra el nodo de la ruta, sobre alguien con membership en su
 *     subárbol. Ve sus nodos que administra, y sus sesiones e invitaciones en ese subárbol;
 *   - desde Plataforma → Usuarios (`platformDetail`): el superadmin, sobre cualquier cuenta. Ve sus
 *     nodos, sesiones e invitaciones en toda la plataforma.
 *
 * Las sesiones, los códigos de recuperación y los equipos de confianza tienen RLS por usuario: se
 * leen con las funciones SECURITY DEFINER de 0064, que no autorizan (y además no responden a quien no
 * podría verlo). La autorización vive acá y va primero. Nunca salen hashes de tokens, secretos de MFA
 * ni contraseñas; la IP y el navegador de cada sesión sí, como en Puestos.
 */
@Injectable()
export class MemberDetailService {
  constructor(
    private readonly db: DatabaseService,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
    private readonly notices: SecurityNoticeService,
  ) {}

  /**
   * La ficha desde Equipo. El orden importa: primero que el actor administre el nodo de la ruta (403
   * sin leer nada del usuario), después que el usuario tenga una membership en ese subárbol, leída
   * con la RLS del actor (404). Así quien no administra el nodo no averigua si alguien pertenece a
   * él. Uno mismo también puede verse.
   */
  async detail(actorUserId: string, tenantId: string, targetUserId: string): Promise<MemberDetail> {
    const routeRole = await this.network.roleOver(actorUserId, tenantId);
    if (routeRole === undefined) throw new TenantNotManagedError();

    const detail = await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const member = await trx
        .selectFrom('memberships as m')
        .innerJoin('tenants as t', 't.id', 'm.tenant_id')
        .select('m.id')
        .where('m.user_id', '=', targetUserId)
        .where(withinRoot('t.path', tenantId))
        .limit(1)
        .executeTakeFirst();
      if (!member) throw new MemberNotFoundError();
      const loaded = await this.load(trx, actorUserId, targetUserId, { rootTenantId: tenantId });
      // Tiene membership, así que la cuenta existe; se mira igual por si se borró en el medio.
      if (loaded === undefined) throw new MemberNotFoundError();
      return loaded;
    });
    if (routeRole === 'superadmin') return detail;

    // La RLS de memberships ya acota a su red; esto deja sólo los nodos que de verdad administra
    // (como canManageTenant: no cuenta un nodo bajo uno suspendido).
    const administered = await this.network.rolesOver(
      actorUserId,
      detail.memberships.map((m) => m.tenantId),
    );
    return {
      ...detail,
      memberships: detail.memberships.filter((m) => administered.has(m.tenantId)),
    };
  }

  /**
   * La ficha desde Plataforma → Usuarios: cualquier cuenta, todo. 403 a quien no es superadmin,
   * antes de leer nada de la cuenta; 404 si no existe. El chequeo vive acá y no en el controlador
   * para que ningún llamador pueda saltearlo.
   */
  async platformDetail(actorUserId: string, targetUserId: string): Promise<MemberDetail> {
    if (!(await this.network.isSuperadmin(actorUserId))) throw new SuperadminOnlyError();
    const detail = await this.db.withRequestContext({ userId: actorUserId }, (trx) =>
      this.load(trx, actorUserId, targetUserId, { rootTenantId: null }),
    );
    if (detail === undefined) throw new UserNotFoundError();
    return detail;
  }

  /**
   * Cierra UNA sesión de la persona (`revoke_session(id, 'revoked_by_admin')`): su próximo request
   * responde SESSION_REVOKED. Las demás siguen abiertas.
   *
   * - Nunca la propia: las sesiones propias se cierran desde Mi cuenta → Seguridad. Se decide sin
   *   leer nada.
   * - El actor administra el nodo de la ruta (403) y la sesión es de esa persona y está abierta en
   *   ese subárbol (404, un solo motivo para todo).
   * - Salvo el superadmin, el actor supera en rango, sobre el nodo de ESA sesión, al rol con que la
   *   persona opera ahí (su membership activa en el nodo o en un ancestro, o un rol de plataforma).
   *   Es más estricto que liberar un puesto, que sólo pide administrar el nodo: acá se elige a una
   *   persona, no un puesto, y un admin no le corta la sesión a otro de su rango (doc 15).
   *
   * La revocación y `auth.session.revoked_by_admin` van en una transacción. 404 si se cerró entre la
   * lectura y la revocación. Después del commit, la persona recibe el aviso `session_revoked` por el
   * correo del nodo de la ruta.
   */
  async revokeSession(
    actorUserId: string,
    tenantId: string,
    targetUserId: string,
    sessionId: string,
  ): Promise<{ ok: true }> {
    if (actorUserId === targetUserId) throw new MemberSelfActionError(OWN_SESSIONS_MESSAGE);

    const routeRole = await this.network.roleOver(actorUserId, tenantId);
    if (routeRole === undefined) throw new TenantNotManagedError();

    const session = await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const res = await sql<{ tenant_id: string | null }>`
        SELECT s.tenant_id
          FROM admin_user_sessions(${targetUserId}::uuid, ${tenantId}::uuid) s
         WHERE s.id = ${sessionId}::uuid
      `.execute(trx);
      return res.rows[0];
    });
    // Con raíz, la función sólo devuelve sesiones con nodo; el `null` se mira igual por si cambia.
    if (session === undefined || session.tenant_id === null) {
      throw new AdminSessionNotFoundError();
    }
    const sessionTenantId = session.tenant_id;

    if (routeRole !== 'superadmin') {
      const actorRole = await this.network.roleOver(actorUserId, sessionTenantId);
      const targetRole = await this.roleOn(targetUserId, sessionTenantId);
      if (
        actorRole === undefined ||
        (targetRole !== undefined && !canGrantRole(actorRole, targetRole))
      ) {
        throw new RoleNotGrantableError(
          'No puedes cerrar la sesión de alguien de rango igual o superior al tuyo en ese nodo.',
        );
      }
    }

    const revoked = await this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const res = await sql<{ revoked: boolean }>`
        SELECT revoke_session(${sessionId}::uuid, ${REVOKED_BY_ADMIN_REASON}) AS revoked
      `.execute(trx);
      if (res.rows[0]?.revoked !== true) return false;
      // En la misma transacción: no queda una sesión cerrada por un admin sin su rastro.
      await this.audit.emitWithin(trx, {
        eventType: 'auth.session.revoked_by_admin',
        tenantId: sessionTenantId,
        actorUserId,
        aggregateType: 'session',
        aggregateId: sessionId,
        payload: { targetUserId, sessionId, viaTenantId: tenantId },
      });
      return true;
    });
    if (!revoked) throw new AdminSessionNotFoundError();
    this.notices.notify('session_revoked', { userId: targetUserId, tenantId });
    return { ok: true };
  }

  /**
   * El rol con que la persona opera sobre `tenantId`: el de más rango entre sus memberships ACTIVAS
   * en ese nodo o en un ancestro y sus roles de plataforma, que valen en cualquier nodo. `undefined`
   * si no tiene ninguno.
   *
   * Sólo activas, como roleOver y como cerrar todas sus sesiones (assertCanSupportMember): un acceso
   * suspendido no le da rango sobre nada. Contarlo dejaba un absurdo: quien fue tenant_admin de la
   * agencia y hoy sólo vende en una sub-agencia no podía perder UNA sesión a manos del admin de la
   * agencia, que sí podía cerrarle todas. La membership del propio nodo de la sesión no hace falta
   * contarla suspendida: suspenderla ya cierra las sesiones de ese subárbol (0056).
   *
   * Se lee con la PERSONA en `app.current_user_id` (policy memberships_self), como
   * MemberSupportService: con el actor en el contexto, la RLS sólo mostraría las de su subárbol, y
   * un consolidator_admin que opera en una agencia parecería no tener rol ahí. Es una lectura de sólo
   * sus memberships, en su propia transacción, que no escribe nada.
   */
  private async roleOn(targetUserId: string, tenantId: string): Promise<Role | undefined> {
    const rows = await this.db.withRequestContext({ userId: targetUserId }, (trx) =>
      trx
        .selectFrom('memberships as m')
        .innerJoin('tenants as mt', 'mt.id', 'm.tenant_id')
        .select('m.role')
        .where('m.user_id', '=', targetUserId)
        .where('m.status', '=', 'active')
        .where((eb) =>
          eb.or([
            eb('m.role', 'in', [...PLATFORM_ROLES]),
            sql<boolean>`mt.path OPERATOR(public.@>) (SELECT st.path FROM tenants st WHERE st.id = ${tenantId}::uuid)`,
          ]),
        )
        .execute(),
    );
    return highestRole(rows.map((r) => r.role));
  }

  /**
   * Todo lo de la ficha, con el contexto de quien mira, en su transacción. `undefined` si la cuenta
   * no existe. Con `rootTenantId`, sesiones e invitaciones se acotan a ese subárbol; las memberships
   * son las que la RLS le deja ver (su red; todas, al superadmin).
   */
  private async load(
    trx: Transaction<DB>,
    actorUserId: string,
    targetUserId: string,
    scope: Scope,
  ): Promise<MemberDetail | undefined> {
    const user = await trx
      .selectFrom('users')
      .select([
        'id',
        'email',
        'name',
        'status',
        // Generated<Timestamp> se selecciona como ColumnType anidado, no como Date.
        sql<Date>`created_at`.as('created_at'),
        'email_verified_at',
        'last_login_at',
        'password_changed_at',
        'password_reset_required_at',
      ])
      .where('id', '=', targetUserId)
      .executeTakeFirst();
    if (!user) return undefined;

    const security = await sql<SecurityRow>`
      SELECT mfa_enabled_at, recovery_codes_left, trusted_devices_active, password_changed_at,
             failed_login_attempts, locked_until
        FROM admin_user_security(${targetUserId}::uuid)
    `.execute(trx);
    const sec = security.rows[0];
    // La función sólo calla ante quien no administra a la persona: si pasó la autorización de acá y
    // calla, las dos reglas se separaron. Mejor un 500 que una ficha con "0 códigos" inventados.
    if (sec === undefined) {
      throw new Error('admin_user_security no respondió a quien la API ya autorizó');
    }

    const memberships = await trx
      .selectFrom('memberships as m')
      .innerJoin('tenants as t', 't.id', 'm.tenant_id')
      .select([
        'm.tenant_id',
        't.name as tenant_name',
        't.tenant_type',
        'm.role',
        'm.status',
        sql<Date>`m.created_at`.as('created_at'),
      ])
      .where('m.user_id', '=', targetUserId)
      // Primero los accesos activos y los nodos más altos, como el directorio.
      .orderBy(sql`(m.status = 'active')`, 'desc')
      .orderBy(sql`nlevel(t.path)`)
      .orderBy('t.name')
      .orderBy('m.tenant_id')
      .execute();

    const sessions = await sql<SessionRow>`
      SELECT id, tenant_id, tenant_name, issued_at, last_seen_at, expires_at, ip, user_agent,
             mfa_verified, seat_tenant_id
        FROM admin_user_sessions(${targetUserId}::uuid, ${scope.rootTenantId}::uuid)
    `.execute(trx);

    const invitedBy = await trx
      .selectFrom('user_invitations as i')
      .innerJoin('tenants as t', 't.id', 'i.tenant_id')
      .leftJoin('users as inviter', 'inviter.id', 'i.invited_by')
      .select(['inviter.email as inviter_email', sql<Date>`i.accepted_at`.as('accepted_at')])
      .where('i.email', '=', user.email)
      .where('i.accepted_at', 'is not', null)
      .where(withinRoot('t.path', scope.rootTenantId))
      .orderBy('i.accepted_at', 'desc')
      .orderBy('i.id', 'desc')
      .limit(1)
      .executeTakeFirst();

    const pendingSent = trx
      .selectFrom('user_invitations as i')
      .innerJoin('tenants as t', 't.id', 'i.tenant_id')
      .where('i.invited_by', '=', targetUserId)
      .where('i.accepted_at', 'is', null)
      .where('i.revoked_at', 'is', null)
      .where(withinRoot('t.path', scope.rootTenantId));
    const pending = await pendingSent
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirst();
    const sent = await pendingSent
      .select(['i.id', 'i.email', 'i.role', 't.name as tenant_name', 'i.expires_at'])
      .orderBy('i.created_at', 'desc')
      .orderBy('i.id', 'desc')
      .limit(INVITATIONS_SENT_LIMIT)
      .execute();

    const currentSessionId = actorUserId === targetUserId ? currentContext()?.sessionId : undefined;

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        status: user.status,
        createdAt: iso(user.created_at),
        emailVerified: user.email_verified_at !== null,
        lastLoginAt: iso(user.last_login_at),
        passwordChangedAt: iso(user.password_changed_at),
        passwordResetRequired: user.password_reset_required_at !== null,
      },
      security: {
        mfaEnabled: sec.mfa_enabled_at !== null,
        mfaEnabledAt: iso(sec.mfa_enabled_at),
        recoveryCodesLeft: Number(sec.recovery_codes_left),
        trustedDevices: Number(sec.trusted_devices_active),
        lockedUntil: iso(sec.locked_until),
        failedLoginAttempts: Number(sec.failed_login_attempts),
      },
      memberships: memberships.map(
        (m): MemberDetailMembership => ({
          tenantId: m.tenant_id,
          tenantName: m.tenant_name,
          tenantType: m.tenant_type,
          role: m.role,
          status: m.status,
          createdAt: iso(m.created_at),
        }),
      ),
      sessions: sessions.rows.map(
        (s): MemberDetailSession => ({
          id: s.id,
          tenantId: s.tenant_id,
          tenantName: s.tenant_name,
          issuedAt: iso(s.issued_at),
          lastSeenAt: iso(s.last_seen_at),
          expiresAt: iso(s.expires_at),
          ip: s.ip,
          userAgent: s.user_agent,
          mfaVerified: s.mfa_verified,
          seatTenantId: s.seat_tenant_id,
          current: currentSessionId !== undefined && s.id === currentSessionId,
        }),
      ),
      invitedBy:
        invitedBy === undefined
          ? null
          : { email: invitedBy.inviter_email, at: iso(invitedBy.accepted_at) },
      invitationsSent: {
        pending: Number(pending?.n ?? 0),
        items: sent.map(
          (i): MemberDetailInvitation => ({
            id: i.id,
            email: i.email,
            role: i.role,
            tenantName: i.tenant_name,
            expiresAt: iso(i.expires_at),
          }),
        ),
      },
    };
  }
}
