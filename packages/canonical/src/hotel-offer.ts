import {
  CountryCodeSchema,
  CurrencyCodeSchema,
  LanguageCodeSchema,
  z,
} from '@sales-travel/validation';
import { BoardTypeSchema, GeoLocationSchema } from './hotel';
import { MoneySchema, type Money } from './money';
import { ProviderRefSchema } from './offer';

/**
 * Contrato NEUTRAL de la vertical de hoteles: criterio de búsqueda, oferta y roompack.
 *
 * Hasta ahora el contrato de facto eran los tipos del ACL de Despegar
 * (`providers/despegar-hotels/src/types.ts`), con su semántica: token por habitación, un solo
 * cargo en destino en la moneda del pack, políticas en horas relativas y ningún proveedor en la
 * oferta. Con un segundo proveedor esa forma no alcanza y, además, dejaría que los tipos de un
 * ACL se filtren al dominio. Vive aquí, y no en `apps/api`, porque cada ACL de hoteles tiene que
 * poder producirlo y validarlo sin importar a otro ACL.
 *
 * `hotel.ts` NO sirve como contrato de oferta: exige nombre, dirección, categoría y camas que
 * una respuesta de disponibilidad no siempre trae, y modela la cancelación "hasta" con zona
 * horaria. Se conserva para `Offer.accommodations` y Package Studio.
 *
 * Regla de lectura de todo el archivo: un campo opcional ausente significa "el proveedor no lo
 * informó", nunca "no aplica". Es la misma distinción que `Offer.baggage`.
 *
 * PR-0.2 del plan de hoteles multi-proveedor (RF-35).
 */

// ───────────────────────── Piezas ─────────────────────────

const IsoDateSchema = z.string().date();

const LOCAL_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

/**
 * Fecha y hora LOCAL del hotel, sin zona: `YYYY-MM-DDTHH:mm:ss`.
 *
 * Hay proveedores que informan el inicio de un tramo de cancelación "en hora del hotel" sin
 * decir qué zona es. Pasarlo a un instante con offset exige inventar la zona, y una penalidad
 * calculada sobre una hora inventada es una promesa que nadie puede sostener. Por eso se rechaza
 * cualquier designador de zona, `Z` incluida: el dato con zona conocida va en un campo con
 * offset, no aquí.
 */
export const HotelLocalDateTimeSchema = z
  .string()
  .regex(LOCAL_DATE_TIME_RE, 'fecha y hora local sin zona esperada: YYYY-MM-DDTHH:mm:ss')
  .refine((v) => IsoDateSchema.safeParse(v.slice(0, 10)).success, {
    message: 'la fecha no existe en el calendario',
  });
export type HotelLocalDateTime = z.infer<typeof HotelLocalDateTimeSchema>;

/**
 * Importe decimal tal como lo escribió el proveedor (`"25.810"`).
 *
 * `Money` asume dos decimales. Un cargo en una moneda con otro exponente ISO 4217 (0 o 3) se
 * vería multiplicado o dividido por diez sin que nadie lo note, así que el literal viaja al lado
 * y es lo que se muestra.
 */
const DecimalTextSchema = z
  .string()
  .max(32)
  .regex(/^\d+(\.\d+)?$/, 'importe decimal sin signo esperado');

/**
 * Código del proveedor en el registry de hoteles (`despegar-hotels`).
 *
 * Es más estricto que `ProviderRefSchema.name` a propósito: con este código se enruta el
 * PreBook y la web busca la ficha legible del proveedor para pintar su pastilla
 * (`apps/web-b2b/src/lib/provider-display.ts`). Un nombre legible aquí ("Despegar Hotels")
 * rompería las dos cosas en silencio.
 */
export const HotelProviderCodeSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'código de proveedor en kebab-case esperado');

/**
 * De qué proveedor es un roompack y con qué referencia se reserva.
 *
 * Reutiliza `ProviderRefSchema` entero —mismo techo de `offerRef`, misma `raw` opaca, JSON y sin
 * PII— y sólo acota `name` al código del registry.
 */
export const HotelProviderRefSchema = ProviderRefSchema.extend({ name: HotelProviderCodeSchema });
export type HotelProviderRef = z.infer<typeof HotelProviderRefSchema>;

/**
 * Ocupación de UNA habitación: adultos y edad de cada niño.
 *
 * Los topes son los del borde HTTP de la plataforma. Cada proveedor declara los suyos, más
 * estrechos, y queda fuera de la búsqueda con motivo si no los cumple: el contrato neutral no
 * trunca ni reparte una ocupación para que entre.
 */
