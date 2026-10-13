import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PlatformOrderAction } from '../../../../../../lib/platform-order-actions';
import {
  parsePlatformOrderDetail,
  type PlatformOrderDetail,
} from '../../../../../../lib/platform-orders';
import { DETAIL_PAYLOAD } from '../../../../../../lib/platform-orders.fixture';
import { voseoIn } from '../../../../../../lib/voseo';
import { OrderActionDialog } from './order-action-dialog';
import { OrderActions } from './order-actions';
import { OrderDetailContent } from './order-detail-sheet';

/*
 * La post-venta del superadmin desde la ficha de Reservas de la red (FD-1 C): el pie con las
 * acciones, el diálogo que pide el motivo (y, al cancelar, la penalidad y el número escrito) y el
 * "Reintentar" del historial. Se prueba lo que se pinta; las reglas, en lib/platform-order-actions.
 */

const NOW = Date.parse('2026-10-13T15:00:00.000Z');
const noop = () => undefined;

/** Hotel confirmado con una cancelación que falló antes de enviarse (reintentable). */
const HOTEL = parsePlatformOrderDetail(DETAIL_PAYLOAD) as PlatformOrderDetail;

/** Vuelo confirmado, sin historial: se puede consultar, reenviar y cancelar. */
const FLIGHT: PlatformOrderDetail = {
  ...HOTEL,
  order: {
    ...HOTEL.order,
    provider: 'latam-ndc',
    pnr: 'XYZ789',
    searchCriteria: { origin: 'BOG', destination: 'LIM' },
    providerTracking: null,
    orderNumber: 7,
  },
  operations: [],
};

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
}

function actions(detail: PlatformOrderDetail): string {
  return renderToStaticMarkup(createElement(OrderActions, { detail, onAction: noop }));
}

function dialog(action: PlatformOrderAction, detail: PlatformOrderDetail = HOTEL): string {
  return renderToStaticMarkup(
    createElement(OrderActionDialog, { action, detail, onClose: noop, onDone: noop }),
  );
}

/** El botón (abre y cierra) que contiene `label`. */
function button(html: string, label: string): string | undefined {
  return [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)]
    .map((m) => m[0])
    .find((b) => text(b).includes(label));
}

describe('el pie de la ficha', () => {
  it('un vuelo confirmado con correo: consultar, reenviar y cancelar, en un grupo con nombre', () => {
    const html = actions(FLIGHT);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Acciones de post-venta"');
    expect(button(html, 'Consultar al proveedor')).toBeDefined();
    expect(button(html, 'Reenviar confirmación')).toBeDefined();
    expect(button(html, 'Cancelar reserva')).toBeDefined();
  });

  it('con una cancelación fallida, cancelar no está y dice que se continúa desde el historial', () => {
    const html = actions(HOTEL);
    expect(button(html, 'Cancelar reserva')).toBeUndefined();
    expect(text(html)).toContain('Continúa desde “Reintentar” en el historial');
    expect(button(html, 'Consultar al proveedor')).toBeDefined();
  });

  it('cancelar no está si el proveedor no cancela (o la reserva está emitida)', () => {
    expect(
      button(actions({ ...FLIGHT, capabilities: { retrieve: true, cancel: false } }), 'Cancelar'),
    ).toBeUndefined();
    expect(
      button(actions({ ...FLIGHT, order: { ...FLIGHT.order, status: 'ticketed' } }), 'Cancelar'),
    ).toBeUndefined();
  });

  it('reenviar sólo con una confirmada o emitida; sin ninguna acción, no hay pie', () => {
    const pending = { ...FLIGHT, order: { ...FLIGHT.order, status: 'pending' as const } };
    expect(button(actions(pending), 'Reenviar confirmación')).toBeUndefined();
    expect(
      actions({
        ...FLIGHT,
        order: { ...FLIGHT.order, status: 'cancelled' },
        capabilities: { retrieve: false, cancel: false },
      }),
    ).toBe('');
  });

  it('nunca ofrece vender: ni pagar, ni emitir, ni servicios, ni recotizar', () => {
    const t = text(actions(FLIGHT));
    for (const word of ['Pagar', 'Emitir', 'Servicios', 'Recotizar', 'Repricing']) {
      expect(t).not.toContain(word);
    }
  });
});

