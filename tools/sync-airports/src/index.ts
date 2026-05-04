import pg from 'pg';

/**
 * Sync diario del catálogo de aeropuertos.
 *
 * Fuente: OpenFlights airports.dat (ODbL — https://openflights.org/data.html).
 *
 * Estrategia:
 *   1. Descargar el dataset crudo (CSV).
 *   2. Parsear y filtrar a aeropuertos con IATA válido.
 *   3. UPSERT por código (insert si nuevo, update si cambió).
 *   4. Marcar como stale los que ya no aparecen y borrarlos opcionalmente.
 *
 * Pensado para correr una vez al día desde un cron de GitHub Actions.
 */

const SOURCE_URL =
  'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat';

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  Colombia: 'CO',
  Brazil: 'BR',
  Peru: 'PE',
  Chile: 'CL',
  Argentina: 'AR',
  Mexico: 'MX',
  Ecuador: 'EC',
  Uruguay: 'UY',
  Paraguay: 'PY',
  Bolivia: 'BO',
  Venezuela: 'VE',
  'Costa Rica': 'CR',
  Panama: 'PA',
  'Dominican Republic': 'DO',
  Cuba: 'CU',
  Guatemala: 'GT',
  Honduras: 'HN',
  Nicaragua: 'NI',
  'El Salvador': 'SV',
  'Puerto Rico': 'PR',
  Haiti: 'HT',
  Jamaica: 'JM',
  Suriname: 'SR',
  Guyana: 'GY',
  'United States': 'US',
  Canada: 'CA',
  Spain: 'ES',
  France: 'FR',
  Italy: 'IT',
  Germany: 'DE',
  'United Kingdom': 'GB',
  Netherlands: 'NL',
  Portugal: 'PT',
  Switzerland: 'CH',
  Belgium: 'BE',
  Ireland: 'IE',
  Austria: 'AT',
  Greece: 'GR',
  Turkey: 'TR',
  China: 'CN',
  Japan: 'JP',
  'South Korea': 'KR',
  Australia: 'AU',
  'New Zealand': 'NZ',
  India: 'IN',
  Thailand: 'TH',
  Vietnam: 'VN',
  Indonesia: 'ID',
  Singapore: 'SG',
  Malaysia: 'MY',
  Philippines: 'PH',
  'United Arab Emirates': 'AE',
  Qatar: 'QA',
  Israel: 'IL',
  Russia: 'RU',
  'South Africa': 'ZA',
  Egypt: 'EG',
  Morocco: 'MA',
};

const COUNTRY_NAME_ES: Record<string, string> = {
  Brazil: 'Brasil',
  Peru: 'Perú',
  Mexico: 'México',
  Panama: 'Panamá',
  Haiti: 'Haití',
  'Dominican Republic': 'República Dominicana',
  'United States': 'Estados Unidos',
  'United Kingdom': 'Reino Unido',
  Spain: 'España',
  France: 'Francia',
  Italy: 'Italia',
  Germany: 'Alemania',
  Netherlands: 'Países Bajos',
  Belgium: 'Bélgica',
  Ireland: 'Irlanda',
  Austria: 'Austria',
  Greece: 'Grecia',
  Turkey: 'Turquía',
  Japan: 'Japón',
  'South Korea': 'Corea del Sur',
  Australia: 'Australia',
  'New Zealand': 'Nueva Zelanda',
  Thailand: 'Tailandia',
  Singapore: 'Singapur',
  'United Arab Emirates': 'Emiratos Árabes Unidos',
  'South Africa': 'Sudáfrica',
  Egypt: 'Egipto',
  Morocco: 'Marruecos',
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

function parseLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      const end = line.indexOf('"', i + 1);
      fields.push(line.slice(i + 1, end));
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

async function fetchSource(): Promise<string> {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${SOURCE_URL}`);
  return res.text();
}

function processCsv(raw: string): AirportRow[] {
  const seen = new Set<string>();
  const out: AirportRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const f = parseLine(line);
    // [id, name, city, country, iata, icao, lat, lon, alt, tz, dst, tzdb, type, source]
    const name = f[1];
    const city = f[2];
    const country = f[3];
    const iata = f[4];
    const lat = f[6];
    const lon = f[7];
    const tz = f[11];
    const type = f[12];

    if (type && type !== 'airport') continue;
    if (!iata || iata === '\\N' || !/^[A-Z]{3}$/.test(iata)) continue;
    if (!name || !city || !country) continue;
    if (seen.has(iata)) continue;
    seen.add(iata);

    out.push({
      code: iata,
      name: name.replace(/ Airport$/, '').replace(/ International$/, ' Internacional'),
      city,
      countryCode: COUNTRY_NAME_TO_CODE[country] ?? null,
      countryName: COUNTRY_NAME_ES[country] ?? country,
      latitude: lat && lat !== '\\N' ? Number(lat) : null,
      longitude: lon && lon !== '\\N' ? Number(lon) : null,
      timezone: tz && tz !== '\\N' ? tz : null,
    });
  }
  return out;
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

  const updated = await client.query<{ count: string }>(`
    UPDATE airports a
    SET name = s.name,
        city = s.city,
        country_code = s.country_code,
        country_name = s.country_name,
        latitude = s.latitude,
        longitude = s.longitude,
        timezone = s.timezone,
        updated_at = now()
    FROM _airports_stage s
    WHERE a.code = s.code
      AND (a.name <> s.name OR a.city <> s.city OR
           coalesce(a.country_code, '') <> coalesce(s.country_code, '') OR
           a.country_name <> s.country_name OR
           coalesce(a.latitude, 0) <> coalesce(s.latitude, 0) OR
           coalesce(a.longitude, 0) <> coalesce(s.longitude, 0) OR
           coalesce(a.timezone, '') <> coalesce(s.timezone, ''))
    RETURNING 1
  `);

  return {
    inserted: inserted.rowCount ?? 0,
    updated: updated.rowCount ?? 0,
  };
}

async function main(): Promise<void> {
  if (!process.env['PGHOST'] || !process.env['PGUSER'] || !process.env['PGPASSWORD']) {
    throw new Error('PGHOST, PGUSER, PGPASSWORD required');
  }

  console.warn('[sync-airports] fetching OpenFlights airports.dat...');
  const raw = await fetchSource();
  const rows = processCsv(raw);
  console.warn(`[sync-airports] parsed ${rows.length} airports with valid IATA`);

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
