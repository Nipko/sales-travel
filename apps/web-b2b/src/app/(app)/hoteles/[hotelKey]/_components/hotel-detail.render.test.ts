import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { hotelImageProxyUrl } from '../../../../../lib/hotel-image-proxy';
import { LocationCard } from './hotel-content-sections';
import { RatesRefundNoticeBox } from './hotel-detail-rates';
import { GallerySkeleton, HotelGallery } from './hotel-gallery';

/*
 * La ficha en su primer pintado: la galería sólo por el proxy propio y navegable con el teclado,
 * la ubicación sin mapa embebido y el aviso de un hotel sin tarifas reembolsables.
 */

const SOURCES = [1, 2, 3].map(
  (n) => `https://api.tbotechnology.in/imageresource.aspx?img=hotel-${n}.jpg`,
);
const PHOTOS = SOURCES.map((src) => hotelImageProxyUrl(src) ?? '');

function gallery(images: readonly string[]): string {
  return renderToStaticMarkup(createElement(HotelGallery, { images, name: 'Hotel Plaza' }));
}

describe('HotelGallery', () => {
  it('todas las fotos por next/image sobre el proxy: ninguna URL del proveedor en el HTML', () => {
    const html = gallery(PHOTOS);
    expect(html).toContain('/_next/image?url=%2Fapi%2Fhotels%2Fimages%2F');
    expect(html).not.toContain('tbotechnology.in');
    expect(html).not.toMatch(/src="https?:/);
  });

  it('carrusel con pestañas: foto grande con su posición, anterior y siguiente, y miniaturas', () => {
    const html = gallery(PHOTOS);
    expect(html).toContain('aria-roledescription="carrusel"');
    expect(html).toContain('aria-label="Fotos de Hotel Plaza"');
    expect(html).toContain('alt="Hotel Plaza, foto 1 de 3"');
    expect(html).toContain('aria-label="Foto anterior"');
    expect(html).toContain('aria-label="Foto siguiente"');
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    // Una sola parada de Tab en las miniaturas: la elegida.
    expect(html.match(/role="tab" aria-selected="true"[^>]*tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(html).toContain('role="tabpanel"');
  });

  it('una sola foto: sin miniaturas ni botones de pasar', () => {
    const html = gallery(PHOTOS.slice(0, 1));
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('Foto siguiente');
    expect(html).toContain('alt="Hotel Plaza, foto 1 de 1"');
  });

  it('sin fotos que el proxy sirva, no pinta nada', () => {
    expect(gallery(SOURCES)).toBe('');
  });

  it('mientras las busca en el proveedor, lo dice', () => {
    const html = renderToStaticMarkup(createElement(GallerySkeleton, { searching: true }));
    expect(html).toContain('role="status"');
    expect(html).toContain('Buscando las fotos del hotel…');
    expect(
      renderToStaticMarkup(createElement(GallerySkeleton, { searching: false })),
    ).not.toContain('role="status"');
  });
});

describe('LocationCard', () => {
  it('dirección, país, coordenadas y el mapa externo en otra pestaña; sin mapa embebido', () => {
    const html = renderToStaticMarkup(
      createElement(LocationCard, {
        view: {
          address: 'Av. 5 # 10-20 (110111)',
          country: 'Colombia',
          coordinates: '4.60971, -74.08175',
          mapHref: 'https://www.google.com/maps/search/?api=1&query=4.609710%2C-74.081750',
        },
      }),
    );
    expect(html).toContain('Ubicación');
    expect(html).toContain('Av. 5 # 10-20 (110111)');
    expect(html).toContain('Colombia');
    expect(html).toContain('4.60971, -74.08175');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Copiar dirección');
    expect(html).not.toContain('<iframe');
  });

  it('sólo coordenadas: sin botón de copiar dirección', () => {
    const html = renderToStaticMarkup(
      createElement(LocationCard, { view: { coordinates: '4.60971, -74.08175' } }),
    );
    expect(html).not.toContain('Copiar dirección');
  });
});

describe('RatesRefundNoticeBox', () => {
  it('ninguna reembolsable: el aviso de advertencia con el 100 %', () => {
    const html = renderToStaticMarkup(
      createElement(RatesRefundNoticeBox, { notice: 'non-refundable-all' }),
    );
    expect(html).toContain('Este hotel no tiene tarifas reembolsables para estas fechas.');
    expect(html).toContain('se cobra el 100 %');
    expect(html).toContain('var(--color-warning)');
  });

  it('bloqueadas para la agencia: dice que no hay qué reservar y por qué', () => {
    const html = renderToStaticMarkup(
      createElement(RatesRefundNoticeBox, { notice: 'blocked-all' }),
    );
    expect(html).toContain('Tu agencia no puede reservar este hotel para estas fechas.');
    expect(html).toContain('quien financia a tu agencia bloqueó');
  });

  it('sin aviso, nada', () => {
    expect(renderToStaticMarkup(createElement(RatesRefundNoticeBox, { notice: undefined }))).toBe(
      '',
    );
  });
});
