import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseSeatsView, type SeatsView } from '../../../../../lib/tenant-admin-seats';
import {
  parseInvitations,
  parseMembers,
  teamActorOf,
  type NetworkMember,
} from '../../../../../lib/tenant-admin-team';
import { InvitationList } from './invitation-list';
import { MemberList, type MemberRowError } from './member-list';
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
    expect(html).toContain('Vos');
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
    expect(html).toContain('no ocupan puesto y no se listan acá');
    expect(html).not.toMatch(/Nadie de este nodo|\(0\)|0 personas|conectadas? ahora/);
  });

  it('nadie ocupando un puesto es distinto de un error', () => {
    const empty = seatsCard({ status: 'ready', view: seatsView({ sessions: [], inUse: 0 }) });
    expect(empty).toContain('Ocupan un puesto ahora (0)');
    expect(empty).toContain('Nadie de este nodo ocupa un puesto ahora.');
    const error = seatsCard({ status: 'error', message: 'No administrás este nodo.' });
    expect(error).toContain('role="alert"');
    expect(error).toContain('No administrás este nodo.');
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

function members(
  items: readonly NetworkMember[] | 'error' | 'loading',
  memberError: MemberRowError | null = null,
): string {
  const state =
    items === 'error'
      ? ({ status: 'error', message: 'No tenés permiso para ver el equipo de este nodo.' } as const)
      : items === 'loading'
        ? ({ status: 'loading' } as const)
        : ({ status: 'ready', items } as const);
  return renderToStaticMarkup(
    createElement(MemberList, {
      state,
      search: '',
      actor: teamActorOf('me', [{ role: 'consolidator_admin', status: 'active' }]),
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

describe('MemberList', () => {
  it('un error no se muestra como "no tiene usuarios"', () => {
    const html = members('error');
    expect(html).toContain('role="alert"');
    expect(html).toContain('No tenés permiso');
    expect(html).not.toContain('no tiene usuarios');
  });

  it('vacío con llamado a invitar', () => {
    const html = members([]);
    expect(html).toContain('Esta agencia no tiene usuarios todavía.');
    expect(html).toContain('Invitá a tu primer vendedor');
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
    const message = 'No lo pudimos hacer: También pertenece a una agencia que no administrás.';
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
    const html = members(parseMembers({ users: [MEMBER, { ...online, userId: 'u4' }] }) ?? []);
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
    expect(html).toContain('Vos');
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
    const html = renderToStaticMarkup(createElement(InvitationList, { items, onRevoke: () => {} }));

    expect(html).toContain('Invitaciones pendientes (2)');
    expect(html).toContain('Invitado por ana@agencia.co · hace 2 días');
    expect(html).toContain('Invitado por un usuario eliminado · hace 1 día');
    expect(html).toContain('aria-label="Revocar la invitación a nuevo@gmail.com"');
  });
});
