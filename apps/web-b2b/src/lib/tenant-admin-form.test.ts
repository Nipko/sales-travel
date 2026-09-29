import { describe, expect, it } from 'vitest';
import {
  createdMessage,
  currencyForCountry,
  emptyDraft,
  nodeDraftPayload,
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

  it('datos del admin sin email: o todos o ninguno', () => {
    expect(validateNodeDraft(draft({ adminName: 'Ana' })).adminEmail).toMatch(/dejá vacíos/);
  });

  it('email y contraseña del admin con el formato del API', () => {
    const errors = validateNodeDraft(draft({ adminEmail: 'no-es-email', adminPassword: 'corta' }));
    expect(errors.adminEmail).toBe('Ese email no parece válido.');
    expect(errors.adminPassword).toMatch(/12 caracteres/);
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

  it('con admin: email en minúsculas; sin contraseña, se lo invita', () => {
    const payload = nodeDraftPayload(
      draft({ kind: 'consolidator', adminEmail: ' Ana@Andes.CO ', adminName: ' Ana ' }),
    );
    expect(payload).toMatchObject({
      tenantType: 'consolidator',
      adminEmail: 'ana@andes.co',
      adminName: 'Ana',
    });
    expect(payload).not.toHaveProperty('adminPassword');
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
    expect(msg.detail).toMatch(/reenviala desde Usuarios/);
  });
});
