import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEAM_FILTERS, type TeamFilters } from '../../../../../lib/team-filters';
import { parseSeatsView, type SeatsView } from '../../../../../lib/tenant-admin-seats';
import {
  grantableRoles,
  parseInvitations,
  parseMembers,
  teamActorOf,
  type NetworkMember,
  type TeamActor,
} from '../../../../../lib/tenant-admin-team';
import { voseoIn } from '../../../../../lib/voseo';
import { InvitationList } from './invitation-list';
import { PendingInvitationNotice } from './invite-dialog';
import { MemberActionItems, MemberList, type MemberRowError } from './member-list';
import { invitableRolesIn } from './roles';
import { SeatsCard, type SeatsState } from './seats-ui';

/*
 * El primer pintado de Equipo: que un error no se vea como vacío, que el medidor de puestos se
 * anuncie con su valor y que cada miembro lleve sus etiquetas para la tarjeta del teléfono.
 */

const TENANT = '33333333-3333-4333-8333-333333333333';

function seatsView(patch: Record<string, unknown> = {}): SeatsView {
  const view = parseSeatsView({
    poolTenantId: TENANT,
    poolTenantName: 'Consolidador Andino',
    inherited: true,
    limit: 5,
    inUse: 3,
    idleTimeoutMinutes: 30,
    idleInherited: true,
    ownSeats: null,
    ownIdleTimeoutMinutes: null,
    sessions: [
      {
        sessionId: '11111111-1111-4111-8111-111111111111',
        userId: 'u1',
        name: 'Ana Pérez',
        email: 'ana@agencia.co',
        tenantId: TENANT,
        tenantName: 'Agencia Norte',
        issuedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        ip: '203.0.113.7',
        device:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      },
      {
        sessionId: '22222222-1111-4111-8111-111111111111',
        userId: 'me',
        name: 'Yo',
        email: 'yo@agencia.co',
        tenantId: TENANT,
        tenantName: 'Agencia Norte',
        issuedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        ip: null,
        device: null,
        current: true,
      },
    ],
    ...patch,
  });
  if (view === undefined) throw new Error('fixture inválida');
  return view;
}

function seatsCard(state: SeatsState): string {
  return renderToStaticMarkup(
    createElement(SeatsCard, { tenantId: TENANT, state, reload: async () => {} }),
  );
}

describe('SeatsCard', () => {
  it('medidor accesible con su valor, compartido e inactividad', () => {
    const html = seatsCard({ status: 'ready', view: seatsView() });
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain('aria-valuemax="5"');
    expect(html).toContain('aria-valuetext="3 de 5 puestos en uso"');
    expect(html).toContain('3 de 5 en uso');
    expect(html).toContain('Compartido con Consolidador Andino');
    expect(html).toContain('Se cierra tras 30 min sin actividad (heredado).');
  });

  it('lista de conectados con dispositivo legible, IP y "Desconectar" salvo en la propia', () => {
    const html = seatsCard({ status: 'ready', view: seatsView() });
    expect(html).toContain('Chrome en Windows');
    expect(html).toContain('203.0.113.7');
    expect(html).toContain('aria-label="Desconectar a Ana Pérez"');
    expect(html).not.toContain('aria-label="Desconectar a Yo"');
    expect(html).toContain('>Tú</span>');
    expect(voseoIn(html)).toEqual([]);
  });

  it('sin límite: sin barra', () => {
    const html = seatsCard({ status: 'ready', view: seatsView({ limit: null, inherited: false }) });
    expect(html).toContain('Sin límite');
    expect(html).not.toContain('role="meter"');
  });

  it('sin límite no dice que no hay nadie conectado', () => {
    // Como lo manda el API para un nodo sin cupo (el estado de todos tras el deploy): inUse 0 y
    // sin sesiones, aunque haya vendedores trabajando. Ni conteo ni "nadie".
    const html = seatsCard({
      status: 'ready',
      view: seatsView({
        poolTenantId: null,
        poolTenantName: null,
        inherited: false,
        limit: null,
        ownSeats: null,
        inUse: 0,
        sessions: [],
      }),
    });
    expect(html).toContain('Este nodo no cuenta puestos');
    expect(html).toContain('no ocupan puesto y no se listan aquí');
    expect(html).not.toMatch(/Nadie de este nodo|\(0\)|0 personas|conectadas? ahora/);
  });

  it('nadie ocupando un puesto es distinto de un error', () => {
    const empty = seatsCard({ status: 'ready', view: seatsView({ sessions: [], inUse: 0 }) });
    expect(empty).toContain('Ocupan un puesto ahora (0)');
    expect(empty).toContain('Nadie de este nodo ocupa un puesto ahora.');
    const error = seatsCard({ status: 'error', message: 'No administras este nodo.' });
    expect(error).toContain('role="alert"');
    expect(error).toContain('No administras este nodo.');
    expect(error).toContain('Reintentar');
    expect(error).not.toContain('Nadie de este nodo');
  });

  it('cargando anuncia que carga', () => {
    expect(seatsCard({ status: 'loading' })).toContain('Cargando puestos…');
  });
});

