import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INVITATION_FILTERS,
  parsePlatformInvitation,
  type InvitationFilters,
  type PlatformInvitation,
} from '../../../../../../lib/platform-invitations';
import { voseoIn } from '../../../../../../lib/voseo';
import {
  InvitationFiltersBar,
  InvitationResults,
  type InvitationAction,
  type InvitationsListState,
  type NodeOptions,
} from './platform-invitations';
import { PlatformUsersPanel } from './platform-users-panel';

/*
 * El primer pintado de Plataforma → Usuarios → Invitaciones: que un error no se vea como vacío, que
 * cada invitación diga su correo, rol, nodo, quién la mandó y cuándo vence (o venció), que una en
 * curso no suelte el foco, y la pestaña dentro de Plataforma → Usuarios. Todo en tú.
 */

const NORTE = '0b6f6a52-7a47-4c8e-9a3b-1a2b3c4d5e6f';
const DAY = 24 * 60 * 60_000;

function invitation(patch: Record<string, unknown> = {}): PlatformInvitation {
  const now = Date.now();
  const parsed = parsePlatformInvitation({
    id: 'inv-1',
    email: 'ana@agencia.co',
    role: 'vendedor',
    tenantId: NORTE,
    tenantName: 'Agencia Norte',
    invitedByEmail: 'root@plataforma.co',
    createdAt: new Date(now - 2 * DAY).toISOString(),
    expiresAt: new Date(now + 5 * DAY + 60_000).toISOString(),
    expired: false,
    ...patch,
  });
  if (parsed === undefined) throw new Error('fixture inválida');
  return parsed;
}

const EXPIRED = invitation({
  id: 'inv-2',
  email: 'beto@agencia.co',
  role: 'tenant_admin',
  tenantName: 'Consolidador Sur',
  invitedByEmail: null,
  createdAt: new Date(Date.now() - 10 * DAY).toISOString(),
  expiresAt: new Date(Date.now() - 3 * DAY).toISOString(),
  expired: true,
});

function results(
  list: InvitationsListState,
  extra: Partial<Parameters<typeof InvitationResults>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(InvitationResults, {
      list,
      filters: DEFAULT_INVITATION_FILTERS,
      busy: new Map<string, InvitationAction>(),
      rowError: null,
      loadingMore: false,
      moreError: '',
      onRetry: () => {},
      onLoadMore: () => {},
      onClearFilters: () => {},
      onDismissError: () => {},
      onResend: () => {},
      onRevoke: () => {},
      ...extra,
    }),
  );
}

function ready(invitations: PlatformInvitation[], nextCursor: string | null = null) {
  return {
    status: 'ready' as const,
    view: { invitations, nextCursor, counts: { pending: 1, expired: 1 } },
  };
}

function filtersBar(
  filters: InvitationFilters,
  nodes: NodeOptions,
  extra: Partial<Parameters<typeof InvitationFiltersBar>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(InvitationFiltersBar, {
      search: filters.q,
      filters,
      counts: { pending: 4, expired: 2 },
      nodes,
      canClear: false,
      onSearch: () => {},
      onState: () => {},
      onTenant: () => {},
      onRetryNodes: () => {},
      onClear: () => {},
      ...extra,
    }),
  );
}

