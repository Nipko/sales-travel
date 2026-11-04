import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GovernanceProfile, GovernedProvider } from '../../../../../../lib/governance';
import { GovernanceRulesEditor } from '../../../_components/governance-rules';
import { EffectiveLine } from '../../../tenants/[tenantId]/_components/tenant-governance-card';
import { GovernanceProfileSelect } from '../../../tenants/_components/governance-profile-field';
import { ProfileEditorDialog } from './profile-editor-dialog';

/*
 * El gobierno en su primer pintado: el editor de perfiles, las reglas a mano, la línea efectiva de
 * un nodo y el selector del alta.
 */

const PERFIL = '20000000-0000-4000-8000-000000000001';
const NODO = '10000000-0000-4000-8000-000000000002';

const CATALOG: GovernedProvider[] = [
  {
    code: 'latam-ndc',
    label: 'LATAM NDC',
    vertical: 'flights',
    paymentMethods: [
      {
        code: 'payment_link',
        use: 'order-payment-link',
        label: 'Enlace de pago LATAM',
        description: 'LATAM le envía al pagador un enlace.',
        pci: 'saq-a',
      },
      {
        code: 'card',
        use: 'order-pay',
        label: 'Tarjeta digitada en la plataforma',
        description: 'El número y el CVV pasan por nuestro servidor.',
        pci: 'out-of-scope',
      },
    ],
  },
  { code: 'tbo-hotels', label: 'TBO hoteles', vertical: 'hotels', paymentMethods: [] },
];

function profile(over: Partial<GovernanceProfile> = {}): GovernanceProfile {
  return {
    id: PERFIL,
    name: 'Agencia Colombia estándar',
    description: null,
    isDefaultForNewNodes: false,
    archived: false,
    items: [],
    tenantCount: 0,
    updatedAt: '2026-11-04T12:00:00.000Z',
    ...over,
  };
}

function editor(p?: GovernanceProfile): string {
  return renderToStaticMarkup(
    createElement(ProfileEditorDialog, {
      catalog: CATALOG,
      profile: p,
      onSaved: () => undefined,
      onClose: () => undefined,
    }),
  );
}

describe('ProfileEditorDialog', () => {
  it('agrupa por vertical y da tres posiciones por celda, con «No decide»', () => {
    const html = editor();
    expect(html).toContain('Nuevo perfil');
    expect(html).toContain('Vuelos');
    expect(html).toContain('Hoteles');
    expect(html).not.toContain('Autos');
    // 4 celdas (LATAM, 2 formas de pago, TBO) × 3 posiciones.
    expect([...html.matchAll(/type="radio"/g)]).toHaveLength(12);
    expect(html).toContain('No decide');
    // Un perfil nuevo no decide nada.
    expect([...html.matchAll(/checked="" value="inherit"/g)]).toHaveLength(4);
  });

  it('la tarjeta digitada avisa que saca a la plataforma de SAQ-A', () => {
    const html = editor();
    expect(html).toContain('Fuera de SAQ-A');
    expect(html).toContain('La tarjeta pasa por nuestro servidor: fuera de PCI SAQ-A.');
    expect(html).toContain('PCI SAQ-A');
  });

  it('un proveedor sin formas de pago lo dice', () => {
    expect(editor()).toContain('Sin formas de pago elegibles: se gobierna sólo el proveedor.');
  });

  it('editar un perfil enlazado avisa a cuántos nodos cambia', () => {
    const html = editor(profile({ tenantCount: 3 }));
    expect(html).toContain('Editar «Agencia Colombia estándar»');
    expect(html).toContain('Cambia a 3 nodos que usan este perfil');
  });

  it('con el proveedor apagado, sus formas de pago se atenúan y se explica por qué', () => {
    const html = editor(
      profile({
        items: [
          { provider: 'latam-ndc', method: '', enabled: false },
          { provider: 'latam-ndc', method: 'card', enabled: true },
        ],
      }),
    );
    expect(html).toContain('Con el proveedor apagado, sus formas de pago no habilitan nada.');
    expect(html).toContain('opacity-60');
    expect([...html.matchAll(/checked="" value="disabled"/g)]).toHaveLength(1);
    expect([...html.matchAll(/checked="" value="enabled"/g)]).toHaveLength(1);
  });
});

describe('GovernanceRulesEditor', () => {
  it('en un nodo, la posición sin regla es «Hereda» y muestra el motivo guardado', () => {
    const html = renderToStaticMarkup(
      createElement(GovernanceRulesEditor, {
        catalog: CATALOG,
        rules: [
          {
            provider: 'tbo-hotels',
            method: '',
            tenantId: NODO,
            enabled: true,
            reason: 'Contrato firmado',
            updatedAt: '2026-11-04T12:00:00.000Z',
          },
        ],
        tenantId: NODO,
        tenantName: 'Agencia Sur',
        unsetLabel: 'Hereda',
        onSaved: () => undefined,
      }),
    );
    expect(html).toContain('Hereda');
    expect(html).toContain('Contrato firmado');
    expect(html).toContain('TBO hoteles en Agencia Sur');
  });
});

describe('EffectiveLine', () => {
  it('dice el estado y de dónde sale', () => {
    const html = renderToStaticMarkup(
      createElement(EffectiveLine, {
        cell: {
          provider: 'latam-ndc',
          method: '',
          enabled: true,
          origin: {
            kind: 'profile',
            tenantId: '10000000-0000-4000-8000-000000000001',
            profileId: PERFIL,
            profileName: 'Solo vuelos',
          },
          originTenantName: 'Consolidador Norte',
        },
        tenantId: NODO,
      }),
    );
    expect(html).toContain('Encendido');
    expect(html).toContain('Perfil «Solo vuelos» en Consolidador Norte');
  });

  it('el apagado por falta de decisión no se confunde con una regla', () => {
    const html = renderToStaticMarkup(
      createElement(EffectiveLine, {
        cell: {
          provider: 'latam-ndc',
          method: 'card',
          enabled: false,
          origin: { kind: 'default' },
          originTenantName: null,
        },
      }),
    );
    expect(html).toContain('Apagado: nadie lo habilitó');
  });
});

describe('GovernanceProfileSelect (alta de nodo)', () => {
  it('ofrece heredar y los perfiles vigentes, marcando el predeterminado', () => {
    const html = renderToStaticMarkup(
      createElement(GovernanceProfileSelect, {
        profiles: {
          ok: true,
          data: [
            profile({ isDefaultForNewNodes: true }),
            profile({ id: 'archivado', name: 'Viejo', archived: true }),
          ],
        },
        value: PERFIL,
        onChange: () => undefined,
      }),
    );
    expect(html).toContain('Heredar del padre');
    expect(html).toContain('Agencia Colombia estándar (predeterminado)');
    expect(html).not.toContain('Viejo');
    expect(html).toContain('Es el perfil predeterminado para nodos nuevos.');
  });

  it('si los perfiles no cargan, queda en heredar y lo dice', () => {
    const html = renderToStaticMarkup(
      createElement(GovernanceProfileSelect, {
        profiles: { ok: false, message: 'No pudimos conectar.' },
        value: '',
        onChange: () => undefined,
      }),
    );
    expect(html).toContain('No pudimos cargar los perfiles (No pudimos conectar.)');
    expect(html).toMatch(/<select[^>]*disabled=""/);
  });
});
