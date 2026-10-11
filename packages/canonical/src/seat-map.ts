import { z } from '@sales-travel/validation';
import { MoneySchema } from './money';
import { CabinClassSchema } from './segment';

/**
 * Mapa de asientos de los tramos de una oferta de vuelo.
 *
 * Es una foto del avión en el momento de la consulta: qué asientos existen, cuáles se pueden
 * vender y a qué precio para CADA pasajero. No es una reserva ni una promesa: al reservar hay que
 * volver a leerlo, porque otro vendedor puede haberse quedado el asiento entre medias.
 *
 * Ningún campo lleva identificadores del proveedor salvo `offerRef`, que es opaco: sólo lo
 * interpreta el ACL que lo escribió.
 */

/**
 * Lo que el vendedor ve de un asiento. Vocabulario NUESTRO, cerrado: cada ACL traduce el suyo
 * (Sabre usa los códigos PADIS 9825) y descarta lo que no encaja aquí.
 *
 * `WINDOW` se promete sólo cuando hay ventana: un asiento junto al fuselaje sin ventana no lo
 * lleva, porque en la cotización se lee como una promesa al cliente.
 */
export const SeatCharacteristicSchema = z.enum([
  'WINDOW',
  'AISLE',
  'MIDDLE',
  'EXIT_ROW',
  'EXTRA_LEGROOM',
  'BASSINET',
  'NO_RECLINE',
]);
export type SeatCharacteristic = z.infer<typeof SeatCharacteristicSchema>;

/**
 * Un asiento vendible a UN pasajero.
 *
 * El precio va por pasajero y no por asiento porque así lo da el proveedor: Sabre devuelve un
 * `offerItem` por pasajero para el mismo asiento, y su precio puede depender del tipo de
 * pasajero o de su programa de viajero frecuente.
 */
export const SeatOfferSchema = z.object({
  /**
   * Índice global, base cero, del pasajero en la búsqueda: adultos, luego niños, luego
   * infantes. Es el mismo `requestedTravelerIndex` que usa la reserva.
   */
  passengerIndex: z.number().int().nonnegative(),
  /**
   * Ausente = el proveedor no informó el precio. `amountMinor: 0` = sin cargo.
   *
   * Son cosas distintas y sólo una se puede vender como gratis: quien trate la ausencia como
   * cero regala un asiento que la aerolínea va a cobrar al emitir.
   */
  price: MoneySchema.optional(),
  /** Identificador opaco de la oferta del asiento. Sólo lo interpreta el ACL que lo escribió. */
  offerRef: z.string().min(1).max(255),
});
export type SeatOffer = z.infer<typeof SeatOfferSchema>;

export const SeatSchema = z
  .object({
    /** Letra de la columna. Fila + columna es el número del asiento: `12C`. */
    column: z.string().regex(/^[A-Z]$/, 'seat column must be one uppercase letter'),
    /**
     * Se le puede vender a alguien: libre, operativo, sin restricción general y con al menos una
     * oferta. Equivale a `offers.length > 0`; que se pueda vender a un pasajero CONCRETO lo dice
     * `offers`, no este campo.
     */
    available: z.boolean(),
    characteristics: z.array(SeatCharacteristicSchema),
    /** Fila de salida de emergencia o asiento no apto para niños: sólo lo ocupa un adulto. */
    adultOnly: z.boolean(),
    /** `false`: un adulto que viaja con un infante en brazos no puede sentarse aquí. */
    infantAllowed: z.boolean(),
    /**
     * Una entrada por pasajero al que se le puede vender. Un pasajero que no aparece no puede
     * elegir este asiento, aunque `available` sea `true`. Un asiento no disponible no lleva
     * ninguna: así nadie puede venderlo leyendo sólo las ofertas.
     */
    offers: z.array(SeatOfferSchema),
  })
  .superRefine((seat, ctx) => {
    const seen = new Set<number>();
    for (const offer of seat.offers) {
      if (seen.has(offer.passengerIndex)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['offers'],
          message: 'a passenger can hold only one offer per seat',
        });
        return;
      }
      seen.add(offer.passengerIndex);
    }
    if (seat.available !== seat.offers.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['available'],
        message: 'a seat is available exactly when it is sellable to at least one passenger',
      });
    }
  });
