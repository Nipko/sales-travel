import { describe, expect, it } from 'vitest';
import {
  createdMessage,
  currencyForCountry,
  emptyDraft,
  nodeDraftPayload,
  seatFieldsPolicy,
  validateNodeDraft,
  type NodeDraft,
} from './tenant-admin-form';

const PLATFORM_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function draft(patch: Partial<NodeDraft> = {}): NodeDraft {
  return {
    ...emptyDraft('branch', PLATFORM_ID),
    name: 'Planetour Bogotá',
    slug: 'planetour-bogota',
    ...patch,
  };
}

describe('validateNodeDraft', () => {
  it('un borrador completo sin admin se puede enviar', () => {
    expect(validateNodeDraft(draft())).toEqual({});
  });

  it('pide tipo, padre, nombre y un slug válido', () => {
    const errors = validateNodeDraft(
      draft({ kind: undefined, parentTenantId: '', name: ' ', slug: 'Con Espacios' }),
    );
    expect(Object.keys(errors).sort()).toEqual(['kind', 'name', 'parentTenantId', 'slug']);
    expect(errors.slug).toMatch(/minúsculas/);
  });

  it('el email del admin, si viene, con el formato del API', () => {
    expect(validateNodeDraft(draft({ adminEmail: 'no-es-email' })).adminEmail).toBe(
      'Ese email no parece válido.',
    );
    expect(validateNodeDraft(draft({ adminEmail: 'ana@andes.co' }))).toEqual({});
  });

  it('el borrador no tiene contraseña ni nombre del admin: se lo invita (docs/platform/14)', () => {
    expect(emptyDraft('agency', PLATFORM_ID)).not.toHaveProperty('adminPassword');
    expect(emptyDraft('agency', PLATFORM_ID)).not.toHaveProperty('adminName');
  });
});

describe('nodeDraftPayload: lo que se manda al API', () => {
  it('una sucursal viaja como agencia marcada, bajo Planetour y sin datos de admin vacíos', () => {
    expect(nodeDraftPayload(draft())).toEqual({
      name: 'Planetour Bogotá',
      slug: 'planetour-bogota',
      countryCode: 'CO',
      defaultCurrency: 'COP',
      defaultLanguage: 'es',
      parentTenantId: PLATFORM_ID,
      tenantType: 'agency',
      isBranch: true,
    });
  });

  it('con admin: sólo su email, en minúsculas; nunca una contraseña', () => {
    const payload = nodeDraftPayload(draft({ kind: 'consolidator', adminEmail: ' Ana@Andes.CO ' }));
    expect(payload).toMatchObject({ tenantType: 'consolidator', adminEmail: 'ana@andes.co' });
    expect(payload).not.toHaveProperty('adminPassword');
    expect(payload).not.toHaveProperty('adminName');
    expect(payload).not.toHaveProperty('isBranch');
  });

  it('sin tipo o sin padre no hay nada que mandar', () => {
    expect(nodeDraftPayload(draft({ kind: undefined }))).toBeUndefined();
    expect(nodeDraftPayload(draft({ parentTenantId: '' }))).toBeUndefined();
  });
});

describe('currencyForCountry', () => {
  it('propone la moneda del país y respeta la elegida si no lo conoce', () => {
    expect(currencyForCountry('BR', 'COP')).toBe('BRL');
    expect(currencyForCountry('EC', 'COP')).toBe('USD');
    expect(currencyForCountry('US', 'PEN')).toBe('PEN');
  });
});

describe('createdMessage', () => {
  const tenant = {
    id: 'x',
    tenantType: 'agency',
    isBranch: true,
    parentTenantId: PLATFORM_ID,
    status: 'active',
    depth: 2,
  };

  it('dice qué se creó y bajo quién', () => {
    expect(createdMessage({ tenant }, 'branch', 'Planetour Bogotá', 'Planetour S.A.S')).toEqual({
      title: 'Sucursal Planetour Bogotá creada bajo Planetour S.A.S.',
      warn: false,
    });
    expect(createdMessage({ tenant }, 'consolidator', 'Andes', 'Planetour S.A.S').title).toBe(
      'Consolidador Andes creado bajo Planetour S.A.S.',
    );
  });

  it('avisa si la invitación del admin no salió', () => {
    const msg = createdMessage(
      { tenant, admin: { email: 'ana@andes.co', status: 'invite_failed' } },
      'agency',
      'Andes',
      'Planetour S.A.S',
    );
    expect(msg.warn).toBe(true);
    expect(msg.detail).toMatch(/invítalo desde Equipo/);
  });

  it('invitado: a quién, cuándo vence y dónde reenviarla', () => {
    const msg = createdMessage(
      {
        tenant,
        admin: { email: 'ana@andes.co', status: 'invited', expiresAt: '2026-10-06T15:00:00.000Z' },
      },
      'agency',
      'Andes',
      'Planetour S.A.S',
      new Date('2026-09-29T15:00:00.000Z'),
    );
    expect(msg.warn).toBe(false);
    expect(msg.detail).toBe(
      'Invitamos a ana@andes.co (la invitación vence en 7 días): elige su contraseña al aceptar. Si no le llega, reenvíala desde Equipo.',
    );
  });
});

describe('puestos e inactividad en el alta (sólo superadmin)', () => {
  it('sólo el superadmin los fija; bajo la plataforma el cupo es obligatorio', () => {
    expect(seatFieldsPolicy(false, 'platform')).toBeUndefined();
    expect(seatFieldsPolicy(true, 'platform')).toEqual({ seatsRequired: true });
    expect(seatFieldsPolicy(true, 'consolidator')).toEqual({ seatsRequired: false });
    expect(seatFieldsPolicy(true, undefined)).toEqual({ seatsRequired: false });
  });

  it('sin política no se validan (quien no es superadmin no los ve)', () => {
    expect(validateNodeDraft(draft({ concurrentSeats: 'x' }))).toEqual({});
  });

  it('bajo la plataforma, vacío es un error', () => {
    const errors = validateNodeDraft(draft(), { seatsRequired: true });
    expect(errors.concurrentSeats).toMatch(/Indicá cuántos/);
    expect(validateNodeDraft(draft({ concurrentSeats: '5' }), { seatsRequired: true })).toEqual({});
  });

  it('más abajo, vacío es heredar; fuera de rango o inactividad rara es un error', () => {
    expect(validateNodeDraft(draft(), { seatsRequired: false })).toEqual({});
    // 4 min queda fuera del rango del API (5-480).
    const errors = validateNodeDraft(draft({ concurrentSeats: '0', idleTimeoutMinutes: '4' }), {
      seatsRequired: false,
    });
    expect(errors.concurrentSeats).toMatch(/entre 1 y/);
    expect(errors.idleTimeoutMinutes).toMatch(/Elegí uno/);
  });

  it('viajan sólo si tienen valor', () => {
    expect(
      nodeDraftPayload(draft({ concurrentSeats: '12', idleTimeoutMinutes: '60' })),
    ).toMatchObject({ concurrentSeats: 12, idleTimeoutMinutes: 60 });
    const inherit = nodeDraftPayload(draft());
    expect(inherit).not.toHaveProperty('concurrentSeats');
    expect(inherit).not.toHaveProperty('idleTimeoutMinutes');
  });
});
