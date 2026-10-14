import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseMemberDetail } from '../../../../../../lib/member-detail';
import { apiDetail, iso, MIN, NOW } from '../../../../../../lib/member-detail.fixture';
import { parsePlatformUser, type PlatformUser } from '../../../../../../lib/platform-users';
import { voseoIn } from '../../../../../../lib/voseo';
import {
  DirectoryFiltersBar,
  DirectoryResults,
  PlatformSheetMenuItems,
  UserActionItems,
  type DirectoryState,
} from './platform-users-panel';

/*
 * El primer pintado de Plataforma → Usuarios: que un error no se vea como vacío, que cada persona
 * lleve sus nodos como chips con "+N" y sus etiquetas para la tarjeta del teléfono, y que el menú
 * ofrezca lo que corresponde (nunca suspenderse a uno mismo). Todo en tú.
 */

const NORTE = '0b6f6a52-7a47-4c8e-9a3b-1a2b3c4d5e6f';
const ANA = '99999999-8888-4777-8666-555555555555';

function user(patch: Record<string, unknown> = {}): PlatformUser {
  const parsed = parsePlatformUser({
    id: ANA,
    email: 'ana@agencia.co',
    name: 'Ana Pérez',
    status: 'active',
    emailVerified: true,
    mfaEnabled: true,
    lockedUntil: null,
    lastLoginAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastSeenAt: new Date(Date.now() - 60_000).toISOString(),
    activeSessions: 1,
    createdAt: '2026-01-01T00:00:00Z',
    memberships: [
      {
        tenantId: NORTE,
        tenantName: 'Agencia Norte',
        tenantType: 'agency',
        isBranch: false,
        role: 'tenant_admin',
        status: 'active',
      },
      {
        tenantId: 'sur',
        tenantName: 'Agencia Sur',
        tenantType: 'agency',
        isBranch: false,
        role: 'vendedor',
        status: 'suspended',
      },
      {
        tenantId: 'este',
        tenantName: 'Agencia Este',
        tenantType: 'agency',
        isBranch: false,
        role: 'admin',
        status: 'active',
      },
    ],
    ...patch,
  });
  if (parsed === undefined) throw new Error('fixture inválida');
  return parsed;
}

function results(
  state: DirectoryState,
  extra: Partial<Parameters<typeof DirectoryResults>[0]> = {},
): string {
  return renderToStaticMarkup(
    createElement(DirectoryResults, {
      state,
      viewerId: null,
      busyUserId: null,
      rowError: null,
      filtered: false,
      loadingMore: false,
      moreError: '',
      onRetry: () => {},
      onLoadMore: () => {},
      onDismissError: () => {},
      onClearFilters: () => {},
      onSetStatus: () => {},
      ...extra,
    }),
  );
}

function menu(u: PlatformUser, self = false): string {
  return renderToStaticMarkup(
    createElement(
      DropdownMenu.Root,
      { open: true, modal: false },
      createElement(DropdownMenu.Trigger, null, 'Acciones'),
      createElement(
        DropdownMenu.Content,
        null,
        createElement(UserActionItems, {
          user: u,
          self,
          onPick: (run: () => void) => run,
          onSetStatus: () => {},
        }),
      ),
    ),
  );
}

