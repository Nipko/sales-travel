import type { HotelRoomOccupancy, HotelSearchCriteria } from '@sales-travel/canonical';
import { z } from 'zod';
import { TboRequestBuildError } from '../errors';
import { TBO_OPERATIONS, TBO_SEARCH_RESPONSE_TIME_S } from '../http/operations';
import { isTboIsoDate } from '../internal/tbo-date';
import { zodIssueRefs } from '../internal/zod-issues';
import { TBO_MEAL_PLANS, type TboMealPlan } from './meal-type';

/**
 * Body de `Search` (docs/tbo/02 §2-§3 y §7; 08 RF-05).
 *
 * Aplica las reglas S-01 a S-06 de 02 §2.3:
 *
 * - **S-01** `HotelCodes` es UN string CSV, sin espacios, deduplicado y con como mucho 100 códigos
 *   ("Recommended Value; 100 hotel codes", p. 10).
 * - **S-02** Nunca `Filters.OrderBy`, `StarRating` ni `HotelName`: sólo existen en Postman y
 *   filtrar por estrellas o nombre es trabajo nuestro sobre el contenido estático.
 * - **S-03** `Filters.MealType` es el string del enum (`"All"`), nunca el ordinal de Postman.
 * - **S-04** `IsDetailedResponse: false` en todo listado (KP-2, p. 71). El detalle de un hotel lo
 *   pide con UN solo código (D-TBO-19 A); con más, el builder se niega.
 * - **S-05** `GuestNationality` es la del huésped líder, alfa-2 y sin valor por defecto (KP-1,
 *   p. 71: "TBO shall not be liable" si se fija en código).
 * - **S-06** `PaxRooms` conserva el orden en que el vendedor cargó las habitaciones: los índices
 *   por habitación de la respuesta y los `CustomerDetails[j]` del Book dependen de él (02 §3.3).
 *
 * Además se envían siempre todos los campos documentados (C-01: el PDF no dice cuáles son
 * obligatorios) y nada más: el body de salida pasa por un Zod `.strict()` antes de devolverse.
 *
 * Nunca se trunca ni se reparte una ocupación que TBO no admite: esa búsqueda queda fuera para
 * TBO con motivo (RF-05 CA-2). {@link checkTboSearchEligibility} lo dice ANTES de construir, para
 * que el servicio muestre el motivo; si igual se llama al builder, lanza `NOT_ELIGIBLE`.
 */

/**
 * Topes de TBO para una búsqueda. Los de ocupación son del contrato (p. 10-11) y los de volumen,
 * decisión nuestra (02 §3.1, §4; Q-14, Q-15).
 */
export const TBO_SEARCH_LIMITS = Object.freeze({
  /** "Recommended Value; 100 hotel codes" (p. 10). */
  maxHotelCodesPerRequest: 100,
  /** No documentado (Q-14): el tope del borde HTTP de la plataforma. */
  maxRoomsPerSearch: 8,
  /** "Number of Adult guests (1-8) per room" (p. 10). */
  minAdultsPerRoom: 1,
  maxAdultsPerRoom: 8,
  /** "Number of Child guests (1-4) per room" (p. 11); el 0 es la habitación sólo de adultos. */
  maxChildrenPerRoom: 4,
  /** "List of children ages (0-18 years)" (p. 11). Nuestro borde corta en 17 (Q-14). */
  minChildAge: 0,
  maxChildAge: 18,
} as const);

/**
 * Qué se manda en `ChildrenAges` para una habitación sin niños (C-04, Q-13). La regla escrita
 * ("The length of array is equal to the number of children", p. 11) pide `[]`; Postman manda `[0]`
 * con `Children: 0`. Queda configurable hasta que la sonda PR-01 fije la que TBO acepta: si TBO
 * rechaza `[]`, el cambio es esta opción y no el builder.
 */
export const TBO_EMPTY_CHILDREN_AGES = ['empty-array', 'omit', 'zero'] as const;
export type TboEmptyChildrenAges = (typeof TBO_EMPTY_CHILDREN_AGES)[number];

/** Por qué TBO no puede participar en una búsqueda. Cada uno es un motivo visible, no un error. */
export type TboSearchIneligibility =
  | 'TOO_MANY_ROOMS'
  | 'ADULTS_OUT_OF_RANGE'
  | 'TOO_MANY_CHILDREN'
  | 'CHILD_AGE_OUT_OF_RANGE'
  | 'GUEST_NATIONALITY_MISSING';

export type TboSearchEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason: TboSearchIneligibility;
      /** Habitación que no cumple, base 1, en el orden del vendedor. */
      readonly roomIndex?: number;
    };