const MEMBER = {
  userId: 'u2',
  email: 'beto@agencia.co',
  name: 'Beto',
  userStatus: 'active',
  role: 'tenant_admin',
  membershipStatus: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
  mfaEnabled: false,
  lockedUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
  activeSessions: 0,
};

const CONSOLIDATOR_ADMIN = teamActorOf('me', [{ role: 'consolidator_admin', status: 'active' }]);

function members(
  items: readonly NetworkMember[] | 'error' | 'loading',
  memberError: MemberRowError | null = null,
  actor: TeamActor = CONSOLIDATOR_ADMIN,
  tenantType = 'agency',
  view: { readonly filters?: Partial<TeamFilters>; readonly search?: string } = {},
): string {
  const state =
    items === 'error'
      ? ({
          status: 'error',
          message: 'No tienes permiso para ver el equipo de este nodo.',
        } as const)
      : items === 'loading'
        ? ({ status: 'loading' } as const)
        : ({ status: 'ready', items } as const);
  return renderToStaticMarkup(
    createElement(MemberList, {
      state,
      search: view.search ?? '',
      filters: { ...DEFAULT_TEAM_FILTERS, ...view.filters },
      onFiltersChange: () => {},
      actor,
      roles: grantableRoles(invitableRolesIn(tenantType), actor),
      tenantName: 'Agencia Norte',
      busyUserId: null,
      memberError,
      onDismissError: () => {},
      onRetry: () => {},
      onInvite: () => {},
      onChangeRole: () => {},
      onSetStatus: () => {},
      onAction: () => {},
    }),
  );
}

/** Sólo la lista de miembros, sin la barra de filtros (cuyas chips repiten "2FA pendiente"…). */
function listOf(html: string): string {
  const at = html.indexOf('<ul ');
  expect(at).toBeGreaterThan(-1);
  return html.slice(at);
}

