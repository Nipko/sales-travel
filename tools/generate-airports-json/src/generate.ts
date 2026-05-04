/**
 * Generates the static airports.json for the web-b2b frontend.
 *
 * Source: OurAirports (public domain)
 * Output: apps/web-b2b/public/data/airports.json
 *
 * Run: pnpm --filter @sales-travel/generate-airports-json generate
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, '../../../apps/web-b2b/public/data');
const OUTPUT_PATH = resolve(OUTPUT_DIR, 'airports.json');

const AIRPORTS_URL =
  'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv';
const COUNTRIES_URL =
  'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/countries.csv';

const VALID_TYPES = new Set(['large_airport', 'medium_airport', 'small_airport']);

const COUNTRY_NAME_ES: Record<string, string> = {
  AD: 'Andorra',
  AE: 'Emiratos Árabes',
  AF: 'Afganistán',
  AG: 'Antigua y Barbuda',
  AL: 'Albania',
  AM: 'Armenia',
  AO: 'Angola',
  AR: 'Argentina',
  AT: 'Austria',
  AU: 'Australia',
  AW: 'Aruba',
  AZ: 'Azerbaiyán',
  BA: 'Bosnia y Herzegovina',
  BB: 'Barbados',
  BD: 'Bangladesh',
  BE: 'Bélgica',
  BF: 'Burkina Faso',
  BG: 'Bulgaria',
  BH: 'Bahréin',
  BI: 'Burundi',
  BJ: 'Benín',
  BM: 'Bermudas',
  BN: 'Brunéi',
  BO: 'Bolivia',
  BR: 'Brasil',
  BS: 'Bahamas',
  BT: 'Bután',
  BW: 'Botsuana',
  BY: 'Bielorrusia',
  BZ: 'Belice',
  CA: 'Canadá',
  CD: 'Congo RDC',
  CF: 'Rep. Centroafricana',
  CG: 'Congo',
  CH: 'Suiza',
  CI: 'Costa de Marfil',
  CL: 'Chile',
  CM: 'Camerún',
  CN: 'China',
  CO: 'Colombia',
  CR: 'Costa Rica',
  CU: 'Cuba',
  CV: 'Cabo Verde',
  CW: 'Curaçao',
  CY: 'Chipre',
  CZ: 'Chequia',
  DE: 'Alemania',
  DJ: 'Yibuti',
  DK: 'Dinamarca',
  DM: 'Dominica',
  DO: 'Rep. Dominicana',
  DZ: 'Argelia',
  EC: 'Ecuador',
  EE: 'Estonia',
  EG: 'Egipto',
  ER: 'Eritrea',
  ES: 'España',
  ET: 'Etiopía',
  FI: 'Finlandia',
  FJ: 'Fiyi',
  FK: 'Malvinas',
  FM: 'Micronesia',
  FO: 'Islas Feroe',
  FR: 'Francia',
  GA: 'Gabón',
  GB: 'Reino Unido',
  GD: 'Granada',
  GE: 'Georgia',
  GF: 'Guayana Francesa',
  GH: 'Ghana',
  GI: 'Gibraltar',
  GL: 'Groenlandia',
  GM: 'Gambia',
  GN: 'Guinea',
  GP: 'Guadalupe',
  GQ: 'Guinea Ecuatorial',
  GR: 'Grecia',
  GT: 'Guatemala',
  GU: 'Guam',
  GW: 'Guinea-Bisáu',
  GY: 'Guyana',
  HK: 'Hong Kong',
  HN: 'Honduras',
  HR: 'Croacia',
  HT: 'Haití',
  HU: 'Hungría',
  ID: 'Indonesia',
  IE: 'Irlanda',
  IL: 'Israel',
  IN: 'India',
  IQ: 'Irak',
  IR: 'Irán',
  IS: 'Islandia',
  IT: 'Italia',
  JM: 'Jamaica',
  JO: 'Jordania',
  JP: 'Japón',
  KE: 'Kenia',
  KG: 'Kirguistán',
  KH: 'Camboya',
  KI: 'Kiribati',
  KM: 'Comoras',
  KN: 'San Cristóbal y Nieves',
  KP: 'Corea del Norte',
  KR: 'Corea del Sur',
  KW: 'Kuwait',
  KY: 'Islas Caimán',
  KZ: 'Kazajistán',
  LA: 'Laos',
  LB: 'Líbano',
  LC: 'Santa Lucía',
  LI: 'Liechtenstein',
  LK: 'Sri Lanka',
  LR: 'Liberia',
  LS: 'Lesoto',
  LT: 'Lituania',
  LU: 'Luxemburgo',
  LV: 'Letonia',
  LY: 'Libia',
  MA: 'Marruecos',
  MC: 'Mónaco',
  MD: 'Moldavia',
  ME: 'Montenegro',
  MG: 'Madagascar',
  MH: 'Islas Marshall',
  MK: 'Macedonia del Norte',
  ML: 'Mali',
  MM: 'Myanmar',
  MN: 'Mongolia',
  MO: 'Macao',
  MQ: 'Martinica',
  MR: 'Mauritania',
  MT: 'Malta',
  MU: 'Mauricio',
  MV: 'Maldivas',
  MW: 'Malaui',
  MX: 'México',
  MY: 'Malasia',
  MZ: 'Mozambique',
  NA: 'Namibia',
  NC: 'Nueva Caledonia',
  NE: 'Níger',
  NG: 'Nigeria',
  NI: 'Nicaragua',
  NL: 'Países Bajos',
  NO: 'Noruega',
  NP: 'Nepal',
  NR: 'Nauru',
  NZ: 'Nueva Zelanda',
  OM: 'Omán',
  PA: 'Panamá',
  PE: 'Perú',
  PF: 'Polinesia Francesa',
  PG: 'Papúa Nueva Guinea',
  PH: 'Filipinas',
  PK: 'Pakistán',
  PL: 'Polonia',
  PR: 'Puerto Rico',
  PS: 'Palestina',
  PT: 'Portugal',
  PW: 'Palaos',
  PY: 'Paraguay',
  QA: 'Catar',
  RE: 'Reunión',
  RO: 'Rumanía',
  RS: 'Serbia',
  RU: 'Rusia',
  RW: 'Ruanda',
  SA: 'Arabia Saudita',
  SB: 'Islas Salomón',
  SC: 'Seychelles',
  SD: 'Sudán',
  SE: 'Suecia',
  SG: 'Singapur',
  SI: 'Eslovenia',
  SK: 'Eslovaquia',
  SL: 'Sierra Leona',
  SM: 'San Marino',
  SN: 'Senegal',
  SO: 'Somalia',
  SR: 'Surinam',
  SS: 'Sudán del Sur',
  SV: 'El Salvador',
  SX: 'San Martín',
  SY: 'Siria',
  SZ: 'Esuatini',
  TC: 'Islas Turcas y Caicos',
  TD: 'Chad',
  TG: 'Togo',
  TH: 'Tailandia',
  TJ: 'Tayikistán',
  TL: 'Timor Oriental',
  TM: 'Turkmenistán',
  TN: 'Túnez',
  TO: 'Tonga',
  TR: 'Turquía',
  TT: 'Trinidad y Tobago',
  TV: 'Tuvalu',
  TW: 'Taiwán',
  TZ: 'Tanzania',
  UA: 'Ucrania',
  UG: 'Uganda',
  US: 'Estados Unidos',
  UY: 'Uruguay',
  UZ: 'Uzbekistán',
  VA: 'Vaticano',
  VC: 'San Vicente y las Granadinas',
  VE: 'Venezuela',
  VG: 'Islas Vírgenes Británicas',
  VI: 'Islas Vírgenes EE.UU.',
  VN: 'Vietnam',
  VU: 'Vanuatu',
  WS: 'Samoa',
  XK: 'Kosovo',
  YE: 'Yemen',
  ZA: 'Sudáfrica',
  ZM: 'Zambia',
  ZW: 'Zimbabue',
};

const FLAG_OFFSET = 0x1f1e6 - 65; // 'A' = 65

function countryFlag(code: string): string {
  if (code.length !== 2) return '';
  const c1 = code.charCodeAt(0);
  const c2 = code.charCodeAt(1);
  return String.fromCodePoint(c1 + FLAG_OFFSET - 32, c2 + FLAG_OFFSET - 32);
}

interface RawAirport {
  iata_code: string;
  name: string;
  municipality: string;
  iso_country: string;
  type: string;
  scheduled_service: string;
  latitude_deg: string;
  longitude_deg: string;
  keywords: string;
}

interface OutputAirport {
  c: string; // IATA code
  n: string; // name
  t: string; // city (municipality)
  cc: string; // country code (ISO2)
  cn: string; // country name (Spanish)
  f: string; // flag emoji
  la: number; // latitude
  lo: number; // longitude
  s: number; // size: 3=large, 2=medium, 1=small
  sc: boolean; // scheduled_service
  k?: string; // keywords (optional, space-separated)
}

function parseCSV(raw: string): Record<string, string>[] {
  const lines = raw.split('\n');
  const headers = parseCSVLine(lines[0]!);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const fields = parseCSVLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = fields[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let end = i + 1;
      while (end < line.length) {
        if (line[end] === '"') {
          if (end + 1 < line.length && line[end + 1] === '"') {
            end += 2;
          } else {
            break;
          }
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

function sizeFromType(type: string): number {
  if (type === 'large_airport') return 3;
  if (type === 'medium_airport') return 2;
  return 1;
}

async function main() {
  console.log('Fetching airports data from OurAirports...');
  const [airportsRaw, countriesRaw] = await Promise.all([
    fetch(AIRPORTS_URL).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching airports`);
      return r.text();
    }),
    fetch(COUNTRIES_URL).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching countries`);
      return r.text();
    }),
  ]);

  console.log('Parsing CSVs...');
  const airportRows = parseCSV(airportsRaw);
  const countryRows = parseCSV(countriesRaw);

  const countryNames = new Map<string, string>();
  for (const row of countryRows) {
    const code = row['code'] ?? '';
    const name = row['name'] ?? '';
    if (code && name) countryNames.set(code, name);
  }

  console.log(`Total airport rows: ${airportRows.length}`);

  const seen = new Set<string>();
  const output: OutputAirport[] = [];

  for (const row of airportRows) {
    const iata = (row['iata_code'] ?? '').trim();
    const type = (row['type'] ?? '').trim();

    if (!iata || !/^[A-Z]{3}$/.test(iata)) continue;
    if (!VALID_TYPES.has(type)) continue;
    if (seen.has(iata)) continue;
    seen.add(iata);

    const isoCountry = (row['iso_country'] ?? '').trim();
    const municipality = (row['municipality'] ?? '').trim();
    const name = (row['name'] ?? '')
      .trim()
      .replace(/ Airport$/i, '')
      .replace(/ International$/i, ' Intl')
      .replace(/ Internacional$/i, ' Intl');
    const lat = parseFloat(row['latitude_deg'] ?? '0');
    const lng = parseFloat(row['longitude_deg'] ?? '0');
    const scheduled = (row['scheduled_service'] ?? '') === 'yes';
    const keywords = (row['keywords'] ?? '').trim();

    const countryNameES = COUNTRY_NAME_ES[isoCountry] ?? countryNames.get(isoCountry) ?? isoCountry;
    const flag = countryFlag(isoCountry);

    const airport: OutputAirport = {
      c: iata,
      n: name,
      t: municipality || name.split(/[–\-,]/)[0]!.trim(),
      cc: isoCountry,
      cn: countryNameES,
      f: flag,
      la: Math.round(lat * 10000) / 10000,
      lo: Math.round(lng * 10000) / 10000,
      s: sizeFromType(type),
      sc: scheduled,
    };

    if (keywords) {
      const kw = keywords
        .replace(/"/g, '')
        .split(',')
        .map((k) => k.trim().toLowerCase())
        .filter((k) => k.length > 2 && k.length < 40)
        .slice(0, 5)
        .join(' ');
      if (kw) airport.k = kw;
    }

    output.push(airport);
  }

  output.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    if (a.sc !== b.sc) return a.sc ? -1 : 1;
    return a.c.localeCompare(b.c);
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const json = JSON.stringify(output);
  writeFileSync(OUTPUT_PATH, json, 'utf-8');

  const sizeKB = Math.round(json.length / 1024);
  console.log(`\nGenerated ${OUTPUT_PATH}`);
  console.log(`  Airports: ${output.length}`);
  console.log(`  Large: ${output.filter((a) => a.s === 3).length}`);
  console.log(`  Medium: ${output.filter((a) => a.s === 2).length}`);
  console.log(`  Small: ${output.filter((a) => a.s === 1).length}`);
  console.log(`  With scheduled service: ${output.filter((a) => a.sc).length}`);
  console.log(`  File size: ${sizeKB} KB (raw JSON, ~${Math.round(sizeKB * 0.25)} KB gzipped)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
