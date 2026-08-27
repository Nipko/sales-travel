/**
 * Arnés de Fase 0 contra el sandbox CERT de Sabre.
 *
 * Ejecuta los pasos de `docs/sabre/11-plan-implementacion.md` §4.2 que NO crean reservas:
 * autenticación, entitlements, captura de shop, medición de aporte incremental, latencia y
 * capturas negativas. Reservar y emitir se dejan fuera a propósito: dependen de D1 (qué forma
 * de pago se manda) y crean PNR reales, aunque sea en certificación.
 *
 * Las credenciales se leen SIEMPRE del entorno. Nunca se imprimen, nunca se guardan en las
 * capturas y nunca entran a Git — ver `docs/sabre/12-cierre-auditoria.md` §1.
 *
 *   node tools/sabre/cert-probe.mjs auth
 *   node tools/sabre/cert-probe.mjs entitlements
 *   node tools/sabre/cert-probe.mjs shop
 *   node tools/sabre/cert-probe.mjs value
 *   node tools/sabre/cert-probe.mjs latency
 *   node tools/sabre/cert-probe.mjs errors
 *   node tools/sabre/cert-probe.mjs all      # todo lo anterior, en orden
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const captureDir = resolve(root, 'docs', 'sabre', 'evidence', 'captures');

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

/** Carga `.env.sabre` de la raíz si existe. Está en .gitignore: es donde viven las credenciales. */
async function loadDotEnv() {
  const path = resolve(root, '.env.sabre');
  if (!existsSync(path)) return;
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
}

function config() {
  const cfg = {
    // Camino corto: el `secret` YA CALCULADO que Postman guarda en su environment. Se admite
    // porque es lo que un operador tiene a mano si ya busca desde Postman, y evita pedirle que
    // desmonte la credencial en tres piezas para que el script la vuelva a montar igual.
    secret: process.env.SABRE_SECRET,
    epr: process.env.SABRE_EPR,
    password: process.env.SABRE_PASSWORD,
    pcc: process.env.SABRE_PCC,
    host: process.env.SABRE_HOST ?? 'https://api.cert.platform.sabre.com',
    domain: process.env.SABRE_DOMAIN ?? 'AA',
    depDate: process.env.DEP_DATE ?? isoPlusDays(30),
    retDate: process.env.RET_DATE ?? isoPlusDays(37),
  };

  // El PCC hace falta SIEMPRE, incluso con el secret ya hecho: va en el body de cada búsqueda
  // (`POS.Source.PseudoCityCode`), no sólo dentro de la credencial.
  if (!cfg.pcc) {
    console.error(
      `Falta SABRE_PCC. Va en el body de cada búsqueda, no sólo dentro del secret.\n` +
        `En tu environment de Postman es la variable \`pcc\`.`,
    );
    process.exit(2);
  }
  if (cfg.secret) return cfg;

  const missing = ['epr', 'password'].filter((k) => !cfg[k]);
  if (missing.length > 0) {
    console.error(
      `Faltan credenciales: ${missing.map((m) => 'SABRE_' + m.toUpperCase()).join(', ')}.\n\n` +
        `Dos formas de darlas, en ${resolve(root, '.env.sabre')} (ya está en .gitignore):\n` +
        `  (a) SABRE_SECRET=<el valor de la variable \`secret\` de tu environment de Postman>\n` +
        `  (b) SABRE_EPR + SABRE_PASSWORD, y el script deriva el secret\n` +
        `En ambos casos hace falta SABRE_PCC.\n` +
        `Ver docs/sabre/20-workflows-e2e.md §8.1.`,
    );
    process.exit(2);
  }
  return cfg;
}

