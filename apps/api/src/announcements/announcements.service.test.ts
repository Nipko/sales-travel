import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import {
  AnnouncementArchivedError,
  AnnouncementAudienceNotFoundError,
  AnnouncementNotFoundError,
  AnnouncementWindowError,
} from './announcements.errors.js';
import {
  ANNOUNCEMENT_MAX_WINDOW_MS,
  announcementWindowError,
  cleanAnnouncementBody,
  cleanAnnouncementTitle,
  CreateAnnouncementSchema,
  UpdateAnnouncementSchema,
  type CreateAnnouncementDto,
} from './announcements.schemas.js';
import {
  ADMIN_ANNOUNCEMENTS_LIMIT,
  ANNOUNCEMENT_EVENTS,
  announcementStatus,
  AnnouncementsService,
} from './announcements.service.js';

/*
 * Los anuncios de la plataforma sin base: lo que entra (texto plano, 31 días como mucho), cómo se
 * deriva el estado y qué consultas arma el servicio. Lo que decide la base —RLS, quién ve qué en la
 * red— lo prueba announcements.integration.test.ts contra Postgres.
 */

const SUPERADMIN = '99999999-9999-4999-8999-999999999999';
const NODO = '11111111-1111-4111-8111-111111111111';
const PLATAFORMA = '00000000-0000-4000-8000-0000000000aa';
const ANUNCIO = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-13T12:00:00.000Z');
const DAY = 86_400_000;

const at = (ms: number) => new Date(NOW.getTime() + ms);

// ───────────────────────────── Lo que entra ─────────────────────────────

function valid(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: 'warning',
    title: 'TBO en mantenimiento',
    body: 'El sábado de 02:00 a 04:00 (hora Bogotá).',
    audience: { rootTenantId: null, adminsOnly: false },
    endsAt: at(DAY).toISOString(),
    ...extra,
  };
}

describe('CreateAnnouncementSchema', () => {
  it('quita los caracteres de control y los invisibles; el mensaje conserva sus saltos de línea', () => {
    const parsed = CreateAnnouncementSchema.parse(
      valid({
        title: '  TBO\u0007 en\nmante\u200Bnimiento\u202E ',
        body: 'Línea uno\r\nLínea\tdos\u0000\u001B[31m\n\n\n\nFin\u2066 ',
      }),
    );
    expect(parsed.title).toBe('TBO en mantenimiento');
    expect(parsed.body).toBe('Línea uno\nLínea dos[31m\n\nFin');
  });

  it('el título va en una línea y el mensaje es opcional (vacío)', () => {
    expect(cleanAnnouncementTitle('Uno\r\nDos\tTres')).toBe('Uno Dos Tres');
    expect(CreateAnnouncementSchema.parse(valid({ body: undefined })).body).toBe('');
    expect(cleanAnnouncementBody('  \n hola \n  ')).toBe('hola');
  });

  it('el título tiene entre 3 y 120 caracteres después de limpiarlo', () => {
    expect(CreateAnnouncementSchema.safeParse(valid({ title: ' \u0007a\u200Bb ' })).success).toBe(
      false,
    );
    expect(CreateAnnouncementSchema.safeParse(valid({ title: 'x'.repeat(120) })).success).toBe(
      true,
    );
    expect(CreateAnnouncementSchema.safeParse(valid({ title: 'x'.repeat(121) })).success).toBe(
      false,
    );
  });

  it('los topes se cuentan en puntos de código, como varchar: 600 emojis entran', () => {
    expect(CreateAnnouncementSchema.safeParse(valid({ body: '🛫'.repeat(600) })).success).toBe(
      true,
    );
    expect(CreateAnnouncementSchema.safeParse(valid({ body: 'a'.repeat(601) })).success).toBe(
      false,
    );
  });

  it('31 días como mucho desde el comienzo, y termina después de empezar', () => {
    const startsAt = NOW.toISOString();
    const ok = CreateAnnouncementSchema.safeParse(
      valid({ startsAt, endsAt: at(ANNOUNCEMENT_MAX_WINDOW_MS).toISOString() }),
    );
    expect(ok.success).toBe(true);

    const largo = CreateAnnouncementSchema.safeParse(
      valid({ startsAt, endsAt: at(ANNOUNCEMENT_MAX_WINDOW_MS + 1).toISOString() }),
    );
    expect(largo.success).toBe(false);
    expect(largo.error?.issues[0]).toMatchObject({
      path: ['endsAt'],
      message: 'Un anuncio dura como mucho 31 días.',
    });

    const alReves = CreateAnnouncementSchema.safeParse(valid({ startsAt, endsAt: startsAt }));
    expect(alReves.error?.issues[0]?.message).toBe(
      'El anuncio tiene que terminar después de empezar.',
    );
  });

  it('estricto: sin campos de más, con fechas ISO y el nodo como UUID en minúsculas', () => {
    expect(CreateAnnouncementSchema.safeParse(valid({ html: '<b>' })).success).toBe(false);
    expect(
      CreateAnnouncementSchema.safeParse(
        valid({ audience: { rootTenantId: null, adminsOnly: false, roles: ['vendedor'] } }),
      ).success,
    ).toBe(false);
    expect(CreateAnnouncementSchema.safeParse(valid({ endsAt: 'mañana' })).success).toBe(false);
    expect(CreateAnnouncementSchema.safeParse(valid({ severity: 'urgent' })).success).toBe(false);
    expect(
      CreateAnnouncementSchema.safeParse(
        valid({ audience: { rootTenantId: 'nodo-1', adminsOnly: true } }),
      ).success,
    ).toBe(false);
    const upper = CreateAnnouncementSchema.parse(
      valid({ audience: { rootTenantId: NODO.toUpperCase(), adminsOnly: true } }),
    );
    expect(upper.audience).toEqual({ rootTenantId: NODO, adminsOnly: true });
  });
});

