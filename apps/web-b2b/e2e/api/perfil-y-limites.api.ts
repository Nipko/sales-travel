import { expect, test } from '@playwright/test';
import { como, sql } from './support/cliente';
import { PERSONAS } from './support/personas';

/**
 * Tanda 7 (docs/qa/01 §5 CTA): límites de Mi cuenta.
 *
 * - CTA-02: el 11.º cambio de nombre en un minuto es 429, con el motivo que el panel traduce a
 *   «Hiciste muchos cambios seguidos»; los 10 anteriores quedan, cada uno con su evento.
 */

test('CTA-02 el 11.º cambio de nombre en un minuto es 429', async () => {
  const api = await como('vendedorSub');
  const email = PERSONAS.vendedorSub.email;
  const [antes] = await sql<{ name: string }>('SELECT name FROM users WHERE email = $1', [email]);
  try {
    const estados: number[] = [];
    for (let i = 1; i <= 11; i++) {
      const r = await api.patch('/me', { name: `QA Vendedor Sub ${i}` });
      estados.push(r.status);
      if (r.status === 429) {
        expect(r.text, 'el 429 dice por qué').toMatch(/demasiados|too many/i);
      }
    }
    expect(estados.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(estados[10]).toBe(429);
    const [despues] = await sql<{ name: string }>('SELECT name FROM users WHERE email = $1', [
      email,
    ]);
    expect(despues?.name, 'el 11.º no se aplicó').toBe('QA Vendedor Sub 10');
  } finally {
    // Sin esperar el minuto: el nombre vuelve por la base para no ensuciar otras corridas.
    if (antes) await sql('UPDATE users SET name = $1 WHERE email = $2', [antes.name, email]);
  }
});