function isoPlusDays(days) {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Esquema de doble base64 de Sabre para `/v2/auth/token`.
 * VERIFICADO en el script pre-request de la colección — ver `docs/sabre/01-…` §2.1.
 * OJO: el secret es reversible, no un hash. Quien lo tenga tiene el password en claro.
 */
function deriveSecret({ secret, epr, pcc, password, domain }) {
  if (secret) return secret;
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  return b64(`${b64(`V1:${epr}:${pcc}:${domain}`)}:${b64(password)}`);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

let cachedToken = null;

async function getToken(cfg) {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const started = Date.now();
  const res = await fetch(`${cfg.host}/v2/auth/token`, {
    method: 'POST',
    headers: {
      // El secret NUNCA se loguea. Es equivalente al password.
      Authorization: `Basic ${deriveSecret(cfg)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`auth ${res.status}: ${text.slice(0, 300)}`);

  const data = JSON.parse(text);
  // P-08: `expires_in` no aparece en ninguna parte de la colección. Se mide aquí.
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(60, (data.expires_in ?? 604800) - 60) * 1000,
    expiresIn: data.expires_in,
    tokenType: data.token_type,
    latencyMs: Date.now() - started,
  };
  return cachedToken.value;
}

async function call(cfg, path, body, { label } = {}) {
  const token = await getToken(cfg);
  const started = Date.now();
  const res = await fetch(`${cfg.host}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Conversation-ID': `salestravel-phase0-${Date.now()}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const latencyMs = Date.now() - started;

  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* respuesta no-JSON: se conserva el texto crudo para diagnóstico */
  }

  return {
    label,
    path,
    status: res.status,
    latencyMs,
    json,
    raw: json ? null : text.slice(0, 2000),
  };
}

/**
 * Sabre transporta fallos de negocio dentro de HTTP 200 — 14 de 21 contratos declaran sólo `200`
 * (`docs/sabre/12-cierre-auditoria.md` §3.1). Mirar `res.ok` da reservas fallidas por confirmadas.
 * Esta es la regla de éxito que el ACL tendrá que implementar de verdad.
 */
function classify(result) {
  if (result.status === 401) return { ok: false, kind: 'AUTH' };
  if (result.status === 403) return { ok: false, kind: 'ENTITLEMENT' };
  if (result.status >= 500) return { ok: false, kind: 'UPSTREAM' };
  if (result.status >= 400) return { ok: false, kind: 'CLIENT' };

  const j = result.json;
  if (!j) return { ok: true, kind: 'OK' };

  const errors = j.errors ?? j.Errors ?? [];
  if (Array.isArray(errors) && errors.length > 0) {
    return { ok: false, kind: 'BODY_ERRORS', detail: summarize(errors) };
  }
  const messages = j.messages ?? j.groupedItineraryResponse?.messages ?? [];
  const severe = (Array.isArray(messages) ? messages : []).filter((m) =>
    /error/i.test(String(m.severity ?? m.type ?? '')),
  );
  if (severe.length > 0) return { ok: false, kind: 'BODY_SEVERITY', detail: summarize(severe) };

  // Entitlement parcial: el vendedor vería datos faltantes como datos vacíos.
  if (JSON.stringify(j).includes('"UNAUTHORIZED"')) {
    return { ok: true, kind: 'OK_PARTIAL_UNAUTHORIZED' };
  }
  return { ok: true, kind: 'OK' };
}

function summarize(items) {
  return items
    .slice(0, 3)
    .map((e) => [e.code, e.type, e.message ?? e.description ?? e.text].filter(Boolean).join(' '))
    .join(' | ')
    .slice(0, 240);
}

// ---------------------------------------------------------------------------
// Capturas
// ---------------------------------------------------------------------------

const PII_KEYS =
  /^(givenName|surname|middleName|birthDate|email|emails|phone|phones|number|documentNumber|passportNumber|cardNumber|creditCardNumber|securityCode|cvv|nameNumber)$/i;

/** Las capturas se versionan: hay que quitar PII antes. `getBooking` hace eco de la request entera. */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, PII_KEYS.test(k) ? '«REDACTADO»' : redact(v)]),
    );
  }
  return value;
}

async function capture(name, payload) {
  const file = resolve(captureDir, `${name}.json`);
  // Se crea el directorio del FICHERO, no `captureDir` a secas: todos los `name` llevan carpeta
  // (`auth/token-200`, `shop/…`, `value/incremental`), así que crear sólo la raíz dejaba el
  // `writeFile` en ENOENT y el paso entero abortado — por eso `evidence/captures/` sigue vacío
  // aunque el arnés "corriera". Verificado ejecutando `cert-probe.mjs shop` contra un Sabre local.
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(redact(payload), null, 2));
  return file;
}

// ---------------------------------------------------------------------------
// Payloads de shop
// ---------------------------------------------------------------------------

