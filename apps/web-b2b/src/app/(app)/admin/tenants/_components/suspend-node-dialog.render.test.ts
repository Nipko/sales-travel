import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { NodeImpact } from '../../../../../lib/platform-node-stats';
import { voseoIn } from '../../../../../lib/voseo';
import { NodeStatsColumns, NodeStatsLine, PendingDepositsBadge, type RowStats } from './node-stats';
import { NodeStatusDialog, SuspendNodeDialog, type ImpactState } from './suspend-node-dialog';

/*
 * Agencias: suspender o reactivar un nodo con motivo, viendo antes a quién afecta, y los números de
 * cada fila (puestos, ventas, última reserva, depósitos por aprobar). Se prueba lo que se pinta; las
 * reglas y los textos, en lib/platform-node-stats.
 */

const NODE = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Agencia Norte' };
const NOW = Date.parse('2026-10-13T15:00:00.000Z');
const noop = () => undefined;

const IMPACT: NodeImpact = {
  tenant: { ...NODE, tenantType: 'agency', isBranch: false, status: 'active' },
  descendants: 2,
  activeUsers: 7,
  liveSessions: 3,
  openOrders: 4,
  held: [{ currency: 'COP', exponent: 2, amountMinor: 150_000 }],
  pendingDepositReports: 2,
  pendingInvitations: 0,
};

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
}

function dialog(
  impact: ImpactState,
  mode: 'suspend' | 'reactivate' = 'suspend',
  ancestor?: string,
) {
  return renderToStaticMarkup(
    createElement(NodeStatusDialog, {
      node: NODE,
      mode,
      suspendedAncestorName: ancestor ?? null,
      impact,
      onRetryImpact: noop,
      onClose: noop,
      onDone: noop,
    }),
  );
}

/** El botón que contiene `label`. */
function button(html: string, label: string): string | undefined {
  return [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)]
    .map((m) => m[0])
    .find((b) => text(b).includes(label));
}

function opening(html: string, tag: string): string | undefined {
  return html.match(new RegExp(`<${tag}[^>]*>`))?.[0];
}

describe('suspender: el impacto antes de confirmar', () => {
  it('dice qué se corta con números, en tú, y es un diálogo con nombre y descripción', () => {
    const html = dialog({ kind: 'ready', impact: IMPACT });
    const plain = text(html);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-describedby=');
    expect(plain).toContain('Suspender Agencia Norte');
    expect(plain).toContain(
      'Se corta de inmediato el acceso a Agencia Norte y a los 2 nodos que cuelgan de él: 7 personas dejan de poder operar y sus 3 sesiones abiertas dejan de funcionar. Las 4 reservas vigentes no se cancelan, pero nadie del nodo podrá gestionarlas mientras siga suspendido.',
    );
    expect(plain).toMatch(/Saldo retenido: .*1\.500/);
    expect(plain).toContain('Depósitos por aprobar: 2.');
    expect(voseoIn(plain)).toEqual([]);
  });

  it('el motivo es obligatorio y queda en la auditoría', () => {
    const html = dialog({ kind: 'ready', impact: IMPACT });
    expect(text(html)).toContain('Motivo (queda en la auditoría)');
    const area = opening(html, 'textarea');
    expect(area).toContain('aria-required="true"');
    expect(area).toContain('name="reason"');
    expect(area).toContain('maxLength="500"');
  });

  it('el botón de confirmar es el de peligro y nombra el nodo', () => {
    const submit = button(dialog({ kind: 'ready', impact: IMPACT }), 'Suspender Agencia Norte');
    expect(submit).toBeDefined();
    expect(submit).toContain('type="submit"');
    expect(submit).not.toContain('disabled=""');
    expect(submit).toMatch(/color-danger/);
  });

  it('mientras se calcula el impacto, lo dice y no deja confirmar', () => {
    const html = dialog({ kind: 'loading' });
    expect(text(html)).toContain('Calculando a quién afecta…');
    expect(html).toContain('role="status"');
    expect(button(html, 'Suspender Agencia Norte')).toContain('disabled=""');
  });

  it('si el impacto falla, el diálogo sigue sin números y se puede suspender igual', () => {
    const html = dialog({ kind: 'error' });
    const plain = text(html);
    expect(plain).toContain('No pudimos calcular el impacto.');
    expect(plain).toMatch(/Se corta de inmediato el acceso a Agencia Norte y a los nodos/);
    expect(plain).not.toMatch(/\d+ personas/);
    expect(button(html, 'Volver a calcular')).toBeDefined();
    expect(button(html, 'Suspender Agencia Norte')).not.toContain('disabled=""');
    expect(voseoIn(plain)).toEqual([]);
  });

  it('el diálogo que carga el impacto arranca calculándolo', () => {
    const html = renderToStaticMarkup(
      createElement(SuspendNodeDialog, {
        node: NODE,
        mode: 'suspend',
        suspendedAncestorName: null,
        onClose: noop,
        onDone: noop,
      }),
    );
    expect(text(html)).toContain('Calculando a quién afecta…');
  });
});