export type Seat = z.infer<typeof SeatSchema>;

export const SeatRowSchema = z.object({
  number: z.number().int().positive(),
  /**
   * Sólo los asientos que existen. Un hueco del avión (pasillo ancho, baño, cocina) no se
   * representa: la columna simplemente falta en la fila.
   */
  seats: z.array(SeatSchema),
});
export type SeatRow = z.infer<typeof SeatRowSchema>;

export const SeatMapCabinSchema = z
  .object({
    /** Ausente = el proveedor usó un código de cabina que no sabemos traducir. */
    cabin: CabinClassSchema.optional(),
    /** Columnas de izquierda a derecha. */
    columns: z.array(z.string().regex(/^[A-Z]$/)).min(1),
    /** Columnas tras las que hay un pasillo: `['C']` en un 3-3, `['C', 'G']` en un 3-4-3. */
    aisleAfter: z.array(z.string().regex(/^[A-Z]$/)),
    rows: z.array(SeatRowSchema),
  })
  .superRefine((cabin, ctx) => {
    const columns = new Set(cabin.columns);
    if (columns.size !== cabin.columns.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['columns'],
        message: 'columns must be unique',
      });
    }
    for (const aisle of cabin.aisleAfter) {
      if (!columns.has(aisle)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['aisleAfter'],
          message: 'an aisle must follow a declared column',
        });
      }
    }
    const rowNumbers = new Set<number>();
    cabin.rows.forEach((row, rowIndex) => {
      if (rowNumbers.has(row.number)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rows', rowIndex, 'number'],
          message: 'row numbers must be unique within a cabin',
        });
      }
      rowNumbers.add(row.number);
      const seatColumns = new Set<string>();
      row.seats.forEach((seat, seatIndex) => {
        if (!columns.has(seat.column) || seatColumns.has(seat.column)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['rows', rowIndex, 'seats', seatIndex, 'column'],
            message: 'each seat must sit in a declared column, once per row',
          });
        }
        seatColumns.add(seat.column);
      });
    });
  });
export type SeatMapCabin = z.infer<typeof SeatMapCabinSchema>;

export const SeatMapSegmentSchema = z.object({
  /**
   * Índice sobre los segmentos de `Offer.itineraries`, aplanados en orden: el mismo eje que
   * `FareComponent.segmentRefs`.
   */
  segmentRef: z.number().int().nonnegative(),
  /**
   * Avión dentro del segmento, base cero. Siempre 0 salvo con cambio de equipo, donde el mismo
   * número de vuelo cambia de avión a mitad de camino y cada avión trae su propio mapa.
   */
  legIndex: z.number().int().nonnegative(),
  /**
   * El segmento cambia de avión. Quien reserve asiento en el primero tiene que reservar también
   * en el segundo, o el pasajero queda sin asiento en la segunda mitad sin que nadie se entere.
   */
  changeOfGauge: z.boolean(),
  cabins: z.array(SeatMapCabinSchema).min(1),
});
export type SeatMapSegment = z.infer<typeof SeatMapSegmentSchema>;

export const SeatMapSchema = z
  .object({
    segments: z.array(SeatMapSegmentSchema),
    /** Códigos de aviso del mapeo, sin repetir. Nunca texto libre del proveedor. */
    warnings: z.array(z.string().min(1).max(80)),
  })
  .superRefine((map, ctx) => {
    const seen = new Set<string>();
    map.segments.forEach((segment, index) => {
      const key = `${String(segment.segmentRef)}:${String(segment.legIndex)}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', index],
          message: 'a segment leg can have only one seat map',
        });
      }
      seen.add(key);
    });
  });
export type SeatMap = z.infer<typeof SeatMapSchema>;
