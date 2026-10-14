import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseAuditPage } from '../../../../../lib/audit-format';
import {
  parseMemberDetail,
  type MemberDetailSource,
  type MemberDetailView,
} from '../../../../../lib/member-detail';
import {
  apiDetail,
  DAY,
  iso,
  MIN,
  NODE,
  NOW,
  SESSION,
  USER,
} from '../../../../../lib/member-detail.fixture';
import { parseMembers } from '../../../../../lib/tenant-admin-team';
import { DEFAULT_TEAM_FILTERS } from '../../../../../lib/team-filters';
import { teamActorOf } from '../../../../../lib/tenant-admin-team';
import { voseoIn } from '../../../../../lib/voseo';
import { MemberList } from './member-list';
import {
  ActivityList,
  MemberNameButton,
  MemberSheetView,
  type ActivityState,
  type DetailState,
} from './member-sheet';

/*
 * La ficha de un usuario en el panel lateral: que sea un diálogo nombrado por la persona, que cada
 * sección diga lo suyo (y su vacío), que sólo ofrezca lo que corresponde (cerrar una sesión ajena,
 * desbloquear, el menú de acciones) y que todo vaya en tú. Sin DOM en los tests: se verifica el
 * HTML del primer pintado.
 */

const TEAM: MemberDetailSource = { kind: 'team', tenantId: NODE, userId: USER };
const PLATFORM: MemberDetailSource = { kind: 'platform', userId: USER };

function detail(patch: Record<string, unknown> = {}): MemberDetailView {
  const parsed = parseMemberDetail(apiDetail(patch));
  if (parsed === undefined) throw new Error('fixture inválida');
  return parsed;
}

const ACTIVITY: ActivityState = {
  status: 'ready',
  events: parseAuditPage({
    events: [
      {
        id: 'e1',
        occurredAt: iso(NOW - 2 * MIN),
        eventType: 'auth.password_reset.sent_by_admin',
        tenantId: NODE,
        tenantName: 'Agencia Norte',
        actorEmail: 'jefa@agencia.co',
        targetEmail: 'ana@agencia.co',
        payload: {},
      },
      {
        id: 'e2',
        occurredAt: iso(NOW - DAY),
        eventType: 'auth.login.success',
        tenantId: null,
        tenantName: null,
        actorEmail: 'ana@agencia.co',
        targetEmail: null,
        payload: { method: 'mfa' },
      },
    ],
  }).events,
  nextBefore: 'c1',
  loadingMore: false,
  moreError: '',
};

type ViewProps = Parameters<typeof MemberSheetView>[0];

function view(over: Partial<ViewProps> = {}): string {
  const props: ViewProps = {
    source: TEAM,
    fallbackName: 'Ana',
    fallbackEmail: 'ana@agencia.co',
    state: { status: 'ready', detail: detail() },
    activity: ACTIVITY,
    now: NOW,
    self: false,
    busy: false,
    actionError: '',
    revokingId: null,
    canRevokeSessions: true,
    menu: () => null,
    onUnlock: () => {},
    onRevokeSession: () => {},
    onRetry: () => {},
    onRetryActivity: () => {},
    onLoadMoreActivity: () => {},
    onDismissError: () => {},
    onClose: () => {},
    ...over,
  };
  return renderToStaticMarkup(createElement(MemberSheetView, props));
}

function dialogTag(html: string): string {
  return /<div[^>]*role="dialog"[^>]*>/.exec(html)?.[0] ?? '';
}

/** El HTML de una sección, desde su título hasta la siguiente. */
function section(html: string, title: string): string {
  const at = html.indexOf(`>${title}</h3>`);
  expect(at, title).toBeGreaterThan(-1);
  const end = html.indexOf('<section', at);
  return html.slice(at, end === -1 ? undefined : end);
}

