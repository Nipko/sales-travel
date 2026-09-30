import { describe, expect, it } from 'vitest';
import { acceptInvitationError } from './errors';

describe('acceptInvitationError: por qué no se pudo aceptar', () => {
  it('quien la mandó ya no podría mandarla, o su nodo no opera: pedir una nueva', () => {
    expect(
      acceptInvitationError({
        status: 400,
        message: 'Esta invitación ya no es válida, pide una nueva.',
        reason: 'INVITATION_NO_LONGER_VALID',
      }),
    ).toBe('Esta invitación ya no es válida, pide una nueva.');
  });

  it('otro 400: usada, vencida o revocada', () => {
    expect(
      acceptInvitationError({ status: 400, message: 'la invitación es inválida o venció' }),
    ).toMatch(/se usó, venció o fue revocada/);
  });

  it('lo demás, con el mensaje del API', () => {
    expect(acceptInvitationError({ status: 429, message: 'Demasiados intentos.' })).toBe(
      'Demasiados intentos.',
    );
  });
});