describe('DirectoryResults', () => {
  it('cada persona con sus columnas, sus nodos como chips "Nodo · Rol" y "+N"', () => {
    const html = results({ status: 'ready', users: [user()], nextCursor: null });

    for (const column of ['Usuario', 'Nodos y roles', 'Último acceso', '2FA', 'Estado']) {
      expect(html).toContain(`>${column}<`);
    }
    expect(html).toContain('Ana Pérez');
    expect(html).toContain('ana@agencia.co');
    expect(html).toContain('Agencia Norte · Admin');
    expect(html).toContain('Agencia Sur · Vendedor');
    expect(html).not.toContain('>Agencia Este · Manager<');
    expect(html).toContain('+1');
    expect(html).toContain('y 1 nodo más: Agencia Este · Manager');
    // El acceso suspendido se tacha y se anuncia.
    expect(html).toContain(', acceso suspendido');
    expect(html).toContain('En línea');
    expect(html).toContain('2FA activo');
    expect(html).toContain('>Activo<');
    expect(html).toContain('1 persona');
    expect(html).not.toContain('Cargar más');
    expect(voseoIn(html)).toEqual([]);
  });

  it('estados de la cuenta: suspendida en toda la plataforma, bloqueada, correo sin verificar, sin nodos', () => {
    const html = results({
      status: 'ready',
      users: [
        user({ id: 'a', status: 'suspended', activeSessions: 0 }),
        user({
          id: 'b',
          lockedUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
          emailVerified: false,
        }),
        user({
          id: 'c',
          name: null,
          email: 'beto@agencia.co',
          memberships: [],
          lastLoginAt: null,
          lastSeenAt: null,
          activeSessions: 0,
          mfaEnabled: false,
        }),
      ],
      nextCursor: 'cur',
    });
    expect(html).toContain('Suspendido en toda la plataforma');
    expect(html).toContain('Bloqueado hasta las ');
    expect(html).toContain('Correo sin verificar');
    expect(html).toContain('Sin nodos');
    expect(html).toContain('Nunca ingresó');
    expect(html).toContain('No requerido');
    expect(html).toContain('3 personas (hay más)');
    expect(html).toContain('Cargar más');
    expect(voseoIn(html)).toEqual([]);
  });

  it('el 2FA pendiente se anuncia con su motivo', () => {
    const html = results({
      status: 'ready',
      users: [user({ mfaEnabled: false })],
      nextCursor: null,
    });
    expect(html).toContain('2FA pendiente');
    expect(html).toContain('Su rol lo exige');
  });

  it('las etiquetas de cada dato van en la tarjeta del teléfono y sólo para lectores en escritorio', () => {
    const html = results({ status: 'ready', users: [user()], nextCursor: null });
    expect(html.match(/md:sr-only/g)?.length).toBe(4);
    expect(html).toContain('md:contents');
  });

  it('cargando, error y vacío no se confunden', () => {
    expect(results({ status: 'loading' })).toContain('Cargando usuarios…');
    expect(results({ status: 'loading' })).toContain('aria-busy="true"');

    const error = results({
      status: 'error',
      message: 'Tu sesión venció. Vuelve a iniciar sesión.',
    });
    expect(error).toContain('role="alert"');
    expect(error).toContain('Tu sesión venció. Vuelve a iniciar sesión.');
    expect(error).toContain('Reintentar');
    expect(error).not.toContain('No encontramos usuarios');

    const empty = results({ status: 'ready', users: [], nextCursor: null }, { filtered: true });
    expect(empty).toContain('No encontramos usuarios con esos filtros.');
    expect(empty).toContain('Limpiar filtros');
    expect(results({ status: 'ready', users: [], nextCursor: null })).not.toContain(
      'Limpiar filtros',
    );
  });

  it('el error de una acción va en la fila de esa persona', () => {
    const html = results(
      { status: 'ready', users: [user()], nextCursor: null },
      {
        rowError: {
          userId: ANA,
          message: 'Es el último superadmin activo: no se puede suspender.',
        },
      },
    );
    expect(html).toContain('Es el último superadmin activo: no se puede suspender.');
    expect(html).toContain('aria-label="Cerrar aviso"');
  });

  it('quien mira lleva "Tú"', () => {
    const html = results({ status: 'ready', users: [user()], nextCursor: null }, { viewerId: ANA });
    expect(html).toContain('>Tú<');
  });

  it('"Cargar más" que falló dice por qué', () => {
    const html = results(
      { status: 'ready', users: [user()], nextCursor: 'cur' },
      {
        moreError: 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
      },
    );
    expect(html).toContain('No pudimos conectar con el servidor.');
  });
});

describe('la ficha desde el directorio', () => {
  it('el nombre de cada persona abre su ficha', () => {
    const html = results(
      { status: 'ready', users: [user()], nextCursor: null },
      { onOpen: () => {} },
    );
    expect(html).toMatch(
      /<button type="button" aria-haspopup="dialog" aria-label="Ver la ficha de Ana Pérez"/,
    );
    expect(results({ status: 'ready', users: [user()], nextCursor: null })).not.toContain(
      'Ver la ficha de',
    );
  });

  function sheetMenu(patch: Record<string, unknown> = {}, withStatus = true): string {
    const detail = parseMemberDetail(apiDetail(patch));
    if (detail === undefined) throw new Error('fixture inválida');
    return renderToStaticMarkup(
      createElement(
        DropdownMenu.Root,
        { open: true, modal: false },
        createElement(DropdownMenu.Trigger, null, 'Acciones'),
        createElement(
          DropdownMenu.Content,
          null,
          createElement(PlatformSheetMenuItems, {
            detail,
            now: NOW,
            onPick: (run: () => void) => run,
            onAction: () => {},
            onSetStatus: withStatus ? () => {} : undefined,
          }),
        ),
      ),
    );
  }

  it('el menú de la ficha: soporte por grupos, la cuenta y "Ver en Equipo"', () => {
    const html = sheetMenu({
      security: { ...(apiDetail().security as object), lockedUntil: iso(NOW + 10 * MIN) },
    });
    const headings = [...html.matchAll(/<div role="group" aria-labelledby="([^"]+)"/g)].map(
      (m) => new RegExp(`id="${m[1]}"[^>]*>([^<]+)</div>`).exec(html)?.[1],
    );
    expect(headings).toEqual(['Acceso', 'Seguridad', 'Cuenta']);
    expect(html).toContain('Enviar enlace para restablecer contraseña');
    expect(html).toContain('Forzar cambio de contraseña');
    expect(html).toContain('Cerrar sus sesiones');
    expect(html).toContain('Restablecer 2FA');
    expect(html).toContain('Suspender en toda la plataforma');
    expect(html).toContain('href="/admin/usuarios?tenant=0b6f6a52-7a47-4c8e-9a3b-1a2b3c4d5e6f"');
    expect(voseoIn(html)).toEqual([]);
  });

  it('una cuenta suspendida se reactiva; sin nodos no hay soporte ni "Ver en Equipo"', () => {
    const suspended = sheetMenu({ user: { ...(apiDetail().user as object), status: 'suspended' } });
    expect(suspended).toContain('Reactivar cuenta');
    // Con la cuenta suspendida, un enlace no le serviría para entrar.
    expect(suspended).toContain('(acceso suspendido)');
    const noNodes = sheetMenu({ memberships: [] });
    expect(noNodes).not.toContain('Enviar enlace');
    expect(noNodes).not.toContain('Ver en Equipo');
    expect(noNodes).toContain('Suspender en toda la plataforma');
    expect(sheetMenu({}, false)).not.toContain('Suspender en toda la plataforma');
  });
});