describe('MemberSheetView: el diálogo', () => {
  it('es un diálogo modal nombrado por la persona y descrito por su correo', () => {
    const html = view();
    const tag = dialogTag(html);
    expect(tag).toContain('aria-modal="true"');
    const titleId = /aria-labelledby="([^"]+)"/.exec(tag)?.[1];
    expect(html).toMatch(new RegExp(`<h2 id="${titleId}"[^>]*>Ana Pérez</h2>`));
    const describedBy = /aria-describedby="([^"]+)"/.exec(tag)?.[1];
    expect(html).toMatch(new RegExp(`<p id="${describedBy}"[^>]*>ana@agencia.co</p>`));
    // Panel a la derecha en escritorio y pantalla completa en el teléfono (el layout de FormSheet).
    expect(tag).toContain('w-full');
    expect(tag).toContain('sm:max-w-[600px]');
    expect(html).toContain('aria-label="Cerrar"');
  });

  it('sin nombre propio, el título es el correo y no se repite debajo', () => {
    const html = view({
      state: {
        status: 'ready',
        detail: detail({ user: { ...(apiDetail().user as object), name: null } }),
      },
    });
    const tag = dialogTag(html);
    expect(html).toMatch(/<h2 [^>]*>ana@agencia.co<\/h2>/);
    expect(tag).not.toContain('aria-describedby');
  });

  it('cada sección es una región nombrada por su título', () => {
    const html = view();
    const titles = [
      'Perfil',
      'Nodos y roles',
      'Seguridad',
      'Sesiones abiertas (1)',
      'Invitaciones que envió',
      'Actividad',
    ];
    for (const title of titles) {
      const id = new RegExp(`<h3 id="([^"]+)"[^>]*>${title.replace(/[()]/g, '\\$&')}</h3>`).exec(
        html,
      )?.[1];
      expect(id, title).toBeDefined();
      expect(html).toContain(`<section aria-labelledby="${id}"`);
    }
    const order = titles.map((t) => html.indexOf(`>${t}</h3>`));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('marcas de la cabecera: "Activo", o lo que le impide entrar; "Tú" en la propia', () => {
    expect(view()).toMatch(/<ul [^>]*aria-label="Estado"[^>]*><li [^>]*>Activo<\/li>/);
    const blocked = view({
      state: {
        status: 'ready',
        detail: detail({
          user: { ...(apiDetail().user as object), status: 'suspended' },
          security: { ...(apiDetail().security as object), lockedUntil: iso(NOW + 10 * MIN) },
        }),
      },
    });
    expect(blocked).toContain('>Cuenta suspendida</li>');
    expect(blocked).toContain('>Bloqueado</li>');
    expect(blocked).not.toContain('>Activo</li>');
    expect(view({ self: true })).toContain('>Tú</li>');
  });
});

