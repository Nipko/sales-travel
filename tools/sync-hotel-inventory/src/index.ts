import pg from 'pg';

/**
 * Sync del catálogo de hoteles de Despegar/HotelDo (resuelve ciudad→IDs).
 *
 * `availability` exige IDs de hotel explícitos; este job descarga el inventario estático
 * (content-api/hotels-inventory) y lo vuelca a la tabla `hotel_inventory`, indexada por city_id.
 *
 * Estrategia: reemplazo atómico por proveedor (DELETE provider_code + bulk INSERT en una tx).
 * Pensado para correr periódicamente desde un cron de GitHub Actions.
 */

const PROVIDER_CODE = process.env['DESPEGAR_PROVIDER_CODE'] ?? 'despegar-hotels';

function baseUrl(): string {
  return process.env['DESPEGAR_BASE_URL'] ?? 'https://api-dev.despegar.com/v3';
}

interface InventoryRow {
  hotelId: string;
  cityId: number | null;
  name: string | null;
  stars: number | null;
  propertyType: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  zipcode: string | null;
  mergedIds: unknown[];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface RawInventoryItem {
  id?: number | string;
  hotel_name?: string;
  published?: boolean;
  stars?: number | string;
  property_type?: string;
  merged_ids?: unknown[];
  location?: {
    city?: { id?: number | string };
    address?: string;
    zipcode?: string;
    latitude?: number | string;
    longitude?: number | string;
  };
}

/** Tamaño de página cuando el inventario responde paginado (`items` + `paging`). */
const PAGE_SIZE = 5000;
/** Tope de páginas: un `paging.total` absurdo no deja al job pidiendo para siempre. */
const MAX_PAGES = 400;

interface InventoryPage {
  items: RawInventoryItem[];
  /** Ausente: la respuesta fue el catálogo entero (array suelto), sin paginar. */
  total?: number;
}

async function fetchPage(apiKey: string, offset: number | undefined): Promise<InventoryPage> {
  const query = offset === undefined ? '' : `?limit=${PAGE_SIZE}&offset=${offset}`;
  const res = await fetch(`${baseUrl()}/content-api/hotels-inventory${query}`, {
    headers: { 'x-apikey': apiKey, accept: 'application/json' },
  });
  if (!res.ok) {
    // Sólo el estado: el cuerpo de un error no se escribe en el log del job.
    throw new Error(`HTTP ${res.status} fetching inventory`);
  }
  const json: unknown = await res.json();
  if (Array.isArray(json)) return { items: json as RawInventoryItem[] };
  const page = json as { items?: RawInventoryItem[]; paging?: { total?: number } };
  return {
    items: page.items ?? [],
    ...(typeof page.paging?.total === 'number' ? { total: page.paging.total } : {}),
  };
}

/**
 * La FAQ de Despegar dice que el inventario no pagina y la spec documenta `limit`/`offset`
 * (docs/despegar/01 § Contenido estático): sin parámetros se pide entero, y si la respuesta trae
 * `paging` se recorren las páginas.
 */
async function fetchAllItems(apiKey: string): Promise<RawInventoryItem[]> {
  const first = await fetchPage(apiKey, undefined);
  if (first.total === undefined || first.items.length >= first.total) return first.items;
  const items: RawInventoryItem[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const next = await fetchPage(apiKey, page * PAGE_SIZE);
    items.push(...next.items);
    if (next.items.length === 0 || items.length >= (next.total ?? first.total)) return items;
  }
  throw new Error('inventory paging exceeded MAX_PAGES');
}

async function fetchInventory(apiKey: string): Promise<InventoryRow[]> {
  const items = await fetchAllItems(apiKey);

  const seen = new Set<string>();
  const rows: InventoryRow[] = [];
  for (const it of items) {
    const hotelId = it.id != null ? String(it.id) : '';
    // Un hotel despublicado no se vende: no entra al catálogo de búsqueda.
    if (it.published === false) continue;
    if (!hotelId || seen.has(hotelId)) continue;
    seen.add(hotelId);
    rows.push({
      hotelId,
      cityId: numOrNull(it.location?.city?.id),
      name: str(it.hotel_name),
      stars: numOrNull(it.stars),
      propertyType: str(it.property_type),
      latitude: numOrNull(it.location?.latitude),
      longitude: numOrNull(it.location?.longitude),
      address: str(it.location?.address),
      zipcode: str(it.location?.zipcode),
      mergedIds: Array.isArray(it.merged_ids) ? it.merged_ids : [],
    });
  }
  return rows;
}

async function replaceInventory(client: pg.Client, rows: InventoryRow[]): Promise<number> {
  await client.query('DELETE FROM hotel_inventory WHERE provider_code = $1', [PROVIDER_CODE]);

  const COLS = 12;
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    slice.forEach((r, idx) => {
      const o = idx * COLS;
      // merged_ids (última col) se castea a jsonb explícitamente.
      placeholders.push(
        `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11},$${o + 12}::jsonb)`,
      );
      values.push(
        PROVIDER_CODE,
        r.hotelId,
        r.cityId,
        null, // country_code: no viene en el inventario
        r.name,
        r.stars,
        r.propertyType,
        r.latitude,
        r.longitude,
        r.address,
        r.zipcode,
        JSON.stringify(r.mergedIds),
      );
    });
    await client.query(
      `INSERT INTO hotel_inventory
         (provider_code, hotel_id, city_id, country_code, name, stars, property_type, latitude, longitude, address, zipcode, merged_ids)
       VALUES ${placeholders.join(',')}`,
      values,
    );
    inserted += slice.length;
  }
  return inserted;
}

async function main(): Promise<void> {
  const apiKey = process.env['DESPEGAR_API_KEY'];
  if (!apiKey) {
    // Sin credenciales todavía: no es un error (se configuran luego). No-op idempotente.
    console.warn(JSON.stringify({ ok: true, action: 'skip', reason: 'DESPEGAR_API_KEY not set' }));
    return;
  }
  if (!process.env['PGHOST'] || !process.env['PGUSER'] || !process.env['PGPASSWORD']) {
    throw new Error('PGHOST, PGUSER, PGPASSWORD required');
  }

  console.warn('[sync-hotel-inventory] fetching content-api/hotels-inventory...');
  const rows = await fetchInventory(apiKey);
  console.warn(`[sync-hotel-inventory] parsed ${rows.length} hotels`);
  if (rows.length === 0) {
    // El reemplazo es DELETE + INSERT: con una respuesta vacía dejaría sin hoteles todas las
    // búsquedas de Despegar. Mejor conservar el catálogo anterior y fallar visible.
    throw new Error('empty inventory: refusing to replace the catalog');
  }

  const client = new pg.Client();
  await client.connect();
  try {
    await client.query('BEGIN');
    const inserted = await replaceInventory(client, rows);
    await client.query('COMMIT');
    console.warn(
      JSON.stringify({ ok: true, action: 'sync', provider: PROVIDER_CODE, total: inserted }),
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
