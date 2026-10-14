import { describe, expect, it } from 'vitest';
import {
  AUDIT_FILTERS,
  auditLoadError,
  categoryOf,
  eventDetail,
  eventLabel,
  isAuditFilter,
  networkAuditUrl,
  parseAuditPage,
  type AuditEntryView,
} from './audit-format';

const ANA = 'ana@agencia.com';
const NODO = '11111111-1111-4111-8111-111111111111';

function entry(
  eventType: string,
  payload: Record<string, unknown> = {},
  targetEmail: string | null = null,
): Pick<AuditEntryView, 'eventType' | 'payload' | 'targetEmail'> {
  return { eventType, payload, targetEmail };
}

describe('eventLabel', () => {
  it('cada tipo conocido tiene su frase', () => {
    const expected: Record<string, string> = {
      UserInvited: 'Invitación enviada',
      UserInvitationResent: 'Invitación reenviada',
      UserInvitationRevoked: 'Invitación revocada',
      UserInvitationAccepted: 'Invitación aceptada',
      UserInvitationRejected: 'Invitación rechazada (ya no era válida)',
      UserInvitationAccountMismatch: 'Invitación rechazada (otra cuenta intentó aceptarla)',
      UserProfileUpdated: 'Cambió su nombre',
      MembershipRoleChanged: 'Cambio de rol',
      MembershipRemoved: 'Quitado del nodo',
      'auth.mfa.reset_by_admin': '2FA restablecido por un administrador',
      'auth.sessions.revoked_by_admin': 'Sesiones cerradas por un administrador',
      'auth.session.revoked_by_admin': 'Sesión cerrada por un administrador',
      'auth.session.released_by_admin': 'Puesto liberado',
      'auth.password_reset.sent_by_admin': 'Enlace para restablecer contraseña enviado',
      'auth.password_reset.required_by_admin': 'Cambio de contraseña forzado',
      'auth.lockout.cleared_by_admin': 'Cuenta desbloqueada',
      'auth.login.success': 'Ingresó',
      'auth.login.failed': 'Ingreso fallido',
      'auth.login.blocked': 'Ingreso bloqueado por intentos',
      'auth.login.password_reset_required': 'Ingreso frenado: debe cambiar su contraseña',
      'auth.password_reset.requested': 'Pidió restablecer su contraseña',
      'auth.password_reset.completed': 'Restableció su contraseña',
      'auth.password_changed': 'Cambió su contraseña',
      'auth.mfa.enabled': '2FA activado',
      'auth.mfa.disabled': '2FA desactivado',
      'auth.mfa.step_up': 'Reconfirmó su 2FA para una acción de alto impacto',
      'auth.mfa.reauth_failed': 'Verificación fallida dentro de su sesión',
      'users.exported': 'Exportó la lista de usuarios',
      TenantCreated: 'Nodo creado',
      ProviderCredentialsUpdated: 'Credenciales de proveedor actualizadas',
      MarkupRuleCreated: 'Regla de markup creada',
      MarkupRuleDeleted: 'Regla de markup eliminada',
    };
    for (const [type, text] of Object.entries(expected)) {
      expect(eventLabel(type, {}), type).toEqual({ text, raw: false });
    }
  });

  it('suspender o reactivar dice cuál de las dos, en el nodo y en toda la plataforma', () => {
    expect(eventLabel('MembershipStatusChanged', { status: 'suspended' }).text).toBe(
      'Acceso al nodo suspendido',
    );
    expect(eventLabel('MembershipStatusChanged', { status: 'active' }).text).toBe(
      'Acceso al nodo reactivado',
    );
    expect(eventLabel('UserStatusChanged', { status: 'suspended' }).text).toBe(
      'Cuenta suspendida en toda la plataforma',
    );
    expect(eventLabel('UserStatusChanged', { status: 'active' }).text).toBe('Cuenta reactivada');
  });

  it('un tipo sin etiqueta sale con su código, marcado como crudo', () => {
    expect(eventLabel('SomethingNew', {})).toEqual({ text: 'SomethingNew', raw: true });
    expect(eventLabel('portfolio.algo_nuevo', {})).toEqual({
      text: 'portfolio.algo_nuevo',
      raw: true,
    });
  });
});