export const HotelRoomOccupancySchema = z.object({
  adults: z.number().int().min(1).max(8),
  childrenAges: z.array(z.number().int().min(0).max(17)).max(6),
});
export type HotelRoomOccupancy = z.infer<typeof HotelRoomOccupancySchema>;

// ───────────────────────── Criterio de búsqueda ─────────────────────────

const HotelStayCriteriaShape = {
  checkinDate: IsoDateSchema,
  checkoutDate: IsoDateSchema,
  /**
   * En el orden en que el vendedor las cargó: los índices por habitación de la respuesta y la
   * lista de huéspedes de la reserva dependen de él.
   */
  rooms: z.array(HotelRoomOccupancySchema).min(1).max(8),
  /**
   * Moneda de VENTA de esta búsqueda: por defecto la del tenant, elegible por el vendedor.
   *
   * No es la moneda en la que cotiza el proveedor: hay proveedores que ni la reciben y cotizan
   * en la que fija la configuración de su cuenta. Obligatoria y sin
   * valor por defecto: un `'USD'` silencioso es cómo una búsqueda en COP terminaba comparando
   * precios en dos monedas. La puerta que descarta packs en otra moneda la aplica el servicio,
   * que es el único que ve juntos a todos los proveedores.
   */
  currency: CurrencyCodeSchema,
  /**
   * Nacionalidad del huésped principal (ISO 3166-1 alfa-2).
   *
   * Opcional en el contrato porque no todo proveedor la usa, pero nunca se rellena con el país
   * del tenant ni de la credencial: eso es fijarla en código. El proveedor que la exige queda
   * fuera de la búsqueda, con motivo, cuando falta.
   */
  guestNationality: CountryCodeSchema.optional(),
  /**
   * País del punto de venta. No es la nacionalidad del huésped: confundirlos es exactamente el
   * error de reutilizar el `countryCode` del borde como nacionalidad.
   */
  pointOfSaleCountry: CountryCodeSchema.optional(),
  language: LanguageCodeSchema.optional(),
  refundableOnly: z.boolean().optional(),
};

// Fechas ISO sin hora: el orden lexicográfico es el cronológico.
const checkoutAfterCheckin = (v: { checkinDate: string; checkoutDate: string }): boolean =>
  v.checkoutDate > v.checkinDate;
const CHECKOUT_AFTER_CHECKIN = {
  message: 'la salida tiene que ser posterior a la entrada',
  path: ['checkoutDate'],
};

/**
 * Lo que recibe el ACL de UN proveedor.
 *
 * `hotelIds` ya está en el espacio de ids de ese proveedor: la resolución destino → hoteles es
 * por proveedor y la hace el servicio contra su catálogo, no el ACL.
 */
export const HotelSearchCriteriaSchema = z
  .object({
    hotelIds: z.array(z.string().min(1).max(64)).min(1).max(100),
    ...HotelStayCriteriaShape,
  })
  .refine(checkoutAfterCheckin, CHECKOUT_AFTER_CHECKIN);
export type HotelSearchCriteria = z.infer<typeof HotelSearchCriteriaSchema>;

/** Tarifas de un solo hotel: la pantalla desde la que se elige qué reservar. */
export const HotelRatesQuerySchema = z
  .object({
    hotelId: z.string().min(1).max(64),
    /** Acota el detalle a un roompack ya visto en el listado. */
    roompackId: z.string().min(1).max(255).optional(),
    ...HotelStayCriteriaShape,
  })
  .refine(checkoutAfterCheckin, CHECKOUT_AFTER_CHECKIN);
export type HotelRatesQuery = z.infer<typeof HotelRatesQuerySchema>;

// ───────────────────────── Precio ─────────────────────────

export const HotelTaxSchema = z.object({
  code: z.string().max(40),
  amount: MoneySchema,
});
export type HotelTax = z.infer<typeof HotelTaxSchema>;

/**
 * Suplemento de un pack: a pagar en el hotel o ya incluido en el total.
 *
 * `amount` va en la moneda DEL SUPLEMENTO, que puede no ser la del pack. Nunca se suma al total
 * ni se convierte: sumar monedas distintas, o cobrar en la reserva lo que se paga en el hotel,
 * son los dos errores que esta forma impide.
 */