describe('UserActionItems: el menú de una persona', () => {
  it('"Ver en Equipo" abre su primer nodo; "Suspender en toda la plataforma" en rojo', () => {
    const html = menu(user());
    expect(html).toContain(`href="/admin/usuarios?tenant=${NORTE}"`);
    expect(html).toContain('Ver en Equipo');
    expect(html).toContain('Suspender en toda la plataforma');
    expect(html).not.toContain('Reactivar cuenta');
    expect(voseoIn(html)).toEqual([]);
  });

  it('una cuenta suspendida ofrece "Reactivar cuenta"', () => {
    const html = menu(user({ status: 'suspended' }));
    expect(html).toContain('Reactivar cuenta');
    expect(html).not.toContain('Suspender en toda la plataforma');
  });

  it('sobre uno mismo sólo "Ver en Equipo"; sin nodos, no hay "Ver en Equipo"', () => {
    const self = menu(user(), true);
    expect(self).toContain('Ver en Equipo');
    expect(self).not.toContain('Suspender');
    const sinNodos = menu(user({ memberships: [] }));
    expect(sinNodos).not.toContain('Ver en Equipo');
    expect(sinNodos).toContain('Suspender en toda la plataforma');
  });
});

describe('DirectoryFiltersBar', () => {
  function bar(extra: Partial<Parameters<typeof DirectoryFiltersBar>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(DirectoryFiltersBar, {
        search: '',
        filters: {},
        nodes: {
          status: 'ready',
          nodes: [
            {
              id: 'p',
              slug: 'planetour',
              name: 'Planetour',
              tenantType: 'platform',
              parentTenantId: null,
              status: 'active',
              depth: 1,
            },
            {
              id: NORTE,
              slug: 'norte',
              name: 'Agencia Norte',
              tenantType: 'agency',
              parentTenantId: 'p',
              status: 'suspended',
              depth: 2,
            },
          ],
        },
        canClear: false,
        onSearch: () => {},
        onFilters: () => {},
        onRetryNodes: () => {},
        onClear: () => {},
        ...extra,
      }),
    );
  }

  it('búsqueda, rol, nodo y los filtros rápidos como botones que se prenden', () => {
    const html = bar({ filters: { status: 'suspended', locked: true } });
    expect(html).toContain('placeholder="Busca por nombre o correo"');
    expect(html).toContain('Todos los roles');
    expect(html).toContain('>Superadmin<');
    expect(html).toContain('Todos los nodos');
    expect(html).toContain('Agencia Norte (suspendido)');
    expect(html).toContain('Incluye todo lo que cuelga de él.');
    for (const chip of ['Activos', 'Suspendidos', 'Sin 2FA', 'Bloqueados', 'Nunca ingresaron']) {
      expect(html).toContain(`>${chip}<`);
    }
    expect(html).toMatch(/aria-pressed="true"[^>]*>Suspendidos</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Activos</);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Bloqueados</);
    expect(html).not.toContain('Limpiar filtros');
    expect(voseoIn(html)).toEqual([]);
  });

  it('con filtros, "Limpiar filtros"; si la red no cargó, lo dice y deja reintentar', () => {
    expect(bar({ canClear: true })).toContain('Limpiar filtros');
    const html = bar({
      nodes: { status: 'error', message: 'No pudimos cargar los nodos de la red.' },
    });
    expect(html).toContain('No pudimos cargar los nodos de la red.');
    expect(html).toContain('aria-label="Volver a cargar los nodos"');
  });
});