describe('MemberSheetView: las secciones', () => {
  it('Perfil: correo, alta, último acceso y quién lo invitó', () => {
    const perfil = section(view(), 'Perfil');
    expect(perfil).toContain('>Correo</dt>');
    expect(perfil).toContain('Verificado</dd>');
    expect(perfil).toContain('>Alta</dt>');
    // Pasado un mes, la fecha: "el 3 sept" o "el 3 de sept", según ICU.
    expect(perfil).toMatch(/>el 3 (de )?sept?\.?<\/time>/);
    expect(perfil).toContain('>Último acceso</dt>');
    expect(perfil).toContain('hace 3 h');
    expect(perfil).toContain('>Invitado por</dt>');
    expect(perfil).toMatch(/>jefa@agencia.co · el 3 (de )?sept?\.?<\/time>/);

    const legacy = section(
      view({
        state: {
          status: 'ready',
          detail: detail({
            invitedBy: null,
            user: { ...(apiDetail().user as object), emailVerified: false, lastLoginAt: null },
          }),
        },
      }),
      'Perfil',
    );
    expect(legacy).toContain('Sin verificar</dd>');
    expect(legacy).toContain('Nunca ingresó');
    expect(legacy).not.toContain('Invitado por');
  });

  it('Nodos y roles: "Nodo · Rol · Estado" para el lector de pantalla', () => {
    const nodos = section(view(), 'Nodos y roles');
    expect(nodos).toContain('<span class="sr-only">Agencia Norte · Admin · Activo</span>');
    expect(nodos).toContain('<span class="sr-only">Sucursal Sur · Vendedor · Suspendido</span>');
    const none = (source: MemberDetailSource) =>
      section(
        view({ source, state: { status: 'ready', detail: detail({ memberships: [] }) } }),
        'Nodos y roles',
      );
    expect(none(TEAM)).toContain('No tiene nodos que administres.');
    expect(none(PLATFORM)).toContain('No pertenece a ningún nodo.');
  });

  it('Seguridad: 2FA, códigos, equipos de confianza y contraseña', () => {
    const seguridad = section(view(), 'Seguridad');
    expect(seguridad).toMatch(/2FA activo desde el 12 (de )?jun/);
    expect(seguridad).toContain('Códigos de recuperación: 8');
    expect(seguridad).toContain('Equipos de confianza: 2');
    expect(seguridad).toContain('Contraseña cambiada hace 2 días');
    expect(seguridad).not.toContain('Bloqueado hasta');
    expect(seguridad).not.toContain('Desbloquear');
  });

  it('Seguridad: bloqueo con "Desbloquear" sólo si se ofrece, y el cambio pendiente', () => {
    const locked = detail({
      user: { ...(apiDetail().user as object), passwordResetRequired: true },
      security: {
        ...(apiDetail().security as object),
        mfaEnabled: false,
        lockedUntil: iso(NOW + 10 * MIN),
      },
    });
    const withUnlock = section(view({ state: { status: 'ready', detail: locked } }), 'Seguridad');
    expect(withUnlock).toMatch(/Bloqueado hasta las \d{1,2}:\d{2}/);
    expect(withUnlock).toMatch(/<button[^>]*>Desbloquear<\/button>/);
    expect(withUnlock).toContain('Cambio de contraseña pendiente');
    expect(withUnlock).toContain('Sin 2FA: su rol lo exige');
    // Sin 2FA, ni códigos ni equipos de confianza (no significan nada).
    expect(withUnlock).not.toContain('Códigos de recuperación');
    const without = section(
      view({ state: { status: 'ready', detail: locked }, onUnlock: undefined }),
      'Seguridad',
    );
    expect(without).toMatch(/Bloqueado hasta las/);
    expect(without).not.toContain('Desbloquear');
  });

  it('Sesiones: el equipo legible, la IP, el nodo y "Cerrar esta sesión"', () => {
    const sesiones = section(view(), 'Sesiones abiertas (1)');
    expect(sesiones).toContain('Chrome en Windows');
    expect(sesiones).toContain('203.0.113.7');
    expect(sesiones).toContain('Agencia Norte');
    expect(sesiones).toContain('Activa hace 3 min');
    expect(sesiones).toContain('aria-label="Cerrar esta sesión: Chrome en Windows, 203.0.113.7"');
    expect(sesiones).toContain('Cerrar esta sesión</button>');
    // Quien no puede actuar sobre la persona no ve el botón.
    expect(section(view({ canRevokeSessions: false }), 'Sesiones abiertas (1)')).not.toContain(
      'Cerrar esta sesión',
    );
  });

  it('la sesión que se está cerrando espera; mientras, las otras no se ofrecen', () => {
    const two = detail({
      sessions: [
        ...(apiDetail().sessions as object[]),
        { id: 'otra', tenantId: NODE, lastSeenAt: iso(NOW - MIN), userAgent: null },
      ],
    });
    const html = section(
      view({ state: { status: 'ready', detail: two }, revokingId: SESSION }),
      'Sesiones abiertas (2)',
    );
    expect(html).toContain('Cerrando…');
    // `aria-disabled` y no `disabled`: el foco no se va de la ficha mientras espera el API.
    expect(html.match(/<button[^>]* aria-disabled="true"/g)).toHaveLength(2);
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
  });

  it('mientras corre una acción del pie, ninguna sesión se ofrece para cerrar', () => {
    const html = section(view({ busy: true }), 'Sesiones abiertas (1)');
    expect(html).toContain('Cerrar esta sesión</button>');
    expect(html.match(/<button[^>]* aria-disabled="true"/g)).toHaveLength(1);
    expect(section(view(), 'Sesiones abiertas (1)')).not.toContain('aria-disabled="true"');
  });

  it('la propia sesión no se cierra desde acá; en la propia ficha, se dice dónde', () => {
    const own = detail({
      sessions: [{ ...(apiDetail().sessions as object[])[0], current: true }],
    });
    const html = view({
      self: true,
      canRevokeSessions: false,
      state: { status: 'ready', detail: own },
    });
    const sesiones = section(html, 'Sesiones abiertas (1)');
    expect(sesiones).toContain('Esta sesión');
    expect(sesiones).not.toContain('Cerrar esta sesión');
    expect(sesiones).toContain('href="/configuracion/seguridad"');
    expect(sesiones).toContain('Mi cuenta → Seguridad');
  });

  it('en el directorio, una sesión sin nodo no se cierra de a una y lo dice', () => {
    const platformSession = detail({
      sessions: [{ ...(apiDetail().sessions as object[])[0], tenantId: null, tenantName: null }],
    });
    const html = section(
      view({ source: PLATFORM, state: { status: 'ready', detail: platformSession } }),
      'Sesiones abiertas (1)',
    );
    expect(html).not.toContain('Cerrar esta sesión</button>');
    expect(html).toContain('Sesión sin nodo');
  });

  it('sin sesiones: el vacío dice de qué alcance', () => {
    const empty = { status: 'ready', detail: detail({ sessions: [] }) } as const;
    expect(section(view({ state: empty }), 'Sesiones abiertas (0)')).toContain(
      'No tiene sesiones abiertas en los nodos que administras.',
    );
    expect(section(view({ source: PLATFORM, state: empty }), 'Sesiones abiertas (0)')).toContain(
      'No tiene sesiones abiertas.',
    );
  });

  it('invitaciones que envió: cuántas, la lista y cuándo vencen; o el vacío', () => {
    const invitaciones = section(view(), 'Invitaciones que envió');
    expect(invitaciones).toContain('1 pendiente');
    expect(invitaciones).toContain('nuevo@gmail.com');
    expect(invitaciones).toContain('Vendedor · Agencia Norte · vence en 5 días');
    const many = detail({
      invitationsSent: { pending: 25, items: (apiDetail().invitationsSent as { items: [] }).items },
    });
    expect(
      section(view({ state: { status: 'ready', detail: many } }), 'Invitaciones que envió'),
    ).toContain('Se muestran las 1 más recientes.');
    const none = detail({ invitationsSent: { pending: 0, items: [] } });
    expect(
      section(view({ state: { status: 'ready', detail: none } }), 'Invitaciones que envió'),
    ).toContain('No tiene invitaciones pendientes.');
  });

  it('Actividad: cada evento con su frase, dónde y quién, y "Cargar más"', () => {
    const actividad = section(view(), 'Actividad');
    expect(actividad).toContain('Enlace para restablecer contraseña enviado');
    expect(actividad).toContain('a ana@agencia.co');
    expect(actividad).toContain('Agencia Norte · por jefa@agencia.co');
    expect(actividad).toContain('Ingresó');
    expect(actividad).toContain('Con contraseña y 2FA');
    expect(actividad).toContain('Cargar más');
  });
});

