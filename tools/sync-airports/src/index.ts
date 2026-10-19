import pg from 'pg';

/**
 * Sync diario del catálogo de aeropuertos.
 *
 * Fuente: OurAirports (dominio público — https://ourairports.com/data/), la misma que genera el
 * catálogo local del buscador (tools/generate-airports-json). Antes era OpenFlights, que dejó de
 * actualizarse: le falta NLU (AIFA, 2022) y pone MDE en «Rio Negro», así que buscar «medellin» en
 * el endpoint devolvía sólo EOH. OurAirports trae la ciudad a la que sirve cada aeropuerto
 * (`municipality`) y se mantiene a diario.
 *
 * Estrategia:
 *   1. Descargar aeropuertos y países (CSV).
 *   2. Quedarse con los aeropuertos abiertos con IATA válido; si dos filas comparten IATA, la del
 *      aeropuerto más grande.
 *   3. UPSERT por código (insert si nuevo, update si cambió). OurAirports no trae zona horaria: la
 *      que ya esté en la tabla se conserva.
 *
 * Pensado para correr una vez al día desde un cron de GitHub Actions. `--dry-run` descarga y
 * procesa sin tocar la base, e imprime un resumen.
 */

const AIRPORTS_URL =
  'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv';
const COUNTRIES_URL =
  'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/countries.csv';

/** Tipos de OurAirports que son aeropuertos abiertos, del más grande al más chico. */
const TYPE_RANK: Readonly<Record<string, number>> = {
  large_airport: 3,
  medium_airport: 2,
  small_airport: 1,
};

interface AirportRow {
  code: string;
  name: string;
  city: string;
  countryCode: string | null;
  countryName: string;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
}

