import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { seesAdministration } from '../../../../lib/nav';
import { voseoIn } from '../../../../lib/voseo';
import { TEAM_CARD_TEXT, TeamCard } from './team-card';

/*
 * La pestaña Equipo de Mi Agencia ya no promete un módulo "disponible próximamente" en usted: lleva
 * a Equipo, y sólo la ve quien administra la agencia activa.
 */

describe('TeamCard', () => {
  const html = renderToStaticMarkup(createElement(TeamCard));

  it('dice dónde se gestiona el equipo y lleva a Equipo', () => {
    expect(html).toContain(TEAM_CARD_TEXT);
    expect(html).toMatch(/<a[^>]*href="\/admin\/usuarios"[^>]*>Ir a Equipo/);
  });

  it('sin el texto viejo ni voseo', () => {
    expect(html).not.toMatch(/Gestione|Habilite|próximamente/);
    expect(voseoIn(html)).toEqual([]);
  });

  it('el ícono no se anuncia', () => {
    expect(html.match(/<svg[^>]*>/g)?.every((svg) => svg.includes('aria-hidden="true"'))).toBe(
      true,
    );
  });
});

describe('seesAdministration: quién ve la pestaña Equipo', () => {
  it.each(['superadmin', 'consolidator_admin', 'tenant_admin', 'agency_admin', 'admin'])(
    '%s sí',
    (role) => {
      expect(seesAdministration(role)).toBe(true);
    },
  );

  it.each(['vendedor', 'agent', '', undefined])('%s no', (role) => {
    expect(seesAdministration(role)).toBe(false);
  });
});
