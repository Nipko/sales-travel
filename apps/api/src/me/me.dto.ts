import { PersonNameSchema, z } from '@sales-travel/validation';

/**
 * PATCH /me: lo único que la persona cambia de su cuenta es su nombre. Estricto: un `email` (o un
 * `userId`) en el cuerpo es un 400, no algo que se ignora en silencio; el correo no se cambia hasta
 * que exista un flujo que verifique el buzón nuevo, y la cuenta es siempre la de la sesión.
 */
export const UpdateProfileSchema = z
  .object({ name: PersonNameSchema })
  .strict('Desde tu perfil sólo puedes cambiar tu nombre.');
export type UpdateProfileDto = z.infer<typeof UpdateProfileSchema>;
