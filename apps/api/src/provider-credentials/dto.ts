import { z } from '@sales-travel/validation';
import { providerAccountIssues } from './provider-specs.js';

/**
 * Upsert de credenciales BYOC.
 *
 * `credentials`/`config` siguen siendo objetos abiertos —su forma depende del proveedor— pero
 * el borde ya NO se limita a "que no esté vacío". El formulario del panel no es el único camino
 * hasta acá: las cuentas de Sabre se cargan hoy por POST directo, y una sin `homePcc` se
 * guardaba sin protestar para quedar inservible en silencio.
 *
 * Las reglas se declaran POR PROVEEDOR en `provider-specs.ts` y se aplican acá en un solo lugar:
 * un proveedor nuevo no añade ninguna rama a este fichero. Un proveedor sin reglas declaradas se
 * acepta exactamente como hasta hoy.
 *
 * NUNCA loguear `credentials`.
 */
export const UpsertProviderAccountSchema = z
  .object({
    tenantId: z.string().uuid(),
    providerCode: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[a-z0-9-]+$/, 'providerCode must be lowercase alphanumeric with hyphens'),
    label: z.string().trim().min(1).max(60).optional(),
    credentials: z.record(z.unknown()).refine((o) => Object.keys(o).length > 0, {
      message: 'credentials must not be empty',
    }),
    config: z.record(z.unknown()).optional(),
    isInheritable: z.boolean().optional(),
    status: z.enum(['active', 'sandbox', 'disabled']).optional(),
  })
  .superRefine((input, ctx) => {
    for (const issue of providerAccountIssues(input)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...issue.path],
        message: issue.message,
      });
    }
  });
export type UpsertProviderAccountInput = z.infer<typeof UpsertProviderAccountSchema>;
