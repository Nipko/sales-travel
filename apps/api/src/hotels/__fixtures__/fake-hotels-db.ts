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
  zipcode?: string | null;
  country_code?: string | null;
}

/**
 * Una fila de `hotel_content` como la devuelve `pg`: JSONB ya parseado y `TIME` como `'HH:MM:SS'`.
 * Lo que no se da sale `null`.
 */
export interface FilaContenido {
  lang: string;
  source: string;
  name?: string | null;
  description_html?: string | null;
  sections?: unknown;
  facilities?: unknown;
  attractions_html?: string | null;
  images?: unknown;
  phone?: string | null;
  website_url?: string | null;
  check_in_time?: string | null;
  check_out_time?: string | null;
}

/** Una equivalencia de `hotel_match`, tal como la devuelve la consulta de la búsqueda. */
export interface FilaEquivalencia {
  canonical_hotel_id: string;
  provider_code: string;
  hotel_id: string;
}

/** Una fila de `hotel_provider_city` tal como la lee la sugerencia de destinos. */
export interface FilaCiudad {
  provider_code: string;
  provider_city_code: string;
  name: string;
  country_code: string;
}

/** Una fila de las fotos candidatas (`hotel-catalog:main-images`), con los nombres de la consulta. */
export interface FilaFoto {
  want_provider: string;
  want_hotel: string;
  provider_code: string;
  image_count: number;
  first_images: unknown[];
}

/** Lo que sabe la base del contenido de un hotel (`hotel-catalog:content-state`). */
export interface FilaEstadoContenido {
  in_catalog: boolean;
  has_details: boolean;
}

/**
 * Las consultas crudas de `HotelCatalogStore` (0054), reconocidas por su marca
 * (`/* hotel-catalog:… *\/`). Sin esta opción responden vacío: sin fotos, sin estado, sin ciudad.
 */
export interface CatalogoBajoDemanda {
  /** Filas de fotos candidatas; una función se evalúa en cada consulta (el catálogo cambia). */
  fotos?: readonly FilaFoto[] | (() => readonly FilaFoto[]);
  /** Por `proveedor hotel`; un hotel ausente no está en el catálogo. */
  estado?: Readonly<Record<string, FilaEstadoContenido>>;
  /** La ciudad de `hotel-catalog:city`; ausente = el catálogo no la conoce. */
  ciudad?: { country_code: string; hotel_count: number | null };
  /** Lo que devuelve `hotel_catalog_import_city`. */
  importar?: { outcome: string; active_hotels: number };
  /**
   * El catálogo (`hotel_inventory`, ciudad → ids) DESPUÉS de una carga: lo que devuelve la consulta
   * del catálogo una vez que pasó `hotel-catalog:import-city`.
   */
  catalogoTrasImportar?: readonly string[] | Readonly<Record<string, readonly string[]>>;
  /** Si se define, la consulta con esa marca falla con este error. */
  fallan?: Readonly<Record<string, Error>>;
  /** Se llama con lo que llega a `hotel_catalog_store_contents`, como si se guardara. */
  alGuardar?: (providerCode: string, filas: readonly Record<string, unknown>[]) => void;
  /** Filas que la función rechaza (las primeras de cada llamada); por defecto, ninguna. */
  rechazadas?: number;
}

type Tabla =
  | 'hotel_inventory'
  | 'tenants'
  | 'hotel_destination_map'
  | 'hotel_match'
  | 'hotel_content'
  | 'hotel_provider_city';

export interface FakeHotelsDbOptions {
  /**
   * `hotel_id` que devuelve la consulta del catálogo, en el orden en que "los devuelve
   * Postgres". El doble no reordena ni recorta: eso lo hace el SQL, y el test lo lee del SQL.
   *
   * Una lista vale para cualquier proveedor; un objeto da el catálogo de cada `provider_code`
   * (el primer parámetro de la consulta) y uno ausente no tiene hoteles.
   */
  catalogo?: readonly string[] | Readonly<Record<string, readonly string[]>>;
  /**
   * Lo que Postgres calcularía con `count(*) over ()` en la consulta del catálogo, por
   * `provider_code`: los activos del destino aunque pasen el `limit`. Sin él, la fila no lo trae y
   * el servicio cuenta lo que llegó.
   */
  totalCatalogo?: Readonly<Record<string, number>>;
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
  /**
   * Filas de `hotel_content` por proveedor y hotel. La consulta de la ficha las filtra por los
   * idiomas que pide (sus parámetros), como lo haría Postgres.
   */
  contenidos?: Readonly<Record<string, Readonly<Record<string, readonly FilaContenido[]>>>>;
  /**
   * Filas de `hotel_provider_city` que devuelve la sugerencia de destinos, tal cual: el doble no
   * filtra por nombre ni ordena. Eso lo hace el SQL, y el test lo lee del SQL.
   */
  ciudades?: readonly FilaCiudad[];
  /** Si se define, la consulta de `hotel_provider_city` falla con este error. */
  ciudadesFallan?: Error;
  /** Las consultas crudas del catálogo bajo demanda (fotos, ciudades que se cargan al buscar). */
  catalogoBajoDemanda?: CatalogoBajoDemanda;
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
  /** Las consultas crudas de `HotelCatalogStore` con esa marca (`main-images`, `import-city`…). */
  consultasMarcadas: (marca: string) => CompiledQuery[];
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

/** La marca de una consulta cruda de `HotelCatalogStore`, o `undefined`. */
function marcaDe(q: CompiledQuery): string | undefined {
  return /\/\* hotel-catalog:([a-z-]+) \*\//.exec(q.sql)?.[1];
}

function catalogoDe(
  opts: FakeHotelsDbOptions,
  q: CompiledQuery,
  importado: boolean,
): readonly string[] {
  const tras = opts.catalogoBajoDemanda?.catalogoTrasImportar;
  const catalogo = (importado && tras !== undefined ? tras : opts.catalogo) ?? [];
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
        zipcode: ficha.zipcode ?? null,
        country_code: ficha.country_code ?? null,
      },
    ];
  });
}