export const HotelFeeSchema = z.object({
  /** Habitación, base 1, en el orden de `rooms`. Ausente: aplica a toda la reserva. */
  roomIndex: z.number().int().positive().optional(),
  /** Lo que se muestra: la traducción si el código se reconoce, el literal si no. */
  description: z.string().min(1).max(200),
  /** El literal del proveedor (`mandatory_tax`), sin catálogo. */
  descriptionRaw: z.string().min(1).max(200).optional(),
  amount: MoneySchema,
  /** Presente cuando la moneda no tiene 2 decimales: entonces se muestra esto y no `amount`. */
  amountText: DecimalTextSchema.optional(),
});
export type HotelFee = z.infer<typeof HotelFeeSchema>;

/**
 * Desglose de precio del roompack. Todo en la moneda de `total`, salvo lo dicho en `HotelFee`.
 *
 * `total` es el NETO del proveedor y nunca se muta: el precio de venta sale del waterfall, en
 * `HotelRoompack.pricing`.
 */
export const HotelPriceSchema = z.object({
  total: MoneySchema,
  taxes: MoneySchema.optional(),
  taxesDetail: z.array(HotelTaxSchema),
  /**
   * Un único cargo en destino en la moneda del pack, como lo informa Despegar. Un proveedor con
   * varios cargos, por habitación o en otra moneda, usa `atPropertyCharges` y deja éste vacío
   * para no mezclar monedas.
   */
  chargeAtDestination: MoneySchema.optional(),
  /** Comisión B2B que expone el proveedor, si la expone: base del waterfall del consolidador. */
  agencyCommission: z
    .object({ amount: MoneySchema, percentage: z.number().min(0).max(100) })
    .optional(),
  /**
   * Precio mínimo al que el proveedor permite vender. Es un piso del waterfall, no un precio: si
   * la cascada queda por debajo, el precio de venta sube hasta aquí.
   */
  minimumSellingPrice: MoneySchema.optional(),
  /** Cargo por huésped adicional que informa el proveedor. Sólo para el vendedor; nunca se suma. */
  extraGuestCharges: MoneySchema.optional(),
  /**
   * Precio por habitación y por noche (`nightly[j][n]`), informativo y redondeado. Nunca se suma
   * para obtener el total: el total es el del proveedor.
   */
  nightly: z.array(z.array(MoneySchema).min(1)).min(1).optional(),
});
export type HotelPrice = z.infer<typeof HotelPriceSchema>;

/**
 * Pricing waterfall aplicado a un roompack, con el mismo contrato que `Offer.pricing`.
 *
 * Deliberadamente sin neto ni desglose por paso: le dirían a una agencia cuánto gana el
 * consolidador sobre ella.
 */
export const HotelPricingSchema = z.object({
  /** Lo que le cuesta a ESTE tenant: neto del proveedor + markup de su red por encima. */
  costMinor: z.number().int(),
  /** Precio de VENTA al cliente final. */
  finalMinor: z.number().int(),
  /** Margen propio del tenant. No incluye el de sus ancestros. */
  ownMarkupMinor: z.number().int(),
  currency: CurrencyCodeSchema,
});
export type HotelPricing = z.infer<typeof HotelPricingSchema>;

// ───────────────────────── Cancelación ─────────────────────────

export const HotelCancellationStatusSchema = z.enum([
  'non_refundable',
  'partially_refundable',
  'fully_refundable',
]);
export type HotelCancellationStatus = z.infer<typeof HotelCancellationStatusSchema>;

/**
 * De dónde salen las políticas del pack.
 *
 * - `none`: el proveedor no mandó tramos (listado sin detalle). Sólo se sabe si es reembolsable.
 * - `search-indicative`: tramos de una búsqueda; se muestran "sujetos a confirmación".
 * - `prebook-final`: tramos del PreBook, que el proveedor declara finales.
 *
 * Ausente = no declarado, como `Offer.expiresAtSource`: sólo `prebook-final` autoriza presentar
 * las políticas como definitivas.
 */
export const HotelPolicySourceSchema = z.enum(['none', 'search-indicative', 'prebook-final']);
export type HotelPolicySource = z.infer<typeof HotelPolicySourceSchema>;

/**
 * Un tramo de penalidad.
 *
 * Admite las dos formas en que los proveedores lo expresan: horas relativas al check-in
 * (`fromHours`/`toHours`) o un inicio absoluto en hora local del hotel (`fromLocalDateTime`),
 * que vale hasta el inicio del tramo siguiente.
 */
