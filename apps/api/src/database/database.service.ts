import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { DB } from './database.types.js';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private pool!: pg.Pool;
  public db!: Kysely<DB>;

  onModuleInit(): void {
    const connectionString = process.env['DATABASE_URL'];
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }

    this.pool = new pg.Pool({
      connectionString,
      max: Number(process.env['DATABASE_POOL_MAX'] ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    this.db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: this.pool }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.destroy();
  }

  async ping(): Promise<boolean> {
    const result = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(this.db);
    return result.rows[0]?.ok === 1;
  }

  /**
   * Ejecuta `fn` dentro de una transacción con `app.current_tenant_id` seteado.
   * Las queries dentro de `fn` ven sólo filas del tenant indicado (RLS forzada).
   */
  async withTenant<T>(
    tenantId: string,
    fn: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`.execute(trx);
      return fn(trx);
    });
  }
}