/** Contenido del proveedor (primer parámetro) y el hotel (segundo) en los idiomas pedidos (el resto). */
function contenidosDe(opts: FakeHotelsDbOptions, q: CompiledQuery): unknown[] {
  const [proveedor, hotelId, ...idiomas] = q.parameters.map(String);
  const filas = opts.contenidos?.[proveedor ?? '']?.[hotelId ?? ''] ?? [];
  return filas
    .filter((f) => idiomas.includes(f.lang))
    .map((f) => ({
      lang: f.lang,
      source: f.source,
      name: f.name ?? null,
      description_html: f.description_html ?? null,
      sections: f.sections ?? null,
      facilities: f.facilities ?? null,
      attractions_html: f.attractions_html ?? null,
      images: f.images ?? null,
      phone: f.phone ?? null,
      website_url: f.website_url ?? null,
      check_in_time: f.check_in_time ?? null,
      check_out_time: f.check_out_time ?? null,
    }));
}

/** Respuesta de una consulta cruda de `HotelCatalogStore`, por su marca. */
function marcadaDe(opts: FakeHotelsDbOptions, marca: string, q: CompiledQuery): unknown[] {
  const bajo = opts.catalogoBajoDemanda ?? {};
  const falla = bajo.fallan?.[marca];
  if (falla !== undefined) throw falla;
  switch (marca) {
    case 'main-images': {
      const fotos = typeof bajo.fotos === 'function' ? bajo.fotos() : (bajo.fotos ?? []);
      return [...fotos];
    }
    case 'content-state': {
      const [proveedores, hoteles] = q.parameters as [string[], string[]];
      return proveedores.map((provider_code, i) => {
        const hotel_id = hoteles[i] ?? '';
        const estado = bajo.estado?.[`${provider_code} ${hotel_id}`];
        return {
          provider_code,
          hotel_id,
          in_catalog: estado?.in_catalog ?? false,
          has_details: estado?.has_details ?? false,
        };
      });
    }
    case 'city':
      return bajo.ciudad === undefined ? [] : [bajo.ciudad];
    case 'import-city':
      return [bajo.importar ?? { outcome: 'loaded', active_hotels: 1 }];
    case 'store-contents': {
      const filas = JSON.parse(String(q.parameters[1])) as Record<string, unknown>[];
      bajo.alGuardar?.(String(q.parameters[0]), filas);
      const rechazadas = Math.min(bajo.rechazadas ?? 0, filas.length);
      return [
        {
          inserted: filas.length - rechazadas,
          rewritten: 0,
          touched: 0,
          unchanged: 0,
          protected: 0,
          rejected: rechazadas,
        },
      ];
    }
    default:
      throw new Error(`consulta marcada no prevista por el doble de hoteles: ${marca}`);
  }
}

export function fakeHotelsDb(opts: FakeHotelsDbOptions = {}): FakeHotelsDb {
  const consultas: CompiledQuery[] = [];
  const tenant = opts.tenant === undefined ? TENANT_POR_DEFECTO : opts.tenant;
  let importado = false;

  const responder = (q: CompiledQuery): unknown[] => {
    consultas.push(q);
    const marca = marcaDe(q);
    if (marca !== undefined) {
      const filas = marcadaDe(opts, marca, q);
      if (marca === 'import-city') importado = true;
      return filas;
    }
    switch (tablaDe(q)) {
      case 'hotel_inventory': {
        if (esFicha(q)) return fichasDe(opts, q);
        const total = opts.totalCatalogo?.[String(q.parameters[0])];
        return catalogoDe(opts, q, importado).map((hotel_id) =>
          total === undefined ? { hotel_id } : { hotel_id, catalog_total: String(total) },
        );
      }
      case 'hotel_destination_map':
        return mapaDe(opts, q);
      case 'hotel_match':
        if (opts.equivalenciasFallan !== undefined) throw opts.equivalenciasFallan;
        return [...(opts.equivalencias ?? [])];
      case 'tenants':
        return tenant ? [tenant] : [];
      case 'hotel_content':
        return contenidosDe(opts, q);
      case 'hotel_provider_city':
        if (opts.ciudadesFallan !== undefined) throw opts.ciudadesFallan;
        return [...(opts.ciudades ?? [])];
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
    consultasMarcadas: (marca) => consultas.filter((q) => marcaDe(q) === marca),
  };
}
