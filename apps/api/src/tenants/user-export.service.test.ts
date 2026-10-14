import type { CompiledQuery } from 'kysely';
import { describe, expect, it } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { NetworkUser } from '../network/network.service.js';
import { requestContextStorage } from '../request-context/request-context.js';
import { ListPlatformUsersQuerySchema, PlatformUsersExportQuerySchema } from './dto.js';
import { directoryQuery, type PlatformUserMembership } from './platform-users.service.js';
import { TenantNotManagedError } from './tenant-admin.policy.js';
import {
  bogotaDateTime,
  exportedDirectoryFilters,
  platformUserLines,
  PLATFORM_USERS_CSV_HEADER,
  TEAM_CSV_HEADER,
  teamLines,
  USER_EXPORT_MAX_USERS,
  UserExportService,
  USERS_EXPORTED_EVENT,
  usersExportFilename,
  type DirectoryPersonRow,
} from './user-export.service.js';

/*
 * La exportación de usuarios a CSV sin base: qué columnas y cómo se dice cada dato, las celdas que
 * una planilla tomaría por fórmula, las fechas en hora de Bogotá, el tope, el rastro en la misma
 * transacción y que la consulta de personas es la del directorio. Que el SQL filtra como la pantalla
 * lo prueba user-export.integration.test.ts contra Postgres.
 */

const SUPERADMIN = '99999999-9999-4999-8999-999999999999';
const ANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BETO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NODO = '11111111-1111-4111-8111-111111111111';
const OTRO_NODO = '22222222-2222-4222-8222-222222222222';
const PLATAFORMA = '00000000-0000-4000-8000-0000000000aa';
/** 13 oct 2026, 10:00 en Bogotá. */
const NOW = new Date('2026-10-13T15:00:00.000Z');
const BOM = '﻿';

function person(id: string, email: string, patch: Partial<DirectoryPersonRow> = {}) {
  return {
    id,
    email,
    name: null,
    status: 'active',
    email_verified_at: new Date('2026-01-01T00:00:00Z'),
    mfa_enabled_at: null,
    last_login_at: null,
    created_at: new Date('2026-10-01T15:30:00.000Z'),
    locked_until: null,
    cursor_at: '2026-10-01T15:30:00.000000Z',
    ...patch,
  };
}

function membership(
  userId: string,
  tenantId: string,
  tenantName: string,
  role: string,
  status = 'active',
) {
  return {
    user_id: userId,
    tenant_id: tenantId,
    tenant_name: tenantName,
    tenant_type: 'agency',
    is_branch: false,
    role,
    status,
  };
}

function member(patch: Partial<NetworkUser> = {}): NetworkUser {
  return {
    userId: ANA,
    email: 'ana@agencia.co',
    name: 'Ana Pérez',
    userStatus: 'active',
    role: 'vendedor',
    membershipStatus: 'active',
    createdAt: new Date('2026-09-01T13:05:00Z'),
    lastLoginAt: new Date('2026-10-12T22:15:00Z'),
    mfaEnabled: true,
    lockedUntil: null,
    activeSessions: 1,
    passwordResetRequired: false,
    ...patch,
  };
}

/**
 * El servicio sobre un Kysely que compila de verdad. `personas`, `nodos`: lo que devuelven la
 * consulta del directorio y la de sus nodos; `equipo` y `overview`: las de Equipo; `nodo`: si el nodo
 * existe; `rastroFalla`: la base no deja escribir el evento.
 */
