import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chunk,
  LEGACY_DIALOG_COPY,
  LEGACY_RESET_BATCH_MAX,
  legacyAccountName,
  legacyCalloutText,
  legacyConfirmCopy,
  legacyDoneMessage,
  legacyLoadError,
  legacyProgressLabel,
  legacyResetError,
  legacyResultView,
  legacySubmitLabel,
  loadLegacyAccounts,
  parseLegacyAccountsList,
  parseLegacyResetBatch,
  requireLegacyResets,
  type LegacyAccount,
  type LegacyResetResult,
} from './legacy-passwords';
import { isStepUpCancelled, registerStepUpPrompt } from './step-up';
import { voseoIn } from './voseo';

/*
 * Las cuentas heredadas con una contraseña de un admin (USR-14) desde el navegador: qué se lee del
 * API, cómo se dice cada resultado, los lotes de a 50, la reconfirmación del 2FA en el medio (USR-13)
 * y qué pasa cuando un lote falla a mitad de camino.
 */

const NORTE = '11111111-1111-4111-8111-111111111111';
const ANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BETO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const MFA_403 = {
  error: 'Confirma con tu código de verificación en dos pasos para seguir.',
  reason: 'MFA_RECENT_REQUIRED',
};

function apiAccount(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    email: `${id.slice(0, 4)}@agencia.co`,
    name: 'Ana Pérez',
    createdAt: '2026-06-01T12:00:00.000Z',
    lastLoginAt: null,
    activeNodes: 1,
    origin: { tenantId: NORTE, tenantName: 'Agencia Norte', createdByEmail: 'admin@norte.co' },
    ...patch,
  };
}

function ids(n: number): string[] {
  return Array.from(
    { length: n },
    (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
  );
}

/** Los ids que mandó un pedido (el cuerpo siempre es el JSON que arma la llamada). */
function bodyIds(init: RequestInit | undefined): string[] {
  const body = typeof init?.body === 'string' ? init.body : '{}';
  return (JSON.parse(body) as { userIds?: string[] }).userIds ?? [];
}

/** Lo que respondería el API a un lote: todas enviadas. */
function sentBatch(init?: RequestInit): Response {
  const body = { userIds: bodyIds(init) };
  return json(200, {
    results: body.userIds.map((userId) => ({ userId, status: 'sent', revokedSessions: 0 })),
    counts: { sent: body.userIds.length, emailFailed: 0, skipped: 0, failed: 0 },
  });
}

function postedIds(call: number): string[] {
  return bodyIds(fetchMock.mock.calls[call]?.[1]);
}

let unregister: (() => void) | null = null;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  unregister?.();
  unregister = null;
  vi.unstubAllGlobals();
});

describe('lo que trae el API', () => {
  it('la lista: cada cuenta con su origen; lo que falta se lee con un valor seguro', () => {
    const list = parseLegacyAccountsList({
      users: [
        apiAccount(ANA),
        apiAccount(BETO, {
          name: null,
          activeNodes: 'dos',
          origin: { tenantId: NORTE, tenantName: 'Norte', createdByEmail: null },
        }),
        { id: 'sin-origen', email: 'x@y.co', createdAt: '2026-06-01T00:00:00Z' },
      ],
      truncated: true,
    });
    expect(list?.truncated).toBe(true);
    expect(list?.users.map((u) => u.id)).toEqual([ANA, BETO]);
    expect(list?.users[1]).toMatchObject({
      name: null,
      activeNodes: 0,
      origin: { createdByEmail: null },
    });
  });

  it('una forma rara es un error, no una lista vacía', () => {
    expect(parseLegacyAccountsList({ cuentas: [] })).toBeUndefined();
    expect(parseLegacyAccountsList(null)).toBeUndefined();
    expect(parseLegacyAccountsList({ users: [] })).toEqual({ users: [], truncated: false });
  });

  it('los resultados de un lote; un estado desconocido invalida la respuesta', () => {
    expect(
      parseLegacyResetBatch({
        results: [
          { userId: ANA, status: 'sent', revokedSessions: 2 },
          { userId: BETO, status: 'skipped', reason: 'already_required' },
          { userId: NORTE, status: 'skipped', reason: 'otro' },
        ],
      }),
    ).toEqual([
      { userId: ANA, status: 'sent', revokedSessions: 2 },
      { userId: BETO, status: 'skipped', reason: 'already_required' },
      { userId: NORTE, status: 'skipped', reason: 'not_candidate' },
    ]);
    expect(parseLegacyResetBatch({ results: [{ userId: ANA, status: 'raro' }] })).toBeUndefined();
    expect(parseLegacyResetBatch({})).toBeUndefined();
  });

  it('en lotes del tamaño del API', () => {
    expect(LEGACY_RESET_BATCH_MAX).toBe(50);
    expect(chunk(ids(120), 50).map((c) => c.length)).toEqual([50, 50, 20]);
    expect(chunk([], 50)).toEqual([]);
  });
});

