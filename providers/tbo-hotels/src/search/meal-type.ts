import type { BoardType } from '@sales-travel/canonical';

/**
 * Los DOS vocabularios de régimen de TBO (docs/tbo/02 §9.8; 08 RF-05 S-03 y RF-11).
 *
 * - **Filtro** del request (`Filters.MealType`; la enumeración se llama `MealPlan`, p. 69): `All`,
 *   `WithMeal`, `RoomOnly`. Siempre como string: Postman manda el ordinal `0` (Postman: Search),
 *   pero el PDF lo declara enum de strings (p. 11) y no dependemos de que TBO acepte los dos.
 * - **Tarifa** de la respuesta (`Rooms[].MealType`, p. 70): diez valores con casing mezclado
 *   (`BreakFast` y `BreakFast_Lunch` frente a `Breakfast_For_1`). `RoomOnly` (filtro) no es
 *   `Room_Only` (tarifa).
 *
 * El canónico `BoardType` tiene cinco valores y TBO diez: `board` sirve para filtrar y agrupar, y
 * lo que se muestra es la etiqueta (S-14). `Breakfast_For_1` cabe en `BB`, pero pintarlo como
 * "Desayuno" en una doble promete de más.
 */

/** `Filters.MealType` del request (p. 11, 69). */
export const TBO_MEAL_PLANS = ['All', 'WithMeal', 'RoomOnly'] as const;
export type TboMealPlan = (typeof TBO_MEAL_PLANS)[number];

export interface TboMealType {
  readonly board: BoardType;
  /** Lo que se muestra. `undefined` nunca: el vendedor ve siempre algo verdadero. */
  readonly label: string;
  /** El literal de TBO, recortado al techo del canónico. Ausente si TBO no mandó régimen. */
  readonly raw: string | undefined;
  /** `false` si el valor no está en la enumeración de p. 70 o no vino: se mide. */
  readonly known: boolean;
}

interface KnownMealType {
  readonly board: BoardType;
  readonly label: string;
}

/**
 * p. 70, con la clave normalizada (minúsculas, sin `_`): la comparación ignora mayúsculas y
 * guiones bajos porque el propio PDF mezcla `BreakFast` y `Breakfast_For_1` (Q-28).
 *
 * `Lunch` y `Dinner` van a `RO`: no hay `BoardType` para "una comida que no es el desayuno", y
 * quedarse corto es mejor que prometer un desayuno que el hotel no da. `BreakFast_Lunch` va a
 * `HB` por ser dos comidas; si TBO lo considera media pensión está abierto en Q-28.
 */
const KNOWN: ReadonlyMap<string, KnownMealType> = new Map<string, KnownMealType>([
  ['roomonly', { board: 'RO', label: 'Solo alojamiento' }],
  ['breakfast', { board: 'BB', label: 'Desayuno' }],
  ['breakfastfor1', { board: 'BB', label: 'Desayuno para 1 persona' }],
  ['breakfastfor2', { board: 'BB', label: 'Desayuno para 2 personas' }],
  ['halfboard', { board: 'HB', label: 'Media pensión' }],
  ['fullboard', { board: 'FB', label: 'Pensión completa' }],
  ['allinclusiveallmeal', { board: 'AI', label: 'Todo incluido' }],
  ['breakfastlunch', { board: 'HB', label: 'Desayuno y almuerzo' }],
  ['lunch', { board: 'RO', label: 'Almuerzo incluido' }],
  ['dinner', { board: 'RO', label: 'Cena incluida' }],
]);

/** Techos de `boardLabel` y `mealTypeRaw` en `packages/canonical/src/hotel-offer.ts`. */
const LABEL_MAX = 120;
const RAW_MAX = 80;

/**
 * Sin régimen informado, `RO` es sólo la clave para agrupar. La etiqueta lo dice: mostrar "Solo
 * alojamiento" afirmaría algo que TBO no dijo (RF-11, "sin datos inventados").
 */
const NOT_INFORMED = 'Régimen no informado';

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * `Rooms[].MealType` → régimen canónico, etiqueta y literal (02 §9.8). Un valor desconocido cae a
 * `RO` con el literal como etiqueta y `known: false`, para que el mapper incremente
 * `tbo.unknown_meal_type` (RF-11 CA-3).
 */
export function mapTboMealType(value: string | null | undefined): TboMealType {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) {
    return { board: 'RO', label: NOT_INFORMED, raw: undefined, known: false };
  }
  const raw = trimmed.slice(0, RAW_MAX);
  const known = KNOWN.get(normalize(trimmed));
  if (known !== undefined) return { board: known.board, label: known.label, raw, known: true };
  return { board: 'RO', label: trimmed.slice(0, LABEL_MAX), raw, known: false };
}