describe('MemberList', () => {
  it('un error no se muestra como "no tiene usuarios"', () => {
    const html = members('error');
    expect(html).toContain('role="alert"');
    expect(html).toContain('No tienes permiso');
    expect(html).not.toContain('no tiene usuarios');
  });

  it('vacío con llamado a invitar', () => {
    const html = members([]);
    expect(html).toContain('Esta agencia no tiene usuarios todavía.');
    expect(html).toContain('Invita a tu primer vendedor');
  });

  it('columnas nuevas: último acceso, 2FA pendiente, bloqueo; con etiquetas para el teléfono', () => {
    const list = parseMembers({ users: [MEMBER] }) ?? [];
    const html = members(list);
    expect(html).toContain('Nunca ingresó');
    expect(html).toContain('2FA pendiente');
    expect(html).toContain('Bloqueado hasta');
    for (const label of ['Rol', 'Último acceso', '2FA', 'Estado']) {
      expect(html).toContain(`>${label}</span>`);
    }
    // Sin tabla de ancho mínimo: en 375 px cada miembro es una tarjeta.
    expect(html).not.toContain('min-w-[640px]');
    expect(html).toContain('aria-label="Acciones sobre Beto"');
  });

  it('el motivo de una acción rechazada se ve en la fila del miembro, no arriba de todo', () => {
    const list =
      parseMembers({
        users: [MEMBER, { ...MEMBER, userId: 'u3', name: 'Carla', email: 'carla@agencia.co' }],
      }) ?? [];
    const message = 'No lo pudimos hacer: También pertenece a una agencia que no administras.';
    const html = members(list, { userId: 'u3', message });
    // '<li ' y no '<li': el ícono de alerta dibuja <line>.
    const rows = html.split('<li ').slice(1);
    const carla = rows.find((r) => r.includes('Carla')) ?? '';
    const beto = rows.find((r) => r.includes('Beto')) ?? '';
    expect(carla).toContain('role="alert"');
    expect(carla).toContain(message);
    expect(carla).toContain('aria-label="Cerrar aviso"');
    expect(beto).not.toContain(message);
    expect(members(list)).not.toContain(message);
  });

  it('los estados sin fondo propio siguen al tema (en oscuro, los tonos fijos no llegan a AA)', () => {
    const online = {
      ...MEMBER,
      activeSessions: 2,
      mfaEnabled: true,
    };
    const html = listOf(
      members(parseMembers({ users: [MEMBER, { ...online, userId: 'u4' }] }) ?? []),
    );
    // La clase del <span> que envuelve cada texto (los íconos y el punto no son <span class=…>).
    const classOf = (text: string): string => {
      const at = html.indexOf(text);
      expect(at).toBeGreaterThan(-1);
      const open = html.lastIndexOf('<span class="', at) + '<span class="'.length;
      return html.slice(open, html.indexOf('"', open));
    };
    const expected = {
      '2FA activo': 'var(--color-success)',
      'En línea': 'var(--color-success)',
      '2FA pendiente': 'var(--color-warning)',
      'Bloqueado hasta': 'var(--color-danger)',
    };
    for (const [text, token] of Object.entries(expected)) {
      const cls = classOf(text);
      expect(cls).not.toMatch(/text-(emerald|amber|red)-\d+/);
      expect(cls).toContain(`text-[color-mix(in_oklab,${token}_60%,var(--color-fg))]`);
    }
  });

  it('sobre sí mismo no hay menú de acciones', () => {
    const list = parseMembers({ users: [{ ...MEMBER, userId: 'me', name: 'Yo' }] }) ?? [];
    const html = members(list);
    expect(html).not.toContain('Acciones sobre Yo');
    expect(html).toContain('>Tú</span>');
  });

  it('el primer pintado va en tú: vacío, error y lista', () => {
    const list = parseMembers({ users: [MEMBER, { ...MEMBER, userId: 'me', name: 'Yo' }] }) ?? [];
    for (const html of [members([]), members('error'), members(list)]) {
      expect(voseoIn(html)).toEqual([]);
    }
  });

  it('en un consolidador, el superadmin puede promover a admin de consolidador desde la fila', () => {
    const superadmin = teamActorOf('root', [{ role: 'superadmin', status: 'active' }]);
    const list = parseMembers({ users: [MEMBER] }) ?? [];
    const option = '<option value="consolidator_admin">Admin de consolidador</option>';
    expect(members(list, null, superadmin, 'consolidator')).toContain(option);
    expect(members(list, null, superadmin, 'agency')).not.toContain('consolidator_admin');
    // Quien ya es admin de consolidador no da su propio rol, ni en su consolidador.
    expect(members(list, null, CONSOLIDATOR_ADMIN, 'consolidator')).not.toContain(option);
  });
});

/** El menú de acciones de un miembro, abierto (sin el portal, que no pinta en el servidor). */
function actionsMenu(member: NetworkMember): string {
  return renderToStaticMarkup(
    createElement(
      DropdownMenu.Root,
      { open: true, modal: false },
      createElement(DropdownMenu.Trigger, null, 'Acciones'),
      createElement(
        DropdownMenu.Content,
        null,
        createElement(MemberActionItems, {
          member,
          now: Date.now(),
          onPick: (run: () => void) => run,
          onSetStatus: () => {},
          onAction: () => {},
        }),
      ),
    ),
  );
}

function parsedMember(patch: Record<string, unknown> = {}): NetworkMember {
  const member = parseMembers({ users: [{ ...MEMBER, ...patch }] })?.[0];
  if (member === undefined) throw new Error('fixture inválida');
  return member;
}

