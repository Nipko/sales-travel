import { z } from '@sales-travel/validation';

/** Verticales combinables en un paquete. Espejo del comentario de package_items en 0010. */
export const PACKAGE_VERTICALS = ['flights', 'hotels', 'cars', 'assistance'] as const;

export const CreatePackageSchema = z
  .object({
    title: z.string().min(1).max(200),
    currency: z.string().length(3),
    customerId: z.string().uuid().nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    expiresAt: z.union([z.string(), z.date()]).optional(),
  })
  .strict();
export type CreatePackageDto = z.infer<typeof CreatePackageSchema>;

export const AddPackageItemSchema = z
  .object({
    vertical: z.enum(PACKAGE_VERTICALS),
    providerName: z.string().min(1).max(50),
    /**
     * 2.000 y no 200: los identificadores de oferta de los GDS son referencias opacas sin
     * longitud acotada por contrato, y el límite viejo rechazaba tarifas legítimas con un
     * error que en la UI se leía como "este vuelo no se puede agregar al paquete". La
     * columna pasó a TEXT en 0035; el tope acá sigue existiendo como cota del borde, no
     * como regla de negocio.
     */
    providerItemId: z.string().min(1).max(2000),
    /** Itinerario/tarifa tal como vino del proveedor, para reconstruir el ítem después. */
    rawDetails: z.record(z.unknown()).optional(),
    baseFareMinor: z.number().int().min(0),
    taxesMinor: z.number().int().min(0),
  })
  .strict();
export type AddPackageItemDto = z.infer<typeof AddPackageItemSchema>;