export const HotelCancellationRuleSchema = z.object({
  /** Tipo de cargo según el proveedor (`PERCENTAGE`, `Fixed`, …), sin normalizar. */
  type: z.string().max(40),
  penaltyPercentage: z.number().min(0).max(100).optional(),
  penaltyNights: z.number().int().nonnegative().optional(),
  fromHours: z.number().nonnegative().optional(),
  toHours: z.number().nonnegative().optional(),
  fromLocalDateTime: HotelLocalDateTimeSchema.optional(),
  /**
   * El literal de la fecha tal como llegó: el formato de origen no es ISO y se guarda para
   * disputas.
   */
  fromDateRaw: z.string().min(1).max(40).optional(),
  /** Penalidad de importe fijo, en la moneda del pack. */
  penaltyAmount: MoneySchema.optional(),
  /** Habitación, base 1. Ausente: el tramo aplica a toda la reserva. */
  roomIndex: z.number().int().positive().optional(),
});
export type HotelCancellationRule = z.infer<typeof HotelCancellationRuleSchema>;

export const HotelCancellationSchema = z
  .object({
    refundable: z.boolean(),
    status: HotelCancellationStatusSchema,
    hoursBeforePenalty: z.number().nonnegative().optional(),
    vendorNotes: z.string().max(4000).optional(),
    rules: z.array(HotelCancellationRuleSchema),
    policySource: HotelPolicySourceSchema.optional(),
    /** Fin de la cancelación gratuita en hora local del hotel, derivado de los tramos. */
    freeCancellationUntilLocal: HotelLocalDateTimeSchema.optional(),
  })
  .superRefine((c, ctx) => {
    // Dos campos para un mismo hecho sólo sirven si no se contradicen: la web pinta uno y el
    // cálculo de la penalidad lee el otro.
    if (c.refundable !== (c.status !== 'non_refundable')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['refundable'],
        message: 'refundable contradice status',
      });
    }
    if (c.policySource === 'none') {
      if (c.rules.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules'],
          message: "policySource 'none' declara que no hay tramos",
        });
      }
      // Declarar "cancelación gratuita" sin haber visto un solo tramo es inventarla, sea como
      // estado o como fecha límite.
      if (c.status === 'fully_refundable') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: "sin tramos (policySource 'none') no se puede afirmar fully_refundable",
        });
      }
      if (c.freeCancellationUntilLocal !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['freeCancellationUntilLocal'],
          message:
            "sin tramos (policySource 'none') no hay de dónde derivar la cancelación gratuita",
        });
      }
    }
  });
export type HotelCancellation = z.infer<typeof HotelCancellationSchema>;

// ───────────────────────── Habitación, roompack y oferta ─────────────────────────

export const HotelRoomSchema = z.object({
  name: z.string().max(500),
  /** Posición de la habitación dentro del pack, como la numera el proveedor. */
  reference: z.number().int().nonnegative(),
  roomTypeId: z.string().max(64).optional(),
  maxCapacity: z.number().int().nonnegative().optional(),
  bedOptions: z.array(z.string().max(200)),
  /**
   * Token reservable POR HABITACIÓN, para el proveedor que reserva así (Despegar, y sólo en el
   * detalle). El que reserva el pack entero lo lleva en `HotelRoompack.provider.offerRef`.
   */
  choiceId: z.string().max(4096).optional(),
  /**
   * La ocupación que cubre esta habitación. La reserva nombra a los huéspedes habitación por
   * habitación.
   */
  occupancy: HotelRoomOccupancySchema.optional(),
  promotions: z.array(z.string().min(1).max(500)).optional(),
});
export type HotelRoom = z.infer<typeof HotelRoomSchema>;

/**
 * Combinación reservable de habitaciones con UN precio. Es indivisible: no se puede reservar la
 * habitación 1 de un pack con la habitación 2 de otro.
 */
