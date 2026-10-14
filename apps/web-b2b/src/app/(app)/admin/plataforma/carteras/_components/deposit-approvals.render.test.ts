import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPROVALS_FILTERS,
  parseQueuedReport,
  type QueuedDepositReport,
} from '../../../../../../lib/deposit-approvals';
import { DepositApprovalsPanel, ReportRow } from './deposit-approvals-panel';

/** Formas del voseo que podrían colarse en esta pantalla (va en tú neutro). */
const VOSEO =
  /(?<!\p{L})(?:podés|tenés|querés|hacé|elegí|probá|volvé|ingresá|revisá|esperá|intentá|recargá|verificá|aprobá|rechazá|usá|buscá|cerrá|vos)(?!\p{L})/giu;

const NODE = '10000000-0000-4000-8000-000000000001';

const REPORT = parseQueuedReport({
  id: '30000000-0000-4000-8000-000000000001',
  tenantId: NODE,
  portfolioId: '20000000-0000-4000-8000-000000000002',
  currency: 'USD',
  exponent: 2,
  amountMinor: 12_000,
  reference: 'WIRE-77',
  depositedOn: '2026-10-09',
  notes: 'Transferencia desde Bancolombia',
  status: 'pending',
  reportedByName: 'Ana',
  reportedAt: '2026-10-08T15:00:00.000Z',
  resolvedByName: null,
  resolvedAt: null,
  resolutionReason: null,
  tenant: {
    id: NODE,
    name: 'Agencia Sur',
    slug: 'agencia-sur',
    tenantType: 'agency',
    isBranch: true,
    status: 'active',
  },
  financier: {
    id: '10000000-0000-4000-8000-0000000000f1',
    name: 'Planetour',
    tenantType: 'platform',
  },
  financedByPlatform: true,
}) as QueuedDepositReport;

const noop = () => undefined;

describe('DepositApprovalsPanel en su primer pintado', () => {
  const html = renderToStaticMarkup(createElement(DepositApprovalsPanel));

  it('título, filtros con nombre y la cola anunciando que carga', () => {
    expect(html).toContain('<h1');
    expect(html).toContain('Carteras de la red');
    expect(html).toContain('esperan tu aprobación');
    expect(html).toContain('Estado de los depósitos');
    expect(html).toContain('De quién es el dinero');
    expect(html).toContain('aria-label="Buscar por agencia o referencia"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Cargando los depósitos…');
  });

  it('arranca en los pendientes que financia Planetour', () => {
    const checked = [...html.matchAll(/<input[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => tag.includes('checked=""'))
      .map((tag) => /value="([^"]*)"/.exec(tag)?.[1]);
    expect(checked).toEqual(['pending', 'platform']);
  });

  it('va en tú', () => {
    expect([...html.replace(/<[^>]+>/g, ' ').matchAll(VOSEO)]).toEqual([]);
  });

  it('acotada a un nodo (?nodo=): lo dice, ofrece volver a toda la red y mira todo lo del nodo', () => {
    const scoped = renderToStaticMarkup(
      createElement(DepositApprovalsPanel, {
        initialFilters: { ...DEFAULT_APPROVALS_FILTERS, financedBy: 'all', tenantId: NODE },
      }),
    );
    expect(scoped).toContain('Ves sólo los depósitos de un nodo y su red.');
    expect(scoped).toContain('Ver toda la red');
    const checked = [...scoped.matchAll(/<input[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => tag.includes('checked=""'))
      .map((tag) => /value="([^"]*)"/.exec(tag)?.[1]);
    expect(checked).toEqual(['pending', 'all']);
  });
});

describe('ReportRow', () => {
  const now = Date.parse('2026-10-11T15:00:00.000Z');

  it('un pendiente: monto, referencia, agencia con enlace a sus carteras, financiador y espera', () => {
    const html = renderToStaticMarkup(
      createElement(ReportRow, { report: REPORT, now, onApprove: noop, onReject: noop }),
    );
    expect(html).toMatch(/US\$\s?120/);
    expect(html).toContain('WIRE-77');
    expect(html).toContain(`href="/admin/tenants/${NODE}/carteras"`);
    expect(html).toContain('(abrir sus carteras)');
    expect(html).toContain('Sucursal');
    expect(html).toContain('Lo financia Planetour');
    expect(html).toContain('Nota de la agencia: </span>Transferencia desde Bancolombia');
    // Tres días esperando: se resalta.
    expect(html).toContain('Informado hace 3 días');
    // Cada botón dice qué depósito resuelve.
    expect(html).toContain(
      'Aprobar<span class="sr-only"> el depósito WIRE-77 de Agencia Sur</span>',
    );
    expect(html).toContain(
      'Rechazar<span class="sr-only"> el depósito WIRE-77 de Agencia Sur</span>',
    );
  });

  it('uno que financia otro nodo: se ve pero no se resuelve aquí, y dice quién lo aprueba', () => {
    const html = renderToStaticMarkup(
      createElement(ReportRow, {
        report: {
          ...REPORT,
          financier: {
            id: '10000000-0000-4000-8000-0000000000c1',
            name: 'Consolidador Andino',
            tenantType: 'consolidator',
          },
          financedByPlatform: false,
        },
        now,
        onApprove: noop,
        onReject: noop,
      }),
    );
    expect(html).not.toContain('Aprobar');
    expect(html).not.toContain('Rechazar');
    expect(html).toContain('Lo aprueba Consolidador Andino');
    expect(html).toContain('Informado hace 3 días');
  });

  it('uno resuelto: sin botones, con quién y por qué', () => {
    const html = renderToStaticMarkup(
      createElement(ReportRow, {
        report: {
          ...REPORT,
          status: 'rejected',
          resolvedByName: 'Luis',
          resolvedAt: '2026-10-10T12:00:00.000Z',
          resolutionReason: 'No aparece en el extracto',
        },
        now,
        onApprove: noop,
        onReject: noop,
      }),
    );
    expect(html).not.toContain('Aprobar');
    expect(html).toContain('Rechazado por Luis el');
    expect(html).toContain('Motivo del rechazo: </span>No aparece en el extracto');
  });
});
