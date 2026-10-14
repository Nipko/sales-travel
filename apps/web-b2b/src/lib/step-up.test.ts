import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentStepUpPrompt,
  isStepUpCancelled,
  needsStepUp,
  normalizeStepUpCode,
  reasonOf,
  registerStepUpPrompt,
  STEP_UP_COPY,
  STEP_UP_REASON,
  stepUpErrorMessage,
  stepUpPlan,
  submitStepUp,
  withStepUp,
  type StepUpAware,
} from './step-up';
import { voseoIn } from './voseo';

/*
 * La reconfirmación del 2FA del lado del panel (USR-13): ante el 403 MFA_RECENT_REQUIRED se pide el
 * código y la acción se repite UNA vez; cerrar el diálogo es cancelar, sin error.
 */

type Res = StepUpAware<string>;
const OK: Res = { ok: true, data: 'hecho' };
const STEP_UP: Res = {
  ok: false,
  message: 'Confirma con tu código de verificación en dos pasos para seguir.',
  reason: STEP_UP_REASON,
};
const OTHER: Res = { ok: false, message: 'No lo pudimos hacer.', reason: 'ROLE_NOT_GRANTABLE' };

/** Una llamada que responde, en orden, lo que se le pasa (y repite la última). */
function sequence(...replies: Res[]) {
  let i = 0;
  return vi.fn(() => Promise.resolve(replies[Math.min(i++, replies.length - 1)]!));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('withStepUp', () => {
  it('sin el 403 de reconfirmar, una sola llamada y sin diálogo', async () => {
    const run = sequence(OK);
    const prompt = vi.fn(() => Promise.resolve(true));
    expect(await withStepUp(run, prompt)).toEqual(OK);

    const failing = sequence(OTHER);
    expect(await withStepUp(failing, prompt)).toEqual(OTHER);
    expect(run).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('con el 403, pide el código y repite la acción una vez', async () => {
    const run = sequence(STEP_UP, OK);
    const prompt = vi.fn(() => Promise.resolve(true));
    expect(await withStepUp(run, prompt)).toEqual(OK);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('si se cierra el diálogo, no repite y vuelve cancelada', async () => {
    const run = sequence(STEP_UP, OK);
    const res = await withStepUp(run, () => Promise.resolve(false));
    expect(isStepUpCancelled(res)).toBe(true);
    expect(res.ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('nunca en bucle: si la repetición también lo pide, vuelve tal cual', async () => {
    const run = sequence(STEP_UP, STEP_UP);
    const prompt = vi.fn(() => Promise.resolve(true));
    expect(await withStepUp(run, prompt)).toEqual(STEP_UP);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('sin diálogo montado, el 403 vuelve como cualquier error', async () => {
    const run = sequence(STEP_UP, OK);
    expect(await withStepUp(run, null)).toEqual(STEP_UP);
    expect(await withStepUp(sequence(STEP_UP))).toEqual(STEP_UP);
  });

  it('usa el diálogo registrado; dos acciones a la vez comparten un solo código', async () => {
    let resolve: (ok: boolean) => void = () => undefined;
    const open = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolve = r;
        }),
    );
    const unregister = registerStepUpPrompt(open);
    try {
      const a = withStepUp(sequence(STEP_UP, OK));
      const b = withStepUp(sequence(STEP_UP, OK));
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
      resolve(true);
      expect(await Promise.all([a, b])).toEqual([OK, OK]);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
    expect(currentStepUpPrompt()).toBeNull();
  });

  it('darse de baja no saca al que se registró después', () => {
    const first = registerStepUpPrompt(() => Promise.resolve(true));
    const second = registerStepUpPrompt(() => Promise.resolve(false));
    first();
    expect(currentStepUpPrompt()).not.toBeNull();
    second();
    expect(currentStepUpPrompt()).toBeNull();
  });
});

describe('needsStepUp, isStepUpCancelled y reasonOf', () => {
  it('sólo el 403 de reconfirmar abre el diálogo', () => {
    expect(needsStepUp(STEP_UP)).toBe(true);
    expect(needsStepUp(OTHER)).toBe(false);
    expect(needsStepUp(OK)).toBe(false);
    expect(needsStepUp({ ok: false, reason: 'MFA_REQUIRED_FOR_ACTION' })).toBe(false);
    expect(isStepUpCancelled(STEP_UP)).toBe(false);
    expect(isStepUpCancelled(null)).toBe(false);
  });

  it('el motivo sale del cuerpo sólo si tiene forma de motivo', () => {
    expect(reasonOf({ error: 'x', reason: STEP_UP_REASON })).toBe(STEP_UP_REASON);
    expect(reasonOf({ reason: 'no es un motivo' })).toBeUndefined();
    expect(reasonOf({ reason: 7 })).toBeUndefined();
    expect(reasonOf([STEP_UP_REASON])).toBeUndefined();
    expect(reasonOf(null)).toBeUndefined();
  });
});

describe('el código y el cuerpo del BFF', () => {
  it('normaliza espacios, guiones y dígitos de ancho completo; exige 6', () => {
    expect(normalizeStepUpCode('123 456')).toBe('123456');
    expect(normalizeStepUpCode('123-456')).toBe('123456');
    expect(normalizeStepUpCode('１２３４５６')).toBe('123456');
    for (const bad of ['12345', '1234567', 'abcdef', 'ABCDE-12345', 123456, undefined]) {
      expect(normalizeStepUpCode(bad)).toBeNull();
    }
  });

  it('el plan reconstruye { code } y no deja pasar nada más', () => {
    expect(stepUpPlan({ code: '123 456', sessionId: 'otra', extra: true })).toEqual({
      ok: true,
      path: '/auth/step-up',
      body: { code: '123456' },
    });
    for (const bad of [undefined, null, [], 'x', { code: '12' }]) {
      expect(stepUpPlan(bad)).toEqual({ ok: false, error: STEP_UP_COPY.incomplete });
    }
  });

  it('el error, según el estado: código incorrecto, demasiados intentos, sesión', () => {
    expect(stepUpErrorMessage(400, 'El código no es válido o ya se usó.')).toBe(
      'Ese código no es válido. Inténtalo de nuevo.',
    );
    expect(stepUpErrorMessage(429, 'x')).toBe('Demasiados intentos. Espera unos minutos.');
    expect(stepUpErrorMessage(401, undefined)).toBe(STEP_UP_COPY.expired);
    expect(stepUpErrorMessage(409, 'La verificación en dos pasos no está activa.')).toBe(
      'La verificación en dos pasos no está activa.',
    );
    expect(stepUpErrorMessage(502, 'Bad gateway')).toBe(STEP_UP_COPY.failed);
    expect(stepUpErrorMessage(403, '')).toBe(STEP_UP_COPY.failed);
  });

  it('todo en tú', () => {
    expect(Object.values(STEP_UP_COPY).flatMap(voseoIn)).toEqual([]);
  });
});

describe('submitStepUp', () => {
  function respond(status: number, body: unknown) {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('manda sólo el código al BFF del panel', async () => {
    const fetchMock = respond(200, { ok: true, verifiedAt: '2026-10-13T15:00:00.000Z' });
    expect(await submitStepUp(' 123456 ')).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/step-up', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
  });

  it('un código incompleto no sale del navegador', async () => {
    const fetchMock = respond(200, {});
    expect(await submitStepUp('123')).toEqual({ ok: false, message: STEP_UP_COPY.incomplete });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('el rechazo del API, con su mensaje para el diálogo', async () => {
    respond(400, { error: 'El código no es válido o ya se usó.', reason: 'MFA_CODE_INVALID' });
    expect(await submitStepUp('123456')).toEqual({ ok: false, message: STEP_UP_COPY.invalid });
    respond(429, { error: 'Demasiados intentos fallidos.', reason: 'MFA_ACCOUNT_LOCKED' });
    expect(await submitStepUp('123456')).toEqual({ ok: false, message: STEP_UP_COPY.locked });
  });

  it('sin conexión', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    expect(await submitStepUp('123456')).toEqual({ ok: false, message: STEP_UP_COPY.offline });
  });
});