function shopBody(cfg, opts = {}) {
  const {
    from = process.env.ROUTE_FROM ?? 'BOG',
    to = process.env.ROUTE_TO ?? 'MDE',
    roundTrip = false,
    sources = { NDC: 'Enable', ATPCO: 'Enable', LCC: 'Disable' },
    pax = [{ Code: 'ADT', Quantity: 1 }],
    cabin = null,
    multiSource = true,
    requestType = '50ITINS',
  } = opts;

  const od = [
    {
      RPH: '1',
      DepartureDateTime: `${cfg.depDate}T00:00:00`,
      OriginLocation: { LocationCode: from },
      DestinationLocation: { LocationCode: to },
    },
  ];
  if (roundTrip) {
    od.push({
      RPH: '2',
      DepartureDateTime: `${cfg.retDate}T00:00:00`,
      OriginLocation: { LocationCode: to },
      DestinationLocation: { LocationCode: from },
    });
  }

  const travelPreferences = { TPA_Extensions: { NumTrips: { Number: 10 }, DataSources: sources } };
  if (cabin) travelPreferences.CabinPref = [{ Cabin: cabin, PreferLevel: 'Preferred' }];

  // Sin este flag Sabre poda la alternativa cross-source más cara antes de que la veamos
  // ("By default, the cheaper will stay" — bargain-finder-max-v5.yml:5473-5478).
  //
  // VA EN `TPA_Extensions.IntelliSellTransaction`, NO en `TravelPreferences.TPA_Extensions`.
  // El contrato sólo lo declara en el primero (`v5.yml:5473` dentro de
  // `OTA_AirLowFareSearchRQ.TPA_Extensions.IntelliSellTransaction`, definición en `:5522`); en
  // `TravelPreferences.TPA_Extensions` (`:5924`) no existe esa propiedad. Puesto ahí, Sabre lo
  // ignora sin devolver error — y entonces el A/B de `stepValue` corre las DOS ramas
  // (`multiSource` true y false) con el mismo request, la diferencia sale ~0 y P-04 se decide
  // con un experimento que nunca midió nada. Es también dónde lo pone el builder de producción
  // (`providers/sabre/src/shop/request.builder.ts`), así que la captura vale para prod.
  const intelliSell = { RequestType: { Name: requestType } };
  if (multiSource) intelliSell.MultipleSourcePerItinerary = { Value: true };

  return {
    OTA_AirLowFareSearchRQ: {
      Version: '5',
      POS: {
        Source: [
          {
            PseudoCityCode: cfg.pcc,
            RequestorID: { Type: '1', ID: '1', CompanyName: { Code: 'TN' } },
          },
        ],
      },
      OriginDestinationInformation: od,
      TravelPreferences: travelPreferences,
      TravelerInfoSummary: { AirTravelerAvail: [{ PassengerTypeQuantity: pax }] },
      TPA_Extensions: { IntelliSellTransaction: intelliSell },
    },
  };
}

// ---------------------------------------------------------------------------
// Pasos
// ---------------------------------------------------------------------------

async function stepAuth(cfg) {
  console.log('\n== 1. Autenticación ==');
  await getToken(cfg);
  console.log(`  token obtenido en ${cachedToken.latencyMs} ms`);
  console.log(`  token_type: ${cachedToken.tokenType}`);
  console.log(`  expires_in: ${cachedToken.expiresIn} s  <- responde P-08`);
  await capture('auth/token-200', {
    note: 'access_token omitido a propósito',
    token_type: cachedToken.tokenType,
    expires_in: cachedToken.expiresIn,
    latencyMs: cachedToken.latencyMs,
  });
}

/** Paso 1 del plan: un request por familia. Un 403 revela al instante qué no tenemos (P-06). */
async function stepEntitlements(cfg) {
  console.log('\n== 2. Entitlements por familia (P-06) ==');
  const probes = [
    ['BFM v5 /v5/offers/shop', '/v5/offers/shop', shopBody(cfg)],
    ['BFM v4 /v4/offers/shop', '/v4/offers/shop', shopBody(cfg)],
    ['Offer Price /v1/offers/price', '/v1/offers/price', { query: [{ offerItemId: ['PROBE'] }] }],
    ['Get Seats v1 (colección)', '/v1/offers/getseats', { offerId: 'PROBE' }],
    ['Get Seats v3 (contrato)', '/v3/offers/getseats', { offerId: 'PROBE' }],
    ['Ancillaries v2 (colección)', '/v2/offers/getAncillaries', { confirmationId: 'PROBE0' }],
    ['Ancillaries v3 (contrato)', '/v3/offers/getAncillaries', { confirmationId: 'PROBE0' }],
    ['Booking getBooking', '/v1/trip/orders/getBooking', { confirmationId: 'PROBE0' }],
    ['checkFlightTickets', '/v1/trip/orders/checkFlightTickets', { confirmationId: 'PROBE0' }],
    ['Hotel Avail v5', '/v5/get/hotelavail', { GetHotelAvailRQ: {} }],
    ['Vehicle Avail v2', '/v2.0.0/get/vehavail', { GetVehAvailRQ: {} }],
  ];

  const rows = [];
  for (const [label, path, body] of probes) {
    let row;
    try {
      const res = await call(cfg, path, body, { label });
      const verdict = classify(res);
      // Un 400 significa "el endpoint existe y me atiende, el payload sonda es inválido":
      // para medir entitlement eso cuenta como acceso concedido.
      const access =
        verdict.kind === 'ENTITLEMENT' ? 'NO AUTORIZADO' : res.status === 404 ? 'NO EXISTE' : 'OK';
      row = { label, path, status: res.status, kind: verdict.kind, access };
    } catch (err) {
      row = { label, path, status: 0, kind: 'FALLO', access: String(err.message).slice(0, 80) };
    }
    rows.push(row);
    console.log(
      `  ${row.access.padEnd(14)} ${String(row.status).padStart(3)}  ${label}  [${row.kind}]`,
    );
  }
  await capture('entitlements', rows);
  console.log('\n  Decide las versiones de getseats y getAncillaries con estas dos parejas.');
}

