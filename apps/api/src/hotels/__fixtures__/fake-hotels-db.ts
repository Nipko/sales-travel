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
 *
 * El doble no filtra por estado ni por ciudad: devuelve lo que se le da. Que la búsqueda pida
 * sólo lo `accepted` o lo activo se afirma sobre el SQL, no sobre el resultado.
 */

export interface FilaTenant {
  default_currency: string;
  country_code: string | null;
}

/** Lo que la tarjeta lee de `hotel_inventory` de un hotel (nombres de columna de la tabla). */
export interface FilaFicha {
  name?: string | null;
  stars?: string | number | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

/** Una equivalencia de `hotel_match`, tal como la devuelve la consulta de la búsqueda. */
export interface FilaEquivalencia {
  canonical_hotel_id: string;
  provider_code: string;
  hotel_id: string;
}

type Tabla = 'hotel_inventory' | 'tenants' | 'hotel_destination_map' | 'hotel_match';

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
  /**
   * Ciudades del mapa de destinos por proveedor destino (`target_provider_code`): lo que
   * devuelve la consulta del mapa. Un proveedor ausente no tiene mapeo.
   */
  mapa?: Readonly<Record<string, readonly string[]>>;
  /** Fichas de `hotel_inventory` por proveedor y hotel, para el contenido de la tarjeta. */
  fichas?: Readonly<Record<string, Readonly<Record<string, FilaFicha>>>>;
  /** Filas de `hotel_match` que devuelve la consulta de equivalencias. */
  equivalencias?: readonly FilaEquivalencia[];
  /** Si se define, la consulta de equivalencias falla con este error. */
  equivalenciasFallan?: Error;
}

export interface FakeHotelsDb {
  service: DatabaseService;
  /** Todas las consultas compiladas, en orden. */
  consultas: CompiledQuery[];
  /**
   * Las consultas cuyo `FROM` es esa tabla. En `hotel_inventory`, sólo las del catálogo
   * (ciudad → ids); las del contenido de la tarjeta están en `consultasDeFichas`.
   */
  consultasA: (tabla: Tabla) => CompiledQuery[];
  /** Las consultas de `hotel_inventory` que leen el contenido de la tarjeta. */
  consultasDeFichas: () => CompiledQuery[];
}

const TENANT_POR_DEFECTO: FilaTenant = { default_currency: 'USD', country_code: 'CO' };

function tablaDe(q: CompiledQuery): string | undefined {
  return /\bfrom "([a-z_]+)"/.exec(q.sql)?.[1];
}

/** La consulta de contenido es la única de `hotel_inventory` que lee el nombre. */
function esFicha(q: CompiledQuery): boolean {
  return tablaDe(q) === 'hotel_inventory' && q.sql.includes('"name"');
}

class DriverQueGraba extends DummyDriver {
  constructor(private readonly responder: (q: CompiledQuery) => unknown[]) {
    super();
  }

  override async acquireConnection(): Promise<DatabaseConnection> {
    const base = await super.acquireConnection();
    return {
      // Dentro del ejecutor: una consulta que el doble hace fallar llega como rechazo, igual que
      // un error del driver, y no como una excepción síncrona.
      executeQuery: <R>(q: CompiledQuery): Promise<QueryResult<R>> =>
        new Promise((resolve) => resolve({ rows: this.responder(q) as R[] })),
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

/** El `target_provider_code` es el tercer parámetro de la consulta del mapa. */
function mapaDe(opts: FakeHotelsDbOptions, q: CompiledQuery): { target_city_code: string }[] {
  const proveedor = String(q.parameters[2]);
  return (opts.mapa?.[proveedor] ?? []).map((target_city_code) => ({ target_city_code }));
}

/** Fichas del proveedor (primer parámetro) para los ids pedidos (el resto), en ese orden. */
function fichasDe(opts: FakeHotelsDbOptions, q: CompiledQuery): unknown[] {
  const [proveedor, ...ids] = q.parameters.map(String);
  const delProveedor = opts.fichas?.[proveedor ?? ''] ?? {};
  return ids.flatMap((hotel_id) => {
    const ficha = delProveedor[hotel_id];
    if (ficha === undefined) return [];
    return [
      {
        hotel_id,
        name: ficha.name ?? null,
        stars: ficha.stars ?? null,
        address: ficha.address ?? null,
        latitude: ficha.latitude ?? null,
        longitude: ficha.longitude ?? null,
      },
    ];
  });
}

export function fakeHotelsDb(opts: FakeHotelsDbOptions = {}): FakeHotelsDb {
  const consultas: CompiledQuery[] = [];
  const tenant = opts.tenant === undefined ? TENANT_POR_DEFECTO : opts.tenant;

  const responder = (q: CompiledQuery): unknown[] => {
    consultas.push(q);
    switch (tablaDe(q)) {
      case 'hotel_inventory':
        return esFicha(q)
          ? fichasDe(opts, q)
          : catalogoDe(opts, q).map((hotel_id) => ({ hotel_id }));
      case 'hotel_destination_map':
        return mapaDe(opts, q);
      case 'hotel_match':
        if (opts.equivalenciasFallan !== undefined) throw opts.equivalenciasFallan;
        return [...(opts.equivalencias ?? [])];
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
    consultasA: (tabla) => consultas.filter((q) => tablaDe(q) === tabla && !esFicha(q)),
    consultasDeFichas: () => consultas.filter(esFicha),
  };
}
