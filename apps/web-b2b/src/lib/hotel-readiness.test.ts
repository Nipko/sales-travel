import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadHotelReadiness,
  nodeKindOf,
  omittedLine,
  parseHotelReadiness,
  readinessChecks,
  type ReadinessCheck,
  type ReadinessNode,
} from './hotel-readiness';

const NORTE = '10000000-0000-4000-8000-000000000001';

/** Una sucursal lista para probar, como la manda el API. */
function lista(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: NORTE,
    name: 'Sucursal Norte',
    isBranch: true,
    ready: true,
    missing: [],
    tbo: 'enabled',
    account: { status: 'ok', source: 'inherited', environment: 'test' },
    wallets: [{ currency: 'USD', status: 'active' }],
    supportContact: 'ok',
    activeSellers: 1,
    ...extra,
  };
}

function nodo(extra: Record<string, unknown> = {}): ReadinessNode {
  const parsed = parseHotelReadiness({ nodes: [lista(extra)], omitted: 0, partial: false });
  const node = parsed?.nodes[0];
  if (node === undefined) throw new Error('no se pudo leer el nodo');
  return node;
}

function check(node: ReadinessNode, key: ReadinessCheck['key']): ReadinessCheck {
  const found = readinessChecks(node).find((c) => c.key === key);
  if (found === undefined) throw new Error(`sin ${key}`);
  return found;
}

describe('parseHotelReadiness: la respuesta del API', () => {
  it('lee una sucursal lista y la deja tal cual', () => {
    expect(parseHotelReadiness({ nodes: [lista()], omitted: 0, partial: false })).toEqual({
      nodes: [
        {
          tenantId: NORTE,
          name: 'Sucursal Norte',
          isBranch: true,
          ready: true,
          missing: [],
          tbo: 'enabled',
          account: { status: 'ok', source: 'inherited', environment: 'test' },
          wallets: [{ currency: 'USD', status: 'active' }],
          supportContact: 'ok',
          activeSellers: 1,
        },
      ],
      omitted: 0,
      partial: false,
    });
  });

  it('lo que no conoce lo lee como «sin revisar», nunca como que está bien', () => {
    const parsed = parseHotelReadiness({
      nodes: [
        lista({
          tenantId: NORTE.toUpperCase(),
          ready: 'sí',
          missing: ['wallet', 'algo-nuevo', 7],
          tbo: 'quizas',
          account: { status: 'ok', source: 'otra' },
          wallets: 'muchas',
          supportContact: 'tal vez',
          activeSellers: 1.5,
        }),
      ],
      omitted: -2,
    });

    expect(parsed?.nodes[0]).toMatchObject({
      tenantId: NORTE,
      ready: false,
      missing: ['wallet'],
      tbo: 'unknown',
      account: { status: 'unknown' },
      wallets: null,
      supportContact: 'unknown',
      activeSellers: null,
    });
    expect(parsed?.omitted).toBe(0);
    // Aunque el API no lo marque, un dato sin revisar es una revisión incompleta.
    expect(parsed?.partial).toBe(true);
  });

  it('las cuentas: entorno desconocido es «sin entorno», y cada problema con su nombre', () => {
    expect(nodo({ account: { status: 'ok', source: 'own', environment: 'x' } }).account).toEqual({
      status: 'ok',
      source: 'own',
      environment: null,
    });
    for (const status of ['no-credentials', 'incomplete', 'not-allowed']) {
      expect(nodo({ account: { status } }).account).toEqual({ status });
    }
    expect(nodo({ account: { status: 'rara' } }).account).toEqual({ status: 'unknown' });
    expect(nodo({ account: 'ok' }).account).toEqual({ status: 'unknown' });
  });

  it('descarta las carteras mal formadas y conserva las demás', () => {
    expect(
      nodo({
        wallets: [
          { currency: 'USD', status: 'active' },
          { currency: 'usd', status: 'active' },
          { currency: 'COP' },
          'BRL',
        ],
      }).wallets,
    ).toEqual([{ currency: 'USD', status: 'active' }]);
  });

  it.each([
    ['con una línea sin revisar', { tbo: 'quizas' }],
    ['con un faltante', { missing: ['wallet'] }],
    ['con carteras ilegibles', { wallets: 'muchas' }],
  ])('«Lista para probar» no sale %s aunque el API diga ready', (_q, extra) => {
    expect(nodo({ ready: true, ...extra }).ready).toBe(false);
  });

  it('sin `missing` no inventa faltantes, y un nodo que no es sucursal lo dice', () => {
    const node = nodo({ missing: undefined, isBranch: false });
    expect(node.missing).toEqual([]);
    expect(node.isBranch).toBe(false);
  });

  it.each([
    ['nada', undefined],
    ['un texto', 'hola'],
    ['sin lista', { omitted: 0 }],
    ['un nodo sin id', { nodes: [lista({ tenantId: 'norte' })] }],
    ['un nodo sin nombre', { nodes: [lista({ name: '  ' })] }],
    ['un nodo que no es un objeto', { nodes: [lista(), 'otro'] }],
  ])('no entiende %s: la pantalla ofrece reintentar', (_q, value) => {
    expect(parseHotelReadiness(value)).toBeUndefined();
  });

  it('cuenta las que quedaron fuera', () => {
    expect(parseHotelReadiness({ nodes: [], omitted: 3 })).toEqual({
      nodes: [],
      omitted: 3,
      partial: false,
    });
  });
});