/** Paso 4: los 6 payloads de shop que faltan como fixtures reales. */
async function stepShop(cfg) {
  console.log('\n== 3. Captura de shop ==');
  const cases = [
    ['v5-atpco-oneway', { sources: { NDC: 'Disable', ATPCO: 'Enable', LCC: 'Disable' } }],
    [
      'v5-atpco-roundtrip',
      { roundTrip: true, sources: { NDC: 'Disable', ATPCO: 'Enable', LCC: 'Disable' } },
    ],
    [
      'v5-ndc-roundtrip',
      { roundTrip: true, sources: { NDC: 'Enable', ATPCO: 'Disable', LCC: 'Disable' } },
    ],
    [
      'v5-multipax-adt-cnn',
      {
        roundTrip: true,
        pax: [
          { Code: 'ADT', Quantity: 1 },
          { Code: 'CNN', Quantity: 1 },
        ],
      },
    ],
    ['v5-cabin-business', { cabin: 'Business' }],
    ['v5-multisource', { roundTrip: true }],
    ['v5-multisource-sin-flag', { roundTrip: true, multiSource: false }],
  ];

  for (const [name, opts] of cases) {
    const res = await call(cfg, '/v5/offers/shop', shopBody(cfg, opts), { label: name });
    const verdict = classify(res);
    const n = countItineraries(res.json);
    console.log(
      `  ${name.padEnd(26)} ${res.status}  ${String(n).padStart(4)} itinerarios  ${res.latencyMs} ms  [${verdict.kind}]`,
    );
    await capture(`shop/${name}-${res.status}`, res.json ?? { raw: res.raw });
  }
  console.log('\n  Compara v5-multisource contra v5-multisource-sin-flag: ese diff es lo que');
  console.log('  el default de Sabre te estaba ocultando.');
}

function countItineraries(json) {
  const groups = json?.groupedItineraryResponse?.itineraryGroups ?? [];
  return groups.reduce((n, g) => n + (g.itineraries?.length ?? 0), 0);
}

/** Paso 2: la medición que alimenta la compuerta Go/No-Go (P-04). */
async function stepValue(cfg) {
  console.log('\n== 4. Aporte incremental (P-04) ==');
  const routes = (process.env.VALUE_ROUTES ?? 'BOG-MDE,BOG-LIM,LIM-CUZ,GRU-GIG,BOG-MIA,BOG-GRU')
    .split(',')
    .map((r) => r.trim().split('-'));

  const rows = [];
  for (const [from, to] of routes) {
    for (const multiSource of [true, false]) {
      const res = await call(
        cfg,
        '/v5/offers/shop',
        shopBody(cfg, { from, to, roundTrip: true, multiSource }),
      );
      const verdict = classify(res);
      const row = {
        route: `${from}-${to}`,
        multiSource,
        status: res.status,
        itineraries: countItineraries(res.json),
        latencyMs: res.latencyMs,
        kind: verdict.kind,
      };
      rows.push(row);
      console.log(
        `  ${row.route.padEnd(9)} multiSource=${String(multiSource).padEnd(5)} ${String(row.itineraries).padStart(4)} itin  ${row.latencyMs} ms  [${row.kind}]`,
      );
    }
  }
  await capture('value/incremental', rows);

  const withFlag = rows.filter((r) => r.multiSource).reduce((n, r) => n + r.itineraries, 0);
  const without = rows.filter((r) => !r.multiSource).reduce((n, r) => n + r.itineraries, 0);
  console.log(`\n  Total con MultipleSourcePerItinerary: ${withFlag}`);
  console.log(`  Total sin el flag:                    ${without}`);
  console.log(`  Diferencia: ${withFlag - without} itinerarios que el default descartaba.`);
  console.log('\n  El aporte incremental REAL frente a LATAM NDC directo se calcula cruzando');
  console.log(
    '  estas capturas con las de LATAM. Documéntalo en docs/sabre/12-hallazgos-sandbox.md.',
  );
}

