import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ISSUE_MESSAGES } from '../issue-ticket-view';
import { IssueTicketDialog, type IssueTicketOrder } from './issue-ticket-dialog';

/*
 * El diálogo de «Emitir tiquete» (SAB-08) en su primer pintado: lo que se va a emitir, cómo se paga
 * y, si es de prueba, que no genera un tiquete real. El botón de emitir arranca deshabilitado hasta
 * comprobar el historial.
 */

function orden(over: Partial<IssueTicketOrder> = {}): IssueTicketOrder {
  return {
    id: 'o-1',
    orderNumber: 7,
    status: 'confirmed',
    pnr: 'ABC123',
    capabilities: {
      retrieve: true,
      cancel: true,
      pay: false,
      services: false,
      reshop: false,
      issue: true,
    },
    totalAmount: 34012,
    currency: 'USD',
    flightTracking: {
      airlineLocators: [],
      documents: [],
      ticketingDeadline: { date: '2099-10-20', time: '23:59', zone: 'PROVIDER_LOCAL' },
    },
    ...over,
  };
}

function pintar(order: IssueTicketOrder): string {
  return renderToStaticMarkup(
    createElement(IssueTicketDialog, {
      order,
      onClose: () => undefined,
      onRequested: () => undefined,
    }),
  );
}

describe('IssueTicketDialog', () => {
  it('dice qué reserva, cuánto, hasta cuándo y cómo se paga', () => {
    const html = pintar(orden());

    expect(html).toContain('Emitir tiquete de la reserva #7');
    expect(html).toMatch(/Total/);
    expect(html).toContain('340,12');
    expect(html).toContain('Emitir antes del');
    expect(html).toContain(ISSUE_MESSAGES.paymentNote);
    expect(html).toContain('>Cancelar<');
    expect(html).toContain('Emitir tiquete');
    expect(html).not.toContain(ISSUE_MESSAGES.testNote);
  });

  it('es un diálogo modal con nombre y descripción para el lector de pantalla', () => {
    const html = pintar(orden());

    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
  });

  it('antes de mirar el historial, el botón de emitir no se puede apretar', () => {
    const html = pintar(orden());

    expect(html).toContain('Comprobando el historial de la reserva');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Emitir tiquete/s);
  });

  it('una reserva de prueba lo avisa: no se genera un tiquete real', () => {
    expect(pintar(orden({ testContent: true }))).toContain(
      'Entorno de pruebas: no se genera un tiquete real.',
    );
  });

  it('con el plazo vencido lo dice, y se puede intentar igual', () => {
    const html = pintar(
      orden({
        flightTracking: {
          airlineLocators: [],
          documents: [],
          ticketingDeadline: {
            date: '2020-01-01',
            time: '10:00',
            zone: 'UTC',
            at: '2020-01-01T10:00:00.000Z',
          },
        },
      }),
    );

    expect(html).toContain('Plazo de emisión vencido');
    expect(html).toContain(ISSUE_MESSAGES.expiredNote);
  });
});

/*
 * La página pide datos al montar y no se pinta sin DOM: se verifica en el código que Reservas usa
 * el diálogo, sigue la emisión y no la mezcla con «Pagar / Emitir».
 */
describe('Reservas ofrece «Emitir tiquete»', () => {
  const page = readFileSync(fileURLToPath(new URL('../page.tsx', import.meta.url)), 'utf8');

  it('en la fila y en el detalle, sólo cuando se puede emitir', () => {
    expect(page).toContain('canIssueTicket(order) && (');
    expect(page).toContain('const canIssue = !isCar && canIssueTicket(order) && !issueInFlight;');
  });

  it('el diálogo pide; la página sigue la operación y avisa al terminar', () => {
    expect(page).toContain('<IssueTicketDialog');
    expect(page).toContain('trackIssue(issuing.id, operationId);');
    expect(page).toContain('toast.message(ISSUE_MESSAGES.started);');
    expect(page).toContain('useIssueTracker(onIssueSettled)');
  });

  it('el pago diferido sigue siendo otro botón, con su propia capacidad', () => {
    expect(page).toContain("supportsOrderCapability(order.capabilities, 'pay')");
  });
});
