import { describe, expect, it } from 'vitest';
import {
  callPolicyLabel,
  choiceOf,
  enablementRequest,
  globalChangeConfirmation,
  globalChangeDialog,
  globalResetOutcome,
  globalSourceLabel,
  globalSwitchState,
  groupByVertical,
  initialReasonFor,
  isProviderCode,
  isTenantId,
  legacyTenantLabels,
  matchTenants,
  normalizeReason,
  originLabel,
  overridesSummary,
  overrideTenantLabel,
  parseEnablementBody,
  parsePlatformProvider,
  parsePlatformProviders,
  parseTenantProviders,
  reasonError,
  savedMessage,
  sortOverrides,
  statusLabel,
  tenantChangeConfirmation,
  tenantChangeDialog,
  updatedLabel,
  requestErrorMessage,
  type PlatformProvider,
  type TenantOverride,
} from './provider-enablement';

/**
 * El panel con el que el superadmin decide quién busca y vende con cada proveedor.
 *
 * Lo que se prueba acá es lo que el superadmin LEE antes de tocar un interruptor: el estado, su
 * origen y lo que va a pasar. Si cualquiera de las tres cosas miente, el panel empuja a apagar a
 * quien no se quería o a creer encendido lo que no lo está.
 */

const CONSOLIDADOR = '10000000-0000-4000-8000-000000000001';
const AGENCIA = '10000000-0000-4000-8000-000000000002';

const SETTING = {
  enabled: true,
  reason: 'Contrato firmado',
  updatedBy: '99999999-9999-4999-8999-999999999999',
  updatedByEmail: 'ana@plataforma.co',
  updatedAt: '2026-09-28T15:00:00.000Z',
};

function platformRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'tbo-hotels',
    vertical: 'hotels',
    callPolicy: 'opt-in',
    defaultEnabled: false,
    killSwitch: null,
    legacyEnv: { allTenants: false, tenantIds: [] },
    global: null,
    overrides: [],
    baseline: { enabled: false, origin: 'default' },
    ...over,
  };
}

function platform(over: Record<string, unknown> = {}): PlatformProvider {
  const parsed = parsePlatformProvider(platformRaw(over));
  if (parsed === undefined) throw new Error('fixture inválida');
  return parsed;
}

function override(over: Partial<TenantOverride> = {}): TenantOverride {
  return {
    ...SETTING,
    tenantId: AGENCIA,
    tenantName: 'Agencia Norte',
    tenantSlug: 'norte',
    ...over,
  };
}

