import type { DatabaseService } from '../../database/database.service.js';

/**
 * Doble de Postgres para la tabla `orders`, compartido por los tests del intent de creación
 * (`external-order-intent.service.test.ts`) y los de las sagas que lo usan
 * (`hotels/hotel-booking.service.test.ts`).
 *
 * Modela lo que decide esos casos: transacciones serializadas que se deshacen enteras si fallan,
 * RLS por tenant en lecturas y escrituras, y los tres índices únicos de `orders` con su alcance
 * real. El de la clave de idempotencia es POR TENANT (0038) y el de la referencia de reserva es
 * ENTRE tenants (0042): como en Postgres, un índice único ve todas las filas aunque la RLS no deje
 * leerlas. Cada sentencia queda en un registro con su transacción, para poder afirmar QUÉ se
 * escribió junto.
 */

export type Row = Record<string, unknown>;

export interface Statement {
  tx: number;
  tenant: string;
  op: 'select' | 'insert' | 'update';
  table: string;
  values?: Row;
  forUpdate?: boolean;
}

export interface MemoryDbOptions {
  /** Toda escritura en `orders` falla, como una base caída a mitad del request. */
  failUpdates?: boolean;
  /** El próximo INSERT falla con este error (una violación que el doble no modela). */
  insertError?: Error;
  /** Cotizaciones que existen, cada una con su tenant. */
  quotations?: Row[];
}

export function uniqueViolation(constraint: string): Error {
  return Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    {
      code: '23505',
      constraint,
    },
  );
}

export function memoryDb(options: MemoryDbOptions = {}) {
  let rows: Row[] = [];
  const log: Statement[] = [];
  const quotations: Row[] = options.quotations ?? [];
  let tail = Promise.resolve();
  let txCounter = 0;
  let sequence = 0;

  const matches = (row: Row, filters: readonly [string, unknown][]): boolean =>
    filters.every(([field, value]) => row[field] === value);

  const transaction = (tx: number, tenant: string) => {
    // RLS: lo que la transacción puede leer o escribir es sólo lo de su tenant.
    const visible = (table: string): Row[] => {
      if (table === 'orders') return rows.filter((row) => row['tenant_id'] === tenant);
      if (table === 'quotations') return quotations.filter((row) => row['tenant_id'] === tenant);
      if (table === 'tenants') return [{ id: tenant }];
      return [];
    };

    const selectFrom = (table: string) => {
      const filters: [string, unknown][] = [];
      let nextNumber = false;
      let forUpdate = false;
      const record = () => log.push({ tx, tenant, op: 'select', table, forUpdate });
      const result = () => visible(table).filter((row) => matches(row, filters));
      const query = {
        select: (selection: unknown) => {
          nextNumber = table === 'orders' && typeof selection === 'object';
          return query;
        },
        selectAll: () => query,
        where: (field: string, _op: string, value: unknown) => {
          filters.push([field, value]);
          return query;
        },
        forUpdate: () => {
          forUpdate = true;
          return query;
        },
        executeTakeFirst: () => {
          record();
          return Promise.resolve(result()[0]);
        },
        executeTakeFirstOrThrow: () => {
          record();
          if (nextNumber) {
            const max = visible('orders').reduce(
              (value, row) => Math.max(value, Number(row['order_number'])),
              0,
            );
            return Promise.resolve({ next: max + 1 });
          }
          const row = result()[0];
          return row === undefined
            ? Promise.reject(new Error(`${table}: sin filas`))
            : Promise.resolve(row);
        },
      };
      return query;
    };

    const insertInto = (table: string) => {
      let values: Row = {};
      const execute = (): Row => {
        log.push({ tx, tenant, op: 'insert', table, values });
        if (table !== 'orders') throw new Error(`insert inesperado en ${table}`);
        if (options.insertError !== undefined) {
          const error = options.insertError;
          delete options.insertError;
          throw error;
        }
        if (values['tenant_id'] !== tenant) throw new Error('RLS: tenant_id ajeno');
        // Índices únicos de `orders`: ven TODAS las filas, no sólo las del tenant.
        const clash = (predicate: (row: Row) => boolean) => rows.some(predicate);
        const key = values['create_request_key'];
        if (
          key !== null &&
          clash(
            (row) => row['tenant_id'] === values['tenant_id'] && row['create_request_key'] === key,
          )
        ) {
          throw uniqueViolation('uq_orders_create_request_key');
        }
        const ref = values['provider_booking_ref'];
        if (
          ref !== undefined &&
          ref !== null &&
          clash(
            (row) => row['provider'] === values['provider'] && row['provider_booking_ref'] === ref,
          )
        ) {
          throw uniqueViolation('uq_orders_provider_booking_ref');
        }
        if (
          clash(
            (row) =>
              row['tenant_id'] === values['tenant_id'] &&
              row['order_number'] === values['order_number'],
          )
        ) {
          throw uniqueViolation('uq_orders_tenant_order_number');
        }
        sequence += 1;
        const inserted: Row = {
          id: `order-${sequence}`,
          provider_booking_ref: null,
          provider_account_id: null,
          created_at: new Date(1_700_000_000_000 + sequence),
          updated_at: new Date(1_700_000_000_000 + sequence),
          ...values,
        };
        rows.push(inserted);
        return { ...inserted };
      };
      const query = {
        values: (next: Row) => {
          values = next;
          return query;
        },
        returningAll: () => query,
        executeTakeFirstOrThrow: () => Promise.resolve().then(execute),
      };
      return query;
    };

    const updateTable = (table: string) => {
      const filters: [string, unknown][] = [];
      let values: Row = {};
      const apply = (): Row[] => {
        log.push({ tx, tenant, op: 'update', table, values });
        if (options.failUpdates) throw new Error('orders no disponible');
        const target = visible(table).filter((row) => matches(row, filters));
        for (const row of target) Object.assign(row, values);
        return target.map((row) => ({ ...row }));
      };
      const query = {
        set: (next: Row) => {
          values = next;
          return query;
        },
        where: (field: string, _op: string, value: unknown) => {
          filters.push([field, value]);
          return query;
        },
        returningAll: () => query,
        // La forma real de Kysely: un resultado por sentencia, con el conteo en bigint.
        execute: () => Promise.resolve().then(() => [{ numUpdatedRows: BigInt(apply().length) }]),
        executeTakeFirst: () => Promise.resolve().then(() => apply()[0]),
      };
      return query;
    };

    return { selectFrom, insertInto, updateTable };
  };

  const db = {
    withTenant: async <T>(tenant: string, callback: (trx: unknown) => Promise<T>): Promise<T> => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      txCounter += 1;
      const snapshot = rows.map((row) => ({ ...row }));
      try {
        return await callback(transaction(txCounter, tenant));
      } catch (error) {
        rows = snapshot;
        throw error;
      } finally {
        release();
      }
    },
  } as unknown as DatabaseService;

  return {
    db,
    rows: () => rows,
    log,
    transactions: () => txCounter,
  };
}