describe('ActivityList: sus estados', () => {
  function list(state: ActivityState): string {
    return renderToStaticMarkup(
      createElement(ActivityList, { state, onRetry: () => {}, onLoadMore: () => {} }),
    );
  }

  it('cargando, error con "Reintentar" y vacío son distintos', () => {
    expect(list({ status: 'loading' })).toContain('Cargando la actividad…');
    const error = list({
      status: 'error',
      message: 'No tienes acceso a la actividad de este nodo.',
    });
    expect(error).toContain('role="alert"');
    expect(error).toContain('Reintentar');
    expect(error).not.toContain('Sin actividad');
    const empty = list({ ...ACTIVITY, events: [], nextBefore: null });
    expect(empty).toContain('Sin actividad registrada.');
    expect(empty).not.toContain('Cargar más');
  });

  it('"Cargar más" cargando queda aria-disabled (no suelta el foco); su error se ve', () => {
    const more = list({ ...ACTIVITY, loadingMore: true, moreError: '' });
    expect(more).toMatch(/<button[^>]*aria-disabled="true"[^>]*>.*Cargando…<\/button>/);
    expect(more).not.toMatch(/<button[^>]* disabled=""/);
    const failed = list({ ...ACTIVITY, moreError: 'No pudimos cargar la actividad.' });
    expect(failed).toContain('No pudimos cargar la actividad.');
  });
});

