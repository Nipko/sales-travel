import { describe, expect, it } from 'vitest';
import {
  CIRCUIT_RESET_CONFIRM,
  circuitBadge,
  circuitResetToast,
  ENV_KILL_SWITCH_NOTICE,
  healthCounters,
  KILL_EXPIRY_OPTIONS,
  KILL_LEVEL_OPTIONS,
  killSwitchClearedToast,
  killSwitchDialogCopy,
  killSwitchSetToast,
  panelKillSwitchLine,
  parseCircuitResetBody,
  parseClearKillSwitchBody,
  parseKillSwitchBody,
  parseProviderHealth,
  parseProviderHealthList,
  requiredReasonError,
  typedCodeMatches,
} from './provider-health';

const SUPERADMIN = '99999999-9999-4999-8999-999999999999';

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'tbo-hotels',
    vertical: 'hotels',
    circuit: { state: 'closed', failures: 0, openedAt: null, lastFailureAt: null },
    suspendedAccounts: 0,
    killSwitch: { effective: null, env: null, panel: null },
    accountIssues24h: 0,
    ...over,
  };
}

const PANEL = {
  level: 'sales',
  reason: 'TBO cobra de más',
  setBy: SUPERADMIN,
  setByEmail: 'root@plataforma.co',
  setAt: '2026-10-13T12:00:00.000Z',
  expiresAt: null,
};

describe('parseProviderHealth', () => {
  it('lee un proveedor sano y uno apagado desde el panel', () => {
    expect(parseProviderHealth(raw())).toEqual(raw());
    const apagado = raw({
      killSwitch: { effective: 'sales', env: null, panel: PANEL },
      accountIssues24h: null,
      suspendedAccounts: 2,
    });
    expect(parseProviderHealth(apagado)).toEqual(apagado);
  });

  it('el efectivo es el más amplio de la variable y el panel', () => {
    expect(
      parseProviderHealth(raw({ killSwitch: { effective: 'all', env: 'all', panel: PANEL } })),
    ).toBeDefined();
    expect(
      parseProviderHealth(
        raw({ killSwitch: { effective: 'all', env: 'sales', panel: { ...PANEL, level: 'all' } } }),
      ),
    ).toBeDefined();
  });

  it.each([
    ['sin código', { code: '' }],
    ['una vertical que no existe', { vertical: 'trenes' }],
    [
      'un estado de circuito que no existe',
      { circuit: { state: 'roto', failures: 0, openedAt: null, lastFailureAt: null } },
    ],
    [
      'fallos negativos',
      { circuit: { state: 'closed', failures: -1, openedAt: null, lastFailureAt: null } },
    ],
    ['cuentas en pausa no enteras', { suspendedAccounts: 1.5 }],
    ['avisos como texto', { accountIssues24h: '3' }],
    [
      'un efectivo que no cuadra con la variable ni el panel',
      { killSwitch: { effective: null, env: 'sales', panel: null } },
    ],
    [
      'un panel sin motivo',
      { killSwitch: { effective: 'sales', env: null, panel: { ...PANEL, reason: undefined } } },
    ],
    ['sin apagado', { killSwitch: undefined }],
  ])('rechaza la respuesta entera: %s', (_q, over) => {
    expect(parseProviderHealth(raw(over))).toBeUndefined();
    expect(parseProviderHealthList([raw(), raw(over)])).toBeUndefined();
  });

  it('la lista tiene que ser una lista', () => {
    expect(parseProviderHealthList({ providers: [] })).toBeUndefined();
    expect(parseProviderHealthList([raw()])).toHaveLength(1);
  });
});

describe('la salud en palabras', () => {
  it.each([
    [{ state: 'closed', failures: 0 }, 'Funcionando', 'success'],
    [{ state: 'closed', failures: 3 }, 'Con fallos (3)', 'warning'],
    [{ state: 'open', failures: 5 }, 'No responde: circuito abierto', 'danger'],
    [{ state: 'half-open', failures: 5 }, 'Probando si volvió', 'warning'],
  ] as const)('%j → %s', (circuit, label, tone) => {
    expect(circuitBadge(circuit)).toEqual({ label, tone });
  });

  it('los contadores sólo aparecen cuando no son cero', () => {
    expect(healthCounters({ suspendedAccounts: 0, accountIssues24h: 0 })).toEqual([]);
    expect(healthCounters({ suspendedAccounts: 0, accountIssues24h: null })).toEqual([]);
    expect(healthCounters({ suspendedAccounts: 2, accountIssues24h: 4 })).toEqual([
      'Cuentas en pausa: 2',
      'Avisos de cuenta en 24 h: 4',
    ]);
  });

  it('el apagado del panel dice qué corta, cuándo vence y quién lo puso', () => {
    expect(panelKillSwitchLine({ ...PANEL, level: 'sales' })).toBe(
      'Apagado desde el panel (solo ventas) · sin vencimiento · por root@plataforma.co',
    );
    const vence = panelKillSwitchLine({
      ...PANEL,
      level: 'all',
      setByEmail: null,
      expiresAt: '2026-10-13T13:00:00.000Z',
    });
    expect(vence).toMatch(/^Apagado desde el panel \(todo\) · vence /);
    expect(vence).not.toContain('por ');
  });

  it('el aviso del apagado por variable y la confirmación de cerrar el circuito', () => {
    expect(ENV_KILL_SWITCH_NOTICE).toBe(
      'Apagado por la variable PROVIDERS_DISABLED. Se quita desplegando (ver el runbook).',
    );
    expect(CIRCUIT_RESET_CONFIRM).toBe(
      'El proveedor vuelve a recibir llamadas de inmediato. Si sigue fallando, el circuito se abre otra vez.',
    );
  });
});