function banco(
  opts: {
    personas?: unknown[];
    nodos?: unknown[];
    equipo?: unknown[];
    overview?: unknown[];
    nodo?: { name: string; slug: string } | null;
    rastroFalla?: boolean;
  } = {},
) {
  const scripted = scriptedKysely((q: CompiledQuery) => {
    const s = q.sql;
    if (s.startsWith('insert into "domain_events"')) {
      if (opts.rastroFalla === true) {
        throw Object.assign(new Error('could not extend file'), { code: '53100' });
      }
      return [];
    }
    if (s.includes('to_char(u.created_at')) return opts.personas ?? [];
    if (s.includes('from "memberships" as "m"')) return opts.nodos ?? [];
    if (s.includes('user_admin_overview(')) return opts.overview ?? [];
    if (s.includes('from "memberships" inner join "users"')) return opts.equipo ?? [];
    if (s.includes('"tenant_type" =')) return [{ id: PLATAFORMA }];
    if (s.includes('from "tenants"')) {
      return opts.nodo === null ? [] : [opts.nodo ?? { name: 'Agencia Norte', slug: 'norte' }];
    }
    return [];
  });
  const contexts: unknown[] = [];
  const database = new DatabaseService();
  database.db = scripted.db;
  const withContext = database.withRequestContext.bind(database);
  database.withRequestContext = (ctx, fn) => {
    contexts.push(ctx);
    return withContext(ctx, fn);
  };
  const service = new UserExportService(database, new AuditService(database));
  const eventos = () =>
    scripted.queries
      .filter((q) => q.sql.startsWith('insert into "domain_events"'))
      .map((q) => ({
        tenantId: q.parameters[0],
        actor: q.parameters[1],
        eventType: q.parameters[2],
        payload: JSON.parse(String(q.parameters[5])) as Record<string, unknown>,
      }));
  return { service, scripted, eventos, contexts };
}

function lines(csv: string): string[] {
  expect(csv.startsWith(BOM)).toBe(true);
  expect(csv.endsWith('\r\n')).toBe(true);
  return csv.slice(BOM.length).trimEnd().split('\r\n');
}

describe('las fechas, en hora de Bogotá', () => {
  it('un instante en UTC pasa a Bogotá, también cuando ya es el día siguiente en UTC', () => {
    expect(bogotaDateTime(new Date('2026-10-13T15:00:00Z'))).toBe('2026-10-13 10:00');
    expect(bogotaDateTime('2026-10-14T03:30:59Z')).toBe('2026-10-13 22:30');
    expect(bogotaDateTime(new Date('2026-01-01T05:00:00Z'))).toBe('2026-01-01 00:00');
  });

  it('sin fecha o ilegible, la celda va vacía', () => {
    expect(bogotaDateTime(null)).toBe('');
    expect(bogotaDateTime(undefined)).toBe('');
    expect(bogotaDateTime('no es una fecha')).toBe('');
  });

  it('el encabezado dice la zona', () => {
    expect(PLATFORM_USERS_CSV_HEADER).toEqual([
      'Correo',
      'Nombre',
      'Nodo',
      'Rol',
      'Estado en el nodo',
      'Estado de la cuenta',
      '2FA',
      'Último ingreso (hora de Bogotá UTC-5)',
      'Alta de la cuenta (hora de Bogotá UTC-5)',
    ]);
    expect(TEAM_CSV_HEADER.at(-1)).toBe('Alta en el nodo (hora de Bogotá UTC-5)');
    expect(TEAM_CSV_HEADER.slice(0, -1)).toEqual(PLATFORM_USERS_CSV_HEADER.slice(0, -1));
  });

  it('el nombre del archivo lleva el día de Bogotá y, del nodo, un slug limpio', () => {
    // 22:00 del 13 en Bogotá ya es el 14 en UTC.
    const night = new Date('2026-10-14T03:00:00Z');
    expect(usersExportFilename(night)).toBe('usuarios-2026-10-13.csv');
    expect(usersExportFilename(NOW, 'agencia-norte')).toBe('equipo-agencia-norte-2026-10-13.csv');
    expect(usersExportFilename(NOW, 'Agencia "Norte"; =x')).toBe(
      'equipo-agencia-norte-x-2026-10-13.csv',
    );
    expect(usersExportFilename(NOW, '¡¡!!')).toBe('equipo-2026-10-13.csv');
    expect(usersExportFilename(NOW, 'a'.repeat(200))).toBe(
      `equipo-${'a'.repeat(60)}-2026-10-13.csv`,
    );
  });
});

