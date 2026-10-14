import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ActiveAnnouncement } from '../../lib/announcements';
import { voseoIn } from '../../lib/voseo';
import {
  AnnouncementBanner,
  AnnouncementBannerItem,
  AnnouncementBannerList,
} from './announcement-banner';

/*
 * La franja de anuncios en el primer pintado: texto y no HTML, la gravedad escrita, la X sólo donde
 * se puede ocultar y nada cuando no hay avisos. Sin DOM: se mira el HTML.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

function render(items: ActiveAnnouncement[]): string {
  return renderToStaticMarkup(
    createElement(AnnouncementBannerList, { items, onDismiss: () => undefined }),
  );
}

describe('AnnouncementBannerList', () => {
  it('se pinta como texto, no como HTML: un <b> del título sale escapado', () => {
    const html = render([
      {
        id: A,
        severity: 'info',
        title: '<b>TBO</b> en <script>alert(1)</script>mantenimiento',
        body: '<a href="https://evil.test">entra aquí</a> https://evil.test',
      },
    ]);
    expect(html).toContain('&lt;b&gt;TBO&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<a ');
    // El `href` del mensaje sale como texto escapado (`href=&quot;`), nunca como atributo.
    expect(html).not.toContain('href="');
  });

  it('el mensaje conserva sus saltos de línea', () => {
    const html = render([{ id: A, severity: 'info', title: 'Hola', body: 'Uno\nDos' }]);
    expect(html).toContain('whitespace-pre-line');
    expect(html).toContain('Uno\nDos');
  });

  it('cada gravedad con su etiqueta escrita; lo crítico no se puede ocultar', () => {
    const html = render([
      { id: A, severity: 'critical', title: 'Caída de Sabre', body: '' },
      { id: B, severity: 'warning', title: 'Cambio de política', body: '' },
      { id: C, severity: 'info', title: 'Mantenimiento', body: '' },
    ]);
    expect(html).toContain('>Crítico<');
    expect(html).toContain('>Importante<');
    expect(html).toContain('>Aviso<');
    expect(html.match(/aria-label="Ocultar aviso"/g)?.length).toBe(2);
    const critical = renderToStaticMarkup(
      createElement(AnnouncementBannerItem, {
        announcement: { id: A, severity: 'critical', title: 'Caída', body: '' },
        onDismiss: () => undefined,
      }),
    );
    expect(critical).not.toContain('Ocultar aviso');
  });

  it('una región con nombre; sin avisos, nada', () => {
    const html = render([{ id: A, severity: 'info', title: 'Hola', body: '' }]);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Avisos de la plataforma"');
    expect(render([])).toBe('');
  });

  it('sin onDismiss (la vista previa) no hay X', () => {
    const html = renderToStaticMarkup(
      createElement(AnnouncementBannerItem, {
        announcement: { id: A, severity: 'info', title: 'Hola', body: '' },
      }),
    );
    expect(html).not.toContain('Ocultar aviso');
  });

  it('va en tú', () => {
    const html = render([{ id: A, severity: 'info', title: 'Hola', body: '' }]);
    expect(voseoIn(html.replace(/<[^>]+>/g, ' '))).toEqual([]);
  });
});

describe('AnnouncementBanner', () => {
  it('el primer pintado (antes de preguntar) no pinta avisos: sólo la región viva, vacía', () => {
    // La región viva tiene que estar antes que el texto: un lector de pantalla no anuncia una que
    // llega junto con su contenido.
    expect(renderToStaticMarkup(createElement(AnnouncementBanner))).toBe(
      '<div aria-live="polite" class="shrink-0"></div>',
    );
  });

  it('nunca inyecta HTML', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./announcement-banner.tsx', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('dangerouslySetInnerHTML');
  });
});
