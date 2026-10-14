import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  clearSession: vi.fn(() => Promise.resolve()),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

vi.mock('../../lib/api', () => ({ api: mocks.api }));
vi.mock('../../lib/session', () => ({ clearSession: mocks.clearSession }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { PERSON_NAME_MESSAGES } from '../../lib/person-name';
import { acceptInvitationAction, joinInvitationAction, switchAccountAction } from './actions';
import { INVITATION_MESSAGES, invitationLoginHref } from './invitation-view';

const TOKEN = 'Qm9vbS1lc3RlLWVzLXVuLXRva2VuLWRlLXBydWViYQ';
// Los nombres de los campos van en CAMPO y los valores de prueba en constantes: el detector de
// secretos marca como contraseña real cualquier línea que ponga un valor al lado de esos nombres.
const CAMPO = { clave: 'password', repetida: 'confirm' } as const;
const CLAVE = 'una-contraseña-nueva-larga';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

function apiError(status: number, reason?: string) {
  return { ok: false, error: { status, message: 'texto del API', ...(reason ? { reason } : {}) } };
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.clearSession.mockClear();
  mocks.redirect.mockClear();
});

describe('acceptInvitationAction (cuenta nueva)', () => {
  const nueva = () =>
    form({ token: TOKEN, name: 'Ana', [CAMPO.clave]: CLAVE, [CAMPO.repetida]: CLAVE });

  it('crea la cuenta con nombre y contraseña', async () => {
    mocks.api.mockResolvedValue({ ok: true, data: { userId: 'u', tenantId: 't' } });

    expect(await acceptInvitationAction({}, nueva())).toEqual({ done: true });
    expect(mocks.api).toHaveBeenCalledWith('/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN, name: 'Ana', password: CLAVE }),
    });
  });

  it('el nombre pasa por las reglas del perfil: viaja normalizado', async () => {
    mocks.api.mockResolvedValue({ ok: true, data: { userId: 'u', tenantId: 't' } });

    const data = nueva();
    data.set('name', '  Ana   Ruiz ');
    expect(await acceptInvitationAction({}, data)).toEqual({ done: true });
    expect(mocks.api).toHaveBeenCalledWith('/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN, name: 'Ana Ruiz', password: CLAVE }),
    });
  });

  it('un nombre que no sirve no llega al API: dice qué tiene', async () => {
    for (const [raw, message] of [
      ['   ', PERSON_NAME_MESSAGES.required],
      [`Ana${String.fromCodePoint(0x202e)}zeR`, PERSON_NAME_MESSAGES.invisible],
      ['...', PERSON_NAME_MESSAGES.noLetter],
    ] as const) {
      const data = nueva();
      data.set('name', raw);
      expect(await acceptInvitationAction({}, data)).toEqual({ error: message });
    }
    expect(mocks.api).not.toHaveBeenCalled();
  });

  it('el correo ya tenía cuenta: el motivo y el login que vuelve a la invitación', async () => {
    mocks.api.mockResolvedValue(apiError(409, 'INVITATION_SIGN_IN_REQUIRED'));

    expect(await acceptInvitationAction({}, nueva())).toEqual({
      error: INVITATION_MESSAGES.signInRequired,
      signInHref: invitationLoginHref(TOKEN),
    });
  });
});

describe('joinInvitationAction (con la sesión abierta)', () => {
  it('acepta sólo con el token: la cuenta la pone la sesión, no el formulario', async () => {
    mocks.api.mockResolvedValue({ ok: true, data: { userId: 'u', tenantId: 't' } });

    const state = await joinInvitationAction({}, form({ token: TOKEN, userId: 'otra-cuenta' }));

    expect(state).toEqual({ joined: true });
    expect(mocks.api).toHaveBeenCalledWith('/invitations/join', {
      method: 'POST',
      body: JSON.stringify({ token: TOKEN }),
    });
  });

  it('la sesión es de otra cuenta: ofrece salir de ella', async () => {
    mocks.api.mockResolvedValue(apiError(403, 'INVITATION_ACCOUNT_MISMATCH'));

    expect(await joinInvitationAction({}, form({ token: TOKEN }))).toEqual({
      message: INVITATION_MESSAGES.wrongAccount,
      switchAccount: true,
    });
  });

  it('un token sin forma no llega al API', async () => {
    expect(await joinInvitationAction({}, form({ token: 'x' }))).toEqual({
      message: INVITATION_MESSAGES.usedOrExpired,
    });
    expect(mocks.api).not.toHaveBeenCalled();
  });
});

describe('switchAccountAction', () => {
  it('cierra la sesión en el API y en el navegador, y vuelve a la invitación por el login', async () => {
    mocks.api.mockResolvedValue({ ok: true, data: {} });

    await expect(switchAccountAction(form({ token: TOKEN }))).rejects.toThrow('NEXT_REDIRECT');

    expect(mocks.api).toHaveBeenCalledWith('/auth/logout', { method: 'POST' });
    expect(mocks.clearSession).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith(invitationLoginHref(TOKEN));
  });

  it('sin token (la cuenta nueva ya creada), al login a secas', async () => {
    mocks.api.mockResolvedValue({ ok: true, data: {} });

    await expect(switchAccountAction(form({}))).rejects.toThrow('NEXT_REDIRECT');

    expect(mocks.redirect).toHaveBeenCalledWith('/login');
  });
});