describe('reactivar', () => {
  it('dice quién vuelve; el motivo es opcional y el botón no es de peligro', () => {
    const html = dialog({ kind: 'skipped' }, 'reactivate');
    const plain = text(html);
    expect(plain).toContain('Reactivar Agencia Norte');
    expect(plain).toContain(
      'Vuelven a poder ingresar las personas con acceso activo a Agencia Norte y a su red.',
    );
    expect(plain).toContain('Motivo (opcional)');
    expect(opening(html, 'textarea')).not.toContain('aria-required');
    const submit = button(html, 'Reactivar');
    expect(submit).toBeDefined();
    expect(submit).not.toMatch(/color-danger/);
    expect(plain).not.toContain('Calculando');
    expect(voseoIn(plain)).toEqual([]);
  });

  it('con un ancestro suspendido, lo advierte', () => {
    expect(text(dialog({ kind: 'skipped' }, 'reactivate', 'Consolidador Andes'))).toContain(
      'mientras Consolidador Andes siga suspendido',
    );
  });
});

function stats(extra: Partial<Extract<RowStats, { status: 'ready' }>['node']> = {}): RowStats {
  return {
    status: 'ready',
    at: NOW,
    node: {
      tenantId: NODE.id,
      seatLimit: 5,
      seatsUsed: 3,
      liveSessions: 3,
      activeUsers: 4,
      orders30d: 12,
      sales30d: 9,
      lastOrderAt: '2026-10-10T15:00:00.000Z',
      openOrders: 1,
      pendingDepositReports: 0,
      pendingInvitations: 0,
      held: [],
      ...extra,
    },
  };
}

describe('la fila de la red: puestos, ventas y depósitos', () => {
  it('las columnas: puestos, ventas de 30 días (las confirmadas, no las órdenes) y última reserva', () => {
    const plain = text(renderToStaticMarkup(createElement(NodeStatsColumns, { stats: stats() })));
    expect(plain).toContain('Puestos');
    expect(plain).toContain('3/5');
    expect(plain).toContain('3 de 5 puestos en uso');
    expect(plain).toContain('Ventas 30 d 9');
    expect(plain).not.toContain('Ventas 30 d 12');
    expect(plain).toContain('Última reserva hace 3 días');
  });

  it('al 90 % o más, los puestos van en ámbar y dicen "al límite" (no sólo el color)', () => {
    const full = renderToStaticMarkup(
      createElement(NodeStatsColumns, { stats: stats({ seatsUsed: 5 }) }),
    );
    expect(full).toContain('data-tone="warning"');
    expect(full).toMatch(/color-warning/);
    expect(text(full)).toContain('5/5 al límite');
    const calm = renderToStaticMarkup(createElement(NodeStatsColumns, { stats: stats() }));
    expect(calm).toContain('data-tone="neutral"');
    expect(calm).not.toMatch(/color-warning/);
  });

  it('sin cupo propio, "—" con su explicación; sin reservas, "Nunca"', () => {
    const plain = text(
      renderToStaticMarkup(
        createElement(NodeStatsLine, {
          stats: stats({
            seatLimit: null,
            seatsUsed: null,
            orders30d: 0,
            sales30d: 0,
            lastOrderAt: null,
          }),
        }),
      ),
    );
    expect(plain).toContain('Comparte el cupo de su red');
    expect(plain).toContain('Ventas 30 d 0');
    expect(plain).toContain('Última reserva Nunca');
  });

  it('cargando, las columnas guardan su lugar; sin números, la línea del teléfono no se pinta', () => {
    const loading = renderToStaticMarkup(
      createElement(NodeStatsColumns, { stats: { status: 'loading' } }),
    );
    expect(loading).toContain('aria-busy="true"');
    expect(renderToStaticMarkup(createElement(NodeStatsLine, { stats: { status: 'error' } }))).toBe(
      '',
    );
    expect(
      renderToStaticMarkup(
        createElement(NodeStatsLine, { stats: { status: 'ready', node: undefined, at: NOW } }),
      ),
    ).toBe('');
  });

  it('los depósitos por aprobar enlazan a Carteras acotada al nodo', () => {
    const html = renderToStaticMarkup(
      createElement(PendingDepositsBadge, {
        stats: stats({ pendingDepositReports: 2 }),
        nodeName: NODE.name,
      }),
    );
    expect(html).toContain(`href="/admin/plataforma/carteras?nodo=${NODE.id}"`);
    expect(text(html)).toContain('2 depósitos por aprobar de Agencia Norte');
    expect(
      renderToStaticMarkup(
        createElement(PendingDepositsBadge, { stats: stats(), nodeName: NODE.name }),
      ),
    ).toBe('');
  });
});
