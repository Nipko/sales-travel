import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/*
 * Primer pintado de Mi cuenta → Perfil (USR-18): el campo del nombre con su etiqueta y su ayuda, el
 * correo sólo para leer con cómo se cambia, el botón, y el aviso si `GET /me` no respondió. La
 * acción está en `actions.test.ts`; las reglas del nombre, en `lib/person-name.test.ts`.
 */

vi.mock('./actions', () => ({ updateNameAction: vi.fn(() => Promise.resolve({})) }));

import { voseoIn } from '../../../../lib/voseo';
import { ProfileScreen } from './_components/profile-form';
import { parseProfile, PROFILE_COPY, savedNameFrom } from './profile-model';

function render(profile: Parameters<typeof ProfileScreen>[0]['profile']): string {
  return renderToStaticMarkup(createElement(ProfileScreen, { profile }));
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LAURA = { name: 'Laura Gómez', email: 'laura@agencia.com' };

describe('Perfil: primer pintado', () => {
  it('título, el nombre en un campo con etiqueta y el correo para leer', () => {
    const html = render(LAURA);
    expect(html).toContain('<h1');
    expect(textOf(html)).toContain(PROFILE_COPY.title);

    const input = html.match(/<input[^>]*>/g) ?? [];
    expect(input).toHaveLength(1);
    expect(input[0]).toContain('name="name"');
    expect(input[0]).toContain('value="Laura Gómez"');
    expect(input[0]).toContain('autoComplete="name"');
    expect(input[0]).toContain('aria-required="true"');
    expect(input[0]).toContain('aria-invalid="false"');

    // La etiqueta apunta al campo y la ayuda lo describe.
    const id = /id="([^"]+)"/.exec(input[0]!)?.[1];
    expect(html).toContain(`<label for="${id}"`);
    expect(textOf(html)).toContain(PROFILE_COPY.nameLabel);
    const describedBy = /aria-describedby="([^"]+)"/.exec(input[0]!)?.[1];
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toMatch(new RegExp(`id="${describedBy}"[^>]*>${PROFILE_COPY.nameHint}<`));

    // El correo no es un campo: se lee, y se dice cómo cambiarlo.
    expect(textOf(html)).toContain(`${PROFILE_COPY.emailLabel} laura@agencia.com`);
    expect(textOf(html)).toContain(PROFILE_COPY.emailNote);
    expect(html).not.toContain('type="email"');
  });

  it('un solo botón, Guardar, que envía el formulario', () => {
    const buttons = render(LAURA).match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('type="submit"');
    expect(textOf(buttons[0]!)).toBe(PROFILE_COPY.save);
  });

  it('el nombre se pinta como texto: un nombre con HTML no inyecta nada', () => {
    const html = render({ name: '<img src=x onerror=alert(1)>', email: 'a@b.co' });
    expect(html).not.toContain('<img');
    expect(html).toContain('value="&lt;img src=x onerror=alert(1)&gt;"');
  });

  it('una cuenta sin nombre: el campo vacío para completarlo', () => {
    const html = render({ name: '', email: 'laura@agencia.com' });
    expect(html).toContain('value=""');
  });

  it('sin GET /me: lo dice, sin formulario', () => {
    const html = render(null);
    expect(html).not.toContain('<form');
    expect(html).toContain('role="alert"');
    expect(textOf(html)).toContain(PROFILE_COPY.loadError);
  });

  it('todo en tú', () => {
    const errores = Object.values(PROFILE_COPY).join(' ');
    expect(voseoIn([render(LAURA), render(null), errores].join(' '))).toEqual([]);
  });
});

describe('profile-model', () => {
  it('lee GET /me: correo obligatorio, nombre vacío si no tiene', () => {
    expect(parseProfile({ id: 'u', email: 'a@b.co', name: 'Ana', emailVerified: true })).toEqual({
      email: 'a@b.co',
      name: 'Ana',
    });
    expect(parseProfile({ email: 'a@b.co', name: null })).toEqual({ email: 'a@b.co', name: '' });
    expect(parseProfile({ name: 'Ana' })).toBeNull();
    expect(parseProfile(null)).toBeNull();
    expect(parseProfile([])).toBeNull();
  });

  it('lee el nombre guardado de PATCH /me', () => {
    expect(savedNameFrom({ name: 'Ana' })).toBe('Ana');
    expect(savedNameFrom({ name: '' })).toBeNull();
    expect(savedNameFrom({})).toBeNull();
    expect(savedNameFrom('Ana')).toBeNull();
  });
});
