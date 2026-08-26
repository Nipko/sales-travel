import type { LoggerPort } from '@sales-travel/core';
import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';

/**
 * La guarda «respuesta 2xx no parseable como JSON» del cliente HTTP, fijada por test.
 *
 * Se auditó que quitarla del cliente deja los 719 tests en verde. No es un agujero de seguridad —el
 * cuerpo sigue rechazándose, porque un `payload` que no es objeto tampoco pasa la regla dura del
 * sobre— pero **cambia la identidad del error**, y eso sí es observable y sí importa:
 *
 * - Con la guarda, `body` es una frase NUESTRA, corta y estable: `respuesta 2xx no parseable como
 *   JSON`. Con ella fuera, `body` pasa a ser el resumen del cuerpo AJENO, que en este caso es la
 *   página de error de un balanceador o de Cloudflare: HTML con nombres de host internos, ids de
 *   petición y a veces cabeceras eco. No es lo mismo poner eso en el mensaje de un error que no
 *   ponerlo, y el resumen sólo lo protege por los carriles de redacción, no por diseño.
 * - Con la guarda, `issues` está vacío, que es la verdad: no hubo sobre que clasificar. Sin ella,
 *   el error llega con problemas sintéticos fabricados por el clasificador sobre un `null`, y el
 *   operador que lea el log verá un fallo de negocio donde lo que hubo fue un intermediario
 *   devolviendo HTML.
 *
 * Un 200 con HTML es el síntoma exacto de «alguien que no es Sabre contestó por Sabre» —proxy,
 * portal cautivo, WAF—, y distinguirlo de un fallo de negocio es lo que decide si se escala a redes
 * o a soporte del proveedor. Por eso la identidad del error es la propiedad que se fija aquí.
 */

const SHOP_PATH = '/v5/offers/shop';
const GUARD_MESSAGE = 'respuesta 2xx no parseable como JSON';

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
  message: string;
  meta: Record<string, unknown> | undefined;
}

function spyLogger(): { logger: LoggerPort; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const push =
    () =>
    (message: string, meta?: Record<string, unknown>): void => {
      calls.push({ message, meta });
    };
  const logger: LoggerPort = {
    debug: push(),
    info: push(),
    warn: push(),
    error: push(),
    child: () => logger,
  };
  return { logger, calls };
}

async function postBody(
  body: string,
  status: number,
): Promise<{ error: SabreApiError; logDump: string }> {
  const fetchImpl: SabreFetch = () => Promise.resolve(new Response(body, { status }));
  const { logger, calls } = spyLogger();
  const http = new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    logger,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
  const error = (await http
    .postJson(SHOP_PATH, {}, { idempotent: true })
    .catch((e: unknown) => e)) as SabreApiError;
  expect(error, 'un 2xx no parseable se entregó como éxito').toBeInstanceOf(SabreApiError);
  return { error, logDump: JSON.stringify(calls) };
}

/** Testigo dentro del HTML: un dato del intermediario que no tiene por qué acabar en el error. */
const INTERNAL_HOST = 'edge-lhr-07.internal.example';
const HTML_PAGE = `<!doctype html><html><head><title>502 Bad Gateway</title></head><body><h1>502</h1><p>Host: ${INTERNAL_HOST}</p></body></html>`;

describe('un 2xx cuyo cuerpo no es JSON produce SIEMPRE el error propio del cliente', () => {
  it.each([
    ['HTML de un balanceador', HTML_PAGE],
    ['cuerpo vacío', ''],
    ['texto suelto', 'OK'],
    ['JSON cortado a la mitad', '{"groupedItineraryResponse":{"version":'],
  ])('%s', async (_name, body) => {
    const { error } = await postBody(body, 200);

    // La identidad: el body es NUESTRA frase, no el cuerpo ajeno resumido.
    expect(
      error.body,
      'la guarda de 2xx no parseable desapareció: el error cambió de identidad',
    ).toBe(GUARD_MESSAGE);
    expect(error.message).toContain(GUARD_MESSAGE);
    expect(error.status).toBe(200);
    // No hubo sobre que clasificar, así que no puede haber problemas declarados.
    expect(error.issues).toEqual([]);
  });

  it('el cuerpo del intermediario no entra en el error ni en el log', async () => {
    const { error, logDump } = await postBody(HTML_PAGE, 200);
    expect(error.body).not.toContain(INTERNAL_HOST);
    expect(error.message).not.toContain(INTERNAL_HOST);
    expect(error.message).not.toContain('Bad Gateway');
    expect(logDump).not.toContain(INTERNAL_HOST);
  });

  it('el 200 con HTML no se reintenta como si fuese un fallo transitorio', async () => {
    // `idempotent: true` pide reintentos, y aun así sólo debe haber una llamada: el cuerpo no
    // parseable no es `RETRY_BACKOFF`. Si alguien reclasifica esto, un portal cautivo dispararía
    // tres búsquedas por cada una del vendedor.
    let calls = 0;
    const fetchImpl: SabreFetch = () => {
      calls++;
      return Promise.resolve(new Response(HTML_PAGE, { status: 200 }));
    };
    const http = new SabreHttpClient(config(), tokens, {
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
      jitter: () => 0,
      uuid: () => 'conv-fijo',
    });
    await http.postJson(SHOP_PATH, {}, { idempotent: true }).catch(() => undefined);
    expect(calls).toBe(1);
  });

  it('CONTROL: el mismo cuerpo con status 500 NO usa esta guarda', async () => {
    // Sin esto, los casos de arriba podrían estar pasando por el carril de transporte y el test no
    // probaría la guarda del 2xx. Con 500 el resumen sí es del cuerpo ajeno, que es precisamente la
    // diferencia que la guarda introduce en el 2xx.
    const { error } = await postBody(HTML_PAGE, 500);
    expect(error.body).not.toBe(GUARD_MESSAGE);
    expect(error.body).toContain('502');
  });
});
