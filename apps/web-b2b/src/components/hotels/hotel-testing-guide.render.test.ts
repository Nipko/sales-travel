import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseHotelReadiness, type HotelReadiness } from '../../lib/hotel-readiness';
import {
  HotelTestingGuide,
  HotelTestingGuideView,
  type HotelTestingGuideState,
} from './hotel-testing-guide';

const NORTE = '10000000-0000-4000-8000-000000000001';
const SUR = '10000000-0000-4000-8000-000000000002';
const AGENCIA = '10000000-0000-4000-8000-000000000003';

const INTRO =
  'Entra con un vendedor de una de estas sucursales. Para llegar a «Confirmar reserva», cada una necesita todo lo de su lista.';
const FOOTER =
  'Las reservas con la cuenta de prueba no son reales. Elige una tarifa con cancelación gratis y cancélala al terminar.';

function datos(value: unknown): HotelReadiness {
  const parsed = parseHotelReadiness(value);
  if (parsed === undefined) throw new Error('datos de prueba ilegibles');
  return parsed;
}

function render(state: HotelTestingGuideState): string {
  return renderToStaticMarkup(
    createElement(HotelTestingGuideView, { state, onRetry: () => undefined }),
  );
}

/** El HTML de React escapa `&` y las comillas; el texto de los asertos no. */
function texto(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

const LISTA = datos({
  nodes: [
    {
      tenantId: AGENCIA,
      name: 'Agencia Sur',
      isBranch: false,
      ready: false,
      missing: ['wallet'],
      tbo: 'enabled',
      account: { status: 'ok', source: 'inherited', environment: 'test' },
      wallets: [],
      supportContact: 'ok',
      activeSellers: 2,
    },
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
    {
      tenantId: SUR,
      name: 'Sucursal Sur',
      isBranch: true,
      ready: false,
      missing: ['tbo-not-enabled', 'support-contact', 'no-sellers'],
      tbo: 'not-enabled',
      account: { status: 'ok', source: 'inherited', environment: 'test' },
      wallets: [{ currency: 'USD', status: 'active' }],
      supportContact: 'missing',
      activeSellers: 0,
    },
  ],
  omitted: 2,
  partial: false,
});

describe('HotelTestingGuideView', () => {
  it('cargando: título, instrucciones y pie, y anuncia que está revisando', () => {
    const html = texto(render({ status: 'loading' }));

    expect(html).toMatch(/<h2[^>]*>Probar una reserva de hotel<\/h2>/);
    expect(html).toContain(INTRO);
    expect(html).toContain(FOOTER);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Revisando las sucursales…');
    expect(html).not.toContain('Reintentar');
  });

  it('error: lo dice como alerta y ofrece reintentar', () => {
    const html = render({ status: 'error' });

    expect(html).toMatch(
      /role="alert"[^>]*>No pudimos revisar las sucursales\. Inténtalo de nuevo\.</,
    );
    expect(html).toMatch(/<button[^>]*>.*Reintentar<\/button>/);
    expect(html).toContain('aria-busy="false"');
  });

  it('sin sucursales: manda a crear una en Gestión de Agencias', () => {
    const html = render({ status: 'ready', data: datos({ nodes: [], omitted: 0 }) });

    expect(html).toContain('Todavía no hay sucursales.');
    expect(html).toMatch(
      /<a[^>]*href="\/admin\/tenants"[^>]*>Crea una en Gestión de Agencias\.<\/a>/,
    );
    expect(html).toContain(FOOTER);
  });

  it('con sucursales: cada una con su lista, y «Lista para probar» sólo en la que lo está', () => {
    const html = texto(render({ status: 'ready', data: LISTA }));

    for (const name of ['Agencia Sur', 'Sucursal Norte', 'Sucursal Sur']) {
      expect(html).toMatch(new RegExp(`<h3[^>]*>${name}</h3>`));
    }
    expect(html.match(/Lista para probar/g)).toHaveLength(1);
    const norte = html.slice(html.indexOf('Sucursal Norte'), html.indexOf('Sucursal Sur'));
    expect(norte).toContain('Lista para probar');
    expect(norte).toContain('TBO habilitado');
    expect(norte).toContain('Cuenta TBO activa · Prueba');
    expect(norte).toContain('Cartera en USD activa');
    expect(norte).toContain('Contacto de soporte');
    expect(norte).toContain('1 vendedor activo');
    expect(norte).not.toContain('href=');

    // El estado va escrito para los lectores de pantalla: el color y el ícono no son la única señal.
    expect(html).toContain('<span class="sr-only">Listo: </span>TBO habilitado');
    expect(html).toContain('<span class="sr-only">Falta: </span>TBO no está habilitado');
  });

  it('lo que falta trae el enlace para resolverlo', () => {
    const html = texto(render({ status: 'ready', data: LISTA }));

    expect(html).toMatch(
      new RegExp(`<a[^>]*href="/admin/tenants/${AGENCIA}/carteras"[^>]*>Habilitar una cartera`),
    );
    expect(html).toMatch(
      new RegExp(`<a[^>]*href="/admin/tenants/${SUR}"[^>]*>Habilitar en Proveedores`),
    );
    expect(html).toMatch(
      new RegExp(`<a[^>]*href="/admin/usuarios\\?tenant=${SUR}"[^>]*>Invitar un vendedor`),
    );
    expect(html).toContain(
      'Falta el contacto de soporte: lo completa el admin de la sucursal en Mi Agencia → Marca, o lo hereda de Planetour',
    );
    expect(html).toContain('Sin vendedores');
  });

  it('un nodo que no es sucursal dice por qué está, y cuenta las que quedaron fuera', () => {
    const html = render({ status: 'ready', data: LISTA });

    expect(html).toContain('Con TBO habilitado');
    expect(html).toContain('Hay 2 sucursales más que no entran en esta lista.');
  });

  it('si algún dato no llegó, lo avisa y ofrece reintentar sin esconder la lista', () => {
    const html = render({
      status: 'ready',
      data: datos({
        nodes: [
          {
            tenantId: NORTE,
            name: 'Sucursal Norte',
            isBranch: true,
            ready: false,
            missing: [],
            tbo: 'enabled',
            account: { status: 'unknown' },
            wallets: [{ currency: 'USD', status: 'active' }],
            supportContact: 'ok',
            activeSellers: 1,
          },
        ],
        omitted: 0,
        partial: true,
      }),
    });

    expect(html).toMatch(/role="status"[^>]*>Algunos datos no llegaron a tiempo/);
    expect(html).toContain('Reintentar');
    expect(html).toContain(
      '<span class="sr-only">Sin revisar: </span>No pudimos revisar la cuenta TBO',
    );
    expect(html).not.toContain('Lista para probar');
  });
});

describe('HotelTestingGuide', () => {
  it('en su primer pintado está revisando: la lista llega del API después', () => {
    const html = renderToStaticMarkup(createElement(HotelTestingGuide));

    expect(html).toContain('Probar una reserva de hotel');
    expect(html).toContain('aria-busy="true"');
  });
});