describe('parsePlatformProviders', () => {
  it('lee la lista que manda el API, con global y excepciones', () => {
    const parsed = parsePlatformProviders([
      platformRaw({
        global: SETTING,
        overrides: [override({ enabled: false, reason: null })],
        baseline: { enabled: true, origin: 'global' },
      }),
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.global?.reason).toBe('Contrato firmado');
    expect(parsed?.[0]?.overrides[0]?.tenantName).toBe('Agencia Norte');
    expect(parsed?.[0]?.baseline).toEqual({ enabled: true, origin: 'global' });
  });

  it('un proveedor incompleto invalida la respuesta entera: no se pinta un estado inventado', () => {
    expect(parsePlatformProviders([platformRaw(), { code: 'sabre' }])).toBeUndefined();
    expect(parsePlatformProviders([platformRaw({ baseline: undefined })])).toBeUndefined();
    expect(parsePlatformProviders([platformRaw({ vertical: 'trenes' })])).toBeUndefined();
    expect(parsePlatformProviders([platformRaw({ killSwitch: 'casi' })])).toBeUndefined();
    expect(parsePlatformProviders({ error: 'boom' })).toBeUndefined();
    expect(parsePlatformProviders(null)).toBeUndefined();
  });

  it('una excepción sin tenant o con `enabled` que no es booleano invalida la respuesta', () => {
    expect(
      parsePlatformProviders([platformRaw({ overrides: [{ ...SETTING, tenantId: undefined }] })]),
    ).toBeUndefined();
    expect(
      parsePlatformProviders([platformRaw({ overrides: [override({ enabled: 'sí' as never })] })]),
    ).toBeUndefined();
  });

  it('un "habilitado por el kill-switch" no existe y se rechaza', () => {
    expect(
      parsePlatformProviders([platformRaw({ baseline: { enabled: true, origin: 'kill-switch' } })]),
    ).toBeUndefined();
  });

  it('una lista vacía es válida: la plataforma no tiene proveedores registrados', () => {
    expect(parsePlatformProviders([])).toEqual([]);
  });
});

describe('parseTenantProviders', () => {
  const raw = {
    tenantId: AGENCIA,
    tenantName: 'Agencia Norte',
    tenantSlug: 'norte',
    providers: [
      {
        ...platformRaw(),
        global: undefined,
        overrides: undefined,
        baseline: undefined,
        own: null,
        effective: {
          enabled: true,
          origin: 'tenant',
          originTenantId: CONSOLIDADOR,
          originTenantName: 'Consolidador Andino',
        },
      },
    ],
  };

  it('lee la vista de un tenant con el origen heredado', () => {
    const parsed = parseTenantProviders(raw);
    expect(parsed?.tenantName).toBe('Agencia Norte');
    expect(parsed?.providers[0]?.own).toBeNull();
    expect(parsed?.providers[0]?.effective.originTenantName).toBe('Consolidador Andino');
  });

  it('sin `effective` no hay vista', () => {
    expect(
      parseTenantProviders({ ...raw, providers: [{ ...raw.providers[0], effective: undefined }] }),
    ).toBeUndefined();
    expect(parseTenantProviders({ ...raw, tenantName: undefined })).toBeUndefined();
  });
});

describe('bordes del proxy', () => {
  it('acepta sólo códigos de proveedor con el formato del API', () => {
    expect(isProviderCode('tbo-hotels')).toBe(true);
    expect(isProviderCode('latam-ndc')).toBe(true);
    expect(isProviderCode('../tenants')).toBe(false);
    expect(isProviderCode('Sabre')).toBe(false);
    expect(isProviderCode('')).toBe(false);
    expect(isProviderCode('a'.repeat(65))).toBe(false);
  });

  it('acepta sólo UUIDs como tenant', () => {
    expect(isTenantId(AGENCIA)).toBe(true);
    expect(isTenantId(AGENCIA.toUpperCase())).toBe(true);
    expect(isTenantId('global')).toBe(false);
    expect(isTenantId(`${AGENCIA}/x`)).toBe(false);
  });

  it('reconstruye el cuerpo: sólo `enabled` y `reason`, con el motivo normalizado', () => {
    expect(parseEnablementBody({ enabled: false, reason: '  Deuda vencida  ', extra: 1 })).toEqual({
      enabled: false,
      reason: 'Deuda vencida',
    });
    expect(parseEnablementBody({ enabled: true })).toEqual({ enabled: true, reason: null });
    expect(parseEnablementBody({ enabled: true, reason: '   ' })).toEqual({
      enabled: true,
      reason: null,
    });
  });

  it('rechaza un cuerpo sin `enabled` booleano o con un motivo que no entra', () => {
    expect(parseEnablementBody({ enabled: 'true' })).toBeUndefined();
    expect(parseEnablementBody({ enabled: null })).toBeUndefined();
    expect(parseEnablementBody({ enabled: true, reason: 12 })).toBeUndefined();
    expect(parseEnablementBody({ enabled: true, reason: 'x'.repeat(501) })).toBeUndefined();
    expect(parseEnablementBody(undefined)).toBeUndefined();
  });
});

describe('motivo', () => {
  it('vacío o sólo espacios es "sin motivo"', () => {
    expect(normalizeReason('')).toBeNull();
    expect(normalizeReason('   ')).toBeNull();
    expect(normalizeReason(' ok ')).toBe('ok');
  });

  it('avisa cuando supera el tope de la columna', () => {
    expect(reasonError('x'.repeat(500))).toBeUndefined();
    expect(reasonError(`  ${'x'.repeat(500)}  `)).toBeUndefined();
    expect(reasonError('x'.repeat(501))).toMatch(/500/);
  });
});

describe('control de tres posiciones', () => {
  it('sin ajuste propio es Heredar; con ajuste, lo que diga', () => {
    expect(choiceOf(null)).toBe('inherit');
    expect(choiceOf({ enabled: true })).toBe('enabled');
    expect(choiceOf({ enabled: false })).toBe('disabled');
  });

  it('Heredar es quitar el ajuste (DELETE), no un `enabled: null`', () => {
    expect(enablementRequest('inherit', 'lo que sea')).toEqual({ method: 'DELETE' });
  });

  it('Habilitado y Deshabilitado son un PUT con el motivo normalizado', () => {
    expect(enablementRequest('enabled', ' Piloto ')).toEqual({
      method: 'PUT',
      body: { enabled: true, reason: 'Piloto' },
    });
    expect(enablementRequest('disabled', '')).toEqual({
      method: 'PUT',
      body: { enabled: false, reason: null },
    });
  });

  it('el diálogo arranca con el motivo guardado sólo si no cambia el estado', () => {
    const saved = { enabled: true, reason: 'Contrato firmado' };
    expect(initialReasonFor(saved, 'enabled')).toBe('Contrato firmado');
    expect(initialReasonFor(saved, 'disabled')).toBe('');
    expect(initialReasonFor(saved, 'inherit')).toBe('');
    expect(initialReasonFor(null, 'enabled')).toBe('');
    expect(initialReasonFor({ enabled: false, reason: null }, 'disabled')).toBe('');
  });
});

describe('interruptor "Todos los tenants"', () => {
  it('con ajuste global, manda el ajuste', () => {
    expect(globalSwitchState(platform({ global: { ...SETTING, enabled: false } }))).toEqual({
      on: false,
      source: 'global',
    });
  });

  it('sin ajuste, la variable legado para todos lo muestra encendido', () => {
    const p = platform({ legacyEnv: { allTenants: true, tenantIds: [] } });
    expect(globalSwitchState(p)).toEqual({ on: true, source: 'legacy-env' });
    expect(globalSourceLabel(p)).toContain('HOTEL_PROVIDERS_OPT_IN');
  });

  it('sin ajuste ni legado, decide la política del proveedor', () => {
    expect(globalSwitchState(platform())).toEqual({ on: false, source: 'default' });
    expect(globalSwitchState(platform({ callPolicy: 'always', defaultEnabled: true }))).toEqual({
      on: true,
      source: 'default',
    });
    expect(globalSourceLabel(platform())).toMatch(/apagado hasta que alguien lo habilite/);
  });

  it('el kill-switch no mueve el interruptor: se avisa aparte', () => {
    const p = platform({
      global: SETTING,
      killSwitch: 'all',
      baseline: { enabled: false, origin: 'kill-switch', killSwitch: 'all' },
    });
    expect(globalSwitchState(p).on).toBe(true);
  });

  it('restablecer cae a la variable legado o a la política', () => {
    expect(globalResetOutcome(platform({ global: SETTING }))).toEqual({
      on: false,
      source: 'default',
    });
    expect(
      globalResetOutcome(
        platform({ global: SETTING, legacyEnv: { allTenants: true, tenantIds: [] } }),
      ),
    ).toEqual({ on: true, source: 'legacy-env' });
  });
});

describe('estado efectivo y origen', () => {
  const hotels = { vertical: 'hotels', callPolicy: 'opt-in' } as const;

  it('dice el estado en palabras', () => {
    expect(statusLabel({ enabled: true })).toBe('Habilitado');
    expect(statusLabel({ enabled: false })).toBe('Deshabilitado');
  });

  it('distingue el ajuste propio del heredado de un ancestro', () => {
    const own = { enabled: false, origin: 'tenant', originTenantId: AGENCIA } as const;
    expect(originLabel(own, hotels, AGENCIA)).toBe('Ajuste propio de esta agencia.');
    const inherited = {
      enabled: true,
      origin: 'tenant',
      originTenantId: CONSOLIDADOR,
      originTenantName: 'Consolidador Andino',
    } as const;
    expect(originLabel(inherited, hotels, AGENCIA)).toBe('Heredado de Consolidador Andino.');
    expect(originLabel({ ...inherited, originTenantName: null }, hotels, AGENCIA)).toBe(
      'Heredado de un nivel superior de la red.',
    );
  });

  it('el kill-switch dice si la post-venta sigue', () => {
    expect(
      originLabel({ enabled: false, origin: 'kill-switch', killSwitch: 'sales' }, hotels),
    ).toMatch(/la post-venta sigue/);
    expect(
      originLabel({ enabled: false, origin: 'kill-switch', killSwitch: 'all' }, hotels),
    ).toMatch(/incluida la post-venta/);
  });

  it('nombra la variable legado de la vertical', () => {
    expect(originLabel({ enabled: true, origin: 'legacy-env' }, hotels)).toContain(
      'HOTEL_PROVIDERS_OPT_IN',
    );
    expect(
      originLabel(
        { enabled: true, origin: 'legacy-env' },
        { vertical: 'flights', callPolicy: 'always' },
      ),
    ).toContain('FLIGHT_PROVIDERS_OPT_IN');
  });

  it('global y política', () => {
    expect(originLabel({ enabled: true, origin: 'global' }, hotels)).toBe(
      'Ajuste global de la plataforma.',
    );
    expect(originLabel({ enabled: false, origin: 'default' }, hotels)).toMatch(/Sin ajustes/);
  });
});

describe('confirmaciones', () => {
  it('deshabilitar un tenant se confirma y dice que la post-venta sigue', () => {
    const c = tenantChangeConfirmation({
      providerCode: 'tbo-hotels',
      tenantName: 'Agencia Norte',
      from: 'inherit',
      to: 'disabled',
    });
    expect(c?.destructive).toBe(true);
    expect(c?.title).toBe('¿Deshabilitar TBO Holidays para Agencia Norte?');
    expect(c?.description).toMatch(/su red/);
    expect(c?.description).toMatch(/cancelando/);
  });

  it('volver a heredar desde Habilitado se confirma: lo heredado puede estar apagado', () => {
    const c = tenantChangeConfirmation({
      providerCode: 'tbo-hotels',
      tenantName: 'Agencia Norte',
      from: 'enabled',
      to: 'inherit',
    });
    expect(c?.confirmLabel).toBe('Heredar');
  });

  it('habilitar o volver a heredar desde Deshabilitado no se confirma', () => {
    for (const [from, to] of [
      ['inherit', 'enabled'],
      ['disabled', 'enabled'],
      ['disabled', 'inherit'],
      ['enabled', 'enabled'],
    ] as const) {
      expect(
        tenantChangeConfirmation({ providerCode: 'sabre', tenantName: 'X', from, to }),
      ).toBeNull();
    }
  });

  it('apagar para todos se confirma y recuerda las excepciones que siguen valiendo', () => {
    const p = platform({ global: SETTING, overrides: [override(), override()] });
    const c = globalChangeConfirmation(p, { kind: 'set', enabled: false });
    expect(c?.destructive).toBe(true);
    expect(c?.title).toBe('¿Deshabilitar TBO Holidays para todos los tenants?');
    expect(c?.description).toMatch(/Las 2 excepciones/);
  });

  it('encender para todos también se confirma, sin tono destructivo', () => {
    const c = globalChangeConfirmation(platform(), { kind: 'set', enabled: true });
    expect(c?.destructive).toBe(false);
    expect(c?.confirmLabel).toBe('Habilitar para todos');
  });

  it('un cambio global que no cambia nada no se confirma', () => {
    expect(
      globalChangeConfirmation(platform({ global: SETTING }), { kind: 'set', enabled: true }),
    ).toBeNull();
    // Quitar un "Deshabilitado" global de un opt-in: debajo también está apagado.
    expect(
      globalChangeConfirmation(platform({ global: { ...SETTING, enabled: false } }), {
        kind: 'reset',
      }),
    ).toBeNull();
  });

  it('quitar el ajuste global que lo encendía avisa que queda apagado', () => {
    const c = globalChangeConfirmation(platform({ global: SETTING }), { kind: 'reset' });
    expect(c?.destructive).toBe(true);
    expect(c?.title).toBe('¿Quitar el ajuste global de TBO Holidays?');
    expect(c?.description).toMatch(/Ningún tenant/);
  });

  it('quitar un "Deshabilitado" global con la variable legado encendida lo vuelve a encender', () => {
    const p = platform({
      global: { ...SETTING, enabled: false },
      legacyEnv: { allTenants: true, tenantIds: [] },
    });
    const c = globalChangeConfirmation(p, { kind: 'reset' });
    expect(c?.destructive).toBe(false);
    expect(c?.description).toMatch(/HOTEL_PROVIDERS_OPT_IN/);
  });

  it('quitar un "Deshabilitado" global vuelve a encender a los que la variable legado lista uno por uno', () => {
    // Los tenants sin excepción siguen apagados (política opt-in), pero el ajuste global era lo
    // único que le ganaba a `tbo-hotels@<tenant>`: sin él, esos vuelven a buscar.
    const p = platform({
      global: { ...SETTING, enabled: false },
      legacyEnv: { allTenants: false, tenantIds: [AGENCIA, CONSOLIDADOR] },
    });
    const c = globalChangeConfirmation(p, { kind: 'reset' });
    expect(c).not.toBeNull();
    expect(c?.destructive).toBe(false);
    expect(c?.description).toMatch(/los 2 tenants que habilita uno por uno vuelven a buscar/);
    const d = globalChangeDialog(p, { kind: 'reset' });
    expect(d.description).not.toMatch(/ningún tenant cambia de estado/);
  });

  it('deshabilitar para todos apaga a los que la variable legado lista, aunque el resto ya estuviera apagado', () => {
    const p = platform({ legacyEnv: { allTenants: false, tenantIds: [AGENCIA] } });
    const c = globalChangeConfirmation(p, { kind: 'set', enabled: false });
    expect(c?.destructive).toBe(true);
    expect(c?.description).toMatch(/el tenant que habilita por su cuenta deja de buscar/);
    expect(c?.description).toMatch(/cancelando/);
  });

  it('la variable legado no cuenta para un tenant con excepción propia: ese no se mueve', () => {
    const p = platform({
      global: { ...SETTING, enabled: false },
      legacyEnv: { allTenants: false, tenantIds: [AGENCIA] },
      overrides: [override({ tenantId: AGENCIA })],
    });
    expect(globalChangeConfirmation(p, { kind: 'reset' })).toBeNull();
  });
});

describe('diálogos de cambio', () => {
  it('todo cambio pasa por un diálogo; sólo se pide motivo al fijar un ajuste', () => {
    const enable = tenantChangeDialog({
      providerCode: 'sabre',
      tenantName: 'Agencia Norte',
      from: 'inherit',
      to: 'enabled',
    });
    expect(enable.title).toBe('¿Habilitar Sabre GDS para Agencia Norte?');
    expect(enable.withReason).toBe(true);
    expect(enable.destructive).toBe(false);

    const inherit = tenantChangeDialog({
      providerCode: 'sabre',
      tenantName: 'Agencia Norte',
      from: 'disabled',
      to: 'inherit',
    });
    expect(inherit.withReason).toBe(false);
    expect(inherit.confirmLabel).toBe('Heredar');
  });

  it('la confirmación de deshabilitar es el mismo diálogo, con motivo', () => {
    const d = tenantChangeDialog({
      providerCode: 'sabre',
      tenantName: 'Agencia Norte',
      from: 'enabled',
      to: 'disabled',
    });
    expect(d.destructive).toBe(true);
    expect(d.withReason).toBe(true);
  });

  it('misma posición = editar sólo el motivo', () => {
    const d = tenantChangeDialog({
      providerCode: 'sabre',
      tenantName: 'Agencia Norte',
      from: 'disabled',
      to: 'disabled',
    });
    expect(d.confirmLabel).toBe('Guardar motivo');
    expect(d.destructive).toBe(false);
  });

  it('global: apagar confirma; quitar un ajuste que no cambia nada lo dice', () => {
    expect(
      globalChangeDialog(platform({ global: SETTING }), { kind: 'set', enabled: false })
        .destructive,
    ).toBe(true);
    const reset = globalChangeDialog(platform({ global: { ...SETTING, enabled: false } }), {
      kind: 'reset',
    });
    expect(reset.destructive).toBe(false);
    expect(reset.withReason).toBe(false);
    expect(reset.description).toMatch(/ningún tenant cambia de estado/);
  });

  it('global: fijar lo que ya decide la política queda escrito sin cambiar a nadie', () => {
    const d = globalChangeDialog(platform(), { kind: 'set', enabled: false });
    expect(d.withReason).toBe(true);
    expect(d.description).toMatch(/ningún tenant cambia de estado/);
  });

  it('el aviso tras guardar dice qué quedó y para quién', () => {
    expect(savedMessage('tbo-hotels', 'disabled')).toBe(
      'TBO Holidays: deshabilitado para todos los tenants.',
    );
    expect(savedMessage('tbo-hotels', 'inherit')).toBe('TBO Holidays: sin ajuste global.');
    expect(savedMessage('sabre', 'enabled', 'Agencia Norte')).toBe(
      'Sabre GDS: habilitado para Agencia Norte.',
    );
    expect(savedMessage('sabre', 'inherit', 'Agencia Norte')).toBe(
      'Sabre GDS: Agencia Norte vuelve a heredar.',
    );
  });

  it('nombra la política del proveedor', () => {
    expect(callPolicyLabel('opt-in')).toBe('Requiere habilitación');
    expect(callPolicyLabel('always')).toBe('Se consulta en cada búsqueda');
    expect(callPolicyLabel('fallback')).toBe('De respaldo');
  });
});

describe('listas', () => {
  it('agrupa por vertical en el orden de la navegación y sin grupos vacíos', () => {
    const groups = groupByVertical([
      { vertical: 'hotels', code: 'tbo-hotels' },
      { vertical: 'flights', code: 'sabre' },
      { vertical: 'hotels', code: 'despegar-hotels' },
    ] as const);
    expect(groups.map((g) => g.label)).toEqual(['Vuelos', 'Hoteles']);
    expect(groups[1]?.providers.map((p) => p.code)).toEqual(['tbo-hotels', 'despegar-hotels']);
  });

  it('una excepción de un tenant sin nombre se muestra por su id, nunca en blanco', () => {
    expect(overrideTenantLabel({ tenantId: AGENCIA, tenantName: null })).toBe('Tenant 10000000');
    expect(overrideTenantLabel({ tenantId: AGENCIA, tenantName: '  ' })).toBe('Tenant 10000000');
  });

  it('ordena las excepciones por nombre, sin importar tildes ni mayúsculas', () => {
    const sorted = sortOverrides([
      override({ tenantName: 'Zeta' }),
      override({ tenantName: 'ágora' }),
      override({ tenantName: 'Beta' }),
    ]);
    expect(sorted.map((o) => o.tenantName)).toEqual(['ágora', 'Beta', 'Zeta']);
  });

  it('resume las excepciones', () => {
    expect(overridesSummary([])).toBeNull();
    expect(overridesSummary([{ enabled: true }])).toBe('1 habilitado');
    expect(overridesSummary([{ enabled: true }, { enabled: true }, { enabled: false }])).toBe(
      '2 habilitados · 1 deshabilitado',
    );
  });

  it('busca tenants por nombre o slug, sin tildes, y deja fuera los que ya tienen excepción', () => {
    const tenants = [
      { id: CONSOLIDADOR, name: 'Consolidador Andino', slug: 'andino' },
      { id: AGENCIA, name: 'Agencia Norte', slug: 'norte' },
      { id: '10000000-0000-4000-8000-000000000003', name: 'Viajes Bogotá', slug: 'bogota' },
    ];
    expect(matchTenants(tenants, 'bogota', new Set()).map((t) => t.slug)).toEqual(['bogota']);
    expect(matchTenants(tenants, 'BOGOTÁ', new Set()).map((t) => t.slug)).toEqual(['bogota']);
    expect(matchTenants(tenants, 'no', new Set([AGENCIA])).map((t) => t.slug)).toEqual(['andino']);
    expect(matchTenants(tenants, '   ', new Set())).toEqual([]);
    expect(matchTenants(tenants, 'a', new Set(), 2)).toHaveLength(2);
  });

  it('nombra los tenants de la variable legado, o su id si no se conoce', () => {
    const names = new Map([[AGENCIA, 'Agencia Norte']]);
    expect(
      legacyTenantLabels({ allTenants: false, tenantIds: [AGENCIA, CONSOLIDADOR] }, names),
    ).toEqual(['Agencia Norte', 'Tenant 10000000']);
  });

  it('dice quién y cuándo', () => {
    // El formato exacto de la fecha es del ICU del entorno; lo que importa es quién y el año.
    expect(updatedLabel(SETTING)).toMatch(/^por ana@plataforma\.co · .*28.*2026$/);
    expect(updatedLabel({ updatedAt: 'no-es-fecha', updatedByEmail: null })).toBe('');
  });
});

describe('errores de escritura', () => {
  it('traduce la sesión y el permiso; el resto usa el mensaje del API', () => {
    expect(requestErrorMessage(403, 'superadmin access required', 'write')).toMatch(
      /Sólo el superadmin/,
    );
    expect(requestErrorMessage(401, undefined, 'read')).toMatch(/sesión/);
    expect(requestErrorMessage(404, "El proveedor 'x' no existe en la plataforma.", 'write')).toBe(
      "El proveedor 'x' no existe en la plataforma.",
    );
  });

  it('sin mensaje, dice qué no se pudo hacer', () => {
    expect(requestErrorMessage(500, '  ', 'write')).toMatch(/No se pudo guardar/);
    expect(requestErrorMessage(500, undefined, 'read')).toMatch(/No se pudo cargar/);
  });
});
