import { expect, test } from '@playwright/test';
import { anonimo, como, type Api } from './support/cliente';
import type { PersonaKey } from './support/personas';
import rutasJson from './rutas.generated.json';

/**
 * TRV-01 (mitad «niega»), TRV-02, TRV-03 y TRV-05: la cadena de guardas de la API contra las 262 rutas
 * del inventario (tools/qa/rutas-api.mjs). Sólo pide lo que las guardas tienen que RECHAZAR: el rechazo
 * ocurre antes del handler, así que ninguna de estas pruebas cambia datos. La mitad «permite» (2xx con un
 * cuerpo válido por ruta) va aparte, ruta por ruta.
 *
 * Los parámetros de ruta van con un UUID que no existe: lo que se prueba es la guarda, no el recurso.
 */

interface Ruta {
  method: string;
  path: string;
  controller: string;
  public: boolean;
  roles: string;
  sale: boolean;
  recentMfa: boolean;
  allowWithoutMfa: boolean;
  superadmin: boolean;
}
const RUTAS = rutasJson as Ruta[];
const UUID_INEXISTENTE = '00000000-0000-4000-8000-000000000000';

const concreta = (r: Ruta) => r.path.replace(/:[A-Za-z]+/g, UUID_INEXISTENTE);
const nombre = (r: Ruta) => `${r.method} ${r.path}`;

async function pedir(api: Api, r: Ruta) {
  return r.method === 'GET' || r.method === 'DELETE'
    ? api.pedir(r.method, concreta(r))
    : api.pedir(r.method, concreta(r), { body: {} });
}

/** Junta los desvíos y falla una vez con la lista completa: más útil que cortar en la primera ruta. */
async function revisar(
  api: Api,
  rutas: Ruta[],
  esperado: (status: number, body: unknown) => boolean,
  describir: string,
) {
  const malas: string[] = [];
  for (const r of rutas) {
    const res = await pedir(api, r);
    if (!esperado(res.status, res.body))
      malas.push(`${nombre(r)} → ${res.status} ${res.text.slice(0, 140)}`);
  }
  test.info().annotations.push({ type: 'rutas', description: `${rutas.length} rutas revisadas` });
  expect(
    malas,
    `${malas.length} de ${rutas.length} rutas no ${describir}:\n${malas.join('\n')}`,
  ).toEqual([]);
}

const razon = (body: unknown): string => {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    return String(b['reason'] ?? b['code'] ?? b['error'] ?? '');
  }
  return '';
};

test.describe('Cadena de guardas', () => {
  test('TRV-02 sin sesión, toda ruta no pública responde 401', async () => {
    expect(
      RUTAS.length,
      'el inventario de rutas se achicó: ¿se rompió tools/qa/rutas-api.mjs?',
    ).toBeGreaterThanOrEqual(250);
    const api = await anonimo();
    await revisar(
      api,
      RUTAS.filter((r) => !r.public),
      (s) => s === 401,
      'devolvieron 401',
    );
  });

  test('TRV-02 un token inventado responde 401', async () => {
    const api = await anonimo();
    const r = await api.get('/me', { authorization: 'Bearer no.es.un-token' });
    expect(r.status).toBe(401);
  });

  test('TRV-03 admin sin MFA sólo puede activarlo o salir (403 MFA_ENROLLMENT_REQUIRED)', async () => {
    const api = await como('sinMfa');
    const rutas = RUTAS.filter((r) => !r.public && !r.allowWithoutMfa);
    await revisar(
      api,
      rutas,
      (s, b) => s === 403 && razon(b).includes('MFA_ENROLLMENT_REQUIRED'),
      'devolvieron 403 MFA_ENROLLMENT_REQUIRED',
    );
  });

  test('TRV-05 la plataforma no vende: superadmin en rutas de venta → 403 PLATFORM_ROLE_CANNOT_SELL', async () => {
    for (const key of ['superadmin', 'supervisado'] as const) {
      const api = await como(key);
      await revisar(
        api,
        RUTAS.filter((r) => r.sale),
        (s, b) => s === 403 && razon(b).includes('PLATFORM_ROLE_CANNOT_SELL'),
        `devolvieron PLATFORM_ROLE_CANNOT_SELL para ${key}`,
      );
    }
  });

  /** Quién NO puede entrar a cada grupo de rutas (plan §3.2). La plataforma pasa todo salvo la venta. */
  const NIEGA: Record<string, PersonaKey[]> = {
    AGENCY_ADMIN_ROLES: ['vendedorA', 'clienteA'],
    SELLING_ROLES: ['clienteA'],
    PLATFORM_ROLES: ['consolidador', 'adminA', 'vendedorA'],
    PROVIDER_PAYLOAD_READER_ROLES: ['adminA', 'agencyAdminA', 'vendedorA'],
    superadmin: ['consolidador', 'adminA', 'vendedorA'],
    sale: ['clienteA'],
  };

  for (const [grupo, personas] of Object.entries(NIEGA)) {
    test(`TRV-01 rutas ${grupo}: ${personas.join(', ')} → 403`, async () => {
      const rutas = RUTAS.filter((r) =>
        grupo === 'superadmin' ? r.superadmin : grupo === 'sale' ? r.sale : r.roles === grupo,
      ).filter((r) => !r.public);
      expect(rutas.length).toBeGreaterThan(0);
      for (const key of personas) {
        const api = await como(key);
        await revisar(api, rutas, (s) => s === 403, `negaron el paso a ${key} (403)`);
      }
    });
  }
});
