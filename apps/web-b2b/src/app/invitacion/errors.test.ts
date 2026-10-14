import { describe, expect, it } from 'vitest';
import { PERSON_NAME_MESSAGES } from '../../lib/person-name';
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

  it('un 400 por el nombre (PersonNameSchema): qué tiene el nombre, no "enlace vencido"', () => {
    const summary = (field: string, message: string) =>
      `Revisa los datos ingresados — ${field}: ${message}`;
    expect(
      acceptInvitationError({
        status: 400,
        message: summary('name', PERSON_NAME_MESSAGES.invisible),
      }),
    ).toBe(PERSON_NAME_MESSAGES.invisible);
    // Un mensaje que el panel no conoce (otro idioma, otra versión del API) o de otro campo: el de
    // siempre.
    for (const message of [
      summary('name', 'String must contain at most 120 character(s)'),
      summary('token', PERSON_NAME_MESSAGES.required),
    ]) {
      expect(acceptInvitationError({ status: 400, message })).toMatch(
        /se usó, venció o fue revocada/,
      );
    }
  });

  it('el correo ya tiene cuenta (USR-17): ingresar con ella, no elegir otra contraseña', () => {
    expect(
      acceptInvitationError({
        status: 409,
        message: 'texto del API',
        reason: 'INVITATION_SIGN_IN_REQUIRED',
      }),
    ).toBe(
      'Ya tienes una cuenta con este correo. Ingresa con tu contraseña de siempre para aceptar la invitación.',
    );
  });

  it('lo demás, con el mensaje del API', () => {
    expect(acceptInvitationError({ status: 429, message: 'Demasiados intentos.' })).toBe(
      'Demasiados intentos.',
    );
  });
});