describe('UpdateAnnouncementSchema', () => {
  it('cualquier campo, al menos uno, con las mismas reglas', () => {
    expect(UpdateAnnouncementSchema.safeParse({}).success).toBe(false);
    expect(UpdateAnnouncementSchema.parse({ title: ' Nuevo\u0007 título ' })).toEqual({
      title: 'Nuevo título',
    });
    expect(UpdateAnnouncementSchema.safeParse({ title: 'ok', extra: 1 }).success).toBe(false);
  });
});

describe('announcementWindowError y announcementStatus', () => {
  it('la vigencia', () => {
    expect(announcementWindowError(NOW, at(DAY))).toBeUndefined();
    expect(announcementWindowError(NOW, NOW)).toBeDefined();
    expect(announcementWindowError(NOW, at(32 * DAY))).toBe('Un anuncio dura como mucho 31 días.');
  });

  it('programado, vigente, vencido; archivado gana a todo', () => {
    const row = (starts: number, ends: number, archived: Date | null = null) => ({
      starts_at: at(starts),
      ends_at: at(ends),
      archived_at: archived,
    });
    expect(announcementStatus(row(DAY, 2 * DAY), NOW)).toBe('scheduled');
    expect(announcementStatus(row(0, DAY), NOW)).toBe('active');
    expect(announcementStatus(row(-2 * DAY, 0), NOW)).toBe('expired');
    expect(announcementStatus(row(-DAY, DAY, NOW), NOW)).toBe('archived');
  });
});

// ───────────────────────────── El servicio ─────────────────────────────

