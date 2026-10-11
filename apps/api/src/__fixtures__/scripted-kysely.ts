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
import type { DB } from '../database/database.types.js';

/**
 * Un Kysely de Postgres sin base: cada consulta compilada pasa por `respond`, que devuelve sus filas
 * (o lanza, para simular un error de la base), y queda en `queries` en orden. Sirve para probar qué
 * se consulta, en qué orden y dentro de qué transacción, sin levantar Postgres; que el SQL hace lo
 * que dice lo prueban los tests de integración.
 */
export interface ScriptedKysely {
  readonly db: Kysely<DB>;
  readonly queries: CompiledQuery[];
  /** Índice de la primera consulta cuyo SQL contiene `fragment`; -1 si no hubo. */
  indexOf(fragment: string): number;
}

class ScriptedDriver extends DummyDriver {
  constructor(private readonly respond: (q: CompiledQuery) => unknown[]) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const base = await super.acquireConnection();
    return {
      executeQuery: <R>(q: CompiledQuery): Promise<QueryResult<R>> =>
        new Promise((resolve) => resolve({ rows: this.respond(q) as R[] })),
      streamQuery: (q, chunkSize) => base.streamQuery(q, chunkSize),
    };
  }
}

export function scriptedKysely(respond: (q: CompiledQuery) => unknown[]): ScriptedKysely {
  const queries: CompiledQuery[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () =>
        new ScriptedDriver((q) => {
          queries.push(q);
          return respond(q);
        }),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return {
    db,
    queries,
    indexOf: (fragment) => queries.findIndex((q) => q.sql.includes(fragment)),
  };
}
