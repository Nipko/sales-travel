import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PlatformStatus } from '../../../../../../lib/platform-status';
import { PlatformStatusBoard } from './platform-status-board';

const STATUS: PlatformStatus = {
  generatedAt: '2026-11-19T15:00:00.000Z',
  overall: 'critical',
  areas: [
    {
      id: 'catalogs',
      label: 'Catálogos de hoteles',
      level: 'ok',
      summary: 'Al día.',
      details: [],
      href: '/admin/plataforma/sistema',
    },
    {
      id: 'providers',
      label: 'Proveedores',
      level: 'critical',
      summary: '1 proveedor caído: tbo-hotels (hotels).',
      details: ['tbo-hotels (hotels): caído.'],
      href: '/admin/plataforma/salud',
    },
  ],
  runtime: {
    version: 'ccbf4027294181b6856996d7fce58ce5ef1ed1dd',
    startedAt: '2026-11-19T14:27:00.000Z',
  },
  pendings: [
    {
      id: 'sabre-h07',
      title: 'Sabre H-07',
      since: '2026-11-05',
      daysOpen: 14,
      level: 'critical',
      why: 'Rodeo temporal.',
      steps: [{ owner: 'founder', text: 'Pedir a Sabre la activación.' }],
      links: [{ label: 'Hallazgos', href: 'https://github.com/x/y/blob/main/docs/a.md' }],
    },
  ],
};

describe('PlatformStatusBoard: Plataforma → Estado', () => {
  const html = renderToStaticMarkup(createElement(PlatformStatusBoard, { status: STATUS }));

  it('arriba el veredicto como alerta, y lo roto antes que lo que está bien', () => {
    expect(html).toContain('role="alert"');
    expect(html).toContain('Hay algo roto o urgente');
    expect(html.indexOf('Proveedores')).toBeLessThan(html.indexOf('Catálogos de hoteles'));
    expect(html).toContain('href="/admin/plataforma/salud"');
  });

  it('los pendientes con su antigüedad, quién hace qué y el enlace al doc en otra pestaña', () => {
    expect(html).toContain('hace 14 días');
    expect(html).toContain('Pedir a Sabre la activación.');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  it('la versión desplegada, corta', () => {
    expect(html).toContain('ccbf402');
    expect(html).not.toContain('ccbf4027294181b6');
  });
});
