import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ChangeDialog,
  ChoiceControl,
  DecisionTrail,
  EnablementStatus,
  Switch,
} from './provider-enablement-ui';

/*
 * Las piezas del panel de habilitación en su primer pintado: lo que anuncia un lector de pantalla
 * y lo que queda marcado. El estado no puede depender sólo del color.
 */

const noop = () => undefined;

describe('ChoiceControl', () => {
  it('es un grupo de radios con leyenda y marca lo guardado', () => {
    const html = renderToStaticMarkup(
      createElement(ChoiceControl, {
        legend: 'TBO Holidays para Agencia Norte',
        value: 'disabled',
        onChange: noop,
      }),
    );
    expect(html).toContain('<legend class="sr-only">TBO Holidays para Agencia Norte</legend>');
    expect([...html.matchAll(/type="radio"/g)]).toHaveLength(3);
    expect(html).toMatch(/checked="" value="disabled"/);
    expect(html).toContain('Heredar');
    expect(html).toContain('Habilitado');
    expect(html).toContain('Deshabilitado');
  });

  it('sin ajuste propio queda en Heredar', () => {
    const html = renderToStaticMarkup(
      createElement(ChoiceControl, { legend: 'x', value: 'inherit', onChange: noop }),
    );
    expect(html).toMatch(/checked="" value="inherit"/);
  });
});

describe('Switch', () => {
  it('se anuncia como interruptor con su estado', () => {
    const html = renderToStaticMarkup(
      createElement(Switch, {
        checked: true,
        onToggle: noop,
        label: 'TBO Holidays para todos los tenants',
      }),
    );
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="TBO Holidays para todos los tenants"');
  });
});

describe('DecisionTrail', () => {
  it('marca la capa que decide, también para el lector de pantalla', () => {
    const html = renderToStaticMarkup(createElement(DecisionTrail, { origin: 'global' }));
    expect([...html.matchAll(/aria-current="step"/g)]).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"[^>]*><span class="sr-only">Decide: <\/span>Global/);
  });

  it('sin origen es la leyenda del orden, sin ninguna capa marcada', () => {
    const html = renderToStaticMarkup(createElement(DecisionTrail, {}));
    expect(html).toContain('aria-label="Orden de decisión"');
    expect(html).not.toContain('aria-current');
  });
});

describe('EnablementStatus', () => {
  it('dice el estado en texto', () => {
    expect(
      renderToStaticMarkup(
        createElement(EnablementStatus, { effective: { enabled: true, origin: 'global' } }),
      ),
    ).toContain('Habilitado');
    expect(
      renderToStaticMarkup(
        createElement(EnablementStatus, { effective: { enabled: false, origin: 'tenant' } }),
      ),
    ).toContain('Deshabilitado');
  });

  it('el kill-switch se nombra como apagado de emergencia, no como un ajuste más', () => {
    expect(
      renderToStaticMarkup(
        createElement(EnablementStatus, { effective: { enabled: false, origin: 'kill-switch' } }),
      ),
    ).toContain('Apagado de emergencia');
  });
});

describe('ChangeDialog', () => {
  const base = {
    title: '¿Deshabilitar TBO Holidays para Agencia Norte?',
    description: 'Las reservas ya hechas no se tocan.',
    confirmLabel: 'Deshabilitar',
    destructive: true,
  };

  it('pide motivo al fijar un ajuste, con el motivo guardado ya cargado', () => {
    const html = renderToStaticMarkup(
      createElement(ChangeDialog, {
        dialog: { ...base, withReason: true },
        initialReason: 'Deuda vencida',
        onConfirm: () => Promise.resolve(undefined),
        onClose: noop,
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('<textarea');
    expect(html).toContain('Deuda vencida');
    expect(html).toContain('Deshabilitar');
  });

  it('el lector de pantalla lee al abrir lo que se corta, no sólo el título', () => {
    const html = renderToStaticMarkup(
      createElement(ChangeDialog, {
        dialog: { ...base, withReason: true },
        initialReason: '',
        onConfirm: () => Promise.resolve(undefined),
        onClose: noop,
      }),
    );
    const describedBy = /role="dialog"[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeDefined();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toMatch(
      new RegExp(`id="${describedBy}"[^>]*>Las reservas ya hechas no se tocan.`),
    );
  });

  it('volver a heredar no pide motivo: el DELETE no lleva cuerpo', () => {
    const html = renderToStaticMarkup(
      createElement(ChangeDialog, {
        dialog: { ...base, confirmLabel: 'Heredar', destructive: false, withReason: false },
        initialReason: '',
        onConfirm: () => Promise.resolve(undefined),
        onClose: noop,
      }),
    );
    expect(html).not.toContain('<textarea');
  });
});
