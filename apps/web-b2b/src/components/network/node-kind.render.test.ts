import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NodeKindBadge, NodeKindPicker } from './node-kind';

const noop = () => undefined;

describe('NodeKindBadge', () => {
  it('la sucursal se lee "Sucursal", escrito y no sólo con color', () => {
    const html = renderToStaticMarkup(
      createElement(NodeKindBadge, { node: { tenantType: 'agency', isBranch: true } }),
    );
    expect(html).toContain('>Sucursal<');
  });

  it('cada tipo con su nombre', () => {
    const label = (tenantType: string) =>
      renderToStaticMarkup(createElement(NodeKindBadge, { node: { tenantType } }));
    expect(label('platform')).toContain('>Plataforma<');
    expect(label('consolidator')).toContain('>Consolidador<');
    expect(label('agency')).toContain('>Agencia<');
    expect(label('subagency')).toContain('>Sub-agencia<');
    expect(label('otro')).toContain('>Nodo<');
  });
});

describe('NodeKindPicker', () => {
  it('con varias opciones es un grupo de radios con leyenda y marca la elegida', () => {
    const html = renderToStaticMarkup(
      createElement(NodeKindPicker, {
        kinds: ['agency', 'branch', 'consolidator'],
        value: 'branch',
        onChange: noop,
      }),
    );
    expect(html).toContain('<legend');
    expect([...html.matchAll(/type="radio"/g)]).toHaveLength(3);
    expect(html).toMatch(/checked="" value="branch"/);
    expect(html).toContain('Sucursal');
    expect(html).toContain('Consolidador');
  });

  it('con una sola opción dice cuál va a ser, sin selector', () => {
    const html = renderToStaticMarkup(
      createElement(NodeKindPicker, { kinds: ['subagency'], value: 'subagency', onChange: noop }),
    );
    expect(html).not.toContain('type="radio"');
    expect(html).toContain('Sub-agencia');
  });
});
