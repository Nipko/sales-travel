import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TICKET_CONDITIONS_MESSAGES as M, parseTicketCheck } from '../ticket-conditions-view';
import {
  TicketCheckDetails,
  TicketConditions,
  VoidConfirmDialog,
  type TicketConditionsOrderInput,
} from './ticket-conditions';

/*
 * «Condiciones de los tiquetes» (SAB-09) en su pintado: la sección sólo en una emitida que lo
 * declara, el semáforo con texto (nunca sólo color), el botón de anular sólo con verde y la
 * confirmación con el texto que pide el producto. Sin DOM: lo que depende de clics se prueba en
 * `ticket-conditions-view.test.ts`.
 */

function orden(over: Partial<TicketConditionsOrderInput> = {}): TicketConditionsOrderInput {
  return {
    id: 'o-1',
    orderNumber: 41,
    status: 'ticketed',
    pnr: 'ABC123',
    capabilities: {
      retrieve: true,
      cancel: false,
      pay: false,
      services: false,
      reshop: false,
      ticketCheck: true,
      void: true,
    },
    ...over,
  };
}

function consulta(raw: Record<string, unknown> = {}) {
  const check = parseTicketCheck({
    checkedAt: '2026-10-13T15:00:00.000Z',
    tickets: [
      { number: '0016802004060', voidable: 'yes', refundable: 'unknown' },
      { number: '0016802004061', voidable: 'yes', refundable: 'no' },
    ],
    voidAvailable: true,
    voidStatus: 'available',
    ...raw,
  });
  if (check === null) throw new Error('consulta inválida');
  return check;
}

function seccion(order: TicketConditionsOrderInput): string {
  return renderToStaticMarkup(
    createElement(TicketConditions, {
      order,
      operations: [],
      opsLoading: false,
      opsError: false,
      onVoidAttempted: () => undefined,
    }),
  );
}

function detalle(props: Partial<Parameters<typeof TicketCheckDetails>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(TicketCheckDetails, {
      check: consulta(),
      block: null,
      canVoid: true,
      onVoidRequest: () => undefined,
      ...props,
    }),
  );
}

function confirmacion(props: Partial<Parameters<typeof VoidConfirmDialog>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(VoidConfirmDialog, {
      order: orden(),
      check: consulta(),
      voiding: false,
      canConfirm: true,
      onClose: () => undefined,
      onConfirm: () => undefined,
      ...props,
    }),
  );
}

describe('la sección en el detalle', () => {
  it('en una emitida que declara la consulta: título, aviso de que es en vivo y el botón', () => {
    const html = seccion(orden());
    expect(html).toContain(M.heading);
    expect(html).toContain(M.hint);
    expect(html).toContain(M.check);
    expect(html).toMatch(/<section[^>]*aria-labelledby="[^"]+"/);
    // Sin consultar no hay semáforo ni botón de anular: nada se adivina.
    expect(html).not.toContain(M.voidButton);
    expect(html).not.toContain(M.available);
  });

  it('no aparece en una reserva confirmada, cancelada o sin la capacidad', () => {
    expect(seccion(orden({ status: 'confirmed' }))).toBe('');
    expect(seccion(orden({ status: 'cancelled' }))).toBe('');
    expect(seccion(orden({ capabilities: { ...orden().capabilities, ticketCheck: false } }))).toBe(
      '',
    );
  });
});

describe('el semáforo, con texto y nunca sólo color', () => {
  it('verde: «Se puede anular sin costo», con plazo si lo dio el proveedor, y el botón', () => {
    const html = detalle({ check: consulta({ voidExpiresAt: '2026-10-13T23:59:00.000Z' }) });
    expect(html).toContain(M.available);
    expect(html).toMatch(/hasta \d{1,2} oct 2026, \d{2}:\d{2}/);
    expect(html).toContain('Consultado el');
    expect(html).toContain(M.voidButton);
    expect(html).toMatch(/role="status"/);
  });

  it('cada tiquete con su número y lo que se puede hacer con él', () => {
    const html = detalle();
    expect(html).toContain('0016802004060');
    expect(html).toContain('Anulable · Reembolso sin dato');
    expect(html).toContain('Anulable · No reembolsable');
  });

  it('rojo: «Ya no se puede anular», sin botón', () => {
    const html = detalle({
      check: consulta({ voidStatus: 'unavailable', voidAvailable: false }),
      canVoid: false,
    });
    expect(html).toContain(M.unavailable);
    expect(html).not.toContain(M.voidButton);
  });

  it('gris: «La aerolínea no informó si se puede anular», sin botón', () => {
    const html = detalle({
      check: consulta({ voidStatus: 'unknown', voidAvailable: false }),
      canVoid: false,
    });
    expect(html).toContain(M.unknown);
    expect(html).not.toContain(M.voidButton);
  });

  it('nunca un contador: ni segundos ni minutos restantes', () => {
    const html = detalle({ check: consulta({ voidExpiresAt: '2026-10-13T23:59:00.000Z' }) });
    const texto = html.replace(/<[^>]+>/g, ' ');
    expect(texto).not.toMatch(/quedan|restan|\bmin\b|\bseg\b|\bminutos?\b/i);
  });

  it('un verde que el historial bloquea dice por qué, en vez de esconder el botón sin más', () => {
    const html = detalle({ block: M.pendingBlock, canVoid: false });
    expect(html).toContain(M.pendingBlock);
    expect(html).not.toContain(M.voidButton);
  });
});

describe('la confirmación', () => {
  it('el texto del producto, con cuántos tiquetes y qué reserva', () => {
    const html = confirmacion();
    expect(html).toContain('Anular tiquetes de la reserva #41');
    expect(html).toContain(
      'Anular los tiquetes cancela la reserva y libera los asientos. No se cobra penalidad. ¿Anular los 2 tiquetes de la reserva #41?',
    );
    expect(html).toContain('No, volver');
    expect(html).toContain(M.confirmButton);
    expect(html).not.toContain(M.testNote);
  });

  it('es un diálogo modal con nombre y descripción para el lector de pantalla', () => {
    const html = confirmacion();
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    // El foco arranca en «No, volver»: el que confirma es destructivo.
    expect(html).toContain('data-void-back');
  });

  it('una reserva de prueba se puede anular, y lo dice', () => {
    expect(confirmacion({ order: orden({ testContent: true }) })).toContain(M.testNote);
  });

  it('con el pedido en vuelo los dos botones quedan quietos y se avisa que no se cierre', () => {
    const html = confirmacion({ voiding: true });
    expect(html).toContain(M.voiding);
    expect(html).toContain(M.voidingNote);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*No, volver/s);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Anulando…/s);
  });
});

/*
 * La página pide datos al montar y no se pinta sin DOM: se verifica en el código que el detalle de
 * un vuelo monta la sección con el historial que ya leyó y relee la reserva después de anular.
 */
describe('Reservas ofrece «Condiciones de los tiquetes» en el detalle', () => {
  const page = readFileSync(fileURLToPath(new URL('../page.tsx', import.meta.url)), 'utf8');

  it('en el detalle de un vuelo, con el historial que el detalle ya leyó', () => {
    expect(page).toContain('<TicketConditions');
    expect(page).toContain('operations={operations}');
    expect(page).toContain('opsError={opsError !== null}');
  });

  it('después de anular relee el historial y la lista', () => {
    expect(page).toMatch(
      /onVoidAttempted=\{\(\) => \{\s*void reloadOps\(\);\s*onOrderChanged\(\);/,
    );
    expect(page).toContain('onOrderChanged={() => void loadOrders(false)}');
  });
});
