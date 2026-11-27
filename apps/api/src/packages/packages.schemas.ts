import { z } from '@sales-travel/validation';

/**
 * Verticales combinables en un paquete. `flights`, `hotels`, `cars` y `assistance` vienen de un
 * proveedor; `activities`, `transfers` y `other` por ahora sólo como servicio manual (todavía no
 * hay proveedor de actividades integrado: docs/platform/20-paquetes.md).
 */
export const PACKAGE_VERTICALS = [
  'flights',
  'hotels',
  'cars',
  'assistance',
  'activities',
  'transfers',
  'other',
] as const;
export type PackageVertical = (typeof PACKAGE_VERTICALS)[number];

/**
 * Un servicio que escribe el vendedor (un traslado, un tour de un operador local). Su precio es
 * el de VENTA tal como lo escribió: no pasa por la cascada de markup, porque no hay neto de
 * proveedor sobre el que aplicarla.
 */
export const MANUAL_PROVIDER = 'manual';

export const PACKAGE_STATUSES = ['draft', 'sent', 'accepted', 'expired'] as const;

/** Tope del snapshot de presentación de un ítem: alcanza para un itinerario y unas fotos. */
const MAX_RAW_DETAILS_BYTES = 64 * 1024;

/** `YYYY-MM-DD` que existe en el calendario: «2027-02-31» no pasa (QA-H-32). */
const CalendarDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, {
    message: 'esa fecha no existe',
  });

/** Una fecha que `new Date()` entiende; sin esto, «nunca» terminaba en un 500 (QA-H-33). */
const DateInput = z.union([
  z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'no es una fecha válida' }),
  z.date(),
]);

/** Código ISO 4217. Se acepta en minúsculas y se guarda en mayúsculas. */
const Currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'moneda ISO de 3 letras')
  .transform((c) => c.toUpperCase());

/** Lo que se buscó: presentación de la cotización (portada, itinerario). No se re-ejecuta. */
export const PackageSearchCriteriaSchema = z
  .object({
    origin: z.string().max(80).optional(),
    originLabel: z.string().max(120).optional(),
    destination: z.string().max(80).optional(),
    destinationLabel: z.string().max(120).optional(),
    departureDate: CalendarDay,
    returnDate: CalendarDay,
    rooms: z
      .array(
        z.object({
          adults: z.number().int().min(1).max(9),
          childrenAges: z.array(z.number().int().min(0).max(17)).max(6),
        }),
      )
      .min(1)
      .max(6),
    includes: z.array(z.enum(PACKAGE_VERTICALS)).max(PACKAGE_VERTICALS.length).optional(),
  })
  .strict()
  .refine((v) => v.returnDate >= v.departureDate, {
    message: 'el regreso no puede ser antes de la ida',
    path: ['returnDate'],
  });
export type PackageSearchCriteria = z.infer<typeof PackageSearchCriteriaSchema>;

export const PackageItemInputSchema = z
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
    /** Snapshot de presentación (itinerario, hotel con fotos, auto) para la cotización. */
    rawDetails: z
      .record(z.unknown())
      .refine((v) => JSON.stringify(v).length <= MAX_RAW_DETAILS_BYTES, {
        message: 'el detalle del servicio es demasiado grande',
      })
      .optional(),
    baseFareMinor: z.number().int().min(0),
    taxesMinor: z.number().int().min(0),
    /**
     * La moneda del precio. Un paquete se arma en UNA moneda (no hay tasas de cambio en la
     * plataforma): un ítem en otra se rechaza en vez de sumarse como si fueran iguales.
     */
    currency: Currency.optional(),
    /** Piso de venta del proveedor (hoteles, RF-12), en la moneda del ítem. */
    minimumSellingMinor: z.number().int().min(0).optional(),
  })
  .strict();
export type PackageItemInput = z.infer<typeof PackageItemInputSchema>;

/** Compatibilidad: el alta de un ítem suelto es el mismo contrato. */
export const AddPackageItemSchema = PackageItemInputSchema;
export type AddPackageItemDto = PackageItemInput;

export const CreatePackageSchema = z
  .object({
    title: z.string().min(1).max(200),
    currency: Currency,
    customerId: z.string().uuid().nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    expiresAt: DateInput.optional(),
    searchCriteria: PackageSearchCriteriaSchema.optional(),
    showBreakdown: z.boolean().optional(),
    /** El paquete con sus servicios en una sola transacción: o se guarda entero o nada. */
    items: z.array(PackageItemInputSchema).max(12).optional(),
  })
  .strict();
export type CreatePackageDto = z.infer<typeof CreatePackageSchema>;

export const UpdatePackageSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    notes: z.string().max(4000).nullable().optional(),
    customerId: z.string().uuid().nullable().optional(),
    status: z.enum(PACKAGE_STATUSES).optional(),
    showBreakdown: z.boolean().optional(),
    expiresAt: DateInput.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'nada para actualizar' });
export type UpdatePackageDto = z.infer<typeof UpdatePackageSchema>;