export const HotelRoompackSchema = z
  .object({
    id: z.string().min(1).max(255),
    /**
     * De qué proveedor es ESTA tarifa. Va en el pack y no en el hotel porque un mismo hotel puede
     * reunir tarifas de varios proveedores en una sola tarjeta: atribuirle el hotel entero a uno
     * sería falso. Viaja siempre, se muestre o no según la divulgación del tenant, porque el
     * PreBook se enruta por `provider.name` (RF-40: "me tiene que mostrar de dónde es").
     */
    provider: HotelProviderRefSchema,
    /** Para filtrar y agrupar. Al viajero se le muestra `boardLabel`. */
    board: BoardTypeSchema,
    /**
     * Etiqueta del régimen. `board` tiene cinco valores y los proveedores más: "Desayuno para 1
     * persona" cabe en `BB`, pero mostrarlo como "Desayuno" en una doble promete de más.
     */
    boardLabel: z.string().min(1).max(120).optional(),
    mealTypeRaw: z.string().min(1).max(80).optional(),
    rooms: z.array(HotelRoomSchema).min(1),
    cancellation: HotelCancellationSchema,
    price: HotelPriceSchema,
    /** Ausente si el tenant no tiene reglas de markup: precio de venta = neto. */
    pricing: HotelPricingSchema.optional(),
    /** Hasta cuándo se puede reservar sin volver a buscar. Instante con zona. */
    expiresAt: z.string().datetime({ offset: true }).optional(),
    atPropertyCharges: z.array(HotelFeeSchema).optional(),
    includedSupplements: z.array(HotelFeeSchema).optional(),
    includesTransfers: z.boolean().optional(),
    /** Inclusiones como las escribe el proveedor, sin partir: el separador no está documentado. */
    inclusionText: z.string().min(1).max(2000).optional(),
  })
  .superRefine((pack, ctx) => {
    const currency = pack.price.total.currency;

    // Todo lo que se cobra en la reserva va en UNA moneda. La puerta de moneda decide por
    // `price.total` y un pack que la pasa con un impuesto o un piso en otra moneda llevaría una
    // conversión escondida hasta la factura. Los suplementos quedan fuera: se pagan en el hotel.
    const sameCurrency = (money: Money | undefined, path: (string | number)[]): void => {
      if (money !== undefined && money.currency !== currency) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `${money.currency} no es la moneda del pack (${currency})`,
        });
      }
    };
    sameCurrency(pack.price.taxes, ['price', 'taxes']);
    pack.price.taxesDetail.forEach((t, i) =>
      sameCurrency(t.amount, ['price', 'taxesDetail', i, 'amount']),
    );
    sameCurrency(pack.price.chargeAtDestination, ['price', 'chargeAtDestination']);
    sameCurrency(pack.price.agencyCommission?.amount, ['price', 'agencyCommission', 'amount']);
    sameCurrency(pack.price.minimumSellingPrice, ['price', 'minimumSellingPrice']);
    sameCurrency(pack.price.extraGuestCharges, ['price', 'extraGuestCharges']);
    pack.price.nightly?.forEach((noches, j) =>
      noches.forEach((n, k) => sameCurrency(n, ['price', 'nightly', j, k])),
    );
    pack.cancellation.rules.forEach((r, i) =>
      sameCurrency(r.penaltyAmount, ['cancellation', 'rules', i, 'penaltyAmount']),
    );
    if (pack.pricing !== undefined && pack.pricing.currency !== currency) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pricing', 'currency'],
        message: `${pack.pricing.currency} no es la moneda del pack (${currency})`,
      });
    }

    // Un índice fuera del pack asignaría un cargo a una habitación que no existe.
    const roomCount = pack.rooms.length;
    const inPack = (roomIndex: number | undefined, path: (string | number)[]): void => {
      if (roomIndex !== undefined && roomIndex > roomCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `habitación ${roomIndex} fuera de un pack de ${roomCount}`,
        });
      }
    };
    pack.atPropertyCharges?.forEach((c, i) =>
      inPack(c.roomIndex, ['atPropertyCharges', i, 'roomIndex']),
    );
    pack.includedSupplements?.forEach((c, i) =>
      inPack(c.roomIndex, ['includedSupplements', i, 'roomIndex']),
    );
    pack.cancellation.rules.forEach((r, i) =>
      inPack(r.roomIndex, ['cancellation', 'rules', i, 'roomIndex']),
    );
  });
export type HotelRoompack = z.infer<typeof HotelRoompackSchema>;

/**
 * Un hotel con sus tarifas disponibles.
 *
 * No lleva proveedor propio: el de cada tarifa está en su pack. `name`, `stars` y `location`
 * son opcionales porque hay respuestas de disponibilidad que no los traen y se completan desde
 * el catálogo.
 */
export const HotelOfferSchema = z.object({
  hotelId: z.string().min(1).max(64),
  name: z.string().max(300).optional(),
  stars: z.number().min(0).max(5).optional(),
  type: z.string().max(60).optional(),
  location: GeoLocationSchema.optional(),
  roompacks: z.array(HotelRoompackSchema),
});
export type HotelOffer = z.infer<typeof HotelOfferSchema>;
