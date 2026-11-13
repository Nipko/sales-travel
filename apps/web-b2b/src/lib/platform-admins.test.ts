import { describe, expect, it } from 'vitest';
import {
  activityApproval,
  activityChanges,
  activityDirectSource,
  activityFiltersFromSearchParams,
  activityFiltersToSearchParams,
  activityReason,
  activitySearch,
  activitySecretChanges,
  actorPlatformRoleLabel,
  DEFAULT_ACTIVITY_FILTERS,
  parseActivityPage,
} from './platform-audit';
import { adminAuditTarget } from './platform-audit-proxy';
import {
  changeRequestsTarget,
  decisionPlan,
  grantPlan,
  parseChangeRequests,
  parsePlatformAdmins,
  parseViewer,
  revokePlan,
  supervisionPlan,
} from './platform-admins';

const UID = '3f1c2b4a-1d2e-4f3a-8b9c-0d1e2f3a4b5c';
const NOW = new Date('2026-11-05T15:00:00Z');

describe('Actividad: "Sólo superadmins"', () => {
  it('va y vuelve en la URL de la pantalla y llega al API', () => {
    const filters = { ...DEFAULT_ACTIVITY_FILTERS, platformOnly: true };
    const params = activityFiltersToSearchParams(filters);
    expect(params.get('solo')).toBe('superadmins');
    expect(activityFiltersFromSearchParams(params).platformOnly).toBe(true);
    expect(activitySearch(filters, NOW)).toContain('platformOnly=true');
    expect(activitySearch(DEFAULT_ACTIVITY_FILTERS, NOW)).not.toContain('platformOnly');
  });

  it('el BFF lo deja pasar sólo como true o false', () => {
    const ok = adminAuditTarget('list', new URLSearchParams('platformOnly=true'));
    expect(ok.ok && ok.path).toContain('platformOnly=true');
    expect(adminAuditTarget('list', new URLSearchParams('platformOnly=si')).ok).toBe(false);
  });

  it('lee el tipo de superadmin de quien actuó, y lo desconocido es null', () => {
    const page = parseActivityPage({
      events: [
        { id: 'a', eventType: 'x', occurredAt: NOW.toISOString(), actorPlatformRole: 'supervised' },
        { id: 'b', eventType: 'x', occurredAt: NOW.toISOString(), actorPlatformRole: 'dios' },
      ],
    });
    expect(page?.events.map((e) => e.actorPlatformRole)).toEqual(['supervised', null]);
    expect(actorPlatformRoleLabel('supervised')).toBe('Superadmin supervisado');
    expect(actorPlatformRoleLabel(null)).toBeNull();
  });
});

describe('qué cambió, por qué y quién lo aprobó', () => {
  it('antes → después, abriendo la config para ver justo la clave que cambió', () => {
    const rows = activityChanges({
      before: { status: 'active', config: { pcc: 'AAA1', bookOnTicketingPcc: false } },
      after: { status: 'active', config: { pcc: 'AAA1', bookOnTicketingPcc: true } },
    });
    expect(rows).toEqual([{ field: 'config.bookOnTicketingPcc', before: 'no', after: 'sí' }]);
  });

  it('un cambio directo en la base: cada columna con su antes y después', () => {
    const payload = {
      table: 'provider_accounts',
      dbUser: 'postgres',
      application: 'psql',
      changes: { status: { before: 'sandbox', after: 'active' } },
      secretColumnsChanged: ['credentials_enc'],
    };
    expect(activityChanges(payload)).toEqual([
      { field: 'status', before: 'sandbox', after: 'active' },
    ]);
    expect(activitySecretChanges(payload)).toEqual(['credentials_enc']);
    expect(activityDirectSource({ eventType: 'db.direct_change', payload })).toEqual({
      table: 'provider_accounts',
      dbUser: 'postgres',
      application: 'psql',
    });
    expect(activityDirectSource({ eventType: 'OrderCreated', payload })).toBeNull();
  });

  it('algo nuevo (sin antes) muestra cada valor; un rol, de cuál a cuál', () => {
    expect(activityChanges({ before: null, after: { supervised: true } })).toEqual([
      { field: 'supervised', before: '—', after: 'sí' },
    ]);
    expect(activityChanges({ previousRole: 'admin', newRole: 'vendedor' })).toEqual([
      { field: 'rol', before: 'admin', after: 'vendedor' },
    ]);
    expect(activityChanges({ status: 'suspended' })).toEqual([]);
  });

  it('el motivo, el secreto que cambió (sin el valor) y la aprobación', () => {
    expect(activityReason({ reason: 'Pidió Sabre' })).toBe('Pidió Sabre');
    expect(activitySecretChanges({ credentialsChanged: true })).toEqual(['credenciales']);
    expect(
      activityApproval({
        approval: { changeRequestId: 'r', requestedBy: 's', approvedBy: 'p', note: 'ok' },
      }),
    ).toEqual({ changeRequestId: 'r', requestedBy: 's', approvedBy: 'p', note: 'ok' });
    expect(activityApproval({})).toBeNull();
  });
});

