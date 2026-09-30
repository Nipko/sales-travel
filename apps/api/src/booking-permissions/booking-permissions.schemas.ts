import { z } from '@sales-travel/validation';

/** En minúsculas, como lo devuelve Postgres: el mismo id en mayúsculas no encontraría su fila. */
export const BookingPermissionsTenantIdSchema = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());

/**
 * `PUT /tenants/:tenantId/booking-permissions`: lo que fija quien financia al nodo. El motivo es
 * obligatorio, como en las carteras: es lo que explica el cambio en la auditoría.
 */
export const UpdateBookingPermissionsSchema = z
  .object({
    nonRefundableRates: z.enum(['allowed', 'blocked'], {
      errorMap: () => ({ message: 'indicá allowed o blocked' }),
    }),
    reason: z
      .string({ required_error: 'el motivo es obligatorio' })
      .trim()
      .min(3, 'el motivo es obligatorio (al menos 3 caracteres)')
      .max(500, 'el motivo admite hasta 500 caracteres'),
  })
  .strict();

export type UpdateBookingPermissionsDto = z.infer<typeof UpdateBookingPermissionsSchema>;
