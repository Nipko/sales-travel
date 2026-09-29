import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import {
  ExternalOrderIntentService,
  ProviderBookingRefTakenError,
  type OpenExternalCreateIntentInput,
} from './external-order-intent.service.js';
import { platformRootId } from '../__fixtures__/platform-root.js';

/**
 * API pública del intent contra Postgres real (docs/tbo/09 PR-4.4; 08 RF-19, RF-20).
 *
 * El test unitario usa un doble de la base; éste prueba lo que el doble sólo puede imitar: que
 * los nombres de los índices que el servicio reconoce son los de 0038 y 0042, que el índice de
 * referencias es global entre agencias de la misma red, que el CAS y la liberación de la clave
 * funcionan con el `UpdateResult` real de Kysely, y que el trigger de 0042 que congela la
 * referencia no se dispara con ningún cierre.
 *
 * La red es la del caso que motiva todo: un consolidador con una cuenta heredable y dos agencias
 * que reservan con ella. El proveedor y las referencias son sintéticos y únicos por corrida.
 *
 * Requiere las migraciones hasta la 0042. Se SALTA sin PGHOST.
 */
const hasDb = Boolean(process.env['PGHOST'] && process.env['PGUSER'] && process.env['PGPASSWORD']);
const d = hasDb ? describe : describe.skip;