/**
 * Lo que el builder lee del criterio neutral. `hotelIds` ya son códigos de TBO: la resolución
 * destino → hoteles la hace el servicio contra el catálogo del proveedor.
 */
export type TboSearchCriteria = Pick<
  HotelSearchCriteria,
  'checkinDate' | 'checkoutDate' | 'guestNationality' | 'refundableOnly'
> & {
  readonly hotelIds: readonly string[];
  readonly rooms: readonly HotelRoomOccupancy[];
};

export interface TboSearchRequestOptions {
  /**
   * Detalle de UN hotel (D-TBO-19 A): `IsDetailedResponse: true` para ver políticas y precio por
   * noche "sujetos a confirmación". Exige exactamente un código.
   */
  readonly detailed?: boolean;
  /** `ResponseTime` en segundos, entero de 5 a 20; 10 por defecto (D-TBO-17 A; 02 §6.1). */
  readonly responseTimeSeconds?: number;
  readonly emptyChildrenAges?: TboEmptyChildrenAges;
  /** Sólo puede ACORTAR el tope de 100 (p. 10). */
  readonly maxHotelCodesPerRequest?: number;
  /** Sólo puede ACORTAR el tope de 8 habitaciones. */
  readonly maxRoomsPerSearch?: number;
  /** El borde de hoy no filtra por régimen: `All` por defecto (02 §7). */
  readonly mealPlan?: TboMealPlan;
}

/**
 * ¿Puede TBO buscar esta ocupación con esta nacionalidad? Pura y sin llamar a nadie: la usa el
 * servicio para dejar a TBO fuera con motivo mientras el resto de los proveedores sigue (RF-05
 * CA-2, RF-06 CA-1). Primero la ocupación, que no se arregla completando un campo.
 */
export function checkTboSearchEligibility(
  criteria: Pick<TboSearchCriteria, 'rooms' | 'guestNationality'>,
  options: Pick<TboSearchRequestOptions, 'maxRoomsPerSearch'> = {},
): TboSearchEligibility {
  const maxRooms = Math.min(
    options.maxRoomsPerSearch ?? TBO_SEARCH_LIMITS.maxRoomsPerSearch,
    TBO_SEARCH_LIMITS.maxRoomsPerSearch,
  );
  if (criteria.rooms.length > maxRooms) return { eligible: false, reason: 'TOO_MANY_ROOMS' };

  for (const [index, room] of criteria.rooms.entries()) {
    const roomIndex = index + 1;
    if (
      !Number.isInteger(room.adults) ||
      room.adults < TBO_SEARCH_LIMITS.minAdultsPerRoom ||
      room.adults > TBO_SEARCH_LIMITS.maxAdultsPerRoom
    ) {
      return { eligible: false, reason: 'ADULTS_OUT_OF_RANGE', roomIndex };
    }
    if (room.childrenAges.length > TBO_SEARCH_LIMITS.maxChildrenPerRoom) {
      return { eligible: false, reason: 'TOO_MANY_CHILDREN', roomIndex };
    }
    const ageOutOfRange = room.childrenAges.some(
      (age) =>
        !Number.isInteger(age) ||
        age < TBO_SEARCH_LIMITS.minChildAge ||
        age > TBO_SEARCH_LIMITS.maxChildAge,
    );
    if (ageOutOfRange) return { eligible: false, reason: 'CHILD_AGE_OUT_OF_RANGE', roomIndex };
  }

  const nationality = criteria.guestNationality;
  if (nationality === undefined || nationality.trim().length === 0) {
    return { eligible: false, reason: 'GUEST_NATIONALITY_MISSING' };
  }
  return { eligible: true };
}

// ───────────────────────── Esquema de salida ─────────────────────────

const IsoDateSchema = z.string().refine(isTboIsoDate, { params: { reason: 'invalid_date' } });

const PaxRoomSchema = z
  .object({
    Adults: z
      .number()
      .int()
      .min(TBO_SEARCH_LIMITS.minAdultsPerRoom)
      .max(TBO_SEARCH_LIMITS.maxAdultsPerRoom),
    Children: z.number().int().min(0).max(TBO_SEARCH_LIMITS.maxChildrenPerRoom),
    ChildrenAges: z
      .array(z.number().int().min(TBO_SEARCH_LIMITS.minChildAge).max(TBO_SEARCH_LIMITS.maxChildAge))
      .max(TBO_SEARCH_LIMITS.maxChildrenPerRoom)
      .optional(),
  })
  .strict()
  .superRefine((room, ctx) => {
    const ages = room.ChildrenAges;
    if (room.Children > 0) {
      // S-06: `Children` es la longitud de `ChildrenAges` cuando hay niños, sin excepción.
      if (ages?.length !== room.Children) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ChildrenAges'],
          params: { reason: 'length_differs_from_children' },
        });
      }
      return;
    }
    // Sin niños, sólo las tres formas de `emptyChildrenAges`.
    const emptyShape =
      ages === undefined || ages.length === 0 || (ages.length === 1 && ages[0] === 0);
    if (!emptyShape) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ChildrenAges'],
        params: { reason: 'ages_without_children' },
      });
    }
  });