describe('MemberActionItems: el menú de acciones de un miembro', () => {
  it('agrupa Acceso y Seguridad con encabezados que nombran cada grupo', () => {
    const html = actionsMenu(parsedMember());
    const groups = [...html.matchAll(/<div role="group" aria-labelledby="([^"]+)"/g)];
    expect(groups).toHaveLength(2);
    for (const [i, heading] of ['Acceso', 'Seguridad'].entries()) {
      const id = groups[i]?.[1] ?? '';
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*>${heading}</div>`));
    }
    expect(html.indexOf('Enviar enlace para restablecer contraseña')).toBeLessThan(
      html.indexOf('Cerrar sus sesiones'),
    );
    expect(html.indexOf('Restablecer 2FA')).toBeLessThan(html.indexOf('Suspender'));
    expect(voseoIn(html)).toEqual([]);
  });

  it('"Desbloquear cuenta" aparece sólo con un bloqueo vigente', () => {
    expect(actionsMenu(parsedMember())).toContain('Desbloquear cuenta');
    expect(actionsMenu(parsedMember({ lockedUntil: null }))).not.toContain('Desbloquear cuenta');
    const expired = parsedMember({ lockedUntil: new Date(Date.now() - 60_000).toISOString() });
    expect(actionsMenu(expired)).not.toContain('Desbloquear cuenta');
  });

  it('"Forzar cambio de contraseña" va en Acceso, después de "Enviar enlace"', () => {
    const html = actionsMenu(parsedMember());
    const send = html.indexOf('Enviar enlace para restablecer contraseña');
    const force = html.indexOf('Forzar cambio de contraseña');
    expect(force).toBeGreaterThan(send);
    expect(force).toBeLessThan(html.indexOf('Seguridad'));
    const item = html.split('<div role="menuitem"').find((i) => i.includes('Forzar cambio')) ?? '';
    expect(item).not.toContain('aria-disabled');
    const suspended = actionsMenu(parsedMember({ membershipStatus: 'suspended' }));
    expect(suspended).toContain('Forzar cambio de contraseña (acceso suspendido)');
  });

  it('con el acceso suspendido, "Enviar enlace" queda deshabilitado y dice por qué', () => {
    const sendItem = (html: string) =>
      html.split('<div role="menuitem"').find((item) => item.includes('Enviar enlace')) ?? '';
    for (const patch of [{ membershipStatus: 'suspended' }, { userStatus: 'suspended' }]) {
      const item = sendItem(actionsMenu(parsedMember(patch)));
      expect(item).toMatch(/^ aria-disabled="true"/);
      expect(item).toContain('Enviar enlace para restablecer contraseña (acceso suspendido)');
    }
    expect(sendItem(actionsMenu(parsedMember()))).not.toContain('aria-disabled');
    expect(actionsMenu(parsedMember())).not.toContain('(acceso suspendido)');
    expect(actionsMenu(parsedMember({ membershipStatus: 'suspended' }))).toContain('Reactivar');
  });
});

describe('InvitationList', () => {
  it('cada invitación dice quién la mandó y hace cuánto', () => {
    const DAY = 24 * 60 * 60_000;
    const items =
      parseInvitations({
        invitations: [
          {
            id: 'i1',
            email: 'nuevo@gmail.com',
            role: 'admin',
            invitedByEmail: 'ana@agencia.co',
            expiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
            createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
          },
          {
            id: 'i2',
            email: 'otro@gmail.com',
            role: 'vendedor',
            invitedByEmail: null,
            expiresAt: new Date(Date.now() + 6 * DAY).toISOString(),
            createdAt: new Date(Date.now() - DAY).toISOString(),
          },
        ],
      }) ?? [];
    const html = renderToStaticMarkup(
      createElement(InvitationList, {
        items,
        onRevoke: () => {},
        onResend: () => {},
        resendingId: null,
      }),
    );

    expect(html).toContain('Invitaciones pendientes (2)');
    expect(html).toContain('Invitado por ana@agencia.co · hace 2 días');
    expect(html).toContain('Invitado por un usuario eliminado · hace 1 día');
    expect(html).toContain('aria-label="Revocar la invitación a nuevo@gmail.com"');
    // 5 días justos si pintar cae en el mismo milisegundo que armar el dato; si no, 4 y pico.
    expect(html).toMatch(/vence en [45] días/);
    expect(html).toContain('aria-label="Reenviar la invitación a nuevo@gmail.com"');
  });

  it('una vencida lo dice y se puede reenviar; la que se está reenviando espera', () => {
    const items =
      parseInvitations({
        invitations: [
          {
            id: 'vieja',
            email: 'tarde@gmail.com',
            role: 'vendedor',
            invitedByEmail: 'ana@agencia.co',
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
            createdAt: new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
          },
        ],
      }) ?? [];
    const idle = renderToStaticMarkup(
      createElement(InvitationList, {
        items,
        onRevoke: () => {},
        onResend: () => {},
        resendingId: null,
      }),
    );
    expect(idle).toContain('>Vencida</span>');
    expect(idle).toContain('>Reenviar<');
    expect(idle).not.toMatch(/<button[^>]* disabled=""[^>]*aria-label="Reenviar/);
    expect(idle).not.toContain('vence en');

    const busy = renderToStaticMarkup(
      createElement(InvitationList, {
        items,
        onRevoke: () => {},
        onResend: () => {},
        resendingId: 'vieja',
      }),
    );
    expect(busy).toContain('Reenviando…');
    expect(busy).toMatch(
      /<button[^>]* disabled=""[^>]*aria-label="Reenviar la invitación a tarde@gmail.com"/,
    );
  });
});

describe('PendingInvitationNotice: la invitación ya pendiente se ofrece reenviar', () => {
  it('dice para quién y ofrece "Reenviar la invitación", que espera mientras sale', () => {
    const html = renderToStaticMarkup(
      createElement(PendingInvitationNotice, {
        email: 'beto@agencia.co',
        resending: false,
        onResend: () => {},
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('Ya hay una invitación pendiente para beto@agencia.co.');
    expect(html).toContain('Reenviar la invitación');
    expect(html).not.toContain('disabled=""');
    // Sin la fila en la lista, igual dice que reenviar conserva el rol y cómo cambiarlo.
    expect(html).toContain('con el mismo rol');
    expect(html).toContain('Para darle otro rol, revoca esa invitación');
    expect(voseoIn(html)).toEqual([]);

    const withRole = renderToStaticMarkup(
      createElement(PendingInvitationNotice, {
        email: 'beto@agencia.co',
        role: 'admin',
        resending: false,
        onResend: () => {},
      }),
    );
    expect(withRole).toContain('Está pendiente como Manager.');
    expect(withRole).toContain('un enlace nuevo con ese rol');
    expect(voseoIn(withRole)).toEqual([]);
    // El rol como lo nombra el selector del diálogo: "Consolidador" se lee como tipo de nodo.
    const consolidator = renderToStaticMarkup(
      createElement(PendingInvitationNotice, {
        email: 'beto@agencia.co',
        role: 'consolidator_admin',
        resending: false,
        onResend: () => {},
      }),
    );
    expect(consolidator).toContain('Está pendiente como Admin de consolidador.');

    const busy = renderToStaticMarkup(
      createElement(PendingInvitationNotice, {
        email: 'beto@agencia.co',
        resending: true,
        onResend: () => {},
      }),
    );
    expect(busy).toContain('Reenviando…');
    expect(busy).toMatch(/<button[^>]* disabled=""/);
  });
});

describe('MemberList: cambio de contraseña pendiente', () => {
  it('la fila lo marca, con el porqué para el lector de pantalla, y sólo si está pendiente', () => {
    const pending = listOf(
      members(parseMembers({ users: [{ ...MEMBER, passwordResetRequired: true }] }) ?? []),
    );
    expect(pending).toContain('Cambio de contraseña pendiente');
    expect(pending).toContain(
      'No puede ingresar hasta que elija una contraseña nueva con el enlace que le enviamos a su correo.',
    );
    expect(pending).toContain('sr-only');
    // Con el tono del tema, como el 2FA pendiente: los tonos fijos no llegan a AA en oscuro.
    const at = pending.indexOf('Cambio de contraseña pendiente');
    const open = pending.lastIndexOf('<span class="', at) + '<span class="'.length;
    expect(pending.slice(open, pending.indexOf('"', open))).toContain(
      'text-[color-mix(in_oklab,var(--color-warning)_60%,var(--color-fg))]',
    );
    expect(voseoIn(pending)).toEqual([]);

    for (const value of [false, undefined]) {
      const html = listOf(
        members(parseMembers({ users: [{ ...MEMBER, passwordResetRequired: value }] }) ?? []),
      );
      expect(html).not.toContain('Cambio de contraseña pendiente');
    }
  });
});

describe('MemberList: filtros del equipo y columna Alta', () => {
  const TEAM =
    parseMembers({
      users: [
        { ...MEMBER, lockedUntil: null, lastLoginAt: new Date(Date.now() - 60_000).toISOString() },
        {
          ...MEMBER,
          userId: 'u3',
          name: 'Carla',
          email: 'carla@agencia.co',
          role: 'vendedor',
          lastLoginAt: null,
          lockedUntil: null,
          createdAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
        },
        {
          ...MEMBER,
          userId: 'u4',
          name: 'Dani',
          email: 'dani@agencia.co',
          role: 'vendedor',
          membershipStatus: 'suspended',
          lockedUntil: null,
          lastLoginAt: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString(),
        },
      ],
    }) ?? [];

  /** Los nombres de las filas, en el orden en que se pintan. */
  const rowNames = (html: string) =>
    html
      .split('<li ')
      .slice(1)
      .map((row) => /<span class="truncate">([^<]+)<\/span>/.exec(row)?.[1]);

  /** Si la chip que empieza con `label` está apretada ("true") o no ("false"). */
  const chip = (html: string, label: string) =>
    new RegExp(`<button[^>]*aria-pressed="(true|false)"[^>]*>${label}`).exec(html)?.[1];

  it('la barra: filtros rápidos con cuántos deja cada uno, rol y ocultar suspendidos', () => {
    const html = members(TEAM);
    expect(html).toContain('role="group" aria-label="Filtrar miembros"');
    expect(chip(html, 'Todos')).toBe('true');
    expect(chip(html, '2FA pendiente \\(1\\)')).toBe('false');
    expect(chip(html, 'Bloqueados \\(0\\)')).toBe('false');
    expect(chip(html, 'Nunca ingresaron \\(1\\)')).toBe('false');
    expect(chip(html, 'Cambio de contraseña pendiente \\(0\\)')).toBe('false');
    expect(html).toContain('<option value="" selected="">Todos los roles</option>');
    // Los roles del nodo, del más alto al más bajo, con el nombre del selector de la fila.
    expect(html.indexOf('<option value="tenant_admin">Admin</option>')).toBeLessThan(
      html.indexOf('<option value="vendedor">Vendedor</option>'),
    );
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*\/>Ocultar suspendidos \(1\)/);
    expect(html).toContain('Filtrar por rol');
    // Sin filtros no hay nada que quitar.
    expect(html).not.toContain('Quitar filtros');
    expect(html).toContain('Miembros (3)');
    expect(html).toContain('Se muestran los 3 miembros.');
    expect(voseoIn(html)).toEqual([]);
  });

  it('un filtro rápido deja sólo a quien corresponde y lo dice en el título', () => {
    const html = members(TEAM, null, CONSOLIDATOR_ADMIN, 'agency', {
      filters: { chip: 'never-logged-in' },
    });
    expect(rowNames(html)).toEqual(['Carla']);
    expect(chip(html, 'Todos')).toBe('false');
    expect(chip(html, 'Nunca ingresaron \\(1\\)')).toBe('true');
    expect(html).toContain('Miembros (1 de 3)');
    expect(html).toContain('role="status" class="sr-only">Se muestra 1 de 3 miembros.');
    expect(html).toContain('Quitar filtros');
  });

  it('rol y ocultar suspendidos se suman, y las chips cuentan sobre lo que queda', () => {
    const html = members(TEAM, null, CONSOLIDATOR_ADMIN, 'agency', {
      filters: { role: 'vendedor', hideSuspended: true },
    });
    expect(rowNames(html)).toEqual(['Carla']);
    expect(html).toContain('<option value="vendedor" selected="">Vendedor</option>');
    expect(html).toMatch(/<input[^>]*checked=""[^>]*\/>Ocultar suspendidos \(1\)/);
    expect(chip(html, '2FA pendiente \\(0\\)')).toBe('false');
    expect(chip(html, 'Nunca ingresaron \\(1\\)')).toBe('false');
  });

  it('nadie coincide: lo dice y ofrece quitar los filtros', () => {
    const html = members(TEAM, null, CONSOLIDATOR_ADMIN, 'agency', {
      filters: { chip: 'locked' },
    });
    expect(rowNames(html)).toEqual([]);
    expect(html).toContain('Nadie coincide con estos filtros.');
    // El de la barra y el de la lista vacía.
    expect(html.match(/Quitar filtros/g)).toHaveLength(2);
    // La barra sigue a la vista para cambiar de filtro.
    expect(chip(html, 'Bloqueados \\(0\\)')).toBe('true');
    expect(html).not.toContain('Ningún usuario coincide con la búsqueda.');
    expect(voseoIn(html)).toEqual([]);
  });

  it('si la búsqueda sola no deja a nadie, se dice eso y no lo de los filtros', () => {
    const html = members(TEAM, null, CONSOLIDATOR_ADMIN, 'agency', {
      filters: { chip: 'locked' },
      search: 'zzz',
    });
    expect(html).toContain('Ningún usuario coincide con la búsqueda.');
    expect(html).not.toContain('Nadie coincide con estos filtros.');
  });

  it('la búsqueda por nombre o correo sigue andando', () => {
    const by = (search: string) =>
      rowNames(members(TEAM, null, CONSOLIDATOR_ADMIN, 'agency', { search }));
    expect(by('CARLA')).toEqual(['Carla']);
    expect(by('dani@')).toEqual(['Dani']);
  });

  it('el encabezado "Último acceso" ordena y dice el orden en su nombre', () => {
    const idle = members(TEAM);
    expect(rowNames(idle)).toEqual(['Beto', 'Carla', 'Dani']);
    expect(idle).toMatch(/<button[^>]*title="Ordenar por último acceso"[^>]*>Último acceso/);
    expect(idle).toContain('<span class="sr-only">, sin ordenar</span>');

    const recent = members(TEAM, null, CONSOLIDATOR_ADMIN, 'agency', {
      filters: { sort: 'last-access-desc' },
    });
    expect(rowNames(recent)).toEqual(['Beto', 'Dani', 'Carla']);
    expect(recent).toContain('<span class="sr-only">, más reciente primero</span>');

    const oldest = members(TEAM, null, CONSOLIDATOR_ADMIN, 'agency', {
      filters: { sort: 'last-access-asc' },
    });
    expect(rowNames(oldest)).toEqual(['Carla', 'Dani', 'Beto']);
    expect(oldest).toContain('<span class="sr-only">, más antiguo primero</span>');
    // En el teléfono no hay encabezado: el orden se elige en la barra.
    expect(oldest).toContain('<option value="last-access-asc" selected="">');
    // Ordenar no es filtrar: no hay nada que quitar.
    expect(oldest).not.toContain('Quitar filtros');
  });

  it('la columna Alta: hace cuánto se sumó al nodo, con la fecha exacta al pasar el mouse', () => {
    const html = members(TEAM);
    expect(html).toContain('>Alta</span>');
    const carla = html.split('<li ').find((row) => row.includes('Carla')) ?? '';
    expect(carla).toMatch(/<time dateTime="[^"]+" title="[^"]+">hace 3 días<\/time>/);
    // Sólo en pantalla ancha (`xl`), igual que su título: en la tarjeta del teléfono no se pinta.
    expect(carla).toContain('min-w-0 text-xs text-[var(--color-fg)] hidden xl:block');
    expect(html).toContain('<span aria-hidden="true" class="hidden xl:block">Alta</span>');
    expect(html).toContain('xl:grid-cols-[');
    const old = members(parseMembers({ users: [MEMBER] }) ?? []);
    // Pasado un mes, la fecha (el día depende del huso del equipo que corre el test).
    expect(old).toMatch(/<time dateTime="2026-01-01T00:00:00.000Z" title="[^"]+">el [^<]+<\/time>/);
    const unknown = members(parseMembers({ users: [{ ...MEMBER, createdAt: '' }] }) ?? []);
    expect(unknown).not.toContain('<time dateTime=""');
  });

  it('sin miembros, cargando o con error no hay barra de filtros', () => {
    for (const html of [members([]), members('loading'), members('error')]) {
      expect(html).not.toContain('Filtrar miembros');
    }
  });
});
