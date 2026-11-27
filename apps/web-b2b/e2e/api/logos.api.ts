import { expect, test } from '@playwright/test';
import { E2E } from '../support/env';
import { anonimo, como, nodo, sql } from './support/cliente';

/**
 * Tanda 12 (docs/qa/01 §5 AGE): AGE-06 y QA-H-38. Subir el logo de la agencia y verlo por su URL,
 * que es lo que no funcionaba en ningún ambiente (sin volumen, EACCES, y nadie servía `/blobs/*`).
 * Más los rechazos de la subida: vacío, tamaño, firma y SVG con script.
 *
 * El logo de la agencia A vuelve a lo que tenía al terminar.
 */

// PNG de 1×1.
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

test('AGE-06 / QA-H-38 el logo subido se ve por su URL; lo que no es imagen se rechaza', async () => {
  const admin = await como('adminA');
  const nodoA = await nodo('e2e-agencia-a');
  const [antes] = await sql<{ logo_url: string | null }>(
    'SELECT logo_url FROM tenants WHERE id = $1',
    [nodoA],
  );
  const subir = (dataBase64: string) =>
    admin.post<{ url?: string }>(`/tenants/${nodoA}/brand-assets`, { kind: 'logo', dataBase64 });

  try {
    const ok = await subir(PNG_1X1);
    expect(ok.status, ok.text).toBeLessThan(300);
    const url = ok.body.url!;
    expect(url).toMatch(/\/api\/blobs\/tenants\/[0-9a-f-]{36}\/logo-[0-9a-f]{16}\.png$/);

    // Se lee sin sesión: lo embebe el PDF que recibe el cliente final.
    const anon = await anonimo();
    const leer = await anon.pedir('GET', url.startsWith('http') ? url : `${E2E.apiUrl}${url}`);
    expect(leer.status, leer.text.slice(0, 200)).toBe(200);
    expect(leer.headers['content-type']).toBe('image/png');
    expect(leer.headers['x-content-type-options']).toBe('nosniff');
    expect(leer.headers['cross-origin-resource-policy']).toBe('cross-origin');

    const [despues] = await sql<{ logo_url: string | null }>(
      'SELECT logo_url FROM tenants WHERE id = $1',
      [nodoA],
    );
    expect(despues?.logo_url).toBe(url);

    const malas: string[] = [];
    const casos: [string, string][] = [
      ['texto con nombre de imagen', b64('esto no es una imagen')],
      [
        'svg con script',
        b64('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      ],
      ['más de 512 KB', Buffer.alloc(600 * 1024, 1).toString('base64')],
    ];
    for (const [caso, data] of casos) {
      const r = await subir(data);
      if (r.status !== 400 && r.status !== 413) malas.push(`${caso} → ${r.status}`);
    }
    const vacio = await admin.post(`/tenants/${nodoA}/brand-assets`, {
      kind: 'logo',
      dataBase64: '',
    });
    if (vacio.status !== 400) malas.push(`vacío → ${vacio.status}`);
    expect(malas, malas.join(' | ')).toEqual([]);

    // Una clave que no es de marca no se sirve, ni aunque exista algo con ese nombre.
    const fuera = await anon.pedir('GET', `${E2E.apiUrl}/api/blobs/tenants/${nodoA}/..%2F..%2Fetc`);
    expect(fuera.status).toBe(404);
  } finally {
    await sql('UPDATE tenants SET logo_url = $1 WHERE id = $2', [antes?.logo_url ?? null, nodoA]);
  }
});
