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
import type { DatabaseService } from '../../database/database.service.js';
import type { DB } from '../../database/database.types.js';

/**
 * Base de datos de mentira para `HotelsService`, con el compilador REAL de Postgres de Kysely.
 *
 * Un doble encadenado (`selectFrom().select().where()…`) sólo prueba que se llamó a los métodos
 * en cierto orden; con el compilador real el test afirma sobre el SQL que recibiría Postgres
 * —`order by`, `limit`, filtros y parámetros—, que es lo que no puede cambiar sin que cambien los
 * hoteles que ve el vendedor. Una consulta que este doble no reconoce revienta en vez de
 * devolver vacío: una vacía silenciosa es justo lo que convertiría un test en decorativo.
 */

export interface FilaTenant {
  default_currency: string;
  country_code: string | null;
}

export interface FakeHotelsDbOptions {
  /**
   * `hotel_id` que devuelve la consulta del catálogo, en el orden en que "los devuelve
   * Postgres". El doble no reordena ni recorta: eso lo hace el SQL, y el test lo lee del SQL.
   *
   * Una lista vale para cualquier proveedor; un objeto da el catálogo de cada `provider_code`
   * (el primer parámetro de la consulta) y uno ausente no tiene hoteles.
   */
  catalogo?: readonly string[] | Readonly<Record<string, readonly string[]>>;
  /** Fila de `tenants`; `null` = el tenant no existe. */
  tenant?: FilaTenant | null;
}

export interface FakeHotelsDb {
  service: DatabaseService;
  /** Todas las consultas compiladas, en orden. */
  consultas: CompiledQuery[];
  /** Las consultas cuyo `FROM` es esa tabla. */
  consultasA: (tabla: 'hotel_inventory' | 'tenants') => CompiledQuery[];
}

const TENANT_POR_DEFECTO: FilaTenant = { default_currency: 'USD', country_code: 'CO' };

function tablaDe(q: CompiledQuery): string | undefined {
  return /\bfrom "([a-z_]+)"/.exec(q.sql)?.[1];
}

class DriverQueGraba extends DummyDriver {
  constructor(private readonly responder: (q: CompiledQuery) => unknown[]) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const base = await super.acquireConnection();
    return {
      executeQuery: <R>(q: CompiledQuery): Promise<QueryResult<R>> =>
        Promise.resolve({ rows: this.responder(q) as R[] }),
      streamQuery: (q, chunkSize) => base.streamQuery(q, chunkSize),
    };
  }
}

function catalogoDe(opts: FakeHotelsDbOptions, q: CompiledQuery): readonly string[] {
  const catalogo = opts.catalogo ?? [];
  if (Array.isArray(catalogo)) return catalogo as readonly string[];
  const proveedor = String(q.parameters[0]);
  return (catalogo as Readonly<Record<string, readonly string[]>>)[proveedor] ?? [];
}

export function fakeHotelsDb(opts: FakeHotelsDbOptions = {}): FakeHotelsDb {
  const consultas: CompiledQuery[] = [];
  const tenant = opts.tenant === undefined ? TENANT_POR_DEFECTO : opts.tenant;

  const responder = (q: CompiledQuery): unknown[] => {
    consultas.push(q);
    switch (tablaDe(q)) {
      case 'hotel_inventory':
        return catalogoDe(opts, q).map((hotel_id) => ({ hotel_id }));
      case 'tenants':
        return tenant ? [tenant] : [];
      default:
        throw new Error(`consulta no prevista por el doble de hoteles: ${q.sql}`);
    }
  };

  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DriverQueGraba(responder),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

  return {
    service: { db } as unknown as DatabaseService,
    consultas,
    consultasA: (tabla) => consultas.filter((q) => tablaDe(q) === tabla),
  };
}
