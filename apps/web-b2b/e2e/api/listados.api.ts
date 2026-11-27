import { expect, test } from '@playwright/test';
import { como, nodo, sql } from './support/cliente';
import { PERSONAS } from './support/personas';

/**
 * Tanda 9 (docs/qa/01 §5 POS): POS-02 / QA-H-15. Reservas y cotizaciones guardadas traían sólo las
 * 100 más nuevas, sin decir que había más. Ahora el listado dice `hasMore` y acepta `limit` (1 a
 * 1000) para que el panel pida más.
 *
 * Se siembran 101 filas viejas (año 2001) en la agencia B, al final del orden, y se borran al
 * terminar.
 */

const VIEJA = '2001-01-01T00:00:00Z';

for (const lista of [
  {
    ruta: '/quotations',
    clave: 'quotations',
    tabla: 'quotations',
    sembrar: `INSERT INTO quotations (tenant_id, user_id, search_criteria, selected_offer, quote_number,
                                      expires_at, created_at)
              SELECT $1, u.id, '{}'::jsonb, '{}'::jsonb,
                     (SELECT coalesce(max(quote_number), 0) FROM quotations WHERE tenant_id = $1) + g,
                     now() + interval '1 day', $3::timestamptz + g * interval '1 second'
                FROM users u, generate_series(1, 101) g WHERE u.email = $2
              RETURNING id`,
  },
  {
    ruta: '/orders',
    clave: 'orders',
    tabla: 'orders',
    sembrar: `INSERT INTO orders (tenant_id, user_id, provider, search_criteria, selected_offer,
                                  passengers, contact_info, total_amount, currency, order_number,
                                  status, created_at)
              SELECT $1, u.id, 'latam-ndc', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 1000,
                     'USD',
                     (SELECT coalesce(max(order_number), 0) FROM orders WHERE tenant_id = $1) + g,
                     'cancelled', $3::timestamptz + g * interval '1 second'
                FROM users u, generate_series(1, 101) g WHERE u.email = $2
              RETURNING id`,
  },
] as const) {
  test(`POS-02 ${lista.ruta}: 100 de entrada, dice si hay más y trae más con limit`, async () => {
    const api = await como('vendedorB');
    const nodoB = await nodo('e2e-agencia-b');
    const sembradas = (
      await sql<{ id: string }>(lista.sembrar, [nodoB, PERSONAS.vendedorB.email, VIEJA])
    ).map((r) => r.id);
    const laMasVieja = sembradas[0]!;
    try {
      const pagina = await api.get<Record<string, unknown>>(lista.ruta);
      expect(pagina.status, pagina.text).toBe(200);
      const filas = pagina.body[lista.clave] as { id: string }[];
      expect(filas).toHaveLength(100);
      expect(pagina.body['hasMore']).toBe(true);
      expect(filas.map((f) => f.id)).not.toContain(laMasVieja);

      const todo = await api.get<Record<string, unknown>>(`${lista.ruta}?limit=1000`);
      expect(todo.status, todo.text).toBe(200);
      const ids = (todo.body[lista.clave] as { id: string }[]).map((f) => f.id);
      expect(ids).toContain(laMasVieja);
      expect(ids.at(-1), 'la más vieja va al final').toBe(laMasVieja);
      expect(new Set(ids).size, 'ninguna repetida').toBe(ids.length);

      for (const malo of ['limit=0', 'limit=1001', 'limit=diez', 'pagina=2']) {
        const r = await api.get(`${lista.ruta}?${malo}`);
        expect(r.status, `${malo} → ${r.status}`).toBe(400);
      }
    } finally {
      await sql(`DELETE FROM ${lista.tabla} WHERE id = ANY($1::uuid[])`, [sembradas]);
    }
  });
}
