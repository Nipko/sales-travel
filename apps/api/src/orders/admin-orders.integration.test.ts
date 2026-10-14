import { randomBytes, randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformRootId } from '../__fixtures__/platform-root.js';
import { PlatformConsoleScopeNotFoundError } from '../admin-console/admin-console.errors.js';
import { addDays, todayIn } from '../admin-console/admin-overview.schemas.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { DB } from '../database/database.types.js';
import { SuperadminRequiredError } from '../network/superadmin.errors.js';
import type { PricingService } from '../pricing/pricing.service.js';
import type { FlightProviderRegistry } from '../providers/flight-provider.registry.js';
import type { HotelProviderRegistry } from '../providers/hotel-provider.registry.js';
import type { AgentCarsProviderFactory } from '../providers-agent-cars/agent-cars.factory.js';
import type { PostSaleQueueService } from '../queue/post-sale-queue.service.js';
import { CircuitBreakerService } from '../search/circuit-breaker.service.js';
import type { AdminOrderListItem } from './admin-order-view.js';
import { AdminOrderNotFoundError } from './admin-orders.errors.js';
import { AdminOrdersQuerySchema } from './admin-orders.schemas.js';
import { ADMIN_ORDER_VIEWED_EVENT, AdminOrdersService } from './admin-orders.service.js';
import { HotelOrderReadsService } from './hotel-order-reads.service.js';
import { HotelOrderTrackingStore } from './hotel-order-tracking.store.js';
import { OrderCapabilitiesService } from './order-capabilities.service.js';
import { OrdersService } from './orders.service.js';