describe('cómo se dice, en tú', () => {
  const account = (patch: Partial<LegacyAccount> = {}): LegacyAccount => ({
    ...(parseLegacyAccountsList({ users: [apiAccount(ANA)] })!.users[0] as LegacyAccount),
    ...patch,
  });

  it('el aviso: cuántas, y "más de" si la lista se cortó; sin cuentas, nada', () => {
    expect(legacyCalloutText({ users: [account()], truncated: false })).toBe(
      'Hay 1 cuenta con una contraseña que eligió un admin antes del alta por invitación.',
    );
    expect(legacyCalloutText({ users: [account(), account({ id: BETO })], truncated: false })).toBe(
      'Hay 2 cuentas con una contraseña que eligió un admin antes del alta por invitación.',
    );
    expect(legacyCalloutText({ users: [account()], truncated: true })).toBe(
      'Hay más de 1 cuenta con una contraseña que eligió un admin antes del alta por invitación.',
    );
    expect(legacyCalloutText({ users: [], truncated: false })).toBeNull();
  });

  it('el nombre, o el correo si no tiene', () => {
    expect(legacyAccountName(account())).toBe('Ana Pérez');
    expect(legacyAccountName(account({ name: '  ' }))).toBe('aaaa@agencia.co');
  });

  it('el botón, la confirmación y la espera', () => {
    expect(legacySubmitLabel(0)).toBe('Elige al menos una cuenta');
    expect(legacySubmitLabel(1)).toBe('Forzar el cambio a 1 cuenta');
    expect(legacySubmitLabel(12)).toBe('Forzar el cambio a 12 cuentas');
    expect(legacyConfirmCopy(12)).toEqual({
      title: 'Forzar el cambio de contraseña a 12 cuentas',
      description:
        'Se cierran sus sesiones y cada persona recibe un enlace para elegir una contraseña nueva. No pueden ingresar hasta hacerlo.',
      confirmLabel: 'Forzar el cambio',
    });
    expect(legacyConfirmCopy(1).description).toBe(
      'Se cierran sus sesiones y recibe un enlace para elegir una contraseña nueva. No puede ingresar hasta hacerlo.',
    );
    expect(legacyProgressLabel(50, 120)).toBe('Forzando el cambio… 50 de 120');
  });

  it('cada resultado, con qué hacer cuando hace falta', () => {
    const view = (r: LegacyResetResult) => legacyResultView(r);
    expect(view({ userId: ANA, status: 'sent', revokedSessions: 1 })).toEqual({
      label: 'Enlace enviado',
      hint: null,
      tone: 'ok',
    });
    expect(view({ userId: ANA, status: 'email_failed', revokedSessions: 0 })).toMatchObject({
      label: 'Cambio forzado, pero el correo no salió',
      tone: 'warn',
    });
    expect(view({ userId: ANA, status: 'skipped', reason: 'already_required' }).label).toBe(
      'Omitida: ya tenía el cambio pendiente',
    );
    expect(view({ userId: ANA, status: 'skipped', reason: 'password_changed' }).label).toBe(
      'Omitida: ya eligió su propia contraseña',
    );
    expect(view({ userId: ANA, status: 'skipped', reason: 'suspended' }).label).toBe(
      'Omitida: la cuenta está suspendida',
    );
    expect(view({ userId: ANA, status: 'skipped', reason: 'self' }).label).toBe(
      'Omitida: es tu cuenta',
    );
    expect(view({ userId: ANA, status: 'skipped', reason: 'not_candidate' }).label).toBe(
      'Omitida: ya no es una cuenta heredada',
    );
    expect(view({ userId: ANA, status: 'failed' })).toMatchObject({ tone: 'danger' });
    expect(view({ userId: ANA, status: 'unknown' })).toMatchObject({
      label: 'Sin confirmar',
      tone: 'warn',
    });
    expect(view({ userId: ANA, status: 'not_processed' }).label).toBe('Sin procesar');
  });

  it('el aviso al terminar', () => {
    expect(
      legacyDoneMessage({
        results: [
          { userId: ANA, status: 'sent', revokedSessions: 0 },
          { userId: BETO, status: 'email_failed', revokedSessions: 0 },
          { userId: NORTE, status: 'skipped', reason: 'already_required' },
        ],
        error: null,
      }),
    ).toBe(
      'Listo: 2 cuentas tienen que elegir una contraseña nueva. 1 se omitió. A 1 no le llegó el correo: al intentar ingresar le llega otro.',
    );
    expect(
      legacyDoneMessage({
        results: [{ userId: ANA, status: 'sent', revokedSessions: 0 }],
        error: null,
      }),
    ).toBe('Listo: 1 cuenta tiene que elegir una contraseña nueva.');
    expect(
      legacyDoneMessage({
        results: [
          { userId: ANA, status: 'skipped', reason: 'self' },
          { userId: BETO, status: 'skipped', reason: 'not_candidate' },
        ],
        error: null,
      }),
    ).toBe('No se forzó el cambio a ninguna cuenta. 2 se omitieron.');
    // Sin respuesta no se dice "ninguna": pudo aplicarse.
    expect(
      legacyDoneMessage({
        results: [
          { userId: ANA, status: 'sent', revokedSessions: 0 },
          { userId: BETO, status: 'unknown' },
          { userId: NORTE, status: 'not_processed' },
        ],
        error: 'El servidor no respondió a tiempo.',
      }),
    ).toBe('Listo: 1 cuenta tiene que elegir una contraseña nueva. 1 cuenta quedó sin confirmar.');
    expect(legacyDoneMessage({ results: [{ userId: ANA, status: 'unknown' }], error: 'x' })).toBe(
      '1 cuenta quedó sin confirmar.',
    );
  });

  it('por qué no cargó o no se aplicó', () => {
    expect(legacyLoadError(401, undefined)).toMatch(/sesión venció/);
    expect(legacyLoadError(403, 'Esta acción es sólo para el superadmin.')).toBe(
      'Esta acción es sólo para el superadmin.',
    );
    expect(legacyLoadError(502, 'detalle')).toMatch(/el servidor no respondió/);
    expect(legacyResetError(429, undefined)).toBe(
      'Forzaste varios lotes seguidos. Espera un minuto y vuelve a intentarlo.',
    );
    expect(legacyResetError(524, undefined)).toMatch(/Vuelve a abrir la lista/);
    expect(legacyResetError(403, undefined)).toBe('Esta acción es sólo para el superadmin.');
    expect(legacyResetError(400, 'elige al menos una cuenta')).toBe('elige al menos una cuenta');
  });

  it('ningún texto usa voseo', () => {
    const texts = [
      ...Object.values(LEGACY_DIALOG_COPY),
      legacyCalloutText({ users: [account(), account({ id: BETO })], truncated: true }) ?? '',
      legacySubmitLabel(0),
      legacySubmitLabel(3),
      ...Object.values(legacyConfirmCopy(1)),
      ...Object.values(legacyConfirmCopy(3)),
      legacyProgressLabel(1, 2),
      ...(['sent', 'email_failed', 'failed', 'unknown', 'not_processed'] as const).flatMap(
        (status) => {
          const result: LegacyResetResult =
            status === 'sent' || status === 'email_failed'
              ? { userId: ANA, status, revokedSessions: 0 }
              : { userId: ANA, status };
          const v = legacyResultView(result);
          return [v.label, v.hint ?? ''];
        },
      ),
      ...(
        ['self', 'suspended', 'already_required', 'password_changed', 'not_candidate'] as const
      ).map((reason) => legacyResultView({ userId: ANA, status: 'skipped', reason }).label),
      legacyLoadError(401, undefined),
      legacyLoadError(500, undefined),
      legacyResetError(429, undefined),
      legacyResetError(500, undefined),
    ];
    expect(voseoIn(texts.join('\n'))).toEqual([]);
  });
});

