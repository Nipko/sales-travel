import type { CompiledQuery } from 'kysely';
import { describe, expect, it } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import { PlatformConsoleScopeNotFoundError } from '../admin-console/admin-console.errors.js';
import { DatabaseService } from '../database/database.service.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import { requestContextStorage } from '../request-context/request-context.js';
import {
  AdminAuditExportQuerySchema,
  AdminAuditQuerySchema,
  ADMIN_AUDIT_EXPORT_MAX_ROWS,
} from './admin-audit.schemas.js';
import {
  adminAuditEvent,
  adminAuditPage,
  AdminAuditService,
  auditCsv,
  auditMetaView,
  csvInstant,
  exportedFilters,
  PLATFORM_AUDIT_EXPORTED_EVENT,
  type AdminAuditRow,
} from './admin-audit.service.js';
import { decodeAuditCursor } from './audit.schemas.js';
import { AuditService } from './audit.service.js';

/*
 * Plataforma → Actividad sin base: cómo sale cada evento (payload sin claves sensibles, de `meta`
 * sólo IP, navegador y pedido), la página y su cursor, el CSV y qué consultas arma el servicio. Lo que
 * decide la base —quién puede, qué filas entran— lo prueba admin-audit.integration.test.ts.
 */

const SUPERADMIN = '99999999-9999-4999-8999-999999999999';
const ANA = '22222222-2222-4222-8222-222222222222';
const NODO = '11111111-1111-4111-8111-111111111111';
const PLATAFORMA = '00000000-0000-4000-8000-0000000000aa';
const E1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const E2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** 13 oct 2026, 10:00 en Bogotá. */
const NOW = new Date('2026-10-13T15:00:00.000Z');

function row(extra: Partial<AdminAuditRow> = {}): AdminAuditRow {
  return {
    id: E1,
    occurred_at: new Date('2026-10-13T14:41:12.123Z'),
    cursor_at: '2026-10-13T14:41:12.123456Z',
    event_type: 'ProviderCredentialsUpdated',
    tenant_id: NODO,
    tenant_name: 'Andes Travel',
    actor_user_id: ANA,
    actor_email: 'ana@agencia.com',
    target_email: null,
    aggregate_type: 'provider_account',
    aggregate_id: 'acc-1',
    payload: { providerCode: 'tbo-hotels', label: 'Principal', apiKey: 'sk_live_x' },
    meta: { ip: '190.1.2.3', userAgent: 'Mozilla/5.0', requestId: 'req-1', sessionId: 's-1' },
    ...extra,
  };
}

describe('cómo sale cada evento', () => {
  it('el payload sin claves sensibles y de meta sólo IP, navegador y pedido', () => {
    const view = adminAuditEvent(row());
    expect(view).toEqual({
      id: E1,
      occurredAt: '2026-10-13T14:41:12.123Z',
      eventType: 'ProviderCredentialsUpdated',
      tenantId: NODO,
      tenantName: 'Andes Travel',
      actorEmail: 'ana@agencia.com',
      targetEmail: null,
      aggregateType: 'provider_account',
      aggregateId: 'acc-1',
      payload: { providerCode: 'tbo-hotels', label: 'Principal' },
      meta: { ip: '190.1.2.3', userAgent: 'Mozilla/5.0', requestId: 'req-1' },
    });
    expect(JSON.stringify(view)).not.toMatch(/sessionId|s-1|sk_live/);
  });

  it('un meta raro no rompe nada: lo que no es texto es null y lo largo se corta', () => {
    expect(auditMetaView(null)).toEqual({ ip: null, userAgent: null, requestId: null });
    expect(auditMetaView(['x'])).toEqual({ ip: null, userAgent: null, requestId: null });
    expect(auditMetaView({ ip: 12, userAgent: ' ', requestId: 'r'.repeat(500) })).toEqual({
      ip: null,
      userAgent: null,
      requestId: 'r'.repeat(128),
    });
  });

  it('la página: la fila de más dice que hay otra, y el cursor lleva los microsegundos', () => {
    const rows = [row(), row({ id: E2, cursor_at: '2026-10-13T14:00:00.000001Z' }), row()];
    const page = adminAuditPage(rows, 2);
    expect(page.events.map((e) => e.id)).toEqual([E1, E2]);
    expect(decodeAuditCursor(page.nextCursor ?? '')).toEqual({
      occurredAt: '2026-10-13T14:00:00.000001Z',
      id: E2,
    });
    expect(adminAuditPage(rows.slice(0, 2), 2).nextCursor).toBeNull();
  });
});