/**
 * Plataforma → Reservas de la red contra la base, como `app_user` (el rol de producción, sujeto a la
 * RLS): admin_search_orders y admin_order_tenant (0076) buscan en toda la red sólo para el
 * superadmin, y la ficha se lee con las lecturas de Reservas de la agencia, fijando su tenant.
 *
 * Las redes: Planetour → consolidador C → agencia A → sub-agencia S; Planetour → agencia directa D.
 * La base es compartida con otros tests, así que lo exacto se mira acotado a un nodo o a un proveedor
 * propio de esta corrida.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['APP_USER_PASSWORD']);
const d = hasDb ? describe : describe.skip;

const BOGOTA = 'America/Bogota';

d('Reservas de la red (funciones de 0076 como app_user)', () => {
  const sfx = randomBytes(4).toString('hex');
  const SFX = sfx.toUpperCase();
  /** SUPERUSUARIO: sólo para montar la red y desmontarla. */
  const admin = new pg.Pool();
  const appPool = new pg.Pool({
    user: 'app_user',
    password: process.env['APP_USER_PASSWORD'],
    host: process.env['PGHOST'],
    port: Number(process.env['PGPORT'] ?? 5432),
    database: process.env['PGDATABASE'],
  });
  const database = new DatabaseService();
  database.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: appPool }) });

  const audit = new AuditService(database);
  // Sólo `capabilitiesOf`: dice qué proveedor es de hoteles.
  const hotelRegistry = {
    capabilitiesOf: (provider: string) =>
      provider === 'tbo-hotels' ? { retrieve: true, cancel: true } : undefined,
  };
  const hotelReads = new HotelOrderReadsService(
    hotelRegistry as unknown as HotelProviderRegistry,
    new HotelOrderTrackingStore(database),
    new CircuitBreakerService(),
    audit,
  );
  // La ficha sólo usa findById y listOperations: lo demás no se toca.
  const orders = new OrdersService(
    database,
    {} as unknown as FlightProviderRegistry,
    {} as unknown as PostSaleQueueService,
    {} as unknown as AgentCarsProviderFactory,
    audit,
    {} as unknown as PricingService,
    hotelReads,
  );
  const service = new AdminOrdersService(
    database,
    orders,
    hotelReads,
    audit,
    new OrderCapabilitiesService(
      { capabilitiesOf: () => undefined } as unknown as FlightProviderRegistry,
      hotelReads,
    ),
  );

  const tenants: string[] = [];
  const users: string[] = [];
  const orderIds: string[] = [];
  let seq = 0;

  async function tenant(slug: string, type: string, parent: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [`ro-${slug}-${sfx}`, type, parent],
    );
    tenants.push(rows[0]!.id);
    return rows[0]!.id;
  }

  async function user(label: string, tenantId: string, role: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO users (email, name, status) VALUES ($1, $2, 'active') RETURNING id`,
      [`ro-${label}-${sfx}@test.local`, `Usuario ${label}`],
    );
    users.push(rows[0]!.id);
    await admin.query(
      `INSERT INTO memberships (tenant_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
      [tenantId, rows[0]!.id, role],
    );
    return rows[0]!.id;
  }

  async function order(
    tenantId: string,
    userId: string,
    o: {
      status: string;
      provider?: string;
      vertical?: string;
      pnr?: string;
      bookingRef?: string;
      email?: string;
      passengers?: unknown[];
      contact?: Record<string, unknown>;
      ago?: string;
      at?: string;
    },
  ): Promise<{ id: string; number: number }> {
    seq += 1;
    const number = 5_000 + seq;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, user_id, provider, provider_order_id, provider_booking_ref,
                           search_criteria, selected_offer, passengers, contact_info, total_amount,
                           currency, order_number, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, $7::jsonb, $8::jsonb, 150000, 'cop',
               $9, $10, COALESCE($11::timestamptz, now() - $12::interval),
               COALESCE($11::timestamptz, now() - $12::interval))
       RETURNING id`,
      [
        tenantId,
        userId,
        o.provider ?? 'latam-ndc',
        o.pnr ?? null,
        o.bookingRef ?? null,
        JSON.stringify(o.vertical === undefined ? {} : { vertical: o.vertical }),
        JSON.stringify(o.passengers ?? []),
        JSON.stringify(o.contact ?? (o.email === undefined ? {} : { email: o.email })),
        number,
        o.status,
        o.at ?? null,
        o.ago ?? '1 day',
      ],
    );
    orderIds.push(rows[0]!.id);
    return { id: rows[0]!.id, number };
  }

  const today = todayIn(BOGOTA, new Date());
  const q = (query: Record<string, string>) => AdminOrdersQuerySchema.parse(query);
  const ids = (items: readonly AdminOrderListItem[]) => items.map((o) => o.id);

  let platform: string;
  let consolidator: string;
  let agency: string;
  let sub: string;
  let direct: string;

  let superadmin: string;
  let consolidatorAdmin: string;
  let agencyAdmin: string;
  let seller: string;
  let directSeller: string;

  const o: Record<string, { id: string; number: number }> = {};
  const crossProvider = `px-${sfx}`;
  const pnr = `PNR${SFX}`;
  const bookingRef = `ST-${SFX}`;
  const clientEmail = `cliente.${sfx}@Correo.test`;
  /** Dos órdenes en el mismo microsegundo: el id desempata la paginación. */
  const tieAt = new Date(Date.now() - 5 * 3_600_000).toISOString().replace('Z', '123Z');

  beforeAll(async () => {
    platform = await platformRootId(admin);
    consolidator = await tenant('c', 'consolidator', platform);
    agency = await tenant('a', 'agency', consolidator);
    sub = await tenant('s', 'subagency', agency);
    direct = await tenant('d', 'agency', platform);

    superadmin = await user('sa', platform, 'superadmin');
    consolidatorAdmin = await user('ca', consolidator, 'consolidator_admin');
    agencyAdmin = await user('aa', agency, 'tenant_admin');
    seller = await user('ve', agency, 'vendedor');
    directSeller = await user('dv', direct, 'tenant_admin');

    // A: un vuelo confirmado con su PNR, el correo del cliente y pasajeros con documento.
    o['flight'] = await order(agency, seller, {
      status: 'confirmed',
      pnr,
      contact: {
        email: clientEmail,
        phone: '3001234567',
        countryDialingCode: '57',
        postalAddress: { countryCode: 'CO', postalCode: '110111', street: 'Calle Falsa 123' },
      },
      passengers: [
        {
          paxId: 'PAX1',
          paxType: 'ADT',
          givenName: 'Ana',
          surname: 'Pérez',
          birthdate: '1990-05-17',
          gender: 'F',
          identityDoc: { type: 'PT', number: `DOC${SFX}`, expiryDate: '2031-01-01' },
        },
      ],
      ago: '1 day',
    });
    // A: un hotel con nuestra referencia de reserva, seguimiento y una divergencia crítica.
    o['hotel'] = await order(agency, seller, {
      status: 'confirmed',
      provider: 'tbo-hotels',
      vertical: 'hotels',
      pnr: `TBO-${SFX}`,
      bookingRef,
      passengers: [{ room: 0, guests: [{ paxType: 'ADT', firstName: 'Luis', lastName: 'Gómez' }] }],
      contact: {
        email: `huesped.${sfx}@test.local`,
        phone: { countryCode: '+51', number: '987654' },
      },
      ago: '20 hours',
    });
    // A: una pendiente hace 2 horas sin verificación en curso (create-stuck).
    o['stuck'] = await order(agency, seller, { status: 'pending', ago: '2 hours' });
    // A: dos en el mismo microsegundo, y una vieja fuera del período.
    o['tie1'] = await order(agency, seller, { status: 'confirmed', at: tieAt });
    o['tie2'] = await order(agency, seller, { status: 'ticketed', at: tieAt });
    o['old'] = await order(agency, seller, { status: 'confirmed', ago: '10 days' });
    // S: un auto sin la marca de vertical (la vertical sale del proveedor).
    o['car'] = await order(sub, seller, { status: 'confirmed', provider: 'agent-cars' });
    // Un proveedor propio de esta corrida, en las dos redes.
    o['crossA'] = await order(agency, seller, { status: 'failed', provider: crossProvider });
    o['crossD'] = await order(direct, directSeller, {
      status: 'ticketed',
      provider: crossProvider,
      ago: '3 hours',
    });

    // La post-venta del vuelo: la cancelación falló (cancel-failed).
    await admin.query(
      `INSERT INTO order_operations (tenant_id, order_id, type, status, last_error, created_at, updated_at)
       VALUES ($1, $2, 'cancel', 'failed', 'Cancelación fallida antes de enviar el write.',
               now() - interval '3 hours', now() - interval '3 hours')`,
      [agency, o['flight'].id],
    );
    // Su retención, ya cobrada.
    await admin.query(
      `INSERT INTO wallet_hold_groups (order_id, origin_tenant_id, currency, sale_amount_minor,
                                       provider_code, credential_source, mode, status, created_by,
                                       captured_at)
       VALUES ($1, $2, 'COP', 150000, 'latam-ndc', 'legacy', 'legacy', 'captured', $3, now())`,
      [o['flight'].id, agency, seller],
    );
    // Un evento de la orden que alguna vez se escribió con una clave que no debería salir.
    await admin.query(
      `INSERT INTO domain_events (tenant_id, actor_user_id, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, $2, 'order.created', 'order', $3, $4::jsonb)`,
      [
        agency,
        seller,
        o['flight'].id,
        JSON.stringify({
          orderId: o['flight'].id,
          apiKey: 'no-sale',
          nested: { token: 'x', ok: 1 },
        }),
      ],
    );

    // El seguimiento del hotel y su conciliación.
    await admin.query(
      `INSERT INTO hotel_order_tracking (order_id, tenant_id, provider_status, provider_status_at,
                                         provider_status_source, hcn, hcn_received_at, hcn_state)
       VALUES ($1, $2, 'Confirmed', now(), 'book', 'HCN-1', now(), 'received')`,
      [o['hotel'].id, agency],
    );
    const { rows: account } = await admin.query<{ id: string }>(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, status)
       VALUES ($1, 'tbo-hotels', $2, '\\x00'::bytea, 'active') RETURNING id`,
      [consolidator, `ro-${sfx}`],
    );
    const { rows: run } = await admin.query<{ id: string }>(
      `INSERT INTO provider_reconciliation_runs (tenant_id, account_id, provider_code, trigger, status, finished_at)
       VALUES ($1, $2, 'tbo-hotels', 'forced', 'completed', now()) RETURNING id`,
      [consolidator, account[0]!.id],
    );
    await admin.query(
      `INSERT INTO provider_reconciliation_items (tenant_id, run_id, account_id, provider_code, kind,
                                                  severity, action, order_id, dedupe_key, details)
       VALUES ($1, $2, $3, 'tbo-hotels', 'R4', 'critical', 'review', $4, $5, '{"amount": 1}'::jsonb)`,
      [agency, run[0]!.id, account[0]!.id, o['hotel'].id, `R4|${sfx}|hotel`],
    );
  });

  afterAll(async () => {
    await admin.query('DELETE FROM wallet_hold_groups WHERE order_id = ANY($1::uuid[])', [
      orderIds,
    ]);
    await admin.query('DELETE FROM domain_events WHERE aggregate_id = ANY($1::text[])', [orderIds]);
    const { rows } = await admin.query<{ id: string }>(
      'SELECT id FROM tenants WHERE id = ANY($1::uuid[]) ORDER BY nlevel(path) DESC',
      [tenants],
    );
    for (const r of rows) await admin.query('DELETE FROM tenants WHERE id = $1', [r.id]);
    await admin.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users]);
    await database.db.destroy();
    await admin.end();
  });

  it('el superadmin ve las reservas de las dos redes, sin pasajeros ni contacto', async () => {
    const page = await service.search(superadmin, q({ provider: crossProvider }));

    expect(page.nextCursor).toBeNull();
    expect(page.orders).toEqual([
      expect.objectContaining({
        id: o['crossD']!.id,
        tenantId: direct,
        tenantName: `ro-d-${sfx}`,
        tenantType: 'agency',
        status: 'ticketed',
        vertical: 'flights',
        sellerEmail: `ro-dv-${sfx}@test.local`,
        totalAmountMinor: 150_000,
        currency: 'COP',
      }),
      expect.objectContaining({ id: o['crossA']!.id, tenantId: agency, status: 'failed' }),
    ]);
    for (const item of page.orders) {
      expect(Object.keys(item).sort()).toEqual(
        [
          'attention',
          'createdAt',
          'currency',
          'id',
          'isBranch',
          'orderNumber',
          'provider',
          'providerBookingRef',
          'providerOrderId',
          'sellerEmail',
          'status',
          'subStatus',
          'tenantId',
          'tenantName',
          'tenantType',
          'totalAmountMinor',
          'updatedAt',
          'vertical',
        ].sort(),
      );
    }
  });

  it('el nodo, con su red o sin ella', async () => {
    const inC = ids((await service.search(superadmin, q({ tenantId: consolidator }))).orders);
    expect(inC).toEqual(expect.arrayContaining([o['flight']!.id, o['car']!.id]));
    expect(inC).not.toContain(o['crossD']!.id);

    const onlyC = await service.search(superadmin, q({ tenantId: consolidator, subtree: 'false' }));
    expect(onlyC.orders).toEqual([]);

    const onlyA = ids(
      (await service.search(superadmin, q({ tenantId: agency, subtree: 'false' }))).orders,
    );
    expect(onlyA).toContain(o['flight']!.id);
    expect(onlyA).not.toContain(o['car']!.id);

    const inS = await service.search(superadmin, q({ tenantId: sub }));
    expect(ids(inS.orders)).toEqual([o['car']!.id]);
    expect(inS.orders[0]).toMatchObject({ vertical: 'cars', provider: 'agent-cars' });
  });

  it('estado, vertical, proveedor y fechas', async () => {
    const inC = (query: Record<string, string>) =>
      service
        .search(superadmin, q({ tenantId: consolidator, ...query }))
        .then((p) => ids(p.orders));

    expect(await inC({ vertical: 'cars' })).toEqual([o['car']!.id]);
    expect(await inC({ vertical: 'hotels' })).toEqual([o['hotel']!.id]);
    expect(await inC({ provider: 'tbo-hotels' })).toEqual([o['hotel']!.id]);
    expect(await inC({ status: 'pending' })).toEqual([o['stuck']!.id]);
    expect(await inC({ status: 'failed,ticketed' })).toEqual([o['tie2']!.id, o['crossA']!.id]);
    expect(await inC({ vertical: 'flights', status: 'ticketed' })).toEqual([o['tie2']!.id]);

    // Días de Bogotá, ambos incluidos.
    expect(await inC({ to: addDays(today, -5) })).toEqual([o['old']!.id]);
    const recent = await inC({ from: addDays(today, -3), to: today });
    expect(recent).not.toContain(o['old']!.id);
    expect(recent).toContain(o['flight']!.id);
  });

  it('la búsqueda: PNR, referencia, número, correo EXACTO del cliente e id', async () => {
    const find = (text: string) =>
      service
        .search(superadmin, q({ tenantId: agency, subtree: 'false', q: text }))
        .then((p) => ids(p.orders));

    expect(await find(pnr.toLowerCase())).toEqual([o['flight']!.id]);
    expect(await find(bookingRef)).toEqual([o['hotel']!.id]);
    // Nuestra referencia es exacta.
    expect(await find(bookingRef.toLowerCase())).toEqual([]);
    expect(await find(String(o['stuck']!.number))).toEqual([o['stuck']!.id]);
    expect(await find(clientEmail.toUpperCase())).toEqual([o['flight']!.id]);
    // Una parte del correo no encuentra nada: la búsqueda no sirve para listar clientes.
    expect(await find(`cliente.${sfx}`)).toEqual([]);
    expect(await find(`@correo.test`)).toEqual([]);
    expect(await find(o['hotel']!.id.toUpperCase())).toEqual([o['hotel']!.id]);
    expect(await find('nada-que-ver')).toEqual([]);

    // En toda la red, el PNR también.
    const network = await service.search(superadmin, q({ q: pnr }));
    expect(ids(network.orders)).toEqual([o['flight']!.id]);
  });

  it('las que necesitan a una persona, con su motivo más grave', async () => {
    const page = await service.search(
      superadmin,
      q({ tenantId: agency, subtree: 'false', attention: 'true' }),
    );
    const byId = new Map(page.orders.map((item) => [item.id, item.attention?.reason]));

    expect(byId.get(o['stuck']!.id)).toBe('create-stuck');
    expect(byId.get(o['flight']!.id)).toBe('cancel-failed');
    expect(byId.get(o['hotel']!.id)).toBe('reconciliation');
    expect(byId.has(o['tie1']!.id)).toBe(false);
    expect(byId.has(o['crossA']!.id)).toBe(false);

    const all = await service.search(superadmin, q({ tenantId: agency, subtree: 'false' }));
    expect(all.orders.find((item) => item.id === o['tie1']!.id)?.attention).toBeNull();
  });

  it('pagina por (created_at, id) sin saltar ni repetir, también en el mismo microsegundo', async () => {
    const base = { tenantId: agency, subtree: 'false' };
    const full = ids((await service.search(superadmin, q(base))).orders);
    expect(full).toHaveLength(7);
    expect(full).toEqual(expect.arrayContaining([o['tie1']!.id, o['tie2']!.id]));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await service.search(
        superadmin,
        q({ ...base, limit: '2', ...(cursor === null ? {} : { cursor }) }),
      );
      seen.push(...ids(page.orders));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(4);
    expect(seen).toEqual(full);
  });

  it('la ficha: las lecturas del nodo, recortadas, y queda en la auditoría de ese nodo', async () => {
    const detail = await service.detail(superadmin, o['flight']!.id);

    expect(detail.order).toMatchObject({
      id: o['flight']!.id,
      tenantId: agency,
      pnr,
      status: 'confirmed',
      totalAmount: 150_000,
      orderNumber: o['flight']!.number,
      passengers: [{ givenName: 'Ana', surname: 'Pérez', paxType: 'ADT' }],
      contactInfo: { email: clientEmail, phone: '+57 3001234567' },
    });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(`DOC${SFX}`);
    expect(serialized).not.toContain('1990-05-17');
    expect(serialized).not.toContain('Calle Falsa');
    expect(serialized).not.toContain('no-sale');

    expect(detail.tenant).toMatchObject({ id: agency, tenantType: 'agency', isBranch: false });
    expect(detail.tenant.path.map((p) => p.id)).toEqual([platform, consolidator, agency]);
    expect(detail.seller).toEqual({
      id: seller,
      email: `ro-ve-${sfx}@test.local`,
      name: 'Usuario ve',
    });
    expect(detail.operations).toEqual([
      expect.objectContaining({ type: 'cancel', status: 'failed', retryable: false }),
    ]);
    expect(detail.providerTracking).toBeNull();
    expect(detail.walletHold).toMatchObject({
      status: 'captured',
      mode: 'legacy',
      currency: 'COP',
      saleAmountMinor: 150_000,
    });
    expect(detail.walletHold?.capturedAt).not.toBeNull();
    expect(detail.reconciliation).toEqual([]);
    expect(detail.attention.map((a) => a.reason)).toEqual(['cancel-failed']);
    expect(detail.events).toEqual([
      expect.objectContaining({
        eventType: 'order.created',
        tenantId: agency,
        actorUserId: seller,
        actorEmail: `ro-ve-${sfx}@test.local`,
        payload: { orderId: o['flight']!.id, nested: { ok: 1 } },
      }),
    ]);

    const { rows: viewed } = await admin.query<{
      tenant_id: string;
      actor_user_id: string;
      aggregate_type: string;
      payload: unknown;
    }>(
      `SELECT tenant_id, actor_user_id, aggregate_type, payload FROM domain_events
        WHERE event_type = $1 AND aggregate_id = $2`,
      [ADMIN_ORDER_VIEWED_EVENT, o['flight']!.id],
    );
    expect(viewed).toEqual([
      {
        tenant_id: agency,
        actor_user_id: superadmin,
        aggregate_type: 'order',
        payload: { orderId: o['flight']!.id },
      },
    ]);

    // El administrador de la agencia lo ve en su auditoría (RLS por subárbol administrado).
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [agencyAdmin]);
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM domain_events WHERE event_type = $1 AND aggregate_id = $2`,
        [ADMIN_ORDER_VIEWED_EVENT, o['flight']!.id],
      );
      expect(rows[0]?.n).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }

    // Abrirla otra vez no llena su historial de "la vieron".
    const again = await service.detail(superadmin, o['flight']!.id.toUpperCase());
    expect(again.events.map((e) => e.eventType)).toEqual(['order.created']);
  });

  it('la ficha de un hotel trae su seguimiento y su conciliación, sin los detalles', async () => {
    const detail = await service.detail(superadmin, o['hotel']!.id);

    expect(detail.providerTracking).toMatchObject({
      subStatus: null,
      providerStatus: 'Confirmed',
      providerStatusSource: 'book',
      hotelConfirmationNumber: 'HCN-1',
      hcnState: 'received',
    });
    expect(detail.order.providerTracking).toEqual(detail.providerTracking);
    expect(detail.order.providerBookingRef).toBe(bookingRef);
    expect(detail.order.passengers).toEqual([
      { givenName: 'Luis', surname: 'Gómez', paxType: 'ADT', room: 0 },
    ]);
    expect(detail.order.contactInfo).toEqual({
      email: `huesped.${sfx}@test.local`,
      phone: '+51 987654',
    });
    expect(detail.reconciliation).toHaveLength(1);
    expect(Object.keys(detail.reconciliation[0] ?? {}).sort()).toEqual([
      'action',
      'createdAt',
      'kind',
      'severity',
    ]);
    expect(detail.reconciliation[0]).toMatchObject({
      kind: 'R4',
      severity: 'critical',
      action: 'review',
    });
    expect(detail.walletHold).toBeNull();
    expect(detail.attention.map((a) => a.reason)).toEqual(['reconciliation']);
  });

  it('una reserva o un nodo que no existen son un 404', async () => {
    await expect(service.detail(superadmin, randomUUID())).rejects.toBeInstanceOf(
      AdminOrderNotFoundError,
    );
    await expect(service.search(superadmin, q({ tenantId: randomUUID() }))).rejects.toBeInstanceOf(
      PlatformConsoleScopeNotFoundError,
    );
  });

  it('un consolidator_admin recibe 403 y no deja rastro de haber mirado', async () => {
    await expect(service.search(consolidatorAdmin, q({}))).rejects.toBeInstanceOf(
      SuperadminRequiredError,
    );
    await expect(service.detail(consolidatorAdmin, o['hotel']!.id)).rejects.toBeInstanceOf(
      SuperadminRequiredError,
    );
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM domain_events WHERE event_type = $1 AND actor_user_id = $2`,
      [ADMIN_ORDER_VIEWED_EVENT, consolidatorAdmin],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('las funciones mismas exigen al superadmin: 42501 a cualquier otro o sin usuario', async () => {
    const calls = [
      `SELECT * FROM admin_search_orders(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 10)`,
      `SELECT admin_order_tenant('${o['flight']!.id}'::uuid)`,
    ];
    for (const actor of [consolidatorAdmin, agencyAdmin, null]) {
      for (const call of calls) {
        const client = await appPool.connect();
        try {
          await client.query('BEGIN');
          if (actor !== null) {
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [actor]);
          }
          const error = await client.query(call).then(
            () => undefined,
            (err: { code?: string; message?: string }) => err,
          );
          expect(error, `${actor ?? 'sin usuario'}: ${call}`).toMatchObject({
            code: '42501',
            message: 'admin_superadmin_required',
          });
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      }
    }
  });

  it('un filtro imposible es un error de programación: 22023', async () => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [superadmin]);
      for (const call of [
        `SELECT * FROM admin_search_orders(NULL, NULL, 'trains', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 10)`,
        `SELECT * FROM admin_search_orders(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now(), NULL, 10)`,
        `SELECT * FROM admin_search_orders(NULL, NULL, NULL, NULL, NULL, now(), now() - interval '1 day', NULL, NULL, NULL, NULL, 10)`,
      ]) {
        await client.query('SAVEPOINT intento');
        const error = await client.query(call).then(
          () => undefined,
          (err: { code?: string; message?: string }) => err,
        );
        expect(error, call).toMatchObject({
          code: '22023',
          message: 'admin_orders_filter_invalid',
        });
        await client.query('ROLLBACK TO SAVEPOINT intento');
      }
      // Un texto que no es número ni correo ni id no rompe la búsqueda.
      const { rows } = await client.query(
        `SELECT * FROM admin_search_orders($1::uuid, NULL, NULL, NULL, NULL, NULL, NULL, 'ABC-123', NULL, NULL, NULL, 10)`,
        [agency],
      );
      expect(rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