const TboSearchRequestSchema = z
  .object({
    CheckIn: IsoDateSchema,
    CheckOut: IsoDateSchema,
    HotelCodes: z.string().regex(/^[A-Za-z0-9]+(,[A-Za-z0-9]+)*$/),
    GuestNationality: z.string().regex(/^[A-Z]{2}$/),
    PaxRooms: z.array(PaxRoomSchema).min(1).max(TBO_SEARCH_LIMITS.maxRoomsPerSearch),
    ResponseTime: z
      .number()
      .int()
      .min(TBO_SEARCH_RESPONSE_TIME_S.min)
      .max(TBO_SEARCH_RESPONSE_TIME_S.max),
    IsDetailedResponse: z.boolean(),
    Filters: z
      .object({
        Refundable: z.boolean(),
        // Enviamos `0`, como Postman y el ejemplo de una habitación, leído como "sin límite": la
        // semántica de `NoOfRooms` es ambigua (02 §7, C-12; Q-18).
        NoOfRooms: z.literal(0),
        MealType: z.enum(TBO_MEAL_PLANS),
      })
      .strict(),
  })
  .strict()
  .superRefine((body, ctx) => {
    // Fechas ISO sin hora: el orden del texto es el cronológico.
    if (body.CheckOut <= body.CheckIn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CheckOut'],
        params: { reason: 'not_after_checkin' },
      });
    }
    const codes = body.HotelCodes.split(',');
    if (codes.length > TBO_SEARCH_LIMITS.maxHotelCodesPerRequest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['HotelCodes'],
        params: { reason: 'too_many_codes' },
      });
    }
    if (new Set(codes).size !== codes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['HotelCodes'],
        params: { reason: 'duplicated_code' },
      });
    }
    if (body.IsDetailedResponse && codes.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IsDetailedResponse'],
        params: { reason: 'detail_requires_single_hotel' },
      });
    }
  });

/** El body exacto que sale al cable. Tipo crudo de TBO: no sale del paquete. */
export type TboSearchRequest = z.infer<typeof TboSearchRequestSchema>;
export type TboPaxRoom = TboSearchRequest['PaxRooms'][number];

// ───────────────────────── Construcción ─────────────────────────

/** Un código de TBO sin separadores: una coma o un espacio partirían el CSV (S-01). */
const HOTEL_CODE = /^[A-Za-z0-9]+$/;

function fail(reason: 'SCHEMA' | 'NOT_ELIGIBLE', issues: readonly string[]): never {
  throw new TboRequestBuildError(TBO_OPERATIONS.search.path, reason, issues);
}

/** Opción entera dentro de `[min, max]`, o el valor por defecto si no vino. */
function boundedOption(
  name: string,
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('SCHEMA', [`options.${name}:out_of_range`]);
  }
  return value;
}

/**
 * S-01: deduplica conservando el primer orden de aparición, que es el de relevancia con que el
 * servicio eligió los códigos (02 §4.3).
 */
function hotelCodesCsv(hotelIds: readonly string[], max: number): string {
  if (hotelIds.length === 0) fail('SCHEMA', ['hotelIds:too_small']);
  const invalid = hotelIds.flatMap((code, index) =>
    HOTEL_CODE.test(code) ? [] : [`hotelIds.${index}:invalid_code`],
  );
  if (invalid.length > 0) fail('SCHEMA', invalid.slice(0, 20));
  const unique = [...new Set(hotelIds)];
  // Nunca se recorta: partir en lotes es decisión del adapter (D-TBO-17), y un recorte aquí
  // escondería hoteles sin que nadie lo sepa.
  if (unique.length > max) fail('SCHEMA', ['hotelIds:too_many_codes']);
  return unique.join(',');
}

