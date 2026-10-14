import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  emptyDraft,
  type AdminAnnouncement,
  type AnnouncementStatus,
} from '../../../../../../../lib/announcements';
import { voseoIn } from '../../../../../../../lib/voseo';
import { SystemConsole } from '../../_components/system-console';
import { AnnouncementFormFields, AnnouncementFormSheet } from './announcement-form-sheet';
import { AnnouncementsContent, type AnnouncementsViewState } from './announcements-panel';

/*
 * Sistema › Anuncios en el primer pintado: la lista con su estado, lo que se puede hacer con cada
 * uno, el formulario con su vista previa y que todo vaya en tú. Sin DOM: se mira el HTML.
 */

const NOW = new Date('2026-10-13T17:00:00.000Z');
const NODO = '44444444-4444-4444-8444-444444444444';

function anuncio(n: number, status: AnnouncementStatus, extra: Partial<AdminAnnouncement> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    severity: 'warning',
    title: `Anuncio ${n}`,
    body: '',
    startsAt: '2026-10-17T07:00:00.000Z',
    endsAt: '2026-10-17T09:00:00.000Z',
    audience: { rootTenantId: null, rootTenantName: null, adminsOnly: false },
    status,
    archivedAt: status === 'archived' ? '2026-10-13T16:00:00.000Z' : null,
    ...extra,
  } satisfies AdminAnnouncement;
}

const LISTA: AdminAnnouncement[] = [
  anuncio(1, 'scheduled'),
  anuncio(2, 'active', {
    severity: 'critical',
    audience: { rootTenantId: NODO, rootTenantName: 'Consolidador Norte', adminsOnly: true },
  }),
  anuncio(3, 'expired', { severity: 'info' }),
  anuncio(4, 'archived'),
];

function content(view: AnnouncementsViewState): string {
  return renderToStaticMarkup(
    createElement(AnnouncementsContent, {
      view,
      onNew: () => undefined,
      onEdit: () => undefined,
      onArchive: () => undefined,
      onReload: () => undefined,
      archivingId: null,
    }),
  );
}

/** El texto visible (y el de lectores de pantalla), sin etiquetas. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
}

describe('la lista', () => {
  const html = content({ status: 'ready', announcements: LISTA });
  const text = textOf(html);

  it('cada uno con su estado escrito', () => {
    for (const chip of ['Programado', 'Vigente', 'Vencido', 'Archivado']) {
      expect(text).toContain(chip);
    }
  });

  it('a quién va y cuándo, en hora de Bogotá', () => {
    expect(text).toContain('Toda la red');
    expect(text).toContain('Consolidador Norte y su red · Solo administradores');
    expect(text).toContain('Del 17 oct, 02:00 al 17 oct, 04:00 (hora Bogotá)');
  });

  it('Editar y Archivar en los que no están archivados, con el título en el nombre del botón', () => {
    expect(html.match(/aria-label="Editar: /g)?.length).toBe(3);
    expect(html.match(/aria-label="Archivar: /g)?.length).toBe(3);
    expect(html).toContain('aria-label="Archivar: Anuncio 1"');
    expect(html).not.toContain('aria-label="Archivar: Anuncio 4"');
    expect(html).not.toContain('aria-label="Editar: Anuncio 4"');
  });

  it('el botón para publicar', () => {
    expect(text).toContain('Nuevo anuncio');
  });

  it('cargando, error y vacío', () => {
    expect(content({ status: 'loading' })).toContain('aria-busy="true"');
    const error = content({ status: 'error', message: 'No pudimos conectar con el servidor.' });
    expect(error).toContain('role="alert"');
    expect(textOf(error)).toContain('Reintentar');
    expect(textOf(content({ status: 'ready', announcements: [] }))).toContain(
      'Todavía no hay anuncios',
    );
  });

  it('va en tú', () => {
    expect(voseoIn(text)).toEqual([]);
  });
});

describe('el formulario', () => {
  const sheet = renderToStaticMarkup(
    createElement(AnnouncementFormSheet, {
      nodes: {
        status: 'ready',
        options: [{ id: NODO, label: 'Consolidador Norte · Consolidador' }],
      },
      onClose: () => undefined,
      onSaved: () => undefined,
    }),
  );
  const text = textOf(sheet);

  it('un diálogo con todos los campos, la vista previa y Publicar', () => {
    expect(sheet).toContain('role="dialog"');
    for (const label of [
      'Nuevo anuncio',
      'Gravedad',
      'Información',
      'Advertencia',
      'Crítico',
      'Título',
      'Mensaje',
      'Para',
      'Toda la red',
      'Un nodo y su red',
      'Solo administradores',
      'Desde',
      'Hasta',
      'Vista previa',
      'Publicar',
    ]) {
      expect(text, label).toContain(label);
    }
    expect(sheet).toContain(
      'placeholder="TBO en mantenimiento el sábado de 02:00 a 04:00 (hora Bogotá)"',
    );
    expect(sheet).toContain('type="datetime-local"');
  });

  it('va en tú', () => {
    expect(voseoIn(text)).toEqual([]);
  });

  it('corregir dice Guardar cambios', () => {
    const edit = renderToStaticMarkup(
      createElement(AnnouncementFormSheet, {
        announcement: LISTA[1]!,
        nodes: { status: 'error' },
        onClose: () => undefined,
        onSaved: () => undefined,
      }),
    );
    expect(textOf(edit)).toContain('Editar anuncio');
    expect(textOf(edit)).toContain('Guardar cambios');
    // La red no llegó: el nodo del anuncio sigue elegido, con su nombre.
    expect(edit).toMatch(
      /<option value="44444444-4444-4444-8444-444444444444"[^>]*>Consolidador Norte</,
    );
  });

  it('la vista previa es texto: un <b> del título sale escapado; con el nodo, el selector', () => {
    const fields = renderToStaticMarkup(
      createElement(AnnouncementFormFields, {
        draft: {
          ...emptyDraft(NOW),
          title: '<b>Hola</b>',
          scope: 'node',
          severity: 'critical',
        },
        onChange: () => undefined,
        errors: { rootTenantId: 'Elige el nodo que recibe el anuncio.' },
        showErrors: true,
        nodes: { status: 'loading' },
        disabled: false,
      }),
    );
    expect(fields).toContain('&lt;b&gt;Hola&lt;/b&gt;');
    expect(fields).not.toContain('<b>');
    expect(textOf(fields)).toContain('Cargando la red…');
    expect(textOf(fields)).toContain('Elige el nodo que recibe el anuncio.');
    expect(textOf(fields)).toContain('No se puede ocultar mientras esté vigente.');
  });
});

describe('Sistema con sus secciones', () => {
  it('Anuncios marcada como la actual, Procesos como enlace', () => {
    const html = renderToStaticMarkup(
      createElement(SystemConsole, { current: 'anuncios', children: null }),
    );
    expect(html).toContain('aria-label="Secciones de Sistema"');
    expect(html).toMatch(
      /<a aria-current="page"[^>]*href="\/admin\/plataforma\/sistema\/anuncios"/,
    );
    expect(html).toMatch(/<a class="[^"]*" href="\/admin\/plataforma\/sistema">/);
    expect(textOf(html)).toContain('Los avisos que ve la red dentro del panel');
    expect(voseoIn(textOf(html))).toEqual([]);
  });
});
