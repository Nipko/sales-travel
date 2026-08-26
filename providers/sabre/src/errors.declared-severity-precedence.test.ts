import { describe, expect, it } from 'vitest';
import type { SabreFetch, SabreTokenProvider } from './auth/token.service';
import { SABRE_HOSTS, type SabreConfig } from './config';
import { SabreApiError } from './errors';
import { SabreHttpClient } from './http/sabre-http.client';

/**
 * M-E11 — los TRES niveles de precedencia de `declaredIssueSeverity`.
 *
 * Su comentario dice que el orden «es el histórico» y que importa, pero nada lo sujetaba: mover el
 * chequeo del token benigno por encima del prefijo del `code` deja la suite entera en verde. Y ese
 * mutante concreto es una reserva fantasma con nombre y apellidos: `{severity:'Info',
 * code:'ERR.0161'}` es la forma REAL con la que el dialecto de hoteles manda un error
 * (`help/get-hotel-avail-v4/v4-errors.txt:12`) — el `code` es ahí el campo que lleva la severidad
 * de verdad, y el `severity` viene de adorno. Con el mutante, ese sobre se entrega como éxito.
 *
 * El orden que se fija, de mayor a menor precedencia:
 *
 *   1. tokens de `severity`/`type`  (los dos dialectos: BFM `severity`, NDC `type`)
 *   2. prefijo del `code`           (`ERR|FAULT|FATAL` / `WARN`)
 *   3. token benigno                (`Info`, `Success`, `Complete`, …)
 *
 * Cada nivel se prueba en las dos direcciones —que ascienda y que NO ascienda— porque un orden se
 * rompe por los dos lados. Todo por la puerta pública: `postJson` es quien decide si el sobre se
 * entrega o se lanza, y es lo único que un llamador puede observar.
 */

const SHOP_PATH = '/v5/offers/shop';

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

function clientFor(payload: unknown): SabreHttpClient {
  const fetchImpl: SabreFetch = () =>
    Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  return new SabreHttpClient(config(), tokens, {
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
    jitter: () => 0,
    uuid: () => 'conv-fijo',
  });
}

/** El sobre se rechaza: `postJson` lanza y el issue conserva el identificador para diagnosticar. */
async function expectRejected(payload: unknown): Promise<SabreApiError> {
  const error = (await clientFor(payload)
    .postJson(SHOP_PATH, {})
    .catch((e: unknown) => e)) as SabreApiError;
  expect(error).toBeInstanceOf(SabreApiError);
  expect(error.status).toBe(200);
  expect(error.issues.some((issue) => issue.severity === 'error')).toBe(true);
  return error;
}

/** El sobre se entrega. Devuelve los warnings para distinguir «warning» de «silencio». */
async function expectDelivered(payload: unknown): Promise<readonly { severity: string }[]> {
  const result = await clientFor(payload).postJson(SHOP_PATH, {});
  expect(result.status).toBe(200);
  return result.warnings;
}

describe('M-E11 nivel 1 — los tokens de severity/type mandan sobre el prefijo del code', () => {
  it('severity:Error con code WARN.* es ERROR: el token gana', async () => {
    const error = await expectRejected({ messages: [{ severity: 'Error', code: 'WARN.0788' }] });
    expect(error.issues[0]?.code).toBe('WARN.0788');
  });

  it('type:ERROR (dialecto NDC) con code WARN.* también es ERROR', async () => {
    await expectRejected({ messages: [{ type: 'ERROR', code: 'WARN.0788' }] });
  });

  it('severity:Warning con code ERR.* se ENTREGA como warning: el token gana en las dos direcciones', async () => {
    const warnings = await expectDelivered({
      messages: [{ severity: 'Warning', code: 'ERR.0161' }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe('warning');
  });
});

describe('M-E11 nivel 2 — el prefijo del code manda sobre el token benigno', () => {
  it('severity:Info con code ERR.* es ERROR — la forma real del dialecto de hoteles', async () => {
    const error = await expectRejected({ messages: [{ severity: 'Info', code: 'ERR.0161' }] });
    expect(error.issues[0]?.code).toBe('ERR.0161');
  });

  it('lo mismo con los otros dos prefijos de error del código: FAULT y FATAL', async () => {
    await expectRejected({ messages: [{ severity: 'Success', code: 'FAULT.2SG.SEC' }] });
    await expectRejected({ messages: [{ type: 'INFO', code: 'FATAL.0001' }] });
  });

  it('severity:Info con code WARN.* es WARNING, no silencio', async () => {
    const warnings = await expectDelivered({ messages: [{ severity: 'Info', code: 'WARN.0788' }] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe('warning');
  });

  it('y por el otro punto de llamada: dentro de warnings[], un Info con code ERR.* asciende a error', async () => {
    // `scanIssueValue` usa la misma función: si el token benigno se colara por delante del prefijo,
    // el item se quedaría con la severidad del CONTENEDOR (warning) y el sobre se entregaría.
    await expectRejected({
      warnings: [{ severity: 'Info', code: 'ERR.0161', category: 'APPLICATION_ERROR' }],
    });
  });
});

describe('M-E11 nivel 3 — el token benigno se mira el último, pero se mira', () => {
  it('severity:Info con un code sin prefijo de severidad es benigno: ni error ni warning', async () => {
    const warnings = await expectDelivered({ messages: [{ severity: 'Info', code: '0161' }] });
    // Silencio, no warning: si el carril benigno desapareciera, este sobre se lanzaría como error
    // (contexto `neutral` ⇒ fail-closed) y cada búsqueda con mensajes informativos fallaría.
    expect(warnings).toHaveLength(0);
  });

  it('un Info SIN code sigue siendo benigno', async () => {
    const warnings = await expectDelivered({ messages: [{ severity: 'Info' }] });
    expect(warnings).toHaveLength(0);
  });
});
