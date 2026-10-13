import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProviderHealth } from '../../../../../../lib/provider-health';
import { KillSwitchDialog, ReasonConfirmDialog } from './kill-switch-dialog';
import { ProviderHealthRow } from './provider-health';

/*
 * El apagado de emergencia y la salud de un proveedor en su primer pintado: qué dice el diálogo,
 * qué queda elegido y que el botón de apagar no actúa hasta escribir el código.
 */

const noop = () => undefined;

function dialog(code = 'tbo-hotels'): string {
  return renderToStaticMarkup(
    createElement(KillSwitchDialog, {
      code,
      onConfirm: () => Promise.resolve(undefined),
      onClose: noop,
    }),
  );
}

/** El texto visible, sin etiquetas: las frases se cortan entre elementos. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('KillSwitchDialog', () => {
  it('nombra el proveedor y dice qué corta, sin desplegar', () => {
    const t = text(dialog());
    expect(t).toContain('Apagado de emergencia de TBO Holidays');
    expect(t).toContain(
      'Corta el proveedor para toda la plataforma, por encima de cualquier ajuste por agencia. No hace falta desplegar.',
    );
  });

  it('ofrece sólo ventas o todo, con sólo ventas elegido', () => {
    const html = dialog();
    const t = text(html);
    expect(t).toContain(
      'Solo ventas: se frenan búsquedas, pre-reservas y reservas nuevas; lo ya vendido se sigue consultando y cancelando.',
    );
    expect(t).toContain('Todo: también la post-venta (consultas, cancelaciones y conciliación).');
    const radios = [...html.matchAll(/<input type="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios).toHaveLength(6);
    expect(radios[0]).toContain('checked=""');
    expect(radios[1]).not.toContain('checked=""');
  });

  it('al reemplazar un apagado de todo, arranca en todo: no lo baja sin querer', () => {
    const html = renderToStaticMarkup(
      createElement(KillSwitchDialog, {
        code: 'tbo-hotels',
        initialLevel: 'all',
        onConfirm: () => Promise.resolve(undefined),
        onClose: noop,
      }),
    );
    const radios = [...html.matchAll(/<input type="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios.slice(0, 2).map((r) => r.includes('checked=""'))).toEqual([false, true]);
  });

  it('en vuelos avisa que "Todo" no frena la post-venta; en hoteles, no', () => {
    const conVertical = (code: string, vertical: 'flights' | 'hotels') =>
      text(
        renderToStaticMarkup(
          createElement(KillSwitchDialog, {
            code,
            vertical,
            onConfirm: () => Promise.resolve(undefined),
            onClose: noop,
          }),
        ),
      );
    expect(conVertical('latam-ndc', 'flights')).toContain(
      'En vuelos, la post-venta (consultar, cancelar o pagar una orden) no pasa por este apagado: Todo frena lo mismo que Solo ventas.',
    );
    expect(conVertical('tbo-hotels', 'hotels')).not.toContain('En vuelos');
    expect(text(dialog())).not.toContain('En vuelos');
  });

  it('pide el vencimiento, con 4 horas elegido', () => {
    const html = dialog();
    const t = text(html);
    expect(t).toContain('Vence');
    for (const label of ['En 1 hora', 'En 4 horas', 'En 24 horas', 'Sin vencimiento']) {
      expect(t).toContain(label);
    }
    const radios = [...html.matchAll(/<input type="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios.slice(2).map((r) => r.includes('checked=""'))).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it('el motivo es obligatorio y se pide escribir el código', () => {
    const html = dialog();
    expect(text(html)).toContain('Motivo');
    expect(html).toMatch(/<textarea[^>]*aria-required="true"/);
    expect(text(html)).toContain('Escribe tbo-hotels para confirmar');
    const input = /<input[^>]*name="confirmCode"[^>]*>/.exec(html)?.[0];
    expect(input).toContain('placeholder="tbo-hotels"');
  });

  it('"Apagar" queda aria-disabled hasta que el código coincide', () => {
    const html = dialog();
    expect(html).toMatch(
      /<button[^>]*type="submit"[^>]*aria-disabled="true"[^>]*>Apagar TBO Holidays</,
    );
    // El aviso de código mal escrito sólo aparece tras intentar apagar, no al abrir.
    expect(text(html)).not.toContain('tal cual para poder apagarlo');
  });
});

describe('ReasonConfirmDialog', () => {
  it('cerrar el circuito: la advertencia y el motivo obligatorio', () => {
    const html = renderToStaticMarkup(
      createElement(ReasonConfirmDialog, {
        title: '¿Cerrar el circuito de Sabre GDS?',
        description:
          'El proveedor vuelve a recibir llamadas de inmediato. Si sigue fallando, el circuito se abre otra vez.',
        confirmLabel: 'Cerrar circuito',
        pendingLabel: 'Cerrando…',
        reasonRequired: true,
        onConfirm: () => Promise.resolve(undefined),
        onClose: noop,
      }),
    );
    const t = text(html);
    expect(t).toContain('El proveedor vuelve a recibir llamadas de inmediato.');
    expect(html).toMatch(/<textarea[^>]*aria-required="true"/);
    expect(t).toContain('Cerrar circuito');
  });

  it('reanudar: motivo opcional', () => {
    const html = renderToStaticMarkup(
      createElement(ReasonConfirmDialog, {
        title: '¿Reanudar TBO Holidays?',
        description: 'Levanta el apagado.',
        confirmLabel: 'Reanudar proveedor',
        pendingLabel: 'Reanudando…',
        reasonRequired: false,
        onConfirm: () => Promise.resolve(undefined),
        onClose: noop,
      }),
    );
    expect(text(html)).toContain('Motivo (opcional)');
    expect(html).not.toMatch(/<textarea[^>]*aria-required="true"/);
  });
});

function salud(over: Partial<ProviderHealth> = {}): ProviderHealth {
  return {
    code: 'tbo-hotels',
    vertical: 'hotels',
    circuit: { state: 'closed', failures: 0, openedAt: null, lastFailureAt: null },
    suspendedAccounts: 0,
    killSwitch: { effective: null, env: null, panel: null },
    accountIssues24h: 0,
    ...over,
  };
}

function row(health: ProviderHealth | undefined): string {
  return text(
    renderToStaticMarkup(
      createElement(ProviderHealthRow, {
        code: 'tbo-hotels',
        health,
        onKill: noop,
        onResume: noop,
        onReset: noop,
      }),
    ),
  );
}

describe('ProviderHealthRow', () => {
  it.each([
    [{ state: 'closed', failures: 0 }, 'Funcionando'],
    [{ state: 'closed', failures: 2 }, 'Con fallos (2)'],
    [{ state: 'open', failures: 5 }, 'No responde: circuito abierto'],
    [{ state: 'half-open', failures: 5 }, 'Probando si volvió'],
  ] as const)('%j se lee "%s"', (circuit, label) => {
    expect(row(salud({ circuit: { ...circuit, openedAt: null, lastFailureAt: null } }))).toContain(
      label,
    );
  });

  it('"Cerrar circuito" sólo con el circuito abierto', () => {
    const abierto = salud({
      circuit: {
        state: 'open',
        failures: 5,
        openedAt: '2026-10-13T12:00:00Z',
        lastFailureAt: null,
      },
    });
    expect(row(abierto)).toContain('Cerrar circuito');
    // Una tarjeta por proveedor: el nombre accesible dice de cuál es el botón.
    expect(
      renderToStaticMarkup(
        createElement(ProviderHealthRow, {
          code: 'tbo-hotels',
          health: abierto,
          onKill: noop,
          onResume: noop,
          onReset: noop,
        }),
      ),
    ).toContain('aria-label="Cerrar circuito de TBO Holidays"');
    expect(row(salud())).not.toContain('Cerrar circuito');
    expect(
      row(
        salud({
          circuit: { state: 'half-open', failures: 5, openedAt: null, lastFailureAt: null },
        }),
      ),
    ).not.toContain('Cerrar circuito');
  });

  it('cuentas en pausa y avisos de cuenta, sólo si hay', () => {
    const t = row(salud({ suspendedAccounts: 2, accountIssues24h: 3 }));
    expect(t).toContain('Cuentas en pausa: 2');
    expect(t).toContain('Avisos de cuenta en 24 h: 3');
    expect(row(salud())).not.toContain('Cuentas en pausa');
  });

  it('apagado desde el panel: el motivo y "Reanudar proveedor"', () => {
    const t = row(
      salud({
        killSwitch: {
          effective: 'all',
          env: null,
          panel: {
            level: 'all',
            reason: 'Responde basura',
            setBy: '99999999-9999-4999-8999-999999999999',
            setByEmail: 'root@plataforma.co',
            setAt: '2026-10-13T12:00:00Z',
            expiresAt: null,
          },
        },
      }),
    );
    expect(t).toContain('Apagado desde el panel (todo) · sin vencimiento · por root@plataforma.co');
    expect(t).toContain('Motivo: Responde basura');
    expect(t).toContain('Reanudar proveedor');
    expect(
      renderToStaticMarkup(
        createElement(ProviderHealthRow, {
          code: 'tbo-hotels',
          health: salud({
            killSwitch: {
              effective: 'sales',
              env: null,
              panel: {
                level: 'sales',
                reason: 'Responde basura',
                setBy: '99999999-9999-4999-8999-999999999999',
                setByEmail: null,
                setAt: '2026-10-13T12:00:00Z',
                expiresAt: null,
              },
            },
          }),
          onKill: noop,
          onResume: noop,
          onReset: noop,
        }),
      ),
    ).toContain('aria-label="Reanudar proveedor TBO Holidays"');
  });

  it('apagado sólo por la variable: aviso de sólo lectura, sin "Reanudar"', () => {
    const t = row(salud({ killSwitch: { effective: 'sales', env: 'sales', panel: null } }));
    expect(t).toContain(
      'Apagado por la variable PROVIDERS_DISABLED. Se quita desplegando (ver el runbook).',
    );
    expect(t).not.toContain('Reanudar proveedor');
  });

  it('sin salud todavía, las palancas siguen a mano', () => {
    const t = row(undefined);
    expect(t).toContain('Sin datos todavía');
    expect(t).toContain('Apagado de emergencia');
  });
});