class DriverQueGraba extends DummyDriver {
  constructor(private readonly responder: (q: CompiledQuery) => unknown[]) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const base = await super.acquireConnection();
    return {
      executeQuery: <R>(q: CompiledQuery): Promise<QueryResult<R>> => {
        try {
          return Promise.resolve({ rows: this.responder(q) as R[] });
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
      streamQuery: (q, chunkSize) => base.streamQuery(q, chunkSize),
    };
  }
}

interface Fila {
  severity: string;
  title: string;
  body: string;
  audience_root_tenant_id: string | null;
  audience_admins_only: boolean;
  starts_at: Date;
  ends_at: Date;
  archived_at: Date | null;
}

function fila(extra: Partial<Fila> = {}): Fila {
  return {
    severity: 'info',
    title: 'Aviso',
    body: 'Cuerpo',
    audience_root_tenant_id: null,
    audience_admins_only: false,
    starts_at: at(-DAY),
    ends_at: at(DAY),
    archived_at: null,
    ...extra,
  };
}

/**
 * Un servicio sobre un Kysely que compila de verdad y responde según la consulta. `superadmin` es
 * lo que contesta is_platform_superadmin(); `actual`, el anuncio que se bloquea (o ninguno);
 * `nodo`, si el nodo del público existe; `falla`, un error de la base en el INSERT.
 */
function banco(
  opts: {
    superadmin?: boolean;
    actual?: Fila | null;
    nodo?: boolean;
    activos?: unknown[];
    falla?: Error;
  } = {},
) {
  const consultas: CompiledQuery[] = [];
  const responder = (q: CompiledQuery): unknown[] => {
    const s = q.sql;
    if (s.includes('set_config') || /^(begin|commit|rollback)/i.test(s)) return [];
    if (s.includes('is_platform_superadmin()')) return [{ ok: opts.superadmin ?? true }];
    if (s.includes('active_announcements()')) return opts.activos ?? [];
    if (s.includes('SELECT now() AS now')) return [{ now: NOW }];
    if (s.includes('"tenant_type" =')) return [{ id: PLATAFORMA }];
    if (s.includes('from "tenants" where "id" =')) return opts.nodo === false ? [] : [{ id: NODO }];
    if (s.startsWith('insert into "system_announcements"')) {
      if (opts.falla) throw opts.falla;
      return [{ id: ANUNCIO }];
    }
    if (s.includes('for update'))
      return opts.actual === null ? [] : [{ id: ANUNCIO, ...(opts.actual ?? fila()) }];
    if (s.includes('as "db_now"')) {
      const base = opts.actual ?? fila();
      return [
        {
          id: ANUNCIO,
          ...base,
          audience_root_name: base.audience_root_tenant_id === null ? null : 'Consolidador Norte',
          created_at: at(-DAY),
          updated_at: at(-DAY),
          db_now: NOW,
        },
      ];
    }
    return [];
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new DriverQueGraba((q) => {
          consultas.push(q);
          return responder(q);
        }),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const database = new DatabaseService();
  database.db = db;
  const service = new AnnouncementsService(database, new AuditService(database));
  const negocio = () =>
    consultas.filter(
      (q) => !q.sql.includes('set_config') && !/^(begin|commit|rollback)/i.test(q.sql),
    );
  const contexto = () =>
    consultas
      .filter((q) => q.sql.includes('set_config'))
      .map((q) => [/set_config\('([^']+)'/.exec(q.sql)?.[1], q.parameters[0]]);
  const eventos = () =>
    negocio()
      .filter((q) => q.sql.startsWith('insert into "domain_events"'))
      .map((q) => ({
        tenantId: q.parameters[0],
        actor: q.parameters[1],
        eventType: q.parameters[2],
        aggregateType: q.parameters[3],
        aggregateId: q.parameters[4],
        payload: JSON.parse(String(q.parameters[5])) as Record<string, unknown>,
      }));
  const escrituras = () =>
    negocio().filter((q) => /^(insert into|update) "system_announcements"/.test(q.sql));
  return { service, negocio, contexto, eventos, escrituras };
}

/** Un pedido ya validado; las fechas viajan como ISO, igual que desde el panel. */
function dto(extra: Partial<CreateAnnouncementDto> = {}): CreateAnnouncementDto {
  const { startsAt, endsAt, ...rest } = extra;
  return CreateAnnouncementSchema.parse({
    ...valid(),
    ...rest,
    ...(startsAt === undefined ? {} : { startsAt: startsAt.toISOString() }),
    ...(endsAt === undefined ? {} : { endsAt: endsAt.toISOString() }),
  });
}

describe('AnnouncementsService.active', () => {
  it('sin nodo activo no hay a quién mostrarle nada: ni toca la base', async () => {
    const b = banco();
    await expect(b.service.active(SUPERADMIN, undefined)).resolves.toEqual([]);
    expect(b.negocio()).toEqual([]);
  });

  it('una sola llamada a active_announcements(), con el usuario y el nodo del request', async () => {
    const b = banco({
      activos: [
        {
          id: ANUNCIO,
          severity: 'critical',
          title: 'Caída',
          body: 'Uno\nDos',
          starts_at: at(-DAY),
          ends_at: at(DAY),
        },
      ],
    });
    const out = await b.service.active(SUPERADMIN, NODO);
    expect(b.contexto()).toEqual([
      ['app.current_user_id', SUPERADMIN],
      ['app.current_tenant_id', NODO],
    ]);
    expect(b.negocio()).toHaveLength(1);
    expect(b.negocio()[0]?.parameters).toEqual([]);
    expect(out).toEqual([
      {
        id: ANUNCIO,
        severity: 'critical',
        title: 'Caída',
        body: 'Uno\nDos',
        startsAt: at(-DAY).toISOString(),
        endsAt: at(DAY).toISOString(),
      },
    ]);
  });
});

describe('AnnouncementsService: escribe sólo el superadmin', () => {
  it('si la base dice que ya no lo es: 403 y nada escrito', async () => {
    const b = banco({ superadmin: false });
    await expect(b.service.create(SUPERADMIN, dto())).rejects.toBeInstanceOf(
      SuperadminRequiredError,
    );
    await expect(b.service.list(SUPERADMIN)).rejects.toBeInstanceOf(SuperadminRequiredError);
    expect(b.escrituras()).toEqual([]);
    expect(b.eventos()).toEqual([]);
  });

  it('el 42501 de la RLS es el mismo 403; la FK y el CHECK, los errores de la app', async () => {
    const rls = Object.assign(new Error('new row violates row-level security policy'), {
      code: '42501',
    });
    await expect(banco({ falla: rls }).service.create(SUPERADMIN, dto())).rejects.toBeInstanceOf(
      SuperadminRequiredError,
    );
    const fk = Object.assign(new Error('fk'), {
      code: '23503',
      constraint: 'system_announcements_audience_root_tenant_id_fkey',
    });
    await expect(banco({ falla: fk }).service.create(SUPERADMIN, dto())).rejects.toBeInstanceOf(
      AnnouncementAudienceNotFoundError,
    );
    const window = Object.assign(new Error('check'), {
      code: '23514',
      constraint: 'system_announcements_window',
    });
    await expect(banco({ falla: window }).service.create(SUPERADMIN, dto())).rejects.toBeInstanceOf(
      AnnouncementWindowError,
    );
    const otro = Object.assign(new Error('otro'), { code: '23514', constraint: 'otro' });
    await expect(banco({ falla: otro }).service.create(SUPERADMIN, dto())).rejects.toBe(otro);
  });
});

describe('AnnouncementsService.create', () => {
  it('publica con la hora de la base como comienzo, a su nombre, y deja el rastro sin el mensaje', async () => {
    const b = banco();
    const view = await b.service.create(
      SUPERADMIN,
      dto({ audience: { rootTenantId: NODO, adminsOnly: true } }),
    );

    expect(b.contexto()).toEqual([['app.current_user_id', SUPERADMIN]]);
    const insert = b.escrituras()[0];
    expect(insert?.parameters).toEqual(
      expect.arrayContaining(['warning', 'TBO en mantenimiento', NODO, true, NOW, SUPERADMIN]),
    );
    expect(b.eventos()).toEqual([
      {
        tenantId: PLATAFORMA,
        actor: SUPERADMIN,
        eventType: ANNOUNCEMENT_EVENTS.published,
        aggregateType: 'system_announcement',
        aggregateId: ANUNCIO,
        payload: {
          announcementId: ANUNCIO,
          severity: 'warning',
          audience: { rootTenantId: NODO, adminsOnly: true },
          startsAt: NOW.toISOString(),
          endsAt: at(DAY).toISOString(),
        },
      },
    ]);
    const payload = JSON.stringify(b.eventos()[0]?.payload);
    expect(payload).not.toContain('mantenimiento');
    expect(payload).not.toContain('Bogotá');
    expect(view).toMatchObject({ id: ANUNCIO, status: 'active' });
  });

  it('un nodo que no existe es un 404 y no se escribe nada', async () => {
    const b = banco({ nodo: false });
    await expect(
      b.service.create(SUPERADMIN, dto({ audience: { rootTenantId: NODO, adminsOnly: false } })),
    ).rejects.toBeInstanceOf(AnnouncementAudienceNotFoundError);
    expect(b.escrituras()).toEqual([]);
  });

  it('sin comienzo, los 31 días se cuentan desde ahora; un final que ya pasó no se publica', async () => {
    await expect(
      banco().service.create(SUPERADMIN, dto({ endsAt: at(32 * DAY) })),
    ).rejects.toBeInstanceOf(AnnouncementWindowError);
    await expect(
      banco().service.create(SUPERADMIN, dto({ startsAt: at(-3 * DAY), endsAt: at(-DAY) })),
    ).rejects.toThrow('Ese final ya pasó: elige uno en el futuro.');
  });
});

describe('AnnouncementsService.list', () => {
  it(`los últimos ${ADMIN_ANNOUNCEMENTS_LIMIT}, del más nuevo al más viejo, con el estado de la hora de la base`, async () => {
    const b = banco({ actual: fila({ starts_at: at(DAY), ends_at: at(2 * DAY) }) });
    const list = await b.service.list(SUPERADMIN);
    const q = b.negocio().find((c) => c.sql.includes('as "db_now"'));
    expect(q?.sql).toContain('order by "a"."created_at" desc');
    expect(q?.parameters.at(-1)).toBe(ADMIN_ANNOUNCEMENTS_LIMIT);
    expect(list[0]).toMatchObject({
      status: 'scheduled',
      audience: { rootTenantId: null, rootTenantName: null, adminsOnly: false },
    });
  });
});

describe('AnnouncementsService.update', () => {
  it('uno que no existe es 404; uno archivado, 409', async () => {
    await expect(
      banco({ actual: null }).service.update(SUPERADMIN, ANUNCIO, { title: 'Otro' }),
    ).rejects.toBeInstanceOf(AnnouncementNotFoundError);
    await expect(
      banco({ actual: fila({ archived_at: at(-1) }) }).service.update(SUPERADMIN, ANUNCIO, {
        title: 'Otro',
      }),
    ).rejects.toBeInstanceOf(AnnouncementArchivedError);
  });

  it('sin cambios de verdad no escribe ni audita', async () => {
    const b = banco();
    await b.service.update(SUPERADMIN, ANUNCIO, { title: 'Aviso', severity: 'info' });
    expect(b.escrituras()).toEqual([]);
    expect(b.eventos()).toEqual([]);
  });

  it('cambiar sólo el final respeta los 31 días desde el comienzo que ya tiene', async () => {
    const b = banco({ actual: fila({ starts_at: at(-DAY) }) });
    await expect(
      b.service.update(SUPERADMIN, ANUNCIO, { endsAt: at(31 * DAY) }),
    ).rejects.toBeInstanceOf(AnnouncementWindowError);
    expect(b.escrituras()).toEqual([]);
  });

  it('el rastro nombra qué campos cambiaron, nunca sus valores', async () => {
    const b = banco();
    await b.service.update(SUPERADMIN, ANUNCIO, {
      title: 'Nuevo título',
      body: 'Nuevo mensaje secreto',
      audience: { rootTenantId: NODO, adminsOnly: true },
    });
    expect(b.escrituras()).toHaveLength(1);
    expect(b.eventos()).toEqual([
      expect.objectContaining({
        eventType: ANNOUNCEMENT_EVENTS.updated,
        aggregateId: ANUNCIO,
        payload: {
          announcementId: ANUNCIO,
          severity: 'info',
          audience: { rootTenantId: NODO, adminsOnly: true },
          changed: ['title', 'body', 'audience'],
        },
      }),
    ]);
    expect(JSON.stringify(b.eventos())).not.toContain('secreto');
  });
});

describe('AnnouncementsService.archive', () => {
  it('lo archiva con la hora de la base y deja el rastro con a quién iba', async () => {
    const b = banco({ actual: fila({ severity: 'critical', audience_root_tenant_id: NODO }) });
    await b.service.archive(SUPERADMIN, ANUNCIO);
    expect(b.escrituras()[0]?.sql).toContain('set "archived_at" = now()');
    expect(b.eventos()).toEqual([
      expect.objectContaining({
        eventType: ANNOUNCEMENT_EVENTS.archived,
        payload: {
          announcementId: ANUNCIO,
          severity: 'critical',
          audience: { rootTenantId: NODO, adminsOnly: false },
        },
      }),
    ]);
  });

  it('dos veces no: el segundo es 409', async () => {
    await expect(
      banco({ actual: fila({ archived_at: at(-1) }) }).service.archive(SUPERADMIN, ANUNCIO),
    ).rejects.toBeInstanceOf(AnnouncementArchivedError);
  });
});