describe('el CSV', () => {
  it('la hora de Bogotá con su desfase', () => {
    expect(csvInstant(new Date('2026-10-13T14:41:12.999Z'))).toBe('2026-10-13T09:41:12-05:00');
    expect(csvInstant('2026-10-13T04:30:00Z')).toBe('2026-10-12T23:30:00-05:00');
    expect(csvInstant('no es una fecha')).toBe('');
  });

  it('fecha, evento, nodo, actor, entidad, id e IP; nunca el payload ni el navegador', () => {
    const csv = auditCsv([
      row(),
      row({
        event_type: 'auth.login.failed',
        tenant_id: null,
        tenant_name: null,
        actor_email: null,
        aggregate_type: null,
        aggregate_id: null,
        meta: {},
      }),
      row({ tenant_name: null, actor_email: '=cmd@evil.com', aggregate_id: 'a,b' }),
    ]);
    expect(csv.split('\r\n')).toEqual([
      '\uFEFFfecha,evento,nodo,actor,entidad,id_entidad,ip',
      '2026-10-13T09:41:12-05:00,ProviderCredentialsUpdated,Andes Travel,ana@agencia.com,provider_account,acc-1,190.1.2.3',
      '2026-10-13T09:41:12-05:00,auth.login.failed,Plataforma,,,,',
      `2026-10-13T09:41:12-05:00,ProviderCredentialsUpdated,Nodo eliminado,'=cmd@evil.com,provider_account,"a,b",190.1.2.3`,
      '',
    ]);
    expect(csv).not.toMatch(/tbo-hotels|Mozilla|sk_live|req-1/);
  });
});

describe('exportedFilters', () => {
  it('los filtros como se aplicaron; quién actuó por su id, nunca el correo escrito', () => {
    const period = { from: '2026-10-07', to: '2026-10-13' };
    expect(exportedFilters({ category: 'orders' }, period, null)).toEqual({
      from: '2026-10-07',
      to: '2026-10-13',
      category: 'orders',
      eventType: null,
      actorUserId: null,
      tenantId: null,
      includePlatform: true,
      aggregateType: null,
      aggregateId: null,
    });
    const scoped = exportedFilters({ actorEmail: 'nadie@x.com', tenantId: NODO }, period, null);
    expect(scoped).toMatchObject({ actorNotFound: true, tenantId: NODO, includePlatform: false });
    expect(JSON.stringify(scoped)).not.toContain('nadie@x.com');
    expect(exportedFilters({ actorEmail: 'ana@agencia.com' }, period, ANA)).toMatchObject({
      actorUserId: ANA,
    });
  });
});

// ───────────────────────────── El servicio ─────────────────────────────

/**
 * El servicio sobre un Kysely que compila de verdad. `actor`: si el correo es de alguien; `nodo`: si
 * el nodo existe; `filas`: lo que devuelve admin_audit_events; `deniega`: la base dice que quien pide
 * no es el superadmin.
 */