/** Paso 7: RNF-01 hoy se sostiene en el presupuesto declarado por contrato, no en números medidos. */
async function stepLatency(cfg) {
  console.log('\n== 5. Latencia (RNF-01) ==');
  const runs = Number(process.env.LATENCY_RUNS ?? 8);
  for (const requestType of ['50ITINS', '200ITINS']) {
    for (const [from, to] of [
      ['BOG', 'LIM'],
      ['BOG', 'GRU'],
    ]) {
      const samples = [];
      for (let i = 0; i < runs; i++) {
        const res = await call(
          cfg,
          '/v5/offers/shop',
          shopBody(cfg, { from, to, roundTrip: true, requestType }),
        );
        samples.push(res.latencyMs);
      }
      samples.sort((a, b) => a - b);
      const p = (q) => samples[Math.min(samples.length - 1, Math.floor(samples.length * q))];
      console.log(
        `  ${requestType.padEnd(9)} ${from}-${to}  p50 ${p(0.5)} ms   p95 ${p(0.95)} ms   (n=${runs})`,
      );
    }
  }
}

/** Paso 6: las capturas que más se olvidan y la única defensa real contra R-04. */
async function stepErrors(cfg) {
  console.log('\n== 6. Capturas negativas (R-04) ==');
  const cases = [
    [
      '200-with-errors',
      '/v1/trip/orders/getBooking',
      { confirmationId: 'ZZZZZZ' },
      'PNR inexistente: ¿200 con errors[] o 404?',
    ],
    [
      'bfm-campo-requerido-ausente',
      '/v5/offers/shop',
      { OTA_AirLowFareSearchRQ: { Version: '5' } },
      'sin POS ni OriginDestination',
    ],
    [
      'offer-expired',
      '/v1/offers/price',
      { query: [{ offerItemId: ['EXPIRADO-INVENTADO'] }] },
      'offerItemId inválido',
    ],
    [
      'origen-invalido',
      '/v5/offers/shop',
      shopBody(cfg, { from: 'XXX', to: 'YYY' }),
      'códigos IATA inexistentes',
    ],
  ];

  for (const [name, path, body, note] of cases) {
    const res = await call(cfg, path, body, { label: name });
    const verdict = classify(res);
    console.log(`  ${name.padEnd(30)} HTTP ${res.status}  [${verdict.kind}]  ${note}`);
    if (verdict.detail) console.log(`      ${verdict.detail}`);
    await capture(`errors/${name}-${res.status}`, res.json ?? { raw: res.raw });
  }

  // Token inválido: se pide aparte para no ensuciar la caché del token bueno.
  const bad = await fetch(`${cfg.host}/v1/trip/orders/getBooking`, {
    method: 'POST',
    headers: { Authorization: 'Bearer token-invalido', 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmationId: 'PROBE0' }),
  });
  const badText = await bad.text();
  console.log(`  ${'401-token-invalido'.padEnd(30)} HTTP ${bad.status}`);
  await capture('errors/401-token-invalido', safeJson(badText));
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

// ---------------------------------------------------------------------------

const STEPS = {
  auth: stepAuth,
  entitlements: stepEntitlements,
  shop: stepShop,
  value: stepValue,
  latency: stepLatency,
  errors: stepErrors,
};

await loadDotEnv();
const cfg = config();
const command = process.argv[2] ?? 'auth';
const order = command === 'all' ? Object.keys(STEPS) : [command];

if (!order.every((s) => STEPS[s])) {
  console.error(`Comando desconocido. Usa: ${Object.keys(STEPS).join(' | ')} | all`);
  process.exit(2);
}

console.log(
  `Sabre CERT probe — host ${cfg.host}, PCC ${cfg.pcc}, salida ${cfg.depDate}/${cfg.retDate}`,
);
for (const step of order) {
  try {
    await STEPS[step](cfg);
  } catch (err) {
    console.error(`\n  FALLÓ el paso "${step}": ${err.message}`);
    if (step === 'auth') process.exit(1);
  }
}
console.log(`\nCapturas en ${captureDir}`);
console.log(
  'Siguiente: escribir docs/sabre/12-hallazgos-sandbox.md con la recomendación Go/No-Go.',
);