describe('InvitationResults', () => {
  it('cada invitación con su correo, rol, nodo, vencimiento y quién la mandó, y sus dos acciones', () => {
    const html = results(ready([invitation(), EXPIRED]));

    expect(html).toContain('ana@agencia.co');
    expect(html).toContain('Vendedor · Agencia Norte · ');
    expect(html).toContain('Vence en 5 días');
    expect(html).toContain('Invitado por root@plataforma.co · hace 2 días');
    expect(html).toContain('aria-label="Reenviar la invitación a ana@agencia.co"');
    expect(html).toContain('aria-label="Revocar la invitación a ana@agencia.co"');
    expect(html).toContain('2 invitaciones');
    expect(html).not.toContain('Cargar más');
    expect(voseoIn(html)).toEqual([]);
  });

  it('una vencida lleva la marca, dice hace cuánto venció y destaca "Reenviar"', () => {
    const html = results(ready([EXPIRED]));

    expect(html).toContain('>Vencida<');
    expect(html).toContain('Admin · Consolidador Sur · ');
    expect(html).toContain('Venció hace 3 días');
    expect(html).toContain('Invitado por un usuario eliminado · hace 10 días');
    // "Reenviar" es la acción que sirve: va como botón secundario y no fantasma.
    const resend = html.match(/<button[^>]*aria-label="Reenviar la invitación a beto@agencia\.co"/);
    expect(resend?.[0]).toContain('bg-[var(--color-surface)]');
    expect(results(ready([invitation()]))).not.toContain('>Vencida<');
  });

  it('mientras se reenvía, la fila queda en espera con aria-disabled, sin soltar el foco', () => {
    const html = results(ready([invitation(), EXPIRED]), {
      busy: new Map<string, InvitationAction>([['inv-1', 'resend']]),
    });

    expect(html).toContain('Reenviando…');
    expect(html.match(/<button[^>]* aria-disabled="true"/g)).toHaveLength(2);
    expect(html).not.toMatch(/<button[^>]* disabled=""/);

    const revoking = results(ready([invitation()]), {
      busy: new Map<string, InvitationAction>([['inv-1', 'revoke']]),
    });
    expect(revoking).toContain('Revocando…');
  });

  it('el error de una acción va en su fila, con cómo cerrarlo', () => {
    const html = results(ready([invitation(), EXPIRED]), {
      rowError: { invitationId: 'inv-2', message: 'No puedes reenviar esta invitación.' },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('No puedes reenviar esta invitación.');
    expect(html).toContain('aria-label="Cerrar aviso"');
  });

  it('con más páginas, "Cargar más"; mientras carga, en espera y sin soltar el foco', () => {
    expect(results(ready([invitation()], 'cur'))).toContain('Cargar más');
    expect(results(ready([invitation()], 'cur'))).toContain('1 invitación (hay más)');
    const loading = results(ready([invitation()], 'cur'), { loadingMore: true });
    expect(loading).toContain('Cargando…');
    expect(loading).toMatch(/<button[^>]* aria-disabled="true"[^>]*>.*Cargando…/);
    const failed = results(ready([invitation()], null), { moreError: 'No pudimos cargar.' });
    expect(failed).toContain('No pudimos cargar.');
  });

  it('cargando, error y vacía no se confunden', () => {
    const loading = results({ status: 'loading' });
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('Cargando invitaciones…');

    const error = results({
      status: 'error',
      message: 'Esta pantalla es sólo para el superadmin.',
    });
    expect(error).toContain('role="alert"');
    expect(error).toContain('Esta pantalla es sólo para el superadmin.');
    expect(error).toContain('Reintentar');
    expect(error).not.toContain('No hay invitaciones');

    const empty = results(ready([]));
    expect(empty).toContain('No hay invitaciones pendientes.');
    expect(empty).not.toContain('Limpiar filtros');

    const emptyFiltered = results(ready([]), {
      filters: { state: 'pending', q: 'nadie' },
    });
    expect(emptyFiltered).toContain('No encontramos invitaciones con esos filtros.');
    expect(emptyFiltered).toContain('Limpiar filtros');
    expect(voseoIn(loading + error + empty + emptyFiltered)).toEqual([]);
  });

  it('el título de la lista recibe el foco cuando una fila se va', () => {
    expect(results(ready([invitation()]))).toMatch(
      /<h2[^>]*id="platform-invitations-title"[^>]*tabindex="-1"|<h2[^>]*tabindex="-1"[^>]*id="platform-invitations-title"/i,
    );
  });
});

describe('InvitationFiltersBar', () => {
  const nodes: NodeOptions = {
    status: 'ready',
    nodes: [
      {
        id: NORTE,
        slug: 'norte',
        name: 'Agencia Norte',
        tenantType: 'agency',
        isBranch: false,
        parentTenantId: null,
        status: 'active',
        depth: 1,
      },
    ],
  };

  it('búsqueda por correo, nodo con su subárbol y los tres estados con sus números', () => {
    const html = filtersBar(DEFAULT_INVITATION_FILTERS, nodes);

    expect(html).toContain('placeholder="Busca por correo"');
    expect(html).toContain('Incluye todo lo que cuelga de él.');
    expect(html).toContain('>Todos los nodos<');
    expect(html).toContain('Agencia Norte');
    expect(html).toContain('aria-label="Estado"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Pendientes<span[^>]*>\(4\)/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Vencidas<span[^>]*>\(2\)/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Todas<span[^>]*>\(6\)/);
    expect(html).not.toContain('Limpiar filtros');
    expect(voseoIn(html)).toEqual([]);
  });

  it('sin contadores, los estados sin número; con filtros, "Limpiar filtros"', () => {
    const html = filtersBar({ state: 'expired', q: 'ana' }, nodes, {
      counts: null,
      canClear: true,
    });
    expect(html).toMatch(/aria-pressed="true"[^>]*>Vencidas<\/button>/);
    expect(html).not.toMatch(/\(\d+\)/);
    expect(html).toContain('Limpiar filtros');
  });

  it('si la red no cargó, el nodo lo dice y ofrece reintentar', () => {
    const html = filtersBar(DEFAULT_INVITATION_FILTERS, {
      status: 'error',
      message: 'No pudimos cargar los nodos de la red.',
    });
    expect(html).toContain('No pudimos cargar los nodos de la red.');
    expect(html).toContain('aria-label="Volver a cargar los nodos"');
    expect(filtersBar(DEFAULT_INVITATION_FILTERS, { status: 'loading' })).toContain(
      'Cargando la red…',
    );
  });
});

describe('la pestaña en Plataforma → Usuarios', () => {
  it('"Usuarios" e "Invitaciones" como pestañas; las invitaciones no se piden hasta abrirla', () => {
    const html = renderToStaticMarkup(
      createElement(PlatformUsersPanel, { viewerId: null, viewerEmail: 'root@plataforma.co' }),
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Usuarios de la plataforma"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Usuarios</);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>Invitaciones</);
    // El directorio se ve; el panel de invitaciones existe pero está oculto y vacío.
    expect(html).toContain('placeholder="Busca por nombre o correo"');
    expect(html).toMatch(/<div role="tabpanel"[^>]*-panel-invitations"[^>]*hidden=""[^>]*><\/div>/);
    expect(html).not.toContain('Busca por correo"');
    expect(voseoIn(html)).toEqual([]);
  });

  it('las pestañas no muestran barra de desplazamiento: ni la fina global ni una vertical', () => {
    const html = renderToStaticMarkup(createElement(PlatformUsersPanel, { viewerId: null }));
    const tablist = html.match(/<div role="tablist"[^>]*>/)?.[0] ?? '';
    // En línea, porque la regla `*` de globals.css le gana a cualquier utilidad de Tailwind.
    expect(tablist).toContain('style="scrollbar-width:none"');
    expect(tablist).toContain('overflow-y-hidden');
  });
});
