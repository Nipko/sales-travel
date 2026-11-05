import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  emptyBillingDraft,
  type BillingDraft,
  type BillingPassenger,
} from '../../../../lib/billing';
import { BillingSection, type BillingSectionProps } from './billing-section';
import { customerSearchStatus } from './customer-search-combobox';

const noop = () => undefined;

const PAX1: BillingPassenger = {
  givenName: 'Ana',
  surname: 'Ruiz Toro',
  identityDoc: { type: 'CC', number: '1020304050', issuingCountryCode: 'CO' },
};

function render(over: Partial<BillingSectionProps> & { draft?: BillingDraft } = {}): string {
  return renderToStaticMarkup(
    createElement(BillingSection, {
      draft: emptyBillingDraft(),
      onChange: noop,
      passenger1: PAX1,
      missing: [],
      showErrors: false,
      notes: '',
      onNotesChange: noop,
      onSave: noop,
      saving: false,
      saveInfo: null,
      saveError: null,
      ...over,
    }),
  );
}

describe('BillingSection', () => {
  it('por defecto factura al pasajero 1, con su nombre y documento a la vista', () => {
    const html = render();
    expect(html).toContain('Facturación');
    expect(html).toMatch(/<legend[^>]*>Facturar a<\/legend>/);
    expect(html).toMatch(
      /<input[^>]*type="radio"[^>]*checked=""[^>]*>.*Pasajero 1 \(Ana Ruiz Toro\)/,
    );
    expect(html).toContain('Ana Ruiz Toro · CC 1020304050');
    // No pide de nuevo nombre ni documento, ni ofrece buscar: salen del pasajero.
    expect(html).not.toContain('id="billing-name"');
    expect(html).not.toContain('Buscar cliente registrado');
    for (const campo of [
      'billing-email',
      'billing-phone',
      'billing-address',
      'billing-city',
      'billing-country',
      'notes',
    ]) {
      expect(html, campo).toMatch(new RegExp(`<label[^>]*for="${campo}"`));
    }
    // El país, si no se escribe, es el del documento del pasajero.
    expect(html).toMatch(/id="billing-country"[^>]*placeholder="CO"/);
  });

  it('con otra persona o empresa: buscar, tipo, nombre o razón social y documento fiscal', () => {
    const html = render({
      draft: {
        ...emptyBillingDraft(),
        mode: 'other',
        customerType: 'company',
        documentType: 'NIT',
      },
    });
    expect(html).toContain('Buscar cliente registrado (persona o empresa)');
    expect(html).toMatch(/<input[^>]*role="combobox"/);
    expect(html).toMatch(/<label[^>]*for="billing-name"[^>]*>Razón social/);
    for (const doc of ['CC', 'CE', 'NIT', 'PASAPORTE']) {
      expect(html).toContain(`<option value="${doc}"`);
    }
    expect(html).toMatch(/<option value="NIT" selected="">NIT<\/option>/);
  });

  it('marca lo que falta sólo después de intentarlo', () => {
    const draft: BillingDraft = { ...emptyBillingDraft(), mode: 'other' };
    expect(render({ draft, missing: ['name', 'email'] })).not.toContain('aria-invalid');
    const html = render({ draft, missing: ['name', 'email'], showErrors: true });
    expect(html).toMatch(/id="billing-name"[^>]*aria-invalid="true"/);
    expect(html).toMatch(/id="billing-email"[^>]*aria-invalid="true"/);
    expect(html).not.toMatch(/id="billing-phone"[^>]*aria-invalid/);
  });

  it('un cliente elegido del CRM se ve como tal y se puede desvincular', () => {
    const html = render({
      draft: {
        ...emptyBillingDraft(),
        mode: 'other',
        customerId: '3f1c2b4a-1d2e-4f5a-8b6c-7d8e9f0a1b2c',
      },
    });
    expect(html).toContain('Cliente registrado');
    expect(html).toMatch(/<button[^>]*>.*Desvincular<\/button>/);
  });
});

describe('customerSearchStatus', () => {
  it('anuncia buscando, resultados, nada y error', () => {
    expect(customerSearchStatus({ kind: 'idle' }, '')).toBe('');
    expect(customerSearchStatus({ kind: 'loading' }, 'an')).toBe('Buscando…');
    expect(customerSearchStatus({ kind: 'done', results: [] }, ' ana ')).toBe(
      'Sin clientes registrados para «ana».',
    );
    expect(customerSearchStatus({ kind: 'error' }, 'ana')).toContain('Inténtalo de nuevo');
  });
});