function paxRoom(room: HotelRoomOccupancy, emptyChildrenAges: TboEmptyChildrenAges): TboPaxRoom {
  const children = room.childrenAges.length;
  if (children > 0) {
    return { Adults: room.adults, Children: children, ChildrenAges: [...room.childrenAges] };
  }
  switch (emptyChildrenAges) {
    case 'empty-array':
      return { Adults: room.adults, Children: 0, ChildrenAges: [] };
    case 'omit':
      return { Adults: room.adults, Children: 0 };
    case 'zero':
      // La forma de Postman. Sólo existe para que la sonda PR-01 la pueda comparar.
      return { Adults: room.adults, Children: 0, ChildrenAges: [0] };
  }
}

function ineligibilityIssue(
  eligibility: Exclude<TboSearchEligibility, { eligible: true }>,
): string {
  const room = eligibility.roomIndex === undefined ? '' : `.${eligibility.roomIndex - 1}`;
  switch (eligibility.reason) {
    case 'TOO_MANY_ROOMS':
      return 'PaxRooms:too_many_rooms';
    case 'ADULTS_OUT_OF_RANGE':
      return `PaxRooms${room}.Adults:out_of_range`;
    case 'TOO_MANY_CHILDREN':
      return `PaxRooms${room}.Children:too_many_children`;
    case 'CHILD_AGE_OUT_OF_RANGE':
      return `PaxRooms${room}.ChildrenAges:out_of_range`;
    case 'GUEST_NATIONALITY_MISSING':
      return 'GuestNationality:missing';
  }
}

/**
 * Construye el body de un Search. Lanza `TboRequestBuildError`:
 *
 * - `NOT_ELIGIBLE` si la búsqueda no cumple {@link checkTboSearchEligibility}: el servicio tenía
 *   que haber dejado a TBO fuera con motivo antes de llegar aquí;
 * - `SCHEMA` ante un criterio o una opción que no tiene forma de request válido.
 *
 * En los dos casos nada salió hacia TBO, y los issues son `ruta:código`, sin valores.
 */
export function buildTboSearchRequest(
  criteria: TboSearchCriteria,
  options: TboSearchRequestOptions = {},
): TboSearchRequest {
  const maxRooms = boundedOption(
    'maxRoomsPerSearch',
    options.maxRoomsPerSearch,
    TBO_SEARCH_LIMITS.maxRoomsPerSearch,
    1,
    TBO_SEARCH_LIMITS.maxRoomsPerSearch,
  );
  const maxCodes = boundedOption(
    'maxHotelCodesPerRequest',
    options.maxHotelCodesPerRequest,
    TBO_SEARCH_LIMITS.maxHotelCodesPerRequest,
    1,
    TBO_SEARCH_LIMITS.maxHotelCodesPerRequest,
  );
  const responseTime = boundedOption(
    'responseTimeSeconds',
    options.responseTimeSeconds,
    TBO_SEARCH_RESPONSE_TIME_S.default,
    TBO_SEARCH_RESPONSE_TIME_S.min,
    TBO_SEARCH_RESPONSE_TIME_S.max,
  );
  const emptyChildrenAges = options.emptyChildrenAges ?? 'empty-array';
  if (!TBO_EMPTY_CHILDREN_AGES.includes(emptyChildrenAges)) {
    fail('SCHEMA', ['options.emptyChildrenAges:invalid_enum_value']);
  }
  const mealPlan = options.mealPlan ?? 'All';
  if (!TBO_MEAL_PLANS.includes(mealPlan)) fail('SCHEMA', ['options.mealPlan:invalid_enum_value']);
  if (criteria.rooms.length === 0) fail('SCHEMA', ['rooms:too_small']);

  const eligibility = checkTboSearchEligibility(criteria, { maxRoomsPerSearch: maxRooms });
  if (!eligibility.eligible) fail('NOT_ELIGIBLE', [ineligibilityIssue(eligibility)]);

  // El orden de las claves es el del PDF (p. 11-12): no lo exige nadie, pero el RQ que se entrega
  // en la certificación se lee al lado del contrato.
  const body = {
    CheckIn: criteria.checkinDate,
    CheckOut: criteria.checkoutDate,
    HotelCodes: hotelCodesCsv(criteria.hotelIds, maxCodes),
    GuestNationality: criteria.guestNationality,
    PaxRooms: criteria.rooms.map((room) => paxRoom(room, emptyChildrenAges)),
    ResponseTime: responseTime,
    IsDetailedResponse: options.detailed === true,
    Filters: {
      Refundable: criteria.refundableOnly ?? false,
      NoOfRooms: 0,
      MealType: mealPlan,
    },
  };

  const parsed = TboSearchRequestSchema.safeParse(body);
  if (!parsed.success) fail('SCHEMA', zodIssueRefs(parsed.error));
  return parsed.data;
}