describe('las filas: lo mínimo para revisar accesos', () => {
  it('una por persona y nodo; quien no tiene nodos sale con "Sin nodos"', () => {
    const nodes = new Map<string, PlatformUserMembership[]>([
      [
        ANA,
        [
          {
            tenantId: NODO,
            tenantName: 'Agencia Norte',
            tenantType: 'agency',
            isBranch: false,
            role: 'vendedor',
            status: 'active',
          },
          {
            tenantId: OTRO_NODO,
            tenantName: 'Sucursal Centro',
            tenantType: 'agency',
            isBranch: true,
            role: 'agency_admin',
            status: 'suspended',
          },
        ],
      ],
    ]);
    const out = platformUserLines(
      [
        person(ANA, 'ana@agencia.co', {
          name: 'Ana Pérez',
          mfa_enabled_at: new Date('2026-02-01T00:00:00Z'),
          last_login_at: new Date('2026-10-12T22:15:00Z'),
        }),
        person(BETO, 'beto@agencia.co', { status: 'suspended' }),
      ],
      nodes,
    );
    expect(out).toEqual([
      [
        'ana@agencia.co',
        'Ana Pérez',
        'Agencia Norte',
        'Vendedor',
        'Activo',
        'Activa',
        'Sí',
        '2026-10-12 17:15',
        '2026-10-01 10:30',
      ],
      [
        'ana@agencia.co',
        'Ana Pérez',
        'Sucursal Centro',
        'Admin de agencia',
        'Suspendido',
        'Activa',
        'Sí',
        '2026-10-12 17:15',
        '2026-10-01 10:30',
      ],
      [
        'beto@agencia.co',
        null,
        'Sin nodos',
        null,
        null,
        'Suspendida',
        'No',
        '',
        '2026-10-01 10:30',
      ],
    ]);
  });

  it('el equipo de un nodo: el alta es la del nodo; un rol o estado desconocido sale con su código', () => {
    expect(
      teamLines('Agencia Norte', [
        member(),
        member({
          email: 'beto@agencia.co',
          name: null,
          role: 'rol_nuevo',
          membershipStatus: 'otro',
          userStatus: 'suspended',
          mfaEnabled: false,
          lastLoginAt: null,
        }),
      ]),
    ).toEqual([
      [
        'ana@agencia.co',
        'Ana Pérez',
        'Agencia Norte',
        'Vendedor',
        'Activo',
        'Activa',
        'Sí',
        '2026-10-12 17:15',
        '2026-09-01 08:05',
      ],
      [
        'beto@agencia.co',
        null,
        'Agencia Norte',
        'rol_nuevo',
        'otro',
        'Suspendida',
        'No',
        '',
        '2026-09-01 08:05',
      ],
    ]);
  });

  it('nunca salen hashes, secretos, sesiones ni bloqueos, aunque la fila los traiga', () => {
    const row = {
      ...person(ANA, 'ana@agencia.co'),
      password_hash: '$2b$12$secreto',
      mfa_secret: 'JBSWY3DPEHPK3PXP',
      session_id: 'ses-1',
    } as DirectoryPersonRow;
    const out = JSON.stringify(platformUserLines([row], new Map()));
    expect(out).not.toMatch(/\$2b|JBSWY|ses-1|locked/);
    const team = JSON.stringify(teamLines('N', [member({ activeSessions: 3 })]));
    expect(team).not.toContain('passwordResetRequired');
  });
});