describe('Superadmins: el BFF', () => {
  it('dar acceso: correo, tipo y motivo reconstruidos', () => {
    expect(grantPlan({ email: ' Ana@X.CO ', supervised: true, reason: '  ', extra: 1 })).toEqual({
      ok: true,
      path: '/admin/platform-admins',
      body: { email: 'ana@x.co', supervised: true, reason: null },
    });
    expect(grantPlan({ email: 'ana', supervised: true }).ok).toBe(false);
    expect(grantPlan({ email: 'ana@x.co' }).ok).toBe(false);
    expect(grantPlan({ email: 'ana@x.co', supervised: false, reason: 'ok' }).ok).toBe(false);
  });

  it('crear la cuenta sólo si se pide, con el nombre si viene', () => {
    expect(
      grantPlan({
        email: 'nueva@x.co',
        supervised: true,
        reason: '',
        createAccount: true,
        name: ' Ana Ruiz ',
      }),
    ).toMatchObject({
      ok: true,
      body: { email: 'nueva@x.co', createAccount: true, name: 'Ana Ruiz' },
    });
    const sinPedir = grantPlan({ email: 'nueva@x.co', supervised: true, name: 'Ana' });
    expect(sinPedir.ok && 'body' in sinPedir ? sinPedir.body : {}).not.toHaveProperty(
      'createAccount',
    );
  });

  it('cambiar el tipo y quitar acceso: sólo con un id válido', () => {
    expect(supervisionPlan(UID, { supervised: false, reason: 'ya no' })).toMatchObject({
      ok: true,
      path: `/admin/platform-admins/${UID}/supervision`,
    });
    expect(supervisionPlan('../x', { supervised: false }).ok).toBe(false);
    expect(revokePlan(UID, {})).toEqual({
      ok: true,
      path: `/admin/platform-admins/${UID}/revoke`,
      body: { reason: null },
    });
  });

  it('decidir: sólo approve, reject o cancel; cancelar sin cuerpo', () => {
    expect(decisionPlan(UID, 'approve', { note: 'listo' })).toEqual({
      ok: true,
      path: `/admin/change-requests/${UID}/approve`,
      body: { note: 'listo' },
    });
    expect(decisionPlan(UID, 'cancel', { note: 'x' })).toEqual({
      ok: true,
      path: `/admin/change-requests/${UID}/cancel`,
      body: {},
    });
    expect(decisionPlan(UID, 'delete', {}).ok).toBe(false);
    expect(changeRequestsTarget(new URLSearchParams('status=pending'))).toEqual({
      ok: true,
      path: '/admin/change-requests?status=pending',
    });
    expect(changeRequestsTarget(new URLSearchParams('status=todo')).ok).toBe(false);
  });
});

describe('Superadmins: las respuestas', () => {
  it('lee la lista, las solicitudes y quién mira; descarta lo ilegible', () => {
    expect(
      parsePlatformAdmins([
        { userId: UID, email: 'a@x.co', supervised: true, mfaEnabled: true },
        { email: 'sin-id@x.co' },
      ]),
    ).toEqual([
      expect.objectContaining({ userId: UID, email: 'a@x.co', supervised: true, mfaEnabled: true }),
    ]);
    expect(
      parseChangeRequests([
        {
          id: 'r1',
          kind: 'governance.rule.set',
          summary: 'Gobierno: apagar sabre',
          status: 'pending',
          requestedBy: { id: UID, email: 'a@x.co' },
          createdAt: NOW.toISOString(),
        },
        { id: 'r2', kind: 'x.y', summary: 's', status: 'raro', requestedBy: { id: UID } },
      ])?.map((r) => r.id),
    ).toEqual(['r1']);
    expect(parseViewer({ userId: UID, standing: 'supervised' })).toEqual({
      userId: UID,
      standing: 'supervised',
    });
    expect(parseViewer({ userId: UID, standing: 'otro' })).toBeUndefined();
  });
});
