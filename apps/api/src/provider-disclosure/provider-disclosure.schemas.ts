import { z } from '@sales-travel/validation';

/**
 * `showProviderInResults: null` NO es lo mismo que `false`, y por eso el campo es nullable
 * en vez de opcional: `null` significa "volvé a heredar de mi consolidador" y `false`
 * significa "acá se oculta pase lo que pase arriba". Aceptar sólo booleanos dejaría al
 * administrador sin forma de deshacer una decisión propia.
 */
export const UpdateProviderDisclosureSchema = z
  .object({
    tenantId: z.string().uuid(),
    showProviderInResults: z.boolean().nullable(),
  })
  .strict();

export type UpdateProviderDisclosureDto = z.infer<typeof UpdateProviderDisclosureSchema>;