describe('las celdas que una planilla tomaría por fórmula (CSV injection)', () => {
  const HOSTIL = [
    '=HYPERLINK("http://evil.test","clic")',
    '+cmd|/C calc!A0',
    '-2+3',
    '@SUM(1+1)',
    '\t=1+1',
    '\r=1+1',
  ];

  it.each(HOSTIL)(
    '%j en un nombre, un correo o un nodo lleva el apóstrofo y va entre comillas si hace falta',
    async (hostil) => {
      const { service } = banco({
        personas: [person(ANA, `${hostil}@x.co`, { name: hostil })],
        nodos: [membership(ANA, NODO, hostil, 'vendedor')],
      });
      const out = await service.exportPlatform(
        SUPERADMIN,
        PlatformUsersExportQuerySchema.parse({}),
      );
      const body = lines(out.csv)[1] ?? '';
      // Ninguna celda empieza con el carácter peligroso: o lleva el apóstrofo, o va entre comillas
      // con el apóstrofo adentro.
      const cells = body.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? [];
      for (const cell of cells.slice(0, 3)) {
        const raw = cell.replace(/,$/, '');
        const inner = raw.startsWith('"') ? raw.slice(1, -1) : raw;
        expect(inner.startsWith("'"), raw).toBe(true);
      }
    },
  );

  it('una comilla, una coma, un punto y coma o un salto de línea van entre comillas y no cortan la fila', async () => {
    const { service } = banco({
      personas: [person(ANA, 'ana@x.co', { name: 'Ana "la jefa", Ruiz; =1\nsegunda' })],
    });
    const out = await service.exportPlatform(SUPERADMIN, PlatformUsersExportQuerySchema.parse({}));
    expect(out.csv).toContain('"Ana ""la jefa"", Ruiz; =1\nsegunda"');
    // Encabezado y una persona: el salto de línea va dentro de la celda.
    expect(out.csv.slice(BOM.length).trimEnd().split('\r\n')).toHaveLength(2);
  });
});

