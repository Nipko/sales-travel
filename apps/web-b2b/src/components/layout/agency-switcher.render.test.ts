import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgencyOption } from '../../lib/agencies';
import { AgencyTrigger, AgencySwitcherProvider, SwitcherDialog } from './agency-switcher';

// Las server actions importan `next/headers`: acá sólo interesa lo que se pinta.
vi.mock('./agency-switcher-actions', () => ({
  switchAgencyAction: vi.fn(),
  releaseSeatForSwitchAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));

/*
 * El primer pintado del selector de agencia: la semántica de diálogo y de lista que lee un lector
 * de pantalla, qué se puede elegir y por qué no. La lógica está en lib/agencies y lib/tenant-switch.
 */

function option(overrides: Partial<AgencyOption> & { tenantId: string }): AgencyOption {
  return {
    name: `Agencia ${overrides.tenantId}`,
    slug: overrides.tenantId,
    role: 'vendedor',
    logoUrl: null,
    current: false,
    disabledReason: null,
    ...overrides,
  };
}

const noop = () => undefined;

function renderAgencies(agencies: AgencyOption[], extra: { error?: string | null } = {}) {
  return renderToStaticMarkup(
    createElement(SwitcherDialog, {
      dialog: { page: 'agencies', from: null },
      agencies,
      current: agencies.find((a) => a.current),
      canSwitch: true,
      pendingId: null,
      error: extra.error ?? null,
      onClose: noop,
      onNavigate: noop,
      onPage: noop,
      onChoose: noop,
      onSwitched: noop,
      onSeatsRetry: noop,
    }),
  );
}

const THREE = [
  option({ tenantId: 'a', name: 'Viajes Andinos', current: true, role: 'admin' }),
  option({ tenantId: 'b', name: 'Turismo Bogotá' }),
  option({ tenantId: 'c', name: 'Cerrada', disabledReason: 'Agencia suspendida' }),
];

describe('selector de agencia: diálogo', () => {
  it('es un diálogo modal con título "Cambiar de agencia" y dice con cuál opera', () => {
    const html = renderAgencies(THREE);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    const labelledBy = /role="dialog"[^>]*aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`<h2 id="${labelledBy}"`);
    expect(html).toContain('Cambiar de agencia');
    expect(html).toMatch(/Operas como <span[^>]*>Viajes Andinos<\/span> · Manager/);
  });

  it('una opción por agencia, en una lista enlazada al título', () => {
    const html = renderAgencies(THREE);
    expect(html.match(/role="option"/g)).toHaveLength(3);
    expect(html).toMatch(/role="listbox"[^>]*aria-labelledby=/);
  });

  it('la suspendida se puede recorrer pero no elegir, y dice por qué', () => {
    const html = renderAgencies(THREE);
    const disabled = html.match(/<li[^>]*aria-disabled="true"[^>]*>/g) ?? [];
    expect(disabled).toHaveLength(1);
    expect(html).toContain('Agencia suspendida');
  });

  it('la actual lleva la marca "Actual"; la activa de entrada es la primera que se puede elegir', () => {
    const html = renderAgencies(THREE);
    expect(html).toContain('Actual');
    const options = html.match(/<li[^>]*role="option"[^>]*>/g) ?? [];
    expect(options[1]).toContain('aria-selected="true"');
    expect(options[0]).toContain('aria-selected="false"');
  });

  it('con menos de 5 agencias no hay buscador: el foco va a la lista', () => {
    const html = renderAgencies(THREE);
    expect(html).not.toContain('role="combobox"');
    expect(html).toMatch(/role="listbox"[^>]*tabindex="0"/);
  });

  it('con 5 o más, buscador (combobox) que controla la lista y anuncia la opción activa', () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      option({ tenantId: id, current: id === 'a' }),
    );
    const html = renderAgencies(many);
    const input = /<input[^>]*role="combobox"[^>]*>/.exec(html)?.[0] ?? '';
    expect(input).toContain('aria-label="Buscar agencia"');
    const listId = /aria-controls="([^"]+)"/.exec(input)?.[1];
    expect(html).toContain(`id="${listId}"`);
    expect(input).toMatch(/aria-activedescendant="[^"]+"/);
  });

  it('un error se muestra en una región de alerta', () => {
    const html = renderAgencies(THREE, { error: 'Esa agencia está suspendida.' });
    expect(html).toMatch(/role="alert"[^>]*>.*Esa agencia está suspendida\./);
  });
});

describe('selector de agencia: disparador del topbar', () => {
  function trigger(agencies: AgencyOption[]) {
    return renderToStaticMarkup(
      createElement(AgencySwitcherProvider, {
        agencies,
        children: createElement(AgencyTrigger, {
          tenantName: 'Viajes Andinos',
          tenantSlug: 'andinos',
        }),
      }),
    );
  }

  it('con varias agencias es un botón que abre el diálogo y dice qué hace', () => {
    const html = trigger(THREE);
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"/);
    expect(html).toContain('aria-label="Agencia activa: Viajes Andinos. Cambiar de agencia"');
  });

  it('con una sola, sólo la muestra: no hay botón', () => {
    const html = trigger([option({ tenantId: 'a', current: true })]);
    expect(html).not.toContain('<button');
    expect(html).toContain('Viajes Andinos');
  });
});
