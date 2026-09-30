import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DepositReport, Wallet } from '../../lib/wallets';
import {
  DepositReportDialog,
  EnableWalletDialog,
  EntryDialog,
  RejectReportDialog,
  WalletStatusDialog,
} from './wallet-dialogs';

/*
 * Los formularios en su primer pintado: diálogo con nombre y descripción, campos con etiqueta y
 * obligatorios marcados, y el motivo que queda en la auditoría.
 */

const USD: Wallet = {
  id: '20000000-0000-4000-8000-000000000002',
  tenantId: '10000000-0000-4000-8000-000000000001',
  currency: 'USD',
  exponent: 2,
  creditLimitMinor: 100_000,
  balanceMinor: 20_000,
  availableMinor: 120_000,
  status: 'active',
  updatedAt: '',
};

const REPORT: DepositReport = {
  id: '30000000-0000-4000-8000-000000000001',
  portfolioId: USD.id,
  currency: 'USD',
  exponent: 2,
  amountMinor: 50_000,
  reference: '54223',
  depositedOn: null,
  notes: null,
  status: 'pending',
  reportedByName: 'Ana',
  reportedAt: '2026-09-29T12:00:00.000Z',
  resolvedByName: null,
  resolvedAt: null,
  resolutionReason: null,
};

const noop = () => undefined;
const submit = () => Promise.resolve(undefined);

function labelsOf(html: string): string[] {
  return [...html.matchAll(/<label[^>]*for="[^"]+"[^>]*>([^<]+)/g)].map((m) => m[1]!.trim());
}

describe('diálogos de quien financia', () => {
  it('habilitar: moneda, cupo inicial opcional y motivo obligatorio', () => {
    const html = renderToStaticMarkup(
      createElement(EnableWalletDialog, {
        nodeName: 'Agencia Sur',
        available: ['EUR', 'USD'],
        defaultCurrency: 'USD',
        onSubmit: submit,
        onClose: noop,
      }),
    );
    expect(html).toContain('role="dialog"');
    // El nombre del diálogo es su título visible: aria-labelledby apunta al <h2>.
    const titleId = /role="dialog"[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(titleId).toBeTruthy();
    expect(html).toMatch(new RegExp(`<h2 id="${titleId}"[^>]*>Habilitar una moneda</h2>`));
    expect(labelsOf(html)).toEqual(['Moneda', 'Cupo inicial (USD)', 'Motivo']);
    expect(html).toContain('Habilitar USD');
    expect(html).toContain('Queda en la auditoría');
    expect(html).toMatch(/<optgroup label="Frecuentes"><option value="USD"[^>]*selected/);
    expect(html).toContain('<optgroup label="Otras"><option value="EUR"');
  });

  it('habilitar sin la moneda del nodo disponible: no elige ninguna por el usuario', () => {
    const html = renderToStaticMarkup(
      createElement(EnableWalletDialog, {
        nodeName: 'Agencia Sur',
        available: ['AED', 'EUR'],
        defaultCurrency: 'COP',
        onSubmit: submit,
        onClose: noop,
      }),
    );
    expect(html).toMatch(/<option value="" disabled="" selected="">Elegí la moneda<\/option>/);
    expect(html).not.toMatch(/<option value="AED"[^>]*selected/);
    expect(html).toContain('>Habilitar<');
  });

  it('un depósito se revisa antes de acreditar', () => {
    const html = renderToStaticMarkup(
      createElement(EntryDialog, {
        kind: 'deposit',
        wallet: USD,
        nodeName: 'Agencia Sur',
        onSubmit: submit,
        onClose: noop,
      }),
    );
    expect(html).toContain('Registrar depósito en USD');
    expect(labelsOf(html)).toEqual(['Monto (USD)', 'Motivo']);
    expect(html).toContain('>Revisar<');
    expect(html).not.toContain('Tipo de ajuste');
  });

  it('un ajuste elige si acredita o debita', () => {
    const html = renderToStaticMarkup(
      createElement(EntryDialog, {
        kind: 'adjustment',
        wallet: USD,
        nodeName: 'Agencia Sur',
        onSubmit: submit,
        onClose: noop,
      }),
    );
    expect(html).toContain('<legend');
    expect(html).toContain('Acreditar');
    expect(html).toContain('Debitar');
  });

  it('suspender es destructivo y pide motivo', () => {
    const html = renderToStaticMarkup(
      createElement(WalletStatusDialog, {
        wallet: USD,
        nodeName: 'Agencia Sur',
        to: 'suspended',
        onSubmit: submit,
        onClose: noop,
      }),
    );
    expect(html).toContain('Suspender la cartera USD');
    expect(html).toContain('Suspender cartera');
    expect(labelsOf(html)).toEqual(['Motivo']);
  });

  it('suspender la cartera de quien financia a una red avisa que también frena a su red', () => {
    const html = (financesNetwork: boolean) =>
      renderToStaticMarkup(
        createElement(WalletStatusDialog, {
          wallet: USD,
          nodeName: 'Consolidador Andino',
          financesNetwork,
          to: 'suspended',
          onSubmit: submit,
          onClose: noop,
        }),
      );
    expect(html(true)).toContain(
      'También frena las reservas en USD de la red de Consolidador Andino',
    );
    expect(html(false)).not.toContain('También frena');
  });

  it('habilitar una moneda a quien financia a una red dice que también la habilita para ella', () => {
    const html = renderToStaticMarkup(
      createElement(EnableWalletDialog, {
        nodeName: 'Consolidador Andino',
        financesNetwork: true,
        available: ['EUR', 'USD'],
        defaultCurrency: 'USD',
        onSubmit: submit,
        onClose: noop,
      }),
    );
    expect(html).toContain('También habilita, hasta su disponible, las reservas en esa moneda');
  });

  it('rechazar un informe muestra monto y referencia y pide el motivo', () => {
    const html = renderToStaticMarkup(
      createElement(RejectReportDialog, {
        report: REPORT,
        nodeName: 'Agencia Sur',
        onSubmit: submit,
        onClose: noop,
      }),
    );
    expect(html).toContain('54223');
    expect(labelsOf(html)).toEqual(['Motivo del rechazo']);
  });
});

describe('DepositReportDialog — la agencia informa', () => {
  it('con una sola cartera no pregunta la moneda; referencia obligatoria y fecha no futura', () => {
    const html = renderToStaticMarkup(
      createElement(DepositReportDialog, {
        wallets: [USD],
        financierName: 'Consolidador Andino',
        onSubmit: submit,
        onClose: noop,
      }),
    );
    expect(labelsOf(html)).toEqual([
      'Monto depositado (USD)',
      'Referencia',
      'Fecha del depósito',
      'Nota (opcional)',
    ]);
    expect(html).toMatch(/type="date"[^>]*max="\d{4}-\d{2}-\d{2}"/);
    expect(html).toContain('hasta que Consolidador Andino lo verifique');
  });

  it('con varias carteras, elige en cuál depositó', () => {
    const html = renderToStaticMarkup(
      createElement(DepositReportDialog, {
        wallets: [USD, { ...USD, id: 'x', currency: 'COP' }],
        financierName: null,
        onSubmit: submit,
        onClose: noop,
      }),
    );
    expect(labelsOf(html)[0]).toBe('Cartera');
  });
});
