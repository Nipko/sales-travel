import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { hotelImageProxyUrl } from '../../../../../lib/hotel-image-proxy';
import type { HotelRoompack } from '../../actions';
import type { HotelStay } from '../../_components/hotel-search-handoff';
import type { HotelDetailRatesResult } from '../actions';
import { LocationCard } from './hotel-content-sections';
import { HotelDetailRates, RatesRefundNoticeBox } from './hotel-detail-rates';
import { GallerySkeleton, HotelGallery } from './hotel-gallery';

/*
 * La ficha en su primer pintado: la galería sólo por el proxy propio y navegable con el teclado,
 * la ubicación sin mapa embebido, el aviso de un hotel sin tarifas reembolsables y las tarifas por
 * tipo de habitación, cada plan con sus condiciones.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

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

// ───────────────────────── Tarifas por tipo de habitación ─────────────────────────

const STAY: HotelStay = {
  checkinDate: '2026-11-10',
  checkoutDate: '2026-11-12',
  rooms: [{ adults: 2, childrenAges: [] }],
  guestNationality: 'CO',
  refundableOnly: false,
};

function tarifa(
  id: string,
  saleMinor: number,
  name: string,
  extra: Partial<HotelRoompack> = {},
  roomTypeId?: string,
): HotelRoompack {
  return {
    id,
    provider: { name: 'tbo-hotels', offerRef: `${id}-REF`, raw: { searchId: 'srch_1' } },
    board: 'RO',
    rooms: [
      {
        name,
        reference: 1,
        bedOptions: [],
        occupancy: { adults: 2, childrenAges: [] },
        ...(roomTypeId === undefined ? {} : { roomTypeId }),
      },
    ],
    cancellation: {
      refundable: true,
      status: 'partially_refundable',
      rules: [],
      policySource: 'search-indicative',
    },
    price: { total: { amountMinor: saleMinor, currency: 'USD' }, taxesDetail: [] },
    ...extra,
  };
}

const CON_TRAMOS: Partial<HotelRoompack> = {
  cancellation: {
    refundable: true,
    status: 'partially_refundable',
    policySource: 'search-indicative',
    rules: [
      {
        type: 'Percentage',
        penaltyPercentage: 100,
        fromLocalDateTime: '2026-11-08T00:00:00',
      },
    ],
  },
};

const NO_REEMBOLSABLE: Partial<HotelRoompack> = {
  cancellation: { refundable: false, status: 'non_refundable', rules: [] },
};

function detailRates(
  roompacks: HotelRoompack[],
  extra: Partial<HotelDetailRatesResult> = {},
): string {
  return renderToStaticMarkup(
    createElement(HotelDetailRates, {
      hotelKey: 'dGJvLWhvdGVsc34x',
      searchToken: undefined,
      stay: STAY,
      nights: 2,
      showProvider: false,
      rates: {
        ok: true,
        outcomes: [
          { ref: { provider: 'tbo-hotels', hotelId: '1' }, offer: { hotelId: '1', roompacks } },
        ],
        receivedAt: Date.UTC(2026, 9, 11, 12, 0, 0),
        ...extra,
      },
      loading: false,
      onReload: () => undefined,
      facts: new Map(),
      shownFacts: { name: 'Hotel Plaza' },
    }),
  );
}

describe('HotelDetailRates — por tipo de habitación', () => {
  it('cuenta tipos y tarifas, y cada tipo es una sección con su h3 bajo «Tarifas»', () => {
    const html = detailRates([
      tarifa('D1', 400_00, 'Deluxe King', {}, '77'),
      tarifa('D2', 450_00, 'DELUXE KING', { board: 'BB' }),
      tarifa('S', 300_00, 'Superior Twin', {}, '88'),
    ]);
    expect(html).toContain(
      '2 tipos de habitación · 3 tarifas · precios de venta por la estadía completa',
    );
    const headings = [
      ...html.matchAll(
        /<section aria-labelledby="([^"]+)"[^>]*>.*?<h3 id="\1"[^>]*>([^<]*)<\/h3>/g,
      ),
    ].map((m) => m[2]);
    expect(headings).toEqual(['Superior Twin', 'Deluxe King']);
    expect(html).toContain('2 adultos');
    // «desde» sólo con más de un plan: el tipo de un solo plan dice su precio a secas.
    expect(html).toMatch(/<p[^>]*><span[^>]*>150,00\s*US\$<\/span> por noche/);
    expect(html).toMatch(/desde <span[^>]*>200,00\s*US\$<\/span> por noche/);
    // Un «Reservar» por plan, sin el nombre del hotel: en la ficha todos son del mismo.
    const buttons = html.match(
      /<button[^>]*>Reservar<span class="sr-only">[^<]*<\/span><\/button>/g,
    );
    expect(buttons).toHaveLength(3);
    expect(buttons?.[0]).not.toContain(', en ');
  });

  it('los tramos de la política van en «Ver condiciones» del plan', () => {
    const html = detailRates([tarifa('A', 400_00, 'Doble', CON_TRAMOS)]);
    expect(html).toMatch(
      /<details[^>]*><summary[^>]*>Ver condiciones<span class="sr-only">: Solo alojamiento, 400,00\s*US\$<\/span>/,
    );
    expect(html).toMatch(/<details.*Cancelación.*Desde el 8 nov 2026, 00:00:.*<\/details>/);
  });

  it('sin tramos ni nada que agregar, el plan no ofrece «Ver condiciones»', () => {
    expect(detailRates([tarifa('A', 400_00, 'Doble')])).not.toContain('Ver condiciones');
  });

  it('una no reembolsable dice a la vista cuánto se pierde, fuera de «Ver condiciones»', () => {
    const html = detailRates([tarifa('A', 400_00, 'Doble', NO_REEMBOLSABLE)]);
    const visible = html.replace(/<details.*?<\/details>/g, '');
    expect(visible).toMatch(/se cobra el 100 %: <span[^>]*>400,00\s*US\$<\/span>/);
  });

  it('bloqueadas para la agencia: se marcan y no se ofrece reservarlas', () => {
    const html = detailRates([tarifa('A', 400_00, 'Doble', NO_REEMBOLSABLE)], {
      nonRefundableBlocked: true,
    });
    expect(html).toContain('No disponible para tu agencia');
    expect(html).not.toMatch(/>Reservar</);
  });
});