function banco(
  opts: { actor?: boolean; nodo?: boolean; filas?: AdminAuditRow[]; deniega?: boolean } = {},
) {
  const scripted = scriptedKysely((q: CompiledQuery) => {
    const s = q.sql;
    if (s.includes('admin_audit_events(')) {
      if (opts.deniega === true) {
        throw Object.assign(new Error('admin_superadmin_required'), { code: '42501' });
      }
      return opts.filas ?? [];
    }
    if (s.includes('from "users"')) return opts.actor === false ? [] : [{ id: ANA }];
    if (s.includes('"tenant_type" =')) return [{ id: PLATAFORMA }];
    if (s.includes('from "tenants"')) return opts.nodo === false ? [] : [{ id: NODO }];
    return [];
  });
  const database = new DatabaseService();
  database.db = scripted.db;
  const service = new AdminAuditService(database, new AuditService(database));
  const lecturas = () => scripted.queries.filter((q) => q.sql.includes('admin_audit_events('));
  const eventos = () =>
    scripted.queries
      .filter((q) => q.sql.startsWith('insert into "domain_events"'))
      .map((q) => ({
        tenantId: q.parameters[0],
        actor: q.parameters[1],
        eventType: q.parameters[2],
        payload: JSON.parse(String(q.parameters[5])) as Record<string, unknown>,
        meta: JSON.parse(String(q.parameters[6])) as Record<string, unknown>,
      }));
  return { service, scripted, lecturas, eventos };
}

describe('AdminAuditService.list', () => {
  it('pasa a la función los días de Bogotá, los prefijos y una fila de más', async () => {
    const { service, lecturas, scripted } = banco({ filas: [row()] });
    const page = await service.list(
      SUPERADMIN,
      AdminAuditQuerySchema.parse({ category: 'providers', tenantId: NODO, limit: '20' }),
      NOW,
    );
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    const [q] = lecturas();
    expect(q?.parameters).toEqual([
      '2026-10-07',
      'America/Bogota',
      '2026-10-13',
      'America/Bogota',
      ['platform.provider', 'Provider', 'tenant.provider_disclosure'],
      null,
      null,
      null,
      NODO,
      false,
      null,
      null,
      null,
      null,
      21,
    ]);
    // Corre como quien pide: la guarda de la base lee app.current_user_id.
    expect(scripted.indexOf('set_config')).toBeGreaterThanOrEqual(0);
    expect(scripted.queries.find((x) => x.sql.includes('set_config'))?.parameters).toContain(
      SUPERADMIN,
    );
  });

  it('"Todo" excluye system.* y mira también los eventos sin nodo', async () => {
    const { service, lecturas } = banco();
    await service.list(SUPERADMIN, AdminAuditQuerySchema.parse({}), NOW);
    const params = lecturas()[0]?.parameters ?? [];
    expect(params[4]).toBeNull();
    expect(params[5]).toEqual(['system.']);
    expect(params[9]).toBe(true);
  });

  it('un correo que no es de nadie: lista vacía, sin leer el audit log', async () => {
    const { service, lecturas } = banco({ actor: false });
    const page = await service.list(
      SUPERADMIN,
      AdminAuditQuerySchema.parse({ actorEmail: 'nadie@x.com' }),
      NOW,
    );
    expect(page).toEqual({ events: [], nextCursor: null });
    expect(lecturas()).toHaveLength(0);
  });

  it('con un correo conocido filtra por su id', async () => {
    const { service, lecturas } = banco();
    await service.list(SUPERADMIN, AdminAuditQuerySchema.parse({ actorEmail: 'ANA@x.com' }), NOW);
    expect(lecturas()[0]?.parameters[7]).toBe(ANA);
  });

  it('un nodo que no existe: 404, sin leer', async () => {
    const { service, lecturas } = banco({ nodo: false });
    await expect(
      service.list(SUPERADMIN, AdminAuditQuerySchema.parse({ tenantId: NODO }), NOW),
    ).rejects.toBeInstanceOf(PlatformConsoleScopeNotFoundError);
    expect(lecturas()).toHaveLength(0);
  });

  it('el rechazo de la base es el mismo 403 que la guarda', async () => {
    const { service } = banco({ deniega: true });
    await expect(
      service.list(SUPERADMIN, AdminAuditQuerySchema.parse({}), NOW),
    ).rejects.toBeInstanceOf(SuperadminRequiredError);
  });
});

