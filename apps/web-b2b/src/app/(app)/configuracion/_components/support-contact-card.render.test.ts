import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SupportContactCard } from './support-contact-card';
import type { SupportContactFields } from './support-contact';

/*
 * Mi Agencia → Marca: el contacto de soporte que el checkout de hoteles pide completar («Ir a Mi
 * Agencia»). Cada campo con su rótulo, y el aviso del teléfono sólo cuando así no se puede reservar.
 */

function html(value: SupportContactFields): string {
  return renderToStaticMarkup(
    createElement(SupportContactCard, { value, onChange: () => undefined }),
  );
}

describe('SupportContactCard — el contacto de soporte de la agencia', () => {
  it('cada campo tiene su rótulo asociado y el valor guardado', () => {
    const out = html({
      supportEmail: 'reservas@agencia.example',
      supportPhone: '+57 300 123 4567',
    });
    for (const label of ['Email de soporte', 'Teléfono de soporte']) {
      const match = new RegExp(`<label for="([^"]+)"[^>]*>${label}</label>`).exec(out);
      expect(match).not.toBeNull();
      expect(out).toContain(`id="${match?.[1] ?? ''}"`);
    }
    expect(out).toContain('type="email"');
    expect(out).toContain('type="tel"');
    expect(out).toContain('value="reservas@agencia.example"');
    expect(out).toContain('value="+57 300 123 4567"');
    expect(out).toContain('se usan los de tu consolidador');
    expect(out).not.toContain('Así no se pueden reservar hoteles');
  });

  it('un teléfono sin + avisa que así no se reservan hoteles, y el campo lo anuncia', () => {
    const out = html({ supportEmail: null, supportPhone: '300 123 4567' });
    expect(out).toContain(
      'Así no se pueden reservar hoteles: escríbelo con + y el código de país.',
    );
    const describedBy = /type="tel"[^>]*aria-describedby="([^"]+)"/.exec(out)?.[1] ?? '';
    expect(describedBy.split(' ')).toHaveLength(2);
  });

  it('vacíos se heredan: no hay aviso', () => {
    const out = html({ supportEmail: null, supportPhone: null });
    expect(out).toContain('value=""');
    expect(out).not.toContain('Así no se pueden reservar hoteles');
  });
});
