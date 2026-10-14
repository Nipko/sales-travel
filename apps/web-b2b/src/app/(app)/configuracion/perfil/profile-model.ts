import type { ApiResponse } from '../../../../lib/api';
import { PERSON_NAME_MESSAGES } from '../../../../lib/person-name';

/**
 * Qué muestra Mi cuenta → Perfil (USR-18) y cómo se lee lo que responde el API, sin Next ni I/O para
 * probarlo. Hoy el perfil es el nombre visible; el correo se muestra y no se cambia acá.
 */

export const PROFILE_PATH = '/configuracion/perfil';

export const PROFILE_COPY = {
  title: 'Perfil',
  intro: 'Tu nombre y el correo con el que ingresas.',
  sectionTitle: 'Datos de tu cuenta',
  nameLabel: 'Tu nombre',
  nameHint: 'Es el que ven tu equipo y las personas a las que invitas.',
  emailLabel: 'Tu correo',
  // Sin la marca de la plataforma: el panel es white-label y lo ve la agencia con la suya.
  emailNote: 'Para cambiar tu correo, pídeselo al equipo de soporte.',
  save: 'Guardar',
  saving: 'Guardando…',
  saved: 'Guardamos tu nombre.',
  loadError: 'No pudimos cargar tu perfil. Recarga la página.',
} as const;

export const PROFILE_ERRORS = {
  invalid: 'Revisa tu nombre e inténtalo de nuevo.',
  rateLimited: 'Hiciste muchos cambios seguidos. Espera un minuto y prueba de nuevo.',
  mfaRequired:
    'Tu rol exige la verificación en dos pasos. Actívala en Mi cuenta → Seguridad y vuelve a intentarlo.',
  unexpected: 'No pudimos guardar tu nombre. Inténtalo de nuevo.',
} as const;

/** Lo que el perfil necesita de `GET /me`. */
export interface ProfileData {
  readonly name: string;
  readonly email: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `GET /me`, validado. Sin nombre (una cuenta vieja) es un campo vacío para completar. */
export function parseProfile(body: unknown): ProfileData | null {
  const r = record(body);
  const email = r?.['email'];
  if (typeof email !== 'string' || email === '') return null;
  const name = r?.['name'];
  return { email, name: typeof name === 'string' ? name : '' };
}

/** El nombre que guardó `PATCH /me` (ya normalizado por el API), o `null` si no vino. */
export function savedNameFrom(body: unknown): string | null {
  const name = record(body)?.['name'];
  return typeof name === 'string' && name !== '' ? name : null;
}

const KNOWN_NAME_MESSAGES: readonly string[] = Object.values(PERSON_NAME_MESSAGES);

/**
 * El mensaje del campo `name` de un 400 de `ZodValidationPipe` (`fields: [{ field, message }]`),
 * sólo si es uno de los que el panel conoce: un API de otra versión podría mandar uno en inglés.
 */
function nameFieldMessage(body: unknown): string | null {
  const fields = record(body)?.['fields'];
  if (!Array.isArray(fields)) return null;
  for (const item of fields) {
    const f = record(item);
    const message = f?.['message'];
    if (f?.['field'] === 'name' && typeof message === 'string') {
      if (KNOWN_NAME_MESSAGES.includes(message)) return message;
    }
  }
  return null;
}

/** El error para el formulario de un `PATCH /me` que no fue 2xx. El 401 lo resuelve la acción. */
export function profileFailureMessage(res: ApiResponse): string {
  if (res.kind === 'unreachable') return res.message;
  if (res.status === 429) return PROFILE_ERRORS.rateLimited;
  if (res.status === 400) {
    return (res.kind === 'json' ? nameFieldMessage(res.body) : null) ?? PROFILE_ERRORS.invalid;
  }
  if (res.status === 403 && res.kind === 'json') {
    const reason = record(res.body)?.['reason'];
    if (reason === 'MFA_ENROLLMENT_REQUIRED') return PROFILE_ERRORS.mfaRequired;
  }
  return PROFILE_ERRORS.unexpected;
}