describe('readinessChecks: lo que dice de cada sucursal', () => {
  it('lista: cinco cosas en orden, todas bien y sin acciones', () => {
    const checks = readinessChecks(nodo());

    expect(checks.map((c) => [c.key, c.state, c.text])).toEqual([
      ['tbo', 'ok', 'TBO habilitado'],
      ['account', 'ok', 'Cuenta TBO activa · Prueba'],
      ['wallet', 'ok', 'Cartera en USD activa'],
      ['support-contact', 'ok', 'Contacto de soporte'],
      ['sellers', 'ok', '1 vendedor activo'],
    ]);
    expect(checks.some((c) => c.action !== undefined)).toBe(false);
  });

  it('a la que le falta todo: cada faltante con su texto y su enlace', () => {
    const checks = readinessChecks(
      nodo({
        ready: false,
        missing: ['tbo-not-enabled', 'tbo-account', 'wallet', 'support-contact', 'no-sellers'],
        tbo: 'not-enabled',
        account: { status: 'no-credentials' },
        wallets: [{ currency: 'USD', status: 'suspended' }],
        supportContact: 'missing',
        activeSellers: 0,
      }),
    );

    expect(checks.map((c) => [c.state, c.text, c.action?.label, c.action?.href])).toEqual([
      ['missing', 'TBO no está habilitado', 'Habilitar en Proveedores', `/admin/tenants/${NORTE}`],
      ['missing', 'Sin cuenta TBO heredada', 'Ir a Proveedores (GDS)', '/admin/proveedores'],
      [
        'missing',
        'Sin cartera activa',
        'Habilitar una cartera',
        `/admin/tenants/${NORTE}/carteras`,
      ],
      [
        'missing',
        'Falta el contacto de soporte: lo completa el admin de la sucursal en Mi Agencia → Marca, o lo hereda de Planetour',
        undefined,
        undefined,
      ],
      ['missing', 'Sin vendedores', 'Invitar un vendedor', `/admin/usuarios?tenant=${NORTE}`],
    ]);
  });

  it('TBO apagado por la plataforma se dice distinto, con la misma acción', () => {
    const tbo = check(
      nodo({ tbo: 'platform-disabled', missing: ['tbo-not-enabled'], ready: false }),
      'tbo',
    );
    expect(tbo.text).toBe('TBO está deshabilitado para esta sucursal');
    expect(tbo.action?.href).toBe(`/admin/tenants/${NORTE}`);
  });

  it('el apagado de emergencia no se arregla en la sucursal: manda al panel de la plataforma', () => {
    const node = nodo({ tbo: 'kill-switch', missing: ['tbo-not-enabled'], ready: false });
    const tbo = check(node, 'tbo');

    expect(node.tbo).toBe('kill-switch');
    expect(tbo).toEqual({
      key: 'tbo',
      state: 'missing',
      text: 'TBO está apagado de emergencia para toda la plataforma (PROVIDERS_DISABLED)',
      action: {
        label: 'Ver en Proveedores de la plataforma',
        href: '/admin/plataforma/proveedores',
      },
    });
  });

  it('la cuenta: producción, propia, sin entorno, incompleta o no admitida', () => {
    const texto = (account: Record<string, unknown>) => check(nodo({ account }), 'account').text;
    expect(texto({ status: 'ok', source: 'inherited', environment: 'live' })).toBe(
      'Cuenta TBO activa · Producción',
    );
    expect(texto({ status: 'ok', source: 'own', environment: 'test' })).toBe(
      'Cuenta TBO propia activa · Prueba',
    );
    expect(texto({ status: 'ok', source: 'inherited', environment: null })).toBe(
      'Cuenta TBO activa',
    );
    expect(texto({ status: 'incomplete' })).toBe('La cuenta TBO que hereda está incompleta');
    expect(texto({ status: 'not-allowed' })).toBe(
      'Su cuenta TBO no se admite: TBO opera sólo con la de Planetour o un consolidador',
    );
  });

  it('las carteras activas se nombran; con la cuenta propia no hace falta ninguna', () => {
    const texto = (extra: Record<string, unknown>) => check(nodo(extra), 'wallet').text;
    expect(
      texto({
        wallets: [
          { currency: 'USD', status: 'active' },
          { currency: 'COP', status: 'active' },
        ],
      }),
    ).toBe('Carteras en USD y COP activas');
    expect(
      texto({
        wallets: [
          { currency: 'USD', status: 'active' },
          { currency: 'COP', status: 'active' },
          { currency: 'BRL', status: 'active' },
          { currency: 'PEN', status: 'suspended' },
        ],
      }),
    ).toBe('Carteras en USD, COP y BRL activas');
    expect(
      texto({ account: { status: 'ok', source: 'own', environment: 'live' }, wallets: [] }),
    ).toBe('Con cuenta TBO propia no usa cartera');
  });

  it('varios vendedores, en plural', () => {
    expect(check(nodo({ activeSellers: 3 }), 'sellers').text).toBe('3 vendedores activos');
  });

  it('lo que no se pudo leer queda «sin revisar», sin acciones', () => {
    const checks = readinessChecks(
      nodo({
        ready: false,
        tbo: 'unknown',
        account: { status: 'unknown' },
        wallets: null,
        supportContact: 'unknown',
        activeSellers: null,
      }),
    );

    expect(checks.map((c) => [c.state, c.text])).toEqual([
      ['unknown', 'No pudimos revisar si TBO está habilitado'],
      ['unknown', 'No pudimos revisar la cuenta TBO'],
      ['unknown', 'No pudimos revisar sus carteras'],
      ['unknown', 'No pudimos revisar el contacto de soporte'],
      ['unknown', 'No pudimos revisar sus vendedores'],
    ]);
    expect(checks.some((c) => c.action !== undefined)).toBe(false);
  });
});