function parseCsv(raw: string): Record<string, string>[] {
  const lines = raw.split(/\r?\n/);
  const headers = parseLine(lines[0] ?? '');
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;
    const fields = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      row[h] = fields[j] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

function parseLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let end = i + 1;
      while (end < line.length) {
        if (line[end] === '"') {
          if (line[end + 1] === '"') end += 2;
          else break;
        } else {
          end++;
        }
      }
      fields.push(line.slice(i + 1, end).replace(/""/g, '"'));
      i = end + 1;
      if (line[i] === ',') i++;
    } else {
      const next = line.indexOf(',', i);
      const end = next === -1 ? line.length : next;
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

const REGION_ES = new Intl.DisplayNames(['es'], { type: 'region' });

/** El país en español, con el ICU de Node; si no lo conoce, el nombre en inglés del CSV. */
function countryNameEs(iso: string, english: ReadonlyMap<string, string>): string {
  try {
    const name = REGION_ES.of(iso);
    if (name && name !== iso) return name;
  } catch {
    // Código que Intl no acepta: se cae al nombre del CSV.
  }
  return english.get(iso) ?? iso;
}

function processRows(
  airports: readonly Record<string, string>[],
  countries: readonly Record<string, string>[],
): AirportRow[] {
  const english = new Map<string, string>();
  for (const c of countries) {
    const code = c['code'];
    const name = c['name'];
    if (code && name) english.set(code, name);
  }

  const best = new Map<string, { rank: number; row: AirportRow }>();
  for (const r of airports) {
    const iata = (r['iata_code'] ?? '').trim();
    const rank = TYPE_RANK[(r['type'] ?? '').trim()];
    if (rank === undefined || !/^[A-Z]{3}$/.test(iata)) continue;
    const previous = best.get(iata);
    if (previous && previous.rank >= rank) continue;

    const name = (r['name'] ?? '')
      .trim()
      .replace(/ Airport$/i, '')
      .replace(/ International$/i, ' Intl')
      .replace(/ Internacional$/i, ' Intl');
    if (!name) continue;
    const iso = (r['iso_country'] ?? '').trim().toUpperCase();
    const lat = Number.parseFloat(r['latitude_deg'] ?? '');
    const lon = Number.parseFloat(r['longitude_deg'] ?? '');

    best.set(iata, {
      rank,
      row: {
        code: iata,
        name,
        city: (r['municipality'] ?? '').trim() || name,
        countryCode: /^[A-Z]{2}$/.test(iso) ? iso : null,
        countryName: iso ? countryNameEs(iso, english) : '',
        latitude: Number.isFinite(lat) ? lat : null,
        longitude: Number.isFinite(lon) ? lon : null,
        timezone: null,
      },
    });
  }
  return [...best.values()].map((b) => b.row).sort((a, b) => (a.code < b.code ? -1 : 1));
}

async function upsert(
  client: pg.Client,
  rows: AirportRow[],
): Promise<{ inserted: number; updated: number }> {
  await client.query(
    'CREATE TEMP TABLE _airports_stage (LIKE airports INCLUDING DEFAULTS) ON COMMIT DROP',
  );

  // Bulk insert into staging using pg-copy-style multi-VALUES.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    slice.forEach((r, idx) => {
      const o = idx * 8;
      placeholders.push(
        `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`,
      );
      values.push(
        r.code,
        r.name,
        r.city,
        r.countryCode,
        r.countryName,
        r.latitude,
        r.longitude,
        r.timezone,
      );
    });
    await client.query(
      `INSERT INTO _airports_stage (code, name, city, country_code, country_name, latitude, longitude, timezone)
       VALUES ${placeholders.join(',')}`,
      values,
    );
  }

  const inserted = await client.query<{ count: string }>(`
    INSERT INTO airports (code, name, city, country_code, country_name, latitude, longitude, timezone, updated_at)
    SELECT s.code, s.name, s.city, s.country_code, s.country_name, s.latitude, s.longitude, s.timezone, now()
    FROM _airports_stage s
    LEFT JOIN airports a ON a.code = s.code
    WHERE a.code IS NULL
    RETURNING 1
  `);

  // La zona horaria no viene en OurAirports: la que ya tenga la fila se conserva.
  const updated = await client.query<{ count: string }>(`
    UPDATE airports a
    SET name = s.name,
        city = s.city,
        country_code = s.country_code,
        country_name = s.country_name,
        latitude = s.latitude,
        longitude = s.longitude,
        timezone = coalesce(s.timezone, a.timezone),
        updated_at = now()
    FROM _airports_stage s
    WHERE a.code = s.code
      AND (a.name <> s.name OR a.city <> s.city OR
           coalesce(a.country_code, '') <> coalesce(s.country_code, '') OR
           a.country_name <> s.country_name OR
           coalesce(a.latitude, 0) <> coalesce(s.latitude, 0) OR
           coalesce(a.longitude, 0) <> coalesce(s.longitude, 0) OR
           (s.timezone IS NOT NULL AND coalesce(a.timezone, '') <> s.timezone))
    RETURNING 1
  `);

  return {
    inserted: inserted.rowCount ?? 0,
    updated: updated.rowCount ?? 0,
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (!dryRun && (!process.env['PGHOST'] || !process.env['PGUSER'] || !process.env['PGPASSWORD'])) {
    throw new Error('PGHOST, PGUSER, PGPASSWORD required');
  }

  console.warn('[sync-airports] fetching OurAirports airports.csv + countries.csv...');
  const [airportsRaw, countriesRaw] = await Promise.all([
    fetchText(AIRPORTS_URL),
    fetchText(COUNTRIES_URL),
  ]);
  const rows = processRows(parseCsv(airportsRaw), parseCsv(countriesRaw));
  console.warn(`[sync-airports] parsed ${rows.length} airports with valid IATA`);

  if (dryRun) {
    const sample = new Set(['MDE', 'EOH', 'BOG', 'NLU', 'GRU', 'VCP', 'JFK', 'LHR']);
    console.warn(
      JSON.stringify({
        ok: true,
        action: 'dry-run',
        total: rows.length,
        sample: rows.filter((r) => sample.has(r.code)),
      }),
    );
    return;
  }

  const client = new pg.Client();
  await client.connect();

  try {
    await client.query('BEGIN');
    const result = await upsert(client, rows);
    await client.query('COMMIT');

    console.warn(
      JSON.stringify({
        ok: true,
        action: 'sync',
        source: 'ourairports',
        total: rows.length,
        inserted: result.inserted,
        updated: result.updated,
      }),
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
