import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TodayItem } from '../../lib/agency-today';
import { TodayPanel } from './today-panel';

const ITEMS: TodayItem[] = [
  {
    id: 'deadline-24h',
    tone: 'danger',
    title: '1 reserva vence en menos de 24 h sin emitir',
    detail: 'La primera es la #8.',
    href: '/reservas/abc',
    cta: 'Abrir la reserva #8',
  },
  {
    id: 'provider-tbo',
    tone: 'danger',
    title: 'TBO · Hoteles: falla del proveedor',
    detail: 'No responde.',
    href: null,
    cta: '',
  },
];

const render = (items: TodayItem[], unavailable = false) =>
  renderToStaticMarkup(createElement(TodayPanel, { items, unavailable }));

describe('TodayPanel: Inicio → Hoy', () => {
  it('lista lo que hay que atender, con enlace sólo donde se puede resolver', () => {
    const html = render(ITEMS);
    expect(html).toContain('2 cosas por atender');
    expect(html).toContain('href="/reservas/abc"');
    expect(html).toContain('Abrir la reserva #8');
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it('sin nada que atender lo dice, en vez de un bloque vacío', () => {
    expect(render([])).toContain('Nada pendiente');
  });

  it('si no se pudieron leer las reservas, avisa y no dice «nada pendiente»', () => {
    const html = render([], true);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('Nada pendiente');
  });
});
