import { Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { PLATFORM_TIME_ZONE, todayIn } from '../admin-console/admin-overview.schemas.js';
import { toCsv, type CsvValue } from '../admin-console/csv.js';
import { platformTenantId } from '../audit/admin-audit.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { roleName } from '../mail/security-notices.js';
import { readTenantUsers, type NetworkUser } from '../network/network.service.js';
import type { PlatformUsersExportQuery } from './dto.js';
import {
  directoryMemberships,
  directoryQuery,
  type PlatformUserMembership,
} from './platform-users.service.js';
import { TenantNotManagedError } from './tenant-admin.policy.js';

/**
 * Exportar la lista de usuarios a CSV (USR-16): el directorio de la plataforma filtrado (sólo el
 * superadmin) o el equipo de un nodo (quien lo administra). Para revisiones de cumplimiento y de
 * puestos.
 *
 * Lo que sale es lo mismo que la pantalla y nada más:
 *
 *   - las personas salen de la MISMA consulta que la pantalla (`directoryQuery` del directorio,
 *     `readTenantUsers` de Equipo), con los mismos filtros y sin los nodos de los que se quitó a
 *     alguien (USR-11);
 *   - las columnas son las mínimas para revisar accesos: correo, nombre, nodo, rol, los dos estados,
 *     si tiene el 2FA, su último ingreso y el alta. Nunca IPs, contraseñas, secretos del 2FA, tokens
 *     ni sesiones;
 *   - las fechas van en hora de Bogotá, y el encabezado lo dice.
 *
 * Cada exportación deja `users.exported` (quién, con qué filtros y cuántas filas, nunca correos) en la
 * MISMA transacción que leyó las filas y sin tragarse el fallo (`emitWithin`): si el rastro no se
 * escribe, no sale el archivo. Quién puede lo decide el controlador ANTES de llamar acá.
 */

/** El evento de cada exportación. Su nombre legible está en el panel (audit-format.ts). */
export const USERS_EXPORTED_EVENT = 'users.exported';

/**
 * Como mucho tantas personas por archivo. El directorio sale de las altas más recientes; Equipo, de
 * las primeras en sumarse al nodo. Si había más, el archivo lo dice (`truncated`).
 */
export const USER_EXPORT_MAX_USERS = 10_000;

/** La zona de las fechas, como va en el encabezado. Colombia no cambia de hora. */
export const EXPORT_TIME_ZONE_LABEL = 'hora de Bogotá UTC-5';

export const PLATFORM_USERS_CSV_HEADER = [
  'Correo',
  'Nombre',
  'Nodo',
  'Rol',
  'Estado en el nodo',
  'Estado de la cuenta',
  '2FA',
  `Último ingreso (${EXPORT_TIME_ZONE_LABEL})`,
  `Alta de la cuenta (${EXPORT_TIME_ZONE_LABEL})`,
] as const;

/** Lo mismo que el directorio, salvo el alta: en Equipo es el alta en el nodo (su columna Alta). */
export const TEAM_CSV_HEADER = [
  ...PLATFORM_USERS_CSV_HEADER.slice(0, -1),
  `Alta en el nodo (${EXPORT_TIME_ZONE_LABEL})`,
] as const;

/** Qué se exportó: toda la plataforma (con los filtros del directorio) o el equipo de un nodo. */
export type UsersExportScope = 'platform' | 'node';

/** El CSV de una exportación, con lo que hace falta para las cabeceras de la respuesta. */
export interface UsersExport {
  csv: string;
  filename: string;
  /** Personas exportadas. */
  users: number;
  /** Filas del archivo, sin el encabezado: una por persona y nodo. */
  rows: number;
  /** Había más de {@link USER_EXPORT_MAX_USERS} personas: el archivo se cortó en el tope. */
  truncated: boolean;
}

// ─────────────────────────── Plegados (sin I/O) ───────────────────────────

// `invited`: el esquema original (0001) lo admite y una membership vieja puede tenerlo. Equipo la
// muestra como "Invitado"; el archivo dice lo mismo y no el código en inglés.
const MEMBERSHIP_STATUS: Readonly<Record<string, string>> = {
  active: 'Activo',
  suspended: 'Suspendido',
  invited: 'Invitado',
};

const ACCOUNT_STATUS: Readonly<Record<string, string>> = {
  active: 'Activa',
  suspended: 'Suspendida',
};

function label(map: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(map, value) ? (map[value] ?? value) : value;
}

const BOGOTA = new Intl.DateTimeFormat('en-US', {
  timeZone: PLATFORM_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Un instante en hora de Bogotá, `2026-10-13 09:41`: lo lee una persona, lo ordena cualquier planilla
 * y la zona va en el encabezado. Vacío si no hay (nunca ingresó) o no se puede leer.
 */
export function bogotaDateTime(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return '';
  const parts = BOGOTA.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/** `usuarios-2026-10-13.csv` o `equipo-agencia-norte-2026-10-13.csv`: el día de Bogotá. */
export function usersExportFilename(now: Date, nodeSlug?: string): string {
  const day = todayIn(PLATFORM_TIME_ZONE, now);
  if (nodeSlug === undefined) return `usuarios-${day}.csv`;
  // El slug va al nombre de un archivo: sólo lo que no hay que escapar en ninguna planilla ni disco.
  const slug = nodeSlug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug === '' ? `equipo-${day}.csv` : `equipo-${slug}-${day}.csv`;
}

/** Una persona del directorio, como la devuelve `directoryQuery`. */
export interface DirectoryPersonRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  mfa_enabled_at: Date | string | null;
  last_login_at: Date | string | null;
  created_at: Date | string;
}

/**
 * Las filas del directorio: una por persona y nodo, en el orden de la pantalla (altas más recientes
 * primero; sus nodos como los lista su fila). Quien no tiene ningún nodo también sale, en una fila
 * con "Sin nodos": el directorio lo muestra.
 */
export function platformUserLines(
  people: readonly DirectoryPersonRow[],
  nodesOf: ReadonlyMap<string, readonly PlatformUserMembership[]>,
): CsvValue[][] {
  return people.flatMap((person) => {
    const account: CsvValue[] = [
      label(ACCOUNT_STATUS, person.status),
      person.mfa_enabled_at === null ? 'No' : 'Sí',
      bogotaDateTime(person.last_login_at),
      bogotaDateTime(person.created_at),
    ];
    const nodes = nodesOf.get(person.id) ?? [];
    if (nodes.length === 0)
      return [[person.email, person.name, 'Sin nodos', null, null, ...account]];
    return nodes.map((node) => [
      person.email,
      person.name,
      node.tenantName,
      roleName(node.role),
      label(MEMBERSHIP_STATUS, node.status),
      ...account,
    ]);
  });
}

/** Las filas del equipo de un nodo: una por persona, en el orden de Equipo (por alta en el nodo). */
export function teamLines(nodeName: string, members: readonly NetworkUser[]): CsvValue[][] {
  return members.map((m) => [
    m.email,
    m.name,
    nodeName,
    roleName(m.role),
    label(MEMBERSHIP_STATUS, m.membershipStatus),
    label(ACCOUNT_STATUS, m.userStatus),
    m.mfaEnabled ? 'Sí' : 'No',
    bogotaDateTime(m.lastLoginAt),
    bogotaDateTime(m.createdAt),
  ]);
}

/**
 * Los filtros del directorio como quedan en el rastro. La búsqueda queda sólo como "hubo una": puede
 * ser un correo, y el rastro no lleva correos.
 */
export function exportedDirectoryFilters(query: PlatformUsersExportQuery): Record<string, unknown> {
  return {
    search: query.q !== undefined,
    status: query.status ?? null,
    role: query.role ?? null,
    tenantId: query.tenantId ?? null,
    mfa: query.mfa ?? null,
    locked: query.locked === 'true',
    neverLoggedIn: query.neverLoggedIn === 'true',
  };
}

// ─────────────────────────── El servicio ───────────────────────────

@Injectable()
export class UserExportService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * El directorio de la plataforma con estos filtros. Con el contexto del superadmin, como la lista:
   * `users` no tiene RLS y la de memberships le deja leerlas todas (0020). El rastro va a la raíz
   * `platform`, como el de la Actividad (ADM-8).
   */
  async exportPlatform(
    actorUserId: string,
    query: PlatformUsersExportQuery,
    now: Date = new Date(),
  ): Promise<UsersExport> {
    return this.db.withRequestContext({ userId: actorUserId }, async (trx) => {
      const read = await directoryQuery(trx, query, USER_EXPORT_MAX_USERS).execute();
      const people = read.slice(0, USER_EXPORT_MAX_USERS);
      const nodesOf = await directoryMemberships(
        trx,
        people.map((p) => p.id),
      );
      const lines = platformUserLines(people, nodesOf);
      const out: Omit<UsersExport, 'csv' | 'filename'> = {
        users: people.length,
        rows: lines.length,
        truncated: read.length > USER_EXPORT_MAX_USERS,
      };
      await this.trace(trx, actorUserId, await platformTenantId(trx), 'platform', {
        filters: exportedDirectoryFilters(query),
        ...out,
      });
      return {
        csv: toCsv(PLATFORM_USERS_CSV_HEADER, lines),
        filename: usersExportFilename(now),
        ...out,
      };
    });
  }

  /**
   * El equipo de un nodo, como Equipo: con el contexto `{ userId, tenantId }` (la RLS de memberships
   * devuelve sólo las del nodo). El controlador ya comprobó que el actor lo administra
   * (`canManageTenant`). El rastro va al nodo: lo ve su Actividad de la red (filtro Usuarios).
   */
  async exportTeam(
    actorUserId: string,
    tenantId: string,
    now: Date = new Date(),
  ): Promise<UsersExport> {
    return this.db.withRequestContext({ userId: actorUserId, tenantId }, async (trx) => {
      // `tenants` no tiene RLS. Si el nodo dejó de existir después de autorizar, no hay qué exportar.
      const node = await trx
        .selectFrom('tenants')
        .select(['name', 'slug'])
        .where('id', '=', tenantId)
        .executeTakeFirst();
      if (node === undefined) throw new TenantNotManagedError();

      const read = await readTenantUsers(trx, tenantId, USER_EXPORT_MAX_USERS + 1);
      const members = read.slice(0, USER_EXPORT_MAX_USERS);
      const lines = teamLines(node.name, members);
      const out: Omit<UsersExport, 'csv' | 'filename'> = {
        users: members.length,
        rows: lines.length,
        truncated: read.length > USER_EXPORT_MAX_USERS,
      };
      await this.trace(trx, actorUserId, tenantId, 'node', { filters: { tenantId }, ...out });
      return {
        csv: toCsv(TEAM_CSV_HEADER, lines),
        filename: usersExportFilename(now, node.slug),
        ...out,
      };
    });
  }

  /** El rastro, en la transacción de la lectura y sin tragarse el fallo. */
  private trace(
    trx: Transaction<DB>,
    actorUserId: string,
    tenantId: string | null,
    scope: UsersExportScope,
    payload: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.emitWithin(trx, {
      eventType: USERS_EXPORTED_EVENT,
      tenantId,
      actorUserId,
      payload: { scope, ...payload },
    });
  }
}
