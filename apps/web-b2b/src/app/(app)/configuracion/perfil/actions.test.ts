import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class RedirectSignal extends Error {
    constructor(readonly url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  return {
    RedirectSignal,
    apiWithStatus: vi.fn(),
    clearSession: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('../../../../lib/api', () => ({ apiWithStatus: mocks.apiWithStatus }));
vi.mock('../../../../lib/session', () => ({ clearSession: mocks.clearSession }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new mocks.RedirectSignal(url);
  },
}));

import { PERSON_NAME_MESSAGES } from '../../../../lib/person-name';
import { updateNameAction } from './actions';
import { PROFILE_ERRORS } from './profile-model';

function form(name?: string): FormData {
  const data = new FormData();
  if (name !== undefined) data.set('name', name);
  return data;
}

function json(status: number, body: unknown) {
  return { kind: 'json' as const, status, body };
}

/** El cuerpo que mandó la acción al API. */
function sentBody(): unknown {
  const init = mocks.apiWithStatus.mock.calls[0]?.[1] as { body?: string } | undefined;
  return init?.body === undefined ? undefined : JSON.parse(init.body);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateNameAction (PATCH /me)', () => {
  it('manda sólo el nombre normalizado, sin ningún id, y revalida todo el panel', async () => {
    mocks.apiWithStatus.mockResolvedValue(json(200, { name: 'Laura Gómez' }));

    await expect(updateNameAction(form('  Laura   Gómez '))).resolves.toEqual({
      ok: true,
      name: 'Laura Gómez',
    });

    expect(mocks.apiWithStatus).toHaveBeenCalledWith(
      '/me',
      expect.objectContaining({ method: 'PATCH' }),
    );
    expect(sentBody()).toEqual({ name: 'Laura Gómez' });
    // La barra de arriba lee /me en el layout: se revalida desde ahí para que cambie al instante.
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('devuelve el nombre como lo guardó el API', async () => {
    mocks.apiWithStatus.mockResolvedValue(json(200, { name: 'Laura G.' }));
    await expect(updateNameAction(form('Laura G.'))).resolves.toMatchObject({ name: 'Laura G.' });
  });

  it('un nombre que no sirve no llega al API: el error es el del campo', async () => {
    const rtl = `Laura${String.fromCodePoint(0x202e)}zemóG`;
    for (const [raw, message] of [
      ['   ', PERSON_NAME_MESSAGES.required],
      ['a'.repeat(121), PERSON_NAME_MESSAGES.tooLong],
      [rtl, PERSON_NAME_MESSAGES.invisible],
      ['...', PERSON_NAME_MESSAGES.noLetter],
    ] as const) {
      await expect(updateNameAction(form(raw))).resolves.toEqual({ error: message });
    }
    await expect(updateNameAction(form())).resolves.toEqual({
      error: PERSON_NAME_MESSAGES.required,
    });
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('un 400 del API con el mensaje del campo lo muestra; uno desconocido, uno genérico', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(
      json(400, {
        message: 'Revisa los datos ingresados — name: …',
        fields: [{ field: 'name', message: PERSON_NAME_MESSAGES.invisible }],
      }),
    );
    await expect(updateNameAction(form('Laura'))).resolves.toEqual({
      error: PERSON_NAME_MESSAGES.invisible,
    });

    mocks.apiWithStatus.mockResolvedValueOnce(
      json(400, { fields: [{ field: 'name', message: 'String must contain at most 120' }] }),
    );
    await expect(updateNameAction(form('Laura'))).resolves.toEqual({
      error: PROFILE_ERRORS.invalid,
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('429: que espere; 403 por 2FA pendiente: que lo active; 500 o sin servidor: que reintente', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce(json(429, { message: 'Too Many Requests' }));
    await expect(updateNameAction(form('Laura'))).resolves.toEqual({
      error: PROFILE_ERRORS.rateLimited,
    });

    mocks.apiWithStatus.mockResolvedValueOnce(
      json(403, { message: 'x', reason: 'MFA_ENROLLMENT_REQUIRED' }),
    );
    await expect(updateNameAction(form('Laura'))).resolves.toEqual({
      error: PROFILE_ERRORS.mfaRequired,
    });

    mocks.apiWithStatus.mockResolvedValueOnce(json(500, { message: 'Internal server error' }));
    await expect(updateNameAction(form('Laura'))).resolves.toEqual({
      error: PROFILE_ERRORS.unexpected,
    });

    mocks.apiWithStatus.mockResolvedValueOnce({
      kind: 'unreachable',
      status: 503,
      message: 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
    });
    await expect(updateNameAction(form('Laura'))).resolves.toEqual({
      error: 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
    });
  });

  it('sesión cerrada (401): borra la cookie y va al login con el motivo y la vuelta', async () => {
    mocks.apiWithStatus.mockResolvedValue(json(401, { message: 'x', reason: 'SESSION_IDLE' }));
    const err = await updateNameAction(form('Laura')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(mocks.RedirectSignal);
    const url = (err as InstanceType<typeof mocks.RedirectSignal>).url;
    expect(url).toContain('/login?');
    expect(url).toContain('motivo=inactividad');
    expect(decodeURIComponent(url)).toContain('/configuracion/perfil');
    expect(mocks.clearSession).toHaveBeenCalledTimes(1);
  });
});
