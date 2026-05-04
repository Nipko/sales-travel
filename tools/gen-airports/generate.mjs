#!/usr/bin/env node
// Genera apps/web-b2b/src/lib/airports.generated.ts a partir del dataset
// OpenFlights (https://openflights.org/data.html, ODbL license).
//
// Uso:
//   node tools/gen-airports/generate.mjs
//
// El script:
//   1. Descarga airports.dat de OpenFlights.
//   2. Filtra a type=airport con IATA code válido (3 letras).
//   3. Normaliza, deduplica por IATA, ordena.
//   4. Mapea country name → ISO-3166 alpha-2 (los más comunes; resto vacío).
//   5. Escribe el TS generado.
//
// Re-correrlo cuando salga release nuevo de OpenFlights (cada pocos meses).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_URL =
  'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat';
const OUT_PATH = path.join(ROOT, 'apps/web-b2b/src/lib/airports.generated.ts');

const COUNTRY_NAME_TO_CODE = {
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

const COUNTRY_NAME_ES = {
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

// Parser CSV simple para el formato de OpenFlights (campos quoted con comillas
// dobles, sin escape de comillas dentro de strings — se rompe si lo hubiera).
function parseLine(line) {
  const fields = [];
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

async function fetchSource() {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${SOURCE_URL}`);
  return res.text();
}

// Países LATAM + Caribe (todos los aeropuertos) y hubs intl seleccionados.
const LATAM_COUNTRIES = new Set(Object.keys(COUNTRY_NAME_TO_CODE).filter((c) =>
  ['CO', 'BR', 'PE', 'CL', 'AR', 'MX', 'EC', 'UY', 'PY', 'BO', 'VE',
   'CR', 'PA', 'DO', 'CU', 'GT', 'HN', 'NI', 'SV', 'PR', 'HT', 'JM',
   'SR', 'GY'].includes(COUNTRY_NAME_TO_CODE[c])
));

// Hubs intl: solo IATA codes específicos de aeropuertos relevantes para LATAM.
// Lista cerrada — no incluimos cada aeropuerto chico de US/EU/Asia.
const INTL_HUB_CODES = new Set([
  // USA
  'MIA', 'JFK', 'EWR', 'LGA', 'LAX', 'ORD', 'IAH', 'DFW', 'ATL', 'MCO',
  'LAS', 'SFO', 'BOS', 'IAD', 'DCA', 'SEA', 'PHX', 'CLT', 'DEN', 'MSP',
  'DTW', 'PHL', 'BWI', 'TPA', 'FLL', 'SAN', 'AUS', 'PDX', 'SLC', 'STL',
  // Canadá
  'YYZ', 'YVR', 'YUL', 'YYC',
  // España
  'MAD', 'BCN', 'PMI', 'AGP', 'TFS', 'TFN', 'LPA', 'VLC', 'BIO', 'SVQ',
  // Resto Europa
  'CDG', 'ORY', 'FCO', 'MXP', 'LIN', 'LHR', 'LGW', 'STN', 'AMS', 'FRA',
  'MUC', 'TXL', 'BER', 'LIS', 'OPO', 'ZRH', 'GVA', 'BRU', 'VIE', 'ATH',
  'IST', 'HEL', 'OSL', 'CPH', 'ARN', 'DUB', 'EDI',
  // Asia / Oceanía
  'NRT', 'HND', 'ICN', 'PVG', 'PEK', 'PKX', 'HKG', 'TPE', 'BKK', 'SIN',
  'KUL', 'CGK', 'MNL', 'DEL', 'BOM', 'SYD', 'MEL', 'AKL',
  // Medio Oriente / África
  'DXB', 'AUH', 'DOH', 'IST', 'TLV', 'CAI', 'JNB', 'CMN',
]);

function process(raw) {
  const seen = new Set();
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const f = parseLine(line);
    const [, name, city, country, iata, , , , , , , , type] = f;
    if (type && type !== 'airport') continue;
    if (!iata || iata === '\\N' || !/^[A-Z]{3}$/.test(iata)) continue;
    if (!name || !city || !country) continue;
    if (seen.has(iata)) continue;

    const isLatam = LATAM_COUNTRIES.has(country);
    const isIntlHub = INTL_HUB_CODES.has(iata);
    if (!isLatam && !isIntlHub) continue;

    seen.add(iata);
    out.push({
      code: iata,
      name: name.replace(/ Airport$/, '').replace(/ International$/, ' Internacional'),
      city,
      country: COUNTRY_NAME_TO_CODE[country] ?? '',
      countryName: COUNTRY_NAME_ES[country] ?? country,
    });
  }
  out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}

function emit(airports) {
  const header = `// AUTO-GENERATED by tools/gen-airports/generate.mjs
// Source: OpenFlights airports.dat (ODbL — https://openflights.org/data.html)
// Re-generate: node tools/gen-airports/generate.mjs
// Last generated: ${new Date().toISOString()}
// Total airports: ${airports.length}

import type { Airport } from './airports';

export const AIRPORTS_GENERATED: Airport[] = ${JSON.stringify(airports, null, 2)};
`;
  return header;
}

async function main() {
  console.log(`fetching ${SOURCE_URL} ...`);
  const raw = await fetchSource();
  const airports = process(raw);
  console.log(`processed ${airports.length} airports with valid IATA codes`);
  const ts = emit(airports);
  await fs.writeFile(OUT_PATH, ts);
  console.log(`written → ${path.relative(ROOT, OUT_PATH)} (${(ts.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
