import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NodeUsersLink } from './node-users-link';

const NODE = '20000000-0000-4000-8000-000000000002';

function link(userCount: number, name = 'Consolidador Andino'): string {
  return renderToStaticMarkup(
    createElement(NodeUsersLink, { node: { id: NODE, name, userCount } }),
  );
}

describe('NodeUsersLink — los usuarios de un nodo en Gestión de Agencias', () => {
  it('el conteo lleva a Equipo abierto en ese nodo', () => {
    const html = link(3);
    expect(html).toMatch(/^<a /);
    expect(html).toContain(`href="/admin/usuarios?tenant=${NODE}"`);
    expect(html).toContain('>3 usuarios</a>');
  });

  it('el nombre accesible dice a dónde va y contiene el texto visible', () => {
    expect(link(3)).toContain('aria-label="Ver 3 usuarios de Consolidador Andino"');
    expect(link(1)).toContain('aria-label="Ver 1 usuario de Consolidador Andino"');
    expect(link(1)).toContain('>1 usuario</a>');
  });

  it('sin usuarios también enlaza: es cuando hace falta invitar', () => {
    expect(link(0)).toContain(`href="/admin/usuarios?tenant=${NODE}"`);
    expect(link(0)).toContain('>0 usuarios</a>');
  });

  it('el nombre del nodo va escapado', () => {
    expect(link(2, 'Viajes "Sol" & Mar')).toContain(
      'aria-label="Ver 2 usuarios de Viajes &quot;Sol&quot; &amp; Mar"',
    );
  });
});