d('intent de verticales externas contra Postgres (0038 + 0042)', () => {
  const pool = new pg.Pool();
  const database = new DatabaseService();
  const service = new ExternalOrderIntentService(database);
  const sfx = randomBytes(4).toString('hex');
  const PROVEEDOR = `it-bedbank-${sfx}`;
  const ref = (n: number) => `STT${sfx.toUpperCase()}${String(n).padStart(9, '0')}`;

  let consolidador: string;
  let agenciaA: string;
  let agenciaB: string;
  let usuario: string;
  let cuenta: string;

  async function crearTenant(slug: string, tipo: string, padre: string | null): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tenants (slug, name, country_code, default_currency, tenant_type, parent_tenant_id)
       VALUES ($1::text, $1::text, 'CO', 'COP', $2, $3) RETURNING id`,
      [slug, tipo, padre ?? (await platformRootId(pool))],
    );
    return rows[0]!.id;
  }

  function input(overrides: Partial<OpenExternalCreateIntentInput> = {}) {
    return {
      provider: PROVEEDOR,
      vertical: 'hotels',
      idempotencyKey: randomUUID(),
      searchCriteria: { checkIn: '2026-11-02', checkOut: '2026-11-05' },
      selectedOffer: { offerRef: `offer-${sfx}` },
      passengers: [{ room: 1 }],
      contactInfo: { email: `huesped-${sfx}@example.test` },
      totalAmountMinor: 34_012,
      currency: 'USD',
      providerBookingRef: ref(1),
      providerAccountId: cuenta,
      ...overrides,
    } satisfies OpenExternalCreateIntentInput;
  }

  /** Lectura desde OTRA conexión: sólo ve lo que ya se comprometió. */
  async function leer(id: string) {
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT status, create_request_key, provider_booking_ref, provider_account_id, provider_order_id,
              provider_raw, error_message, search_criteria
         FROM orders WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  beforeAll(async () => {
    database.onModuleInit();
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) RETURNING id`,
      [`ext-intent-${sfx}@test.local`],
    );
    usuario = u.rows[0]!.id;
    consolidador = await crearTenant(`ext-c-${sfx}`, 'consolidator', null);
    agenciaA = await crearTenant(`ext-a-${sfx}`, 'agency', consolidador);
    agenciaB = await crearTenant(`ext-b-${sfx}`, 'agency', consolidador);
    const c = await pool.query<{ id: string }>(
      `INSERT INTO provider_accounts (tenant_id, provider_code, label, credentials_enc, is_inheritable, status)
       VALUES ($1, $2, 'default', $3, true, 'active') RETURNING id`,
      [consolidador, PROVEEDOR, Buffer.from('no-es-un-secreto')],
    );
    cuenta = c.rows[0]!.id;
  });

  afterAll(async () => {
    // parent_tenant_id es ON DELETE RESTRICT: de hoja a raíz. Cada agencia se lleva sus órdenes;
    // el consolidador, la cuenta, que para entonces ya no tiene órdenes que la referencien.
    for (const id of [agenciaA, agenciaB, consolidador]) {
      if (id) await pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    }
    if (usuario) await pool.query('DELETE FROM users WHERE id = $1', [usuario]);
    await database.onModuleDestroy();
    await pool.end();
  });

  it('al volver, el intent con su referencia y la cuenta heredada ya está comprometido', async () => {
    const intent = await service.openExternalCreateIntent(agenciaA, usuario, input());

    expect(await leer(intent.id)).toMatchObject({
      status: 'pending',
      provider_booking_ref: ref(1),
      provider_account_id: cuenta,
      provider_order_id: null,
      provider_raw: null,
      search_criteria: { checkIn: '2026-11-02', checkOut: '2026-11-05', vertical: 'hotels' },
    });
  });

  it('la misma clave → 409 duplicateRequest (índice uq_orders_create_request_key)', async () => {
    const idempotencyKey = randomUUID();
    const first = await service.openExternalCreateIntent(
      agenciaA,
      usuario,
      input({ idempotencyKey, providerBookingRef: ref(2) }),
    );

    let error: unknown;
    try {
      await service.openExternalCreateIntent(
        agenciaA,
        usuario,
        input({ idempotencyKey, providerBookingRef: ref(3) }),
      );
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      orderId: first.id,
      duplicateRequest: true,
    });
    const { rows } = await pool.query(`SELECT 1 FROM orders WHERE provider_booking_ref = $1`, [
      ref(3),
    ]);
    expect(rows).toEqual([]);
  });

  it('una agencia hermana no puede repetir la referencia (índice global de 0042)', async () => {
    await service.openExternalCreateIntent(
      agenciaA,
      usuario,
      input({ providerBookingRef: ref(11) }),
    );
    const idempotencyKey = randomUUID();

    await expect(
      service.openExternalCreateIntent(
        agenciaB,
        usuario,
        input({ idempotencyKey, providerBookingRef: ref(11) }),
      ),
    ).rejects.toBeInstanceOf(ProviderBookingRefTakenError);

    // Nada quedó a medias: la misma clave con una referencia nueva entra.
    const retried = await service.openExternalCreateIntent(
      agenciaB,
      usuario,
      input({ idempotencyKey, providerBookingRef: ref(4) }),
    );
    expect(await leer(retried.id)).toMatchObject({
      provider_booking_ref: ref(4),
      create_request_key: `c:${idempotencyKey}`,
    });
  });

  it('CAS: el primer cierre gana, el segundo no toca la fila y el trigger no salta', async () => {
    const intent = await service.openExternalCreateIntent(
      agenciaA,
      usuario,
      input({ providerBookingRef: ref(5) }),
    );

    const settled = await service.settleExternalCreateIntent(agenciaA, intent, {
      status: 'confirmed',
      providerOrderId: `CONF-${sfx}`,
      providerRaw: { ConfirmationNumber: `CONF-${sfx}`, StatusCode: 200 },
    });
    const second = await service.settleExternalCreateIntent(agenciaA, intent, {
      status: 'failed',
      providerRaw: { StatusCode: 207 },
    });
    const late = await service.failExternalCreateIntent(agenciaA, intent);

    expect(settled?.status).toBe('confirmed');
    expect(second).toBeUndefined();
    expect(late).toBe(false);
    expect(await leer(intent.id)).toMatchObject({
      status: 'confirmed',
      provider_order_id: `CONF-${sfx}`,
      provider_booking_ref: ref(5),
      create_request_key: intent.create_request_key,
      provider_raw: {
        ConfirmationNumber: `CONF-${sfx}`,
        StatusCode: 200,
        phase: 'create',
        outcome: 'CONFIRMED',
      },
      error_message: null,
    });
  });

  it('failed y el fallo previo al envío liberan la clave; la referencia queda', async () => {
    const keyFailed = randomUUID();
    const keyNotSent = randomUUID();
    const failed = await service.openExternalCreateIntent(
      agenciaA,
      usuario,
      input({ idempotencyKey: keyFailed, providerBookingRef: ref(6) }),
    );
    const notSent = await service.openExternalCreateIntent(
      agenciaA,
      usuario,
      input({ idempotencyKey: keyNotSent, providerBookingRef: ref(7) }),
    );

    await service.settleExternalCreateIntent(agenciaA, failed, {
      status: 'failed',
      providerRaw: { StatusCode: 207 },
      errorMessage: 'provider-status-207',
    });
    expect(await service.failExternalCreateIntent(agenciaA, notSent)).toBe(true);
    expect(await service.failExternalCreateIntent(agenciaA, notSent)).toBe(false);

    expect(await leer(failed.id)).toMatchObject({
      status: 'failed',
      create_request_key: null,
      provider_booking_ref: ref(6),
    });
    expect(await leer(notSent.id)).toMatchObject({
      status: 'failed',
      create_request_key: null,
      provider_booking_ref: ref(7),
      provider_raw: { phase: 'pre-create', outcome: 'FAILED' },
    });

    // Las dos claves vuelven a servir, con referencias nuevas.
    await service.openExternalCreateIntent(
      agenciaA,
      usuario,
      input({ idempotencyKey: keyFailed, providerBookingRef: ref(8) }),
    );
    await service.openExternalCreateIntent(
      agenciaA,
      usuario,
      input({ idempotencyKey: keyNotSent, providerBookingRef: ref(9) }),
    );
  });

  it('una agencia no cierra ni libera el intent de su hermana', async () => {
    const intent = await service.openExternalCreateIntent(
      agenciaA,
      usuario,
      input({ providerBookingRef: ref(10) }),
    );

    await expect(
      service.settleExternalCreateIntent(agenciaB, intent, {
        status: 'failed',
        providerRaw: { StatusCode: 207 },
      }),
    ).resolves.toBeUndefined();
    await expect(service.failExternalCreateIntent(agenciaB, intent)).resolves.toBe(false);

    expect(await leer(intent.id)).toMatchObject({
      status: 'pending',
      create_request_key: intent.create_request_key,
    });
  });
});