describe('UserExportService.exportPlatform', () => {
  it('lee con el contexto del superadmin y deja el rastro en la raíz, después de leer y en la misma transacción', async () => {
    const { service, scripted, eventos, contexts } = banco({
      personas: [
        person(ANA, 'ana@agencia.co', { name: 'Ana Pérez' }),
        person(BETO, 'beto@agencia.co'),
      ],
      nodos: [
        membership(ANA, NODO, 'Agencia Norte', 'vendedor'),
        membership(ANA, OTRO_NODO, 'Sucursal Centro', 'admin', 'suspended'),
      ],
    });
    const query = PlatformUsersExportQuerySchema.parse({
      q: 'ana@agencia.co',
      role: 'vendedor',
      tenantId: NODO,
      mfa: 'off',
      neverLoggedIn: 'true',
    });

    const out = await requestContextStorage.run(
      { userId: SUPERADMIN, ip: '10.0.0.1', requestId: 'req-x' },
      () => service.exportPlatform(SUPERADMIN, query, NOW),
    );

    expect(contexts).toEqual([{ userId: SUPERADMIN }]);
    expect(out).toMatchObject({
      filename: 'usuarios-2026-10-13.csv',
      users: 2,
      rows: 3,
      truncated: false,
    });
    expect(lines(out.csv)).toEqual([
      PLATFORM_USERS_CSV_HEADER.join(','),
      'ana@agencia.co,Ana Pérez,Agencia Norte,Vendedor,Activo,Activa,No,,2026-10-01 10:30',
      'ana@agencia.co,Ana Pérez,Sucursal Centro,Manager,Suspendido,Activa,No,,2026-10-01 10:30',
      'beto@agencia.co,,Sin nodos,,,Activa,No,,2026-10-01 10:30',
    ]);

    expect(eventos()).toEqual([
      {
        tenantId: PLATAFORMA,
        actor: SUPERADMIN,
        eventType: USERS_EXPORTED_EVENT,
        payload: {
          scope: 'platform',
          filters: {
            search: true,
            status: null,
            role: 'vendedor',
            tenantId: NODO,
            mfa: 'off',
            locked: false,
            neverLoggedIn: true,
          },
          users: 2,
          rows: 3,
          truncated: false,
        },
      },
    ]);
    // El rastro no lleva correos: ni los exportados ni el que se buscó.
    expect(JSON.stringify(eventos())).not.toContain('@');
    expect(scripted.indexOf('insert into "domain_events"')).toBeGreaterThan(
      scripted.indexOf('from "memberships" as "m"'),
    );
  });

  it('la consulta de personas es la del directorio, con los mismos filtros, y pide una de más que el tope', async () => {
    const raw = { q: 'ana', status: 'active', role: 'admin', tenantId: NODO, locked: 'true' };
    const { service, scripted } = banco();
    await service.exportPlatform(SUPERADMIN, PlatformUsersExportQuerySchema.parse(raw), NOW);

    const ran = scripted.queries[scripted.indexOf('to_char(u.created_at')]!;
    const screen = directoryQuery(scripted.db, ListPlatformUsersQuerySchema.parse(raw)).compile();
    expect(ran.sql).toBe(screen.sql);
    expect(ran.parameters.slice(0, -1)).toEqual(screen.parameters.slice(0, -1));
    expect(ran.parameters.at(-1)).toBe(USER_EXPORT_MAX_USERS + 1);
    // Sin cursor: el archivo empieza por el principio, no por una página.
    expect(ran.sql).not.toContain('(u.created_at, u.id) <');
  });

  it('sin nadie con esos filtros igual queda el rastro y sale sólo el encabezado; no pregunta por nodos', async () => {
    const { service, scripted, eventos } = banco({ personas: [] });
    const out = await service.exportPlatform(SUPERADMIN, PlatformUsersExportQuerySchema.parse({}));
    expect(out).toMatchObject({ users: 0, rows: 0, truncated: false });
    expect(out.csv).toBe(`${BOM}${PLATFORM_USERS_CSV_HEADER.join(',')}\r\n`);
    expect(scripted.indexOf('from "memberships" as "m"')).toBe(-1);
    expect(eventos()[0]?.payload).toMatchObject({ users: 0, rows: 0 });
  });

  it(`más de ${USER_EXPORT_MAX_USERS} personas: exporta las del tope y lo dice`, async () => {
    const personas = Array.from({ length: USER_EXPORT_MAX_USERS + 1 }, (_, i) =>
      person(`${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, `p${i}@x.co`),
    );
    const { service, eventos, scripted } = banco({ personas });
    const out = await service.exportPlatform(SUPERADMIN, PlatformUsersExportQuerySchema.parse({}));
    expect(out).toMatchObject({
      users: USER_EXPORT_MAX_USERS,
      rows: USER_EXPORT_MAX_USERS,
      truncated: true,
    });
    expect(lines(out.csv)).toHaveLength(USER_EXPORT_MAX_USERS + 1);
    expect(eventos()[0]?.payload).toMatchObject({ users: USER_EXPORT_MAX_USERS, truncated: true });
    // Los nodos, de las del tope nada más, en un solo arreglo.
    const nodos = scripted.queries[scripted.indexOf('from "memberships" as "m"')]!;
    expect((nodos.parameters[0] as string[]).length).toBe(USER_EXPORT_MAX_USERS);
  });

  it('si el rastro no se escribe, no sale el archivo: el error sube', async () => {
    const { service, scripted } = banco({
      personas: [person(ANA, 'ana@agencia.co')],
      rastroFalla: true,
    });
    await expect(
      service.exportPlatform(SUPERADMIN, PlatformUsersExportQuerySchema.parse({})),
    ).rejects.toMatchObject({ code: '53100' });
    // Se leyó, pero el CSV nunca llega a quien lo pidió.
    expect(scripted.indexOf('to_char(u.created_at')).toBeGreaterThanOrEqual(0);
  });
});

describe('UserExportService.exportTeam', () => {
  it('el equipo del nodo con el contexto del nodo, y el rastro en el nodo', async () => {
    const { service, scripted, eventos, contexts } = banco({
      nodo: { name: 'Agencia Norte', slug: 'agencia-norte' },
      equipo: [
        {
          userId: ANA,
          email: 'ana@agencia.co',
          name: 'Ana Pérez',
          userStatus: 'active',
          role: 'tenant_admin',
          membershipStatus: 'active',
          createdAt: new Date('2026-09-01T13:05:00Z'),
        },
      ],
      overview: [
        {
          user_id: ANA,
          last_login_at: new Date('2026-10-12T22:15:00Z'),
          mfa_enabled: true,
          locked_until: null,
          active_sessions: '1',
          password_reset_required: false,
        },
      ],
    });

    const out = await service.exportTeam(SUPERADMIN, NODO, NOW);

    expect(contexts).toEqual([{ userId: SUPERADMIN, tenantId: NODO }]);
    expect(out).toMatchObject({
      filename: 'equipo-agencia-norte-2026-10-13.csv',
      users: 1,
      rows: 1,
      truncated: false,
    });
    expect(lines(out.csv)).toEqual([
      TEAM_CSV_HEADER.join(','),
      'ana@agencia.co,Ana Pérez,Agencia Norte,Admin,Activo,Activa,Sí,2026-10-12 17:15,2026-09-01 08:05',
    ]);
    expect(eventos()).toEqual([
      {
        tenantId: NODO,
        actor: SUPERADMIN,
        eventType: USERS_EXPORTED_EVENT,
        payload: {
          scope: 'node',
          filters: { tenantId: NODO },
          users: 1,
          rows: 1,
          truncated: false,
        },
      },
    ]);
    // La lista de Equipo: sin quitados, por alta en el nodo, con una de más que el tope.
    const equipo = scripted.queries[scripted.indexOf('from "memberships" inner join "users"')]!;
    expect(equipo.sql).toContain('"memberships"."status" != $2');
    expect(equipo.sql).toContain('order by "memberships"."created_at"');
    expect(equipo.parameters).toEqual([NODO, 'removed', USER_EXPORT_MAX_USERS + 1]);
    expect(scripted.indexOf('insert into "domain_events"')).toBeGreaterThan(
      scripted.indexOf('user_admin_overview('),
    );
  });

  it('si el nodo ya no existe: 403 como cualquier nodo ajeno, sin leer ni dejar rastro', async () => {
    const { service, scripted, eventos } = banco({ nodo: null });
    await expect(service.exportTeam(SUPERADMIN, NODO, NOW)).rejects.toBeInstanceOf(
      TenantNotManagedError,
    );
    expect(scripted.indexOf('from "memberships"')).toBe(-1);
    expect(eventos()).toEqual([]);
  });

  it('si el rastro no se escribe, no sale el archivo', async () => {
    const { service } = banco({ rastroFalla: true });
    await expect(service.exportTeam(SUPERADMIN, NODO, NOW)).rejects.toMatchObject({
      code: '53100',
    });
  });
});

describe('los filtros en el rastro', () => {
  it('la búsqueda sólo como "hubo una"; los demás filtros como se aplicaron', () => {
    expect(exportedDirectoryFilters(PlatformUsersExportQuerySchema.parse({}))).toEqual({
      search: false,
      status: null,
      role: null,
      tenantId: null,
      mfa: null,
      locked: false,
      neverLoggedIn: false,
    });
    expect(
      exportedDirectoryFilters(
        PlatformUsersExportQuerySchema.parse({
          q: 'ana@x.co',
          status: 'suspended',
          locked: 'true',
        }),
      ),
    ).toMatchObject({ search: true, status: 'suspended', locked: true });
  });

  it('el esquema es el del directorio sin paginar: un cursor o un límite son 400', () => {
    expect(PlatformUsersExportQuerySchema.safeParse({ cursor: 'abc' }).success).toBe(false);
    expect(PlatformUsersExportQuerySchema.safeParse({ limit: '10' }).success).toBe(false);
    expect(PlatformUsersExportQuerySchema.safeParse({ otro: '1' }).success).toBe(false);
    expect(PlatformUsersExportQuerySchema.safeParse({ role: 'vendedor', mfa: 'on' }).success).toBe(
      true,
    );
  });
});