describe('el apagado de emergencia', () => {
  it('el diálogo nombra el proveedor y pide su código', () => {
    expect(killSwitchDialogCopy('tbo-hotels')).toEqual({
      title: 'Apagado de emergencia de TBO Holidays',
      description:
        'Corta el proveedor para toda la plataforma, por encima de cualquier ajuste por agencia. No hace falta desplegar.',
      typedLabel: 'Escribe tbo-hotels para confirmar',
      confirmLabel: 'Apagar TBO Holidays',
    });
  });

  it('las opciones: qué corta y cuándo vence', () => {
    expect(KILL_LEVEL_OPTIONS.map((o) => `${o.label}: ${o.detail}`)).toEqual([
      'Solo ventas: se frenan búsquedas, pre-reservas y reservas nuevas; lo ya vendido se sigue consultando y cancelando.',
      'Todo: también la post-venta (consultas, cancelaciones y conciliación).',
    ]);
    expect(KILL_EXPIRY_OPTIONS).toEqual([
      { value: 60, label: 'En 1 hora' },
      { value: 240, label: 'En 4 horas' },
      { value: 1440, label: 'En 24 horas' },
      { value: null, label: 'Sin vencimiento' },
    ]);
  });

  it('la confirmación escrita: el código exacto, sin espacios ni mayúsculas que importen', () => {
    expect(typedCodeMatches('tbo-hotels', 'tbo-hotels')).toBe(true);
    expect(typedCodeMatches('  TBO-Hotels ', 'tbo-hotels')).toBe(true);
    expect(typedCodeMatches('', 'tbo-hotels')).toBe(false);
    expect(typedCodeMatches('tbo', 'tbo-hotels')).toBe(false);
    expect(typedCodeMatches('TBO Holidays', 'tbo-hotels')).toBe(false);
  });

  it('el motivo es obligatorio, de 5 a 500', () => {
    expect(requiredReasonError('')).toBe('Escribe el motivo: queda en la auditoría.');
    expect(requiredReasonError('  ab  ')).toMatch(/al menos 5/);
    expect(requiredReasonError('x'.repeat(501))).toMatch(/500/);
    expect(requiredReasonError(' Cobra de más ')).toBeUndefined();
  });

  it('los avisos tras apagar, reanudar y cerrar el circuito', () => {
    expect(killSwitchSetToast('tbo-hotels', 'sales')).toBe(
      'TBO Holidays quedó apagado (solo ventas).',
    );
    expect(killSwitchSetToast('tbo-hotels', 'all')).toBe('TBO Holidays quedó apagado (todo).');
    expect(killSwitchClearedToast('tbo-hotels')).toBe('TBO Holidays volvió a operar.');
    expect(killSwitchClearedToast('tbo-hotels', 'sales')).toBe(
      'Se levantó el apagado del panel, pero TBO Holidays sigue apagado por la variable PROVIDERS_DISABLED.',
    );
    expect(circuitResetToast('tbo-hotels')).toBe('TBO Holidays: circuito cerrado.');
  });
});

describe('los cuerpos que cruzan el proxy', () => {
  const OK = { level: 'all', reason: ' Responde basura ', expiresInMinutes: 60 };

  it('el apagado se rearma campo por campo', () => {
    expect(parseKillSwitchBody({ ...OK, providerCode: 'otro' })).toEqual({
      level: 'all',
      reason: 'Responde basura',
      expiresInMinutes: 60,
    });
    expect(parseKillSwitchBody({ ...OK, expiresInMinutes: null })).toMatchObject({
      expiresInMinutes: null,
    });
  });

  it.each([
    ['sin cuerpo', undefined],
    ['un nivel que no existe', { ...OK, level: 'ventas' }],
    ['motivo corto', { ...OK, reason: 'ok' }],
    ['motivo no texto', { ...OK, reason: 5 }],
    ['vencimiento fuera de la lista', { ...OK, expiresInMinutes: 30 }],
    ['sin vencimiento declarado', { level: 'all', reason: 'Responde basura' }],
  ])('rechaza el apagado: %s', (_q, body) => {
    expect(parseKillSwitchBody(body)).toBeUndefined();
  });

  it('levantar: motivo opcional', () => {
    expect(parseClearKillSwitchBody(undefined)).toEqual({ reason: null });
    expect(parseClearKillSwitchBody({})).toEqual({ reason: null });
    expect(parseClearKillSwitchBody({ reason: '  ' })).toEqual({ reason: null });
    expect(parseClearKillSwitchBody({ reason: ' Listo ', level: 'all' })).toEqual({
      reason: 'Listo',
    });
    expect(parseClearKillSwitchBody({ reason: 'x'.repeat(501) })).toBeUndefined();
    expect(parseClearKillSwitchBody({ reason: 3 })).toBeUndefined();
    expect(parseClearKillSwitchBody('motivo')).toBeUndefined();
  });

  it('cerrar el circuito: motivo obligatorio', () => {
    expect(parseCircuitResetBody({ reason: ' Sabre volvió ' })).toEqual({ reason: 'Sabre volvió' });
    expect(parseCircuitResetBody({ reason: 'ya' })).toBeUndefined();
    expect(parseCircuitResetBody(undefined)).toBeUndefined();
  });
});
