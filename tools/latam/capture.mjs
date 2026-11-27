#!/usr/bin/env node
// LAT-08 / INF-7 (docs/qa/01): graba respuestas REALES del sandbox de LATAM NDC como fixtures, para
// que las pruebas de mapeo dejen de depender de un único XML sintético.
//
// Corre la venta completa sin pago (BNPL): AirShopping → OfferPrice → OrderCreate → OrderRetrieve →
// cancelación BNPL, con un pasajero inventado. Guarda cada respuesta XML redactada en
// providers/latam-ndc/src/__fixtures__/real/ (o en el directorio de --out).
//
// SÓLO contra el sandbox: con un LATAM_API_URL que no sea de sandbox, no hace nada y sale con 2.
// Las credenciales salen del entorno (las del ambiente de pruebas de la Mac); nunca se imprimen.
//
// Uso, en el contenedor del api de la Mac:
//   docker compose ... run --rm -v "$PWD/tools/latam:/tools" -v /tmp/latam:/out api \
//     node /tools/capture.mjs --out /out --origin GRU --destination GIG
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const { LatamNdcFlightSearchAdapter } = require('@sales-travel/latam-ndc');

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split('--')
    .filter(Boolean)
    .map((a) => {
      const [k, ...v] = a.trim().split(/\s+/);
      return [k, v.join(' ')];
    }),
);

const apiUrl = process.env.LATAM_API_URL ?? '';
if (!/sandbox/i.test(apiUrl)) {
  console.error('LATAM_API_URL no es de sandbox: no se graba nada.');
  process.exit(2);
}

const OUT = args.out || 'providers/latam-ndc/src/__fixtures__/real';
mkdirSync(OUT, { recursive: true });

// Lo que mandamos y no debe quedar en un archivo del repo, aunque sea inventado.
const PASAJERO = {
  givenName: 'PRUEBA',
  surname: 'SANDBOX',
  email: 'pasajero-sandbox@example.test',
  phone: '3001234567',
  doc: 'AB1234567',
};
const secretos = [
  process.env.LATAM_API_KEY,
  process.env.LATAM_API_SECRET,
  process.env.LATAM_AGENCY_ID,
  process.env.LATAM_AGENCY_IATA,
  process.env.LATAM_TRAVEL_AGENT_ID,
  process.env.LATAM_AGENCY_NAME,
].filter((s) => typeof s === 'string' && s.length >= 3);

function redactar(xml) {
  let out = xml;
  for (const s of secretos) out = out.split(s).join('REDACTADO');
  for (const v of [
    PASAJERO.givenName,
    PASAJERO.surname,
    PASAJERO.email,
    PASAJERO.phone,
    PASAJERO.doc,
  ]) {
    out = out.split(v).join(`PAX-${v.length}`);
  }
  return out
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, 'correo@redactado.test')
    .replace(/(<(?:PhoneNumber|PhoneNumberText|ContactNumber)[^>]*>)[^<]*/gi, '$1REDACTADO');
}

// Se graba lo que contesta LATAM, no el token.
const grabados = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const res = await originalFetch(url, init);
  const u = String(url);
  if (!u.includes('/ndc/')) return res;
  const text = await res.clone().text();
  const op = u.replace(/^.*\/ndc\/(v\d+\/)?/, '').replace(/[^a-z0-9]+/gi, '-');
  grabados.push({ op, status: res.status, text });
  return res;
};

const cfg = {
  apiUrl,
  apiKey: process.env.LATAM_API_KEY,
  apiSecret: process.env.LATAM_API_SECRET,
  agencyId: process.env.LATAM_AGENCY_ID,
  agencyIata: process.env.LATAM_AGENCY_IATA,
  agencyName: process.env.LATAM_AGENCY_NAME,
  travelAgentId: process.env.LATAM_TRAVEL_AGENT_ID,
  country: process.env.LATAM_COUNTRY,
  applicationName: process.env.LATAM_APPLICATION_NAME,
  posCity: process.env.LATAM_POS_CITY,
};
const latam = new LatamNdcFlightSearchAdapter(cfg);
const ctx = { tenantId: '00000000-0000-4000-8000-000000000000', requestId: 'lat08-capture' };
const salida = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
const criteria = {
  origin: args.origin || 'GRU',
  destination: args.destination || 'GIG',
  departureDate: salida,
  paxCount: { adults: 1, children: 0, infants: 0 },
  currency: args.currency || 'BRL',
};

const resumen = { criteria: { ...criteria, departureDate: '(+40 días)' }, pasos: [] };
const paso = (nombre, dato) => resumen.pasos.push({ nombre, ...dato });

try {
  const offers = await latam.search(criteria, ctx);
  paso('search', { offers: offers.length });
  const offer = offers[0];
  if (offer) {
    const priced = await latam.priceOffer(offer, criteria, ctx);
    paso('price', { priceChanged: priced.priceChanged });
    const created = await latam.createOrder(
      {
        offer: priced.offer,
        criteria,
        passengers: [
          {
            paxId: 'ADT_1',
            paxType: 'ADT',
            title: 'Mr',
            givenName: PASAJERO.givenName,
            surname: PASAJERO.surname,
            birthdate: '1990-05-14',
            gender: 'M',
            citizenshipCountryCode: 'BR',
            identityDoc: {
              type: 'P',
              number: PASAJERO.doc,
              issuingCountryCode: 'BR',
              expiryDate: '2032-01-01',
            },
          },
        ],
        contactInfo: { email: PASAJERO.email, phone: PASAJERO.phone, countryDialingCode: '55' },
      },
      ctx,
    );
    paso('create', { outcome: created.outcome, conOrden: Boolean(created.orderId) });
    if (created.orderId) {
      const view = await latam.retrieveForDisplay(created.orderId, ctx);
      paso('retrieve', { found: view.found, status: view.status });
      const cancel = await latam.cancelBnplOrder(created.orderId, ctx);
      paso('cancel', { success: cancel.success });
    }
  }
} catch (err) {
  paso('error', { name: err?.name, status: err?.status });
} finally {
  grabados.forEach((g, i) => {
    const file = path.join(OUT, `${String(i + 1).padStart(2, '0')}-${g.op}-${g.status}.xml`);
    writeFileSync(file, redactar(g.text));
  });
  writeFileSync(path.join(OUT, 'resumen.json'), JSON.stringify(resumen, null, 2));
  console.log(JSON.stringify(resumen));
}