describe('eventDetail', () => {
  it('cambio de rol: a quién y de qué a qué, con los nombres de los roles', () => {
    expect(
      eventDetail(
        entry(
          'MembershipRoleChanged',
          { targetUserId: 'x', previousRole: 'vendedor', newRole: 'agency_admin' },
          ANA,
        ),
      ),
    ).toBe(`a ${ANA} · de Vendedor a Admin agencia`);
  });

  it('las acciones de un admin sobre alguien dicen a quién', () => {
    for (const type of [
      'auth.mfa.reset_by_admin',
      'auth.password_reset.sent_by_admin',
      'auth.lockout.cleared_by_admin',
      'auth.session.revoked_by_admin',
      'auth.session.released_by_admin',
    ]) {
      expect(eventDetail(entry(type, { targetUserId: 'x' }, ANA)), type).toBe(`a ${ANA}`);
    }
    expect(eventDetail(entry('auth.sessions.revoked_by_admin', { revoked: 3 }, ANA))).toBe(
      `a ${ANA} · 3 sesiones cerradas`,
    );
    expect(
      eventDetail(entry('auth.password_reset.required_by_admin', { revokedSessions: 1 }, ANA)),
    ).toBe(`a ${ANA} · 1 sesión cerrada`);
    expect(eventDetail(entry('UserStatusChanged', { revokedSessions: 0 }, ANA))).toBe(`a ${ANA}`);
    expect(eventDetail(entry('MembershipStatusChanged', { role: 'vendedor' }, ANA))).toBe(
      `a ${ANA} · Vendedor`,
    );
  });

  it('invitaciones: a qué correo, con qué rol y por qué cayó', () => {
    expect(
      eventDetail(entry('UserInvited', { email: 'nuevo@agencia.com', role: 'tenant_admin' })),
    ).toBe('a nuevo@agencia.com · como Admin');
    expect(
      eventDetail(entry('UserInvitationAccepted', { email: 'nuevo@agencia.com', role: 'admin' })),
    ).toBe('nuevo@agencia.com · como Manager');
    expect(eventDetail(entry('UserInvitationResent', { role: 'vendedor' }))).toBe('como Vendedor');
    expect(eventDetail(entry('UserInvitationRevoked', { role: 'vendedor', cause: 'manual' }))).toBe(
      'como Vendedor',
    );
    expect(eventDetail(entry('UserInvitationRevoked', { cause: 'user_suspended' }))).toBe(
      'al suspender la cuenta de quien la envió',
    );
    expect(eventDetail(entry('UserInvitationRevoked', { cause: 'membership_removed' }))).toBe(
      'al quitar del nodo a quien la envió',
    );
    expect(eventDetail(entry('UserInvitationRejected', { defect: 'tenant_inactive' }))).toBe(
      'el nodo está suspendido',
    );
  });

  it('ingresos: cómo entró o por qué no', () => {
    expect(eventDetail(entry('auth.login.success', { method: 'mfa' }))).toBe(
      'Con contraseña y 2FA',
    );
    expect(eventDetail(entry('auth.login.failed', { reason: 'bad_password' }))).toBe(
      'Contraseña incorrecta',
    );
    expect(eventDetail(entry('auth.login.failed', { reason: 'otro' }))).toBe('');
    expect(eventDetail(entry('auth.login.password_reset_required', { linkSent: true }))).toBe(
      'Se le reenvió el enlace',
    );
  });

  it('verificación fallida dentro de la sesión: qué intentaba y si bloqueó la cuenta', () => {
    expect(eventDetail(entry('auth.mfa.reauth_failed', { action: 'enroll', locked: false }))).toBe(
      'Contraseña incorrecta al activar el 2FA',
    );
    expect(eventDetail(entry('auth.mfa.reauth_failed', { action: 'step_up', locked: true }))).toBe(
      'Al reconfirmar el 2FA · Cuenta bloqueada por intentos',
    );
    expect(eventDetail(entry('auth.mfa.reauth_failed', { action: 'otra' }))).toBe('');
  });

  it('cambio de nombre: de cuál a cuál, o sólo el nuevo si no tenía', () => {
    const payload = (before: unknown, after: unknown) => ({
      changed: ['name'],
      before: { name: before },
      after: { name: after },
    });
    expect(eventDetail(entry('UserProfileUpdated', payload('Ana Ruiz', 'Ana María Ruiz')))).toBe(
      'de «Ana Ruiz» a «Ana María Ruiz»',
    );
    expect(eventDetail(entry('UserProfileUpdated', payload(null, 'Ana')))).toBe('«Ana»');
    expect(eventDetail(entry('UserProfileUpdated', payload('Ana', null)))).toBe('');
    expect(eventDetail(entry('UserProfileUpdated', { changed: ['name'] }))).toBe('');
    expect(categoryOf('UserProfileUpdated')).toBe('users');
  });

  it('exportar la lista de usuarios (USR-16): qué se exportó y cuántas personas, sin ids', () => {
    expect(
      eventDetail(
        entry('users.exported', {
          scope: 'platform',
          filters: { search: true, role: 'vendedor', tenantId: NODO },
          users: 1234,
          rows: 1500,
          truncated: false,
        }),
      ),
    ).toBe('Toda la plataforma · 1.234 personas');
    expect(
      eventDetail(
        entry('users.exported', {
          scope: 'node',
          filters: { tenantId: NODO },
          users: 10_000,
          truncated: true,
        }),
      ),
    ).toBe('El equipo del nodo · 10.000 personas (hasta el tope)');
    expect(eventDetail(entry('users.exported', { scope: 'node', users: 1 }))).toBe(
      'El equipo del nodo · 1 persona',
    );
    expect(eventDetail(entry('users.exported', { scope: 'otro', users: -1 }))).toBe('');
    expect(eventLabel('users.exported', {})).toEqual({
      text: 'Exportó la lista de usuarios',
      raw: false,
    });
  });

  it('credenciales, precios y nodos', () => {
    expect(
      eventDetail(
        entry('ProviderCredentialsUpdated', { providerCode: 'tbo-hotels', label: 'default' }),
      ),
    ).toBe('tbo-hotels · default');
    expect(
      eventDetail(entry('MarkupRuleCreated', { vertical: 'hotels', ruleType: 'percentage' })),
    ).toBe('Hoteles · porcentaje');
    expect(eventDetail(entry('MarkupRuleCreated', { vertical: 'cruceros' }))).toBe('cruceros');
    expect(eventDetail(entry('TenantCreated', { slug: 'agencia-norte' }))).toBe('agencia-norte');
  });

  it('un tipo sin detalle propio muestra a quién, si hay; un payload raro no rompe nada', () => {
    expect(eventDetail(entry('OrderCreated', {}, ANA))).toBe(`a ${ANA}`);
    expect(eventDetail(entry('OrderCreated', {}))).toBe('');
    expect(
      eventDetail(
        entry('MembershipRoleChanged', { previousRole: 7, newRole: null, revoked: 'x' }, null),
      ),
    ).toBe('');
    expect(eventDetail(entry('auth.sessions.revoked_by_admin', { revoked: -2 }, null))).toBe('');
  });

  it('nunca muestra ids', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    for (const type of ['MembershipRoleChanged', 'auth.mfa.reset_by_admin', 'OrderCreated']) {
      expect(eventDetail(entry(type, { targetUserId: id, invitedBy: id }, ANA))).not.toContain(id);
    }
  });
});

