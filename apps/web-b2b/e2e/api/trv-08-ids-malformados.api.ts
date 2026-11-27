import { expect, test } from '@playwright/test';
import { como } from './support/cliente';
import type { PersonaKey } from './support/personas';
import rutasJson from './rutas.generated.json';

/**
 * TRV-08 (hallazgo QA-H-01): un parámetro de ruta que no es UUID no puede terminar en 500. Hoy varias
 * rutas lo pasan tal cual a Postgres, que responde 22P02 («invalid input syntax for type uuid»), y el
 * filtro global lo convierte en 500. Esperado: 400 o 404.
 *
 * Sólo GET: con un id malformado ningún handler encuentra nada que cambiar, pero un GET no cambia nada
 * aunque lo encuentre. Cada ruta se pide con una persona que SÍ pasa sus guardas, para llegar al handler.
 */

interface Ruta {
  method: string;
  path: string;
  public: boolean;
  roles: string;
  sale: boolean;
  superadmin: boolean;
}
const CON_PARAMS = (rutasJson as Ruta[]).filter(
  (r) => r.method === 'GET' && /:[A-Za-z]+/.test(r.path),
);
/** Las reservas de hotel usan el id DEL PROVEEDOR (Despegar), no un UUID nuestro: van en su propio caso. */
const ES_RESERVA_HOTEL = (r: Ruta) => r.path.startsWith('/api/hotels/reservations/');
const RUTAS = CON_PARAMS.filter((r) => !ES_RESERVA_HOTEL(r));

function quien(r: Ruta): PersonaKey {
  if (r.superadmin || r.roles === 'PLATFORM_ROLES') return 'superadmin';
  if (r.roles === 'PROVIDER_PAYLOAD_READER_ROLES') return 'consolidador';
  return 'adminA';
}

test('TRV-08 un id que no es UUID nunca da 500 (QA-H-01)', async () => {
  expect(RUTAS.length).toBeGreaterThan(20);
  const malas: string[] = [];
  for (const r of RUTAS) {
    const api = await como(quien(r));
    const ruta = r.path.replace(/:[A-Za-z]+/g, 'no-es-un-uuid');
    const res = await api.get(ruta);
    if (res.status >= 500)
      malas.push(`${r.method} ${r.path} (${quien(r)}) → ${res.status} ${res.text.slice(0, 120)}`);
  }
  expect(
    malas,
    `${malas.length} de ${RUTAS.length} rutas respondieron 5xx:\n${malas.join('\n')}`,
  ).toEqual([]);
});

test('TRV-08 reserva de hotel inexistente → 404, no 502 (QA-H-30)', async () => {
  const api = await como('adminA');
  const malas: string[] = [];
  for (const r of CON_PARAMS.filter(ES_RESERVA_HOTEL)) {
    const res = await api.get(r.path.replace(/:[A-Za-z]+/g, '999999999'));
    if (res.status >= 500) malas.push(`${r.path} → ${res.status} ${res.text.slice(0, 120)}`);
  }
  expect(malas, malas.join(' | ')).toEqual([]);
});