describe('el diálogo de cada acción', () => {
  it('reenviar: el título con el correo y el motivo obligatorio', () => {
    const html = dialog({ kind: 'send-confirmation', to: 'ana@cliente.com' });
    const t = text(html);
    expect(t).toContain('Reenviar la confirmación a ana@cliente.com');
    expect(t).toContain('Motivo (queda en la auditoría)');
    expect(html).toMatch(/<textarea[^>]*aria-required="true"/);
    expect(html).toMatch(/<textarea[^>]*maxLength="500"/);
    expect(t).toContain('Entre 5 y 500 caracteres. Lo ven la agencia y la plataforma.');
    expect(button(html, 'Reenviar confirmación')).toMatch(/type="submit"/);
    expect(t).not.toContain('Número de la orden');
    expect(t).not.toContain('Penalidad');
  });

  it('consultar y reintentar: sus títulos, sin número que escribir', () => {
    expect(text(dialog({ kind: 'retrieve' }))).toContain('Consultar el estado al proveedor');
    const retry = text(
      dialog({ kind: 'retry-cancel', operationId: HOTEL.operations[0]?.id ?? '' }),
    );
    expect(retry).toContain('Reintentar la cancelación');
    expect(retry).toContain('Motivo (queda en la auditoría)');
    expect(retry).not.toContain('Número de la orden');
  });

  it('cancelar: título con el nodo, penalidad, número escrito y el botón de peligro deshabilitado', () => {
    const html = dialog({ kind: 'cancel' }, FLIGHT);
    const t = text(html);
    expect(t).toContain('Cancelar la reserva #7 de Agencia Sur');
    expect(t).toContain(
      'Penalidad: la informa el proveedor al cancelar. No tenemos una estimación propia para esta reserva.',
    );
    expect(t).toContain('Número de la orden');
    expect(t).toContain('Escribe 7 para confirmar.');
    expect(html).toMatch(/<input[^>]*inputMode="numeric"/);
    const confirm = button(html, 'Cancelar reserva');
    expect(confirm).toMatch(/disabled=""/);
    expect(confirm).toContain('--color-danger');
    // El botón que cierra no dice "Cancelar": al lado de "Cancelar reserva" se confundirían.
    expect(button(html, 'Volver')).toBeDefined();
  });

  it('cancelar un hotel: la penalidad estimada se calcula al abrir', () => {
    const t = text(dialog({ kind: 'cancel' }));
    expect(t).toContain('Cancelar la reserva #1042 de Agencia Sur');
    expect(t).toContain('Calculando la penalidad estimada…');
  });

  it('va en tú', () => {
    const all = [
      dialog({ kind: 'send-confirmation', to: 'ana@cliente.com' }),
      dialog({ kind: 'retrieve' }),
      dialog({ kind: 'retry-cancel', operationId: 'x' }),
      dialog({ kind: 'cancel' }, FLIGHT),
      actions(FLIGHT),
      actions(HOTEL),
    ]
      .map(text)
      .join(' ');
    expect(voseoIn(all)).toEqual([]);
  });
});

describe('la ficha con la post-venta', () => {
  it('con onRetry, la cancelación fallida ofrece "Reintentar"', () => {
    const html = renderToStaticMarkup(
      createElement(OrderDetailContent, { detail: HOTEL, now: NOW, onRetry: noop }),
    );
    expect(button(html, 'Reintentar')).toBeDefined();
  });

  it('si el proveedor ya no cancela, no hay reintento', () => {
    const html = renderToStaticMarkup(
      createElement(OrderDetailContent, {
        detail: { ...HOTEL, capabilities: { retrieve: true, cancel: false } },
        now: NOW,
        onRetry: noop,
      }),
    );
    expect(button(html, 'Reintentar')).toBeUndefined();
  });

  it('un vuelo consultado: lo que respondió el proveedor, aclarando que no queda guardado', () => {
    const before = text(
      renderToStaticMarkup(createElement(OrderDetailContent, { detail: FLIGHT, now: NOW })),
    );
    expect(before).toContain('Sin lectura guardada del proveedor.');

    const html = renderToStaticMarkup(
      createElement(OrderDetailContent, {
        detail: FLIGHT,
        now: NOW,
        reading: {
          found: true,
          status: 'TICKETED',
          airlineLocators: [{ carrierCode: 'LA', locator: 'XYZ987' }],
          ticketNumbers: ['0451234567890'],
          hotelConfirmationNumber: null,
          readAt: '2026-10-13T15:00:00.000Z',
        },
      }),
    );
    const t = text(html);
    expect(t).not.toContain('Sin lectura guardada del proveedor.');
    expect(t).toContain('El proveedor tiene la reserva.');
    expect(html).toContain(
      '<code class="text-[11px] text-[var(--color-fg-muted)]">TICKETED</code>',
    );
    expect(t).toContain('Localizadores de aerolínea: LA XYZ987');
    expect(t).toContain('Tiquetes: 0451234567890');
    expect(t).toContain('Es una lectura en vivo: no queda guardada en la reserva.');
    expect(html).toContain('dateTime="2026-10-13T15:00:00.000Z"');
    expect(voseoIn(t)).toEqual([]);
  });

  it('un hotel con su lectura guardada la muestra a ella, no la de la consulta', () => {
    const t = text(
      renderToStaticMarkup(
        createElement(OrderDetailContent, {
          detail: HOTEL,
          now: NOW,
          reading: {
            found: false,
            status: null,
            airlineLocators: [],
            ticketNumbers: [],
            hotelConfirmationNumber: null,
            readAt: null,
          },
        }),
      ),
    );
    expect(t).not.toContain('El proveedor no encuentra la reserva.');
  });

  it('la Actividad nombra la acción del superadmin y su motivo', () => {
    const t = text(
      renderToStaticMarkup(createElement(OrderDetailContent, { detail: HOTEL, now: NOW })),
    );
    expect(t).toContain('El superadmin consultó el estado al proveedor');
    expect(t).toContain('founder@planetour.cloud');
    expect(t).toContain('Motivo: La agencia pidió revisar el estado');
  });
});