describe('AdminAuditService.exportCsv', () => {
  it('deja platform.audit.exported en la raíz, con filtros y filas, en la misma transacción', async () => {
    const { service, eventos, scripted } = banco({ filas: [row(), row({ id: E2 })] });
    const out = await requestContextStorage.run(
      { userId: SUPERADMIN, ip: '10.0.0.1', requestId: 'req-x', sessionId: 'ses-x' },
      () =>
        service.exportCsv(
          SUPERADMIN,
          AdminAuditExportQuerySchema.parse({ category: 'providers' }),
          NOW,
        ),
    );
    expect(out.rows).toBe(2);
    expect(out.truncated).toBe(false);
    expect(out.filename).toBe('actividad-2026-10-07-a-2026-10-13.csv');
    expect(out.csv.split('\r\n')).toHaveLength(4);

    expect(eventos()).toHaveLength(1);
    expect(eventos()[0]).toMatchObject({
      tenantId: PLATAFORMA,
      actor: SUPERADMIN,
      eventType: PLATFORM_AUDIT_EXPORTED_EVENT,
      payload: {
        filters: { category: 'providers', from: '2026-10-07', to: '2026-10-13' },
        rows: 2,
        truncated: false,
      },
      meta: { ip: '10.0.0.1', requestId: 'req-x' },
    });
    // La lectura y el rastro van en una sola transacción: el rastro después de leer.
    expect(scripted.indexOf('insert into "domain_events"')).toBeGreaterThan(
      scripted.indexOf('admin_audit_events('),
    );
    // Pide una de más para saber si se pasa de 5.000.
    const read = scripted.queries.find((q) => q.sql.includes('admin_audit_events('));
    expect(read?.parameters.at(-1)).toBe(ADMIN_AUDIT_EXPORT_MAX_ROWS + 1);
  });

  it('más de 5.000: exporta las 5.000 más nuevas y lo dice', async () => {
    const filas = Array.from({ length: ADMIN_AUDIT_EXPORT_MAX_ROWS + 1 }, () => row());
    const { service, eventos } = banco({ filas });
    const out = await service.exportCsv(SUPERADMIN, AdminAuditExportQuerySchema.parse({}), NOW);
    expect(out.rows).toBe(ADMIN_AUDIT_EXPORT_MAX_ROWS);
    expect(out.truncated).toBe(true);
    expect(out.csv.trimEnd().split('\r\n')).toHaveLength(ADMIN_AUDIT_EXPORT_MAX_ROWS + 1);
    expect(eventos()[0]?.payload).toMatchObject({
      rows: ADMIN_AUDIT_EXPORT_MAX_ROWS,
      truncated: true,
    });
  });

  it('con un correo que no es de nadie igual queda el rastro: 0 filas', async () => {
    const { service, eventos, lecturas } = banco({ actor: false });
    const out = await service.exportCsv(
      SUPERADMIN,
      AdminAuditExportQuerySchema.parse({ actorEmail: 'nadie@x.com' }),
      NOW,
    );
    expect(out.rows).toBe(0);
    expect(out.csv).toBe('\uFEFFfecha,evento,nodo,actor,entidad,id_entidad,ip\r\n');
    expect(lecturas()).toHaveLength(0);
    expect(eventos()[0]?.payload).toMatchObject({ rows: 0, filters: { actorNotFound: true } });
  });

  it('si la base dice que no es superadmin: 403 y ningún rastro', async () => {
    const { service, eventos } = banco({ deniega: true });
    await expect(
      service.exportCsv(SUPERADMIN, AdminAuditExportQuerySchema.parse({}), NOW),
    ).rejects.toBeInstanceOf(SuperadminRequiredError);
    expect(eventos()).toEqual([]);
  });
});