describe('textos sueltos', () => {
  it('un nodo que no es sucursal dice por qué está en la lista', () => {
    expect(nodeKindOf(nodo())).toBeUndefined();
    expect(nodeKindOf(nodo({ isBranch: false }))).toBe('Con TBO habilitado');
  });

  it('las que quedaron fuera, en singular y en plural', () => {
    expect(omittedLine(0)).toBeUndefined();
    expect(omittedLine(1)).toBe('Hay 1 sucursal más que no entra en esta lista.');
    expect(omittedLine(4)).toBe('Hay 4 sucursales más que no entran en esta lista.');
  });
});

describe('loadHotelReadiness: la llamada del navegador', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function responde(status: number, body: unknown) {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('pide la revisión al proxy del panel, sin caché, y la devuelve leída', async () => {
    const fetchMock = responde(200, { nodes: [lista()], omitted: 0, partial: false });

    const data = await loadHotelReadiness();

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/hotels/readiness', { cache: 'no-store' });
    expect(data?.nodes[0]?.name).toBe('Sucursal Norte');
  });

  it.each([
    ['un error del API', 403, { error: 'superadmin access required' }],
    ['una página en vez de datos', 502, '<!doctype html><p>Bad gateway</p>'],
    ['datos que no entiende', 200, { nodos: [] }],
  ])('con %s no devuelve nada: la pantalla ofrece reintentar', async (_q, status, body) => {
    responde(status, body);
    await expect(loadHotelReadiness()).resolves.toBeUndefined();
  });

  it('sin conexión tampoco lanza', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(loadHotelReadiness()).resolves.toBeUndefined();
  });
});