describe('categoryOf', () => {
  it('espeja los filtros del API por el prefijo del tipo', () => {
    expect(categoryOf('auth.login.failed')).toBe('users');
    expect(categoryOf('users.exported')).toBe('users');
    expect(categoryOf('UserInvited')).toBe('users');
    expect(categoryOf('MembershipRoleChanged')).toBe('users');
    expect(categoryOf('ProviderCredentialsUpdated')).toBe('credentials');
    expect(categoryOf('MarkupRuleDeleted')).toBe('pricing');
    expect(categoryOf('TenantCreated')).toBe('network');
    expect(categoryOf('tenant.branding.updated')).toBe('network');
    expect(categoryOf('OrderCreated')).toBeNull();
    expect(categoryOf('ProviderPayloadsExported')).toBeNull();
  });

  it('los filtros son Todo y las cuatro categorías', () => {
    expect(AUDIT_FILTERS.map((f) => f.label)).toEqual([
      'Todo',
      'Usuarios',
      'Credenciales',
      'Precios',
      'Red',
    ]);
    expect(isAuditFilter('pricing')).toBe(true);
    expect(isAuditFilter('orders')).toBe(false);
  });
});

describe('parseAuditPage', () => {
  it('lee lo que manda el API', () => {
    expect(
      parseAuditPage({
        events: [
          {
            id: 'e1',
            occurredAt: '2026-10-13T12:00:00.000Z',
            eventType: 'auth.login.success',
            tenantId: 't1',
            tenantName: 'Norte',
            actorEmail: ANA,
            targetEmail: null,
            aggregateType: 'user',
            payload: { method: 'password' },
          },
        ],
        nextBefore: 'abc',
      }),
    ).toEqual({
      events: [
        {
          id: 'e1',
          occurredAt: '2026-10-13T12:00:00.000Z',
          eventType: 'auth.login.success',
          tenantId: 't1',
          tenantName: 'Norte',
          actorEmail: ANA,
          targetEmail: null,
          payload: { method: 'password' },
        },
      ],
      nextBefore: 'abc',
    });
  });

  it('nunca lanza: lo ilegible se descarta y una respuesta rara es una página vacía', () => {
    for (const raw of [null, undefined, 'texto', 42, [], { events: 'no' }]) {
      expect(parseAuditPage(raw)).toEqual({ events: [], nextBefore: null });
    }
    const page = parseAuditPage({
      events: [
        null,
        { id: 'sin-tipo', occurredAt: '2026-10-13T12:00:00Z' },
        { id: 'fecha-rara', eventType: 'X', occurredAt: 'ayer' },
        { id: 'ok', eventType: 'X', occurredAt: '2026-10-13T12:00:00Z', payload: [1] },
      ],
      nextBefore: 7,
    });
    expect(page.events.map((e) => e.id)).toEqual(['ok']);
    expect(page.events[0]?.payload).toEqual({});
    expect(page.nextBefore).toBeNull();
  });
});

describe('auditLoadError', () => {
  it('un mensaje por estado, el del API si vino', () => {
    expect(auditLoadError(401, {})).toBe('Tu sesión venció. Vuelve a ingresar.');
    expect(auditLoadError(403, { error: 'No administras este nodo.' })).toBe(
      'No administras este nodo.',
    );
    expect(auditLoadError(403, null)).toBe('No tienes acceso a la actividad de este nodo.');
    expect(auditLoadError(400, {})).toBe(
      'Los filtros de la actividad no son válidos. Recarga la página.',
    );
    expect(auditLoadError(502, { error: 'detalle interno' })).toBe(
      'No pudimos cargar la actividad. Inténtalo de nuevo.',
    );
  });
});

describe('networkAuditUrl', () => {
  it('el nodo, el filtro si no es Todo y el cursor si hay', () => {
    expect(networkAuditUrl('t1', 'all')).toBe('/api/tenants/network/audit?tenantId=t1');
    expect(networkAuditUrl('t1', 'users', 'abc_-')).toBe(
      '/api/tenants/network/audit?tenantId=t1&category=users&before=abc_-',
    );
  });
});