describe('MemberSheetView: cargando, error y el pie', () => {
  it('cargando: el nombre de la fila en el título y un aviso para el lector', () => {
    const html = view({ state: { status: 'loading' } as DetailState });
    expect(html).toMatch(/<h2 [^>]*>Ana<\/h2>/);
    expect(html).toContain('Cargando la ficha…');
    expect(html).not.toContain('Perfil');
    // Sin la ficha, no hay menú de acciones todavía.
    expect(html).not.toContain('aria-label="Acciones sobre');
  });

  it('un error se dice con su motivo y "Reintentar"', () => {
    const html = view({
      state: {
        status: 'error',
        message: 'Esta persona ya no está en este nodo. Cierra la ficha y recarga la lista.',
      },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Esta persona ya no está en este nodo.');
    expect(html).toContain('Reintentar');
  });

  it('el pie: "Cerrar" siempre; "Acciones" sólo con menú; el error de una acción, a la vista', () => {
    const html = view();
    const footer = html.slice(html.indexOf('<footer'));
    expect(footer).toContain('>Cerrar</button>');
    expect(footer).toContain('aria-label="Acciones sobre Ana Pérez"');
    expect(footer).toContain('aria-haspopup="menu"');
    expect(view({ menu: undefined })).not.toContain('Acciones sobre');

    const busy = view({ busy: true });
    expect(busy).toContain('Aplicando…');
    expect(busy).toMatch(/aria-disabled="true"[^>]*aria-label="Acciones sobre Ana Pérez"/);

    const failed = view({ actionError: 'No lo pudimos hacer: su acceso está suspendido.' });
    const failedFooter = failed.slice(failed.indexOf('<footer'));
    expect(failedFooter).toContain('role="alert"');
    expect(failedFooter).toContain('No lo pudimos hacer: su acceso está suspendido.');
    expect(failedFooter).toContain('aria-label="Cerrar aviso"');
  });

  it('todo el primer pintado va en tú: ficha, vacíos, cargando y error', () => {
    const bare = detail({
      memberships: [],
      sessions: [],
      invitationsSent: { pending: 0, items: [] },
      invitedBy: null,
    });
    for (const html of [
      view(),
      view({ self: true }),
      view({ source: PLATFORM, state: { status: 'ready', detail: bare } }),
      view({ state: { status: 'loading' } }),
      view({ state: { status: 'error', message: 'x' }, actionError: 'y' }),
    ]) {
      expect(voseoIn(html)).toEqual([]);
    }
  });
});

describe('abrir y cerrar con el teclado', () => {
  it('el nombre en la lista es un botón que dice qué abre', () => {
    const html = renderToStaticMarkup(
      createElement(MemberNameButton, { name: 'Ana Pérez', onOpen: () => {} }),
    );
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="Ver la ficha de Ana Pérez"');
    expect(html).toContain('focus-visible:ring-2');
  });

  it('en Equipo, el nombre de cada miembro abre su ficha (sólo si la lista sabe abrirla)', () => {
    const members =
      parseMembers({
        users: [
          {
            userId: USER,
            email: 'beto@agencia.co',
            name: 'Beto',
            role: 'vendedor',
            createdAt: iso(NOW),
          },
        ],
      }) ?? [];
    const render = (onOpen?: () => void) =>
      renderToStaticMarkup(
        createElement(MemberList, {
          state: { status: 'ready', items: members },
          search: '',
          filters: DEFAULT_TEAM_FILTERS,
          onFiltersChange: () => {},
          actor: teamActorOf('me', [{ role: 'tenant_admin', status: 'active' }]),
          roles: [],
          tenantName: 'Agencia Norte',
          busyUserId: null,
          memberError: null,
          onDismissError: () => {},
          onRetry: () => {},
          onInvite: () => {},
          ...(onOpen ? { onOpen } : {}),
          onChangeRole: () => {},
          onSetStatus: () => {},
          onAction: () => {},
        }),
      );
    expect(render(() => {})).toContain('aria-label="Ver la ficha de Beto"');
    expect(render()).not.toContain('Ver la ficha de');
  });

  it('Escape cierra y el foco vuelve: la ficha usa el panel de FormSheet y su comportamiento modal', () => {
    const src = (file: string) =>
      readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    expect(src('./member-sheet.tsx')).toMatch(/<Sheet\b/);
    const sheet = src('../../../../../components/ui/form-sheet.tsx');
    expect(sheet).toMatch(/export function Sheet\(/);
    expect(sheet).toMatch(/useModalBehavior\(true, onClose/);
    // Un menú abierto encima atiende su propio Escape: no cierra también la ficha.
    expect(src('../../../../../components/ui/dialog.tsx')).toMatch(
      /if \(e\.defaultPrevented\) return;/,
    );
  });
});