describe('las llamadas del navegador', () => {
  it('la lista por la ruta del panel', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { users: [apiAccount(ANA)], truncated: false }));
    const res = await loadLegacyAccounts();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/legacy-passwords');
    expect(res).toMatchObject({ ok: true, data: { users: [{ id: ANA }] } });

    fetchMock.mockResolvedValueOnce(
      json(403, {
        error: 'Esta acción es sólo para el superadmin.',
        reason: 'SUPERADMIN_REQUIRED',
      }),
    );
    expect(await loadLegacyAccounts()).toEqual({
      ok: false,
      message: 'Esta acción es sólo para el superadmin.',
    });
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await loadLegacyAccounts()).toMatchObject({
      ok: false,
      message: expect.stringMatching(/No pudimos conectar/),
    });
  });

  it('en lotes de 50, uno después del otro, con el avance', async () => {
    fetchMock.mockImplementation((_url, init) => Promise.resolve(sentBatch(init)));
    const progress: number[] = [];
    const res = await requireLegacyResets(ids(120), (done) => progress.push(done));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/admin/legacy-passwords/require-reset');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', cache: 'no-store' });
    expect([postedIds(0).length, postedIds(1).length, postedIds(2).length]).toEqual([50, 50, 20]);
    expect(progress).toEqual([50, 100, 120]);
    expect(res).toMatchObject({ ok: true, data: { error: null } });
    if (!res.ok || isStepUpCancelled(res)) throw new Error('esperaba la corrida');
    expect(res.data.results).toHaveLength(120);
    expect(res.data.results.every((r) => r.status === 'sent')).toBe(true);
  });

  it('sin el 2FA reciente pide el código y repite el lote una vez', async () => {
    const prompt = vi.fn(() => Promise.resolve(true));
    unregister = registerStepUpPrompt(prompt);
    fetchMock
      .mockResolvedValueOnce(json(403, MFA_403))
      .mockImplementationOnce((_url, init) => Promise.resolve(sentBatch(init)));
    const res = await requireLegacyResets([ANA]);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ ok: true, data: { results: [{ userId: ANA, status: 'sent' }] } });
  });

  it('si se cierra el diálogo en el primer lote no se hizo nada', async () => {
    unregister = registerStepUpPrompt(() => Promise.resolve(false));
    fetchMock.mockResolvedValueOnce(json(403, MFA_403));
    const res = await requireLegacyResets(ids(60));
    expect(isStepUpCancelled(res)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('si el primer lote falla, vuelve el error tal cual', async () => {
    fetchMock.mockResolvedValueOnce(
      json(403, {
        error: 'Esta acción es sólo para el superadmin.',
        reason: 'SUPERADMIN_REQUIRED',
      }),
    );
    expect(await requireLegacyResets(ids(60))).toEqual({
      ok: false,
      message: 'Esta acción es sólo para el superadmin.',
      reason: 'SUPERADMIN_REQUIRED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('si el primero no responde, pudo aplicarse: "sin confirmar", no un error que lo dé por no hecho', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>524</html>', { status: 524 }));
    const res = await requireLegacyResets(ids(60));
    if (!res.ok || isStepUpCancelled(res)) throw new Error('esperaba la corrida');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const statuses = res.data.results.map((r) => r.status);
    expect(statuses.slice(0, 50).every((s) => s === 'unknown')).toBe(true);
    expect(statuses.slice(50).every((s) => s === 'not_processed')).toBe(true);
    expect(res.data.error).toMatch(/Vuelve a abrir la lista/);
    expect(legacyDoneMessage(res.data)).toBe('50 cuentas quedaron sin confirmar.');

    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    const offline = await requireLegacyResets([ANA]);
    if (!offline.ok || isStepUpCancelled(offline)) throw new Error('esperaba la corrida');
    expect(offline.data.results).toEqual([{ userId: ANA, status: 'unknown' }]);
  });

  it('si un lote posterior no responde, el suyo queda "sin confirmar" y los siguientes sin procesar', async () => {
    fetchMock
      .mockImplementationOnce((_url, init) => Promise.resolve(sentBatch(init)))
      .mockResolvedValueOnce(new Response('<html>524</html>', { status: 524 }));
    const res = await requireLegacyResets(ids(120));
    if (!res.ok || isStepUpCancelled(res)) throw new Error('esperaba la corrida');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const statuses = res.data.results.map((r) => r.status);
    expect(statuses.slice(0, 50).every((s) => s === 'sent')).toBe(true);
    expect(statuses.slice(50, 100).every((s) => s === 'unknown')).toBe(true);
    expect(statuses.slice(100).every((s) => s === 'not_processed')).toBe(true);
    expect(res.data.error).toMatch(/Vuelve a abrir la lista/);
  });

  it('si el API rechaza un lote posterior (429), ése y los siguientes quedan sin procesar', async () => {
    fetchMock
      .mockImplementationOnce((_url, init) => Promise.resolve(sentBatch(init)))
      .mockResolvedValueOnce(json(429, { error: 'ThrottlerException: Too Many Requests' }));
    const res = await requireLegacyResets(ids(60));
    if (!res.ok || isStepUpCancelled(res)) throw new Error('esperaba la corrida');
    expect(res.data.results.slice(50).every((r) => r.status === 'not_processed')).toBe(true);
    expect(res.data.error).toBe(
      'Forzaste varios lotes seguidos. Espera un minuto y vuelve a intentarlo.',
    );
  });

  it('si se cierra el diálogo del código a mitad de camino, lo dice', async () => {
    unregister = registerStepUpPrompt(() => Promise.resolve(false));
    fetchMock
      .mockImplementationOnce((_url, init) => Promise.resolve(sentBatch(init)))
      .mockResolvedValueOnce(json(403, MFA_403));
    const res = await requireLegacyResets(ids(60));
    if (!res.ok || isStepUpCancelled(res)) throw new Error('esperaba la corrida');
    expect(res.data.results.slice(50).every((r) => r.status === 'not_processed')).toBe(true);
    expect(res.data.error).toBe(
      'No confirmaste el código: las demás cuentas quedaron sin procesar.',
    );
  });

  it('una cuenta que el API no devolvió no se da por hecha', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        results: [{ userId: ANA.toUpperCase(), status: 'sent', revokedSessions: 0 }],
        counts: { sent: 1, emailFailed: 0, skipped: 0, failed: 0 },
      }),
    );
    const res = await requireLegacyResets([ANA, BETO]);
    if (!res.ok || isStepUpCancelled(res)) throw new Error('esperaba la corrida');
    expect(res.data.results.map((r) => r.status)).toEqual(['sent', 'unknown']);
  });
});
