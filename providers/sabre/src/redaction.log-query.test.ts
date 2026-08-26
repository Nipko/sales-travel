import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreHttpClient } from './http/sabre-http.client';
import { REDACTED } from './redaction';

/**
 * M-H04 — NINGÚN log emite query string.
 *
 * `SabreApiError` tira la query en el constructor (`safeErrorPath`) porque por ahí viajan
 * localizadores y datos del pasajero cuando alguien construye la URL a mano (RNF-07). Pero el
 * cliente HTTP loguea el `path` CRUDO en su meta —`sabre.http.ok` y
 * `sabre.http.entitlement_parcial` no pasan por el error— y ahí la query llega entera.
 *
 * Lo único que la miraba era `redactMeta`, que redacta por CLAVE: tapa `passportNumber=…` porque
 * `passportNumber` está en la lista, y deja pasar `pnr=XKCD12`, `recordLocator=…` o cualquier
 * parámetro que nadie haya enumerado. Un PNR en el log de una búsqueda es exactamente el dato que
 * RNF-07 no permite.
 *
 * Los dos logs `warn` estaban a salvo POR ACCIDENTE: el spread `...error.toLogMeta()` va DESPUÉS
 * del `path` crudo en el literal de objeto, así que pisa el campo con la versión ya saneada. Basta
 * reordenar dos líneas para abrir el agujero, y ningún test se pondría rojo.
 *
 * La invariante se fija donde no depende del orden de dos líneas ni de que cada llamador se
 * acuerde: en `redactMeta`, que es el único sitio por el que pasa TODO lo que llega al
 * `LoggerPort`. Este test la comprueba desde fuera, por la puerta pública.
 */

/** Parámetros hostiles: uno cae en la lista de claves sensibles, el otro NO y es el que se fugaba. */
const PNR = 'XKCD12';
const PASSPORT = 'AB1234567';
const QUERY_PATH = `/v5/offers/shop?pnr=${PNR}&passportNumber=${PASSPORT}&lang=es`;

function config(): SabreConfig {
  return {
    host: SABRE_HOSTS.cert.rest,
    epr: '500001',
    homePcc: 'ZZZZ',
    password: 'Pa55w0rd!',
    conversationIdPrefix: 'sales-travel',
  };
}

const tokens: SabreTokenProvider = {
  getToken: () => Promise.resolve('ATK-SUPERSECRETO'),
  invalidate: () => Promise.resolve(),
};

interface LogCall {
  level: string;
  message: string;
  meta: Record<string, unknown> | undefined;
}

function spyLogger(): { logger: LoggerPort; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const push =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      calls.push({ level, message, meta });
    };
  const logger: LoggerPort = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return { logger, calls };
}

async function logsOf(
  payload: unknown,
  status: number,
  idempotent = false,
): Promise<{ calls: LogCall[]; dump: string }> {
  const fetchImpl: SabreFetch = () =>
    Promise.resolve(new Response(JSON.stringify(payload), { status }));
  const { logger, calls } = spyLogger();
  const http = new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });

  await http.postJson(QUERY_PATH, {}, { idempotent }).catch(() => undefined);
  expect(calls.length).toBeGreaterThan(0);
  return { calls, dump: JSON.stringify(calls) };
}

/** Toda cadena que haya llegado al transporte de logs, venga a la profundidad que venga. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (typeof value === 'object' && value !== null)
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      strings(item, out);
    }
  return out;
}

/**
 * La invariante, escrita como propiedad y no como lista de testigos: si una cadena logueada tiene
 * `?`, lo que va detrás sólo puede ser la marca de redacción. Así queda cubierto también el
 * parámetro que nadie ha inventado todavía.
 */
function expectNoQueryString(calls: LogCall[]): void {
  for (const call of calls) {
    for (const text of strings(call.meta)) {
      const cut = text.indexOf('?');
      if (cut < 0) continue;
      expect(text.slice(cut + 1)).toBe(REDACTED);
    }
  }
}

describe('M-H04 — la query string nunca llega al transporte de logs', () => {
  it('sabre.http.ok (200 limpio) no publica el PNR de la query', async () => {
    const { calls, dump } = await logsOf({ groupedItineraryResponse: { version: '5' } }, 200);

    expect(calls.some((call) => call.message === 'sabre.http.ok')).toBe(true);
    expect(dump).not.toContain(PNR);
    expect(dump).not.toContain(PASSPORT);
    expect(dump).not.toContain('pnr=');
    expectNoQueryString(calls);
    // Y la ruta sigue ahí: el log existe para saber QUÉ se rompió.
    //
    // OJO con lo que esta línea NO prueba: sobrevive porque `/v5/offers/shop` es CORTA. Una ruta
    // de 32+ caracteres del alfabeto base64 —`/v1/trip/orders/fulfillFlightTickets`, que es una
    // operación con dinero— cae entera en `LONG_BASE64_RUN` dentro de `redactMeta` y hoy se loguea
    // como «REDACTADO». No es una fuga (se tapa de más), pero deja ciega la traza justo donde más
    // duele, y es exactamente el motivo por el que `errors.ts:safeErrorPath` NO pasa la ruta por
    // `redactText`. Queda reportado, no arreglado aquí: el arreglo pide una pasada de redacción
    // específica para rutas y eso es un rail nuevo, no un ajuste.
    expect(dump).toContain('/v5/offers/shop');
  });

  it('sabre.http.entitlement_parcial tampoco', async () => {
    const { calls, dump } = await logsOf(
      {
        warnings: [{ category: 'UNAUTHORIZED', type: 'UNAUTHORIZED_ACCESS' }],
        groupedItineraryResponse: { version: '5' },
      },
      200,
    );

    expect(calls.some((call) => call.message === 'sabre.http.entitlement_parcial')).toBe(true);
    expect(dump).not.toContain(PNR);
    expect(dump).not.toContain('pnr=');
    expectNoQueryString(calls);
  });

  it('sabre.http.error tampoco — y deja de depender del orden del spread', async () => {
    const { calls, dump } = await logsOf({ message: 'oops' }, 500);

    expect(calls.some((call) => call.message === 'sabre.http.error')).toBe(true);
    expect(dump).not.toContain(PNR);
    expectNoQueryString(calls);
  });

  it('el fragmento (#) se va con la query: es la otra mitad de lo que no construimos nosotros', async () => {
    const fetchImpl: SabreFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ groupedItineraryResponse: { version: '5' } }), {
          status: 200,
        }),
      );
    const { logger, calls } = spyLogger();
    const http = new SabreHttpClient(config(), tokens, {
      fetch: fetchImpl,
      logger,
      sleep: () => Promise.resolve(),
      jitter: () => 0,
      uuid: () => 'conv-fijo',
    });

    await http.postJson(`/v5/offers/shop#${PNR}`, {});

    const dump = JSON.stringify(calls);
    expect(dump).not.toContain(PNR);
    expect(dump).not.toContain('#');
    expect(dump).toContain('/v5/offers/shop');
    expectNoQueryString(calls);
  });

  it('sabre.http.reauth tampoco', async () => {
    const { calls, dump } = await logsOf(
      { message: 'Expired or invalid security token' },
      401,
      true,
    );

    expect(calls.some((call) => call.message === 'sabre.http.reauth')).toBe(true);
    expect(dump).not.toContain(PNR);
    expectNoQueryString(calls);
  });
});
