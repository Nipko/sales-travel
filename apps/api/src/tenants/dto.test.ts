import { BadRequestException } from '@nestjs/common';
import { PERSON_NAME_MESSAGES } from '@sales-travel/validation';
import { describe, expect, it } from 'vitest';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { AcceptInvitationSchema } from './dto.js';

/** Los invisibles se arman por código: escritos tal cual, un reencode los borra sin aviso. */
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);

const TOKEN = 'token-de-la-invitacion';
const PASSWORD = 'una-clave-larga';

function nameIssue(name: unknown) {
  const res = AcceptInvitationSchema.safeParse({ token: TOKEN, name, password: PASSWORD });
  return res.success ? undefined : res.error.issues.find((i) => i.path[0] === 'name');
}

describe('AcceptInvitationSchema: el nombre al sumarse (mismas reglas que Mi cuenta → Perfil)', () => {
  it('lo guarda normalizado, como el perfil', () => {
    expect(
      AcceptInvitationSchema.parse({ token: TOKEN, name: '  Laura   Gómez ', password: PASSWORD })
        .name,
    ).toBe('Laura Gómez');
    expect(
      AcceptInvitationSchema.parse({ token: TOKEN, name: `Jose${cp(0x301)}`, password: PASSWORD })
        .name,
    ).toBe('José');
  });

  it('rechaza lo que el perfil rechaza, con el mismo mensaje en el campo `name`', () => {
    expect(nameIssue('   ')?.message).toBe(PERSON_NAME_MESSAGES.required);
    expect(nameIssue('a'.repeat(121))?.message).toBe(PERSON_NAME_MESSAGES.tooLong);
    expect(nameIssue(`Laura${cp(0x202e)}zemóG`)?.message).toBe(PERSON_NAME_MESSAGES.invisible);
    expect(nameIssue(cp(0x3164, 0x3164))?.message).toBe(PERSON_NAME_MESSAGES.invisible);
    expect(nameIssue('...')?.message).toBe(PERSON_NAME_MESSAGES.noLetter);
  });

  it('el tope de siempre: 120 entran', () => {
    expect(nameIssue('a'.repeat(120))).toBeUndefined();
  });
});

describe('POST /invitations/accept: el 400 del nombre', () => {
  it('nombra el campo y el mensaje: el panel lo lee de ahí (app/invitacion/errors.ts)', () => {
    const pipe = new ZodValidationPipe(AcceptInvitationSchema);
    let thrown: unknown;
    try {
      pipe.transform({ token: TOKEN, name: `Laura${cp(0x202e)}zemóG`, password: PASSWORD });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const body = (thrown as BadRequestException).getResponse() as { message: string };
    expect(body.message).toContain(`name: ${PERSON_NAME_MESSAGES.invisible}`);
  });
});
