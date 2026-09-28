import { BoardTypeSchema } from '@sales-travel/canonical';
import { describe, expect, it } from 'vitest';
import { TBO_MEAL_PLANS, mapTboMealType } from './meal-type';

/** Las dos enumeraciones de régimen de TBO (docs/tbo/02 §9.8; p. 69-70). */

describe('Rooms[].MealType → BoardType con etiqueta y literal (RF-11)', () => {
  // Los diez valores de p. 70, con el casing del PDF.
  it.each([
    ['Room_Only', 'RO', 'Solo alojamiento'],
    ['BreakFast', 'BB', 'Desayuno'],
    ['Breakfast_For_1', 'BB', 'Desayuno para 1 persona'],
    ['Breakfast_For_2', 'BB', 'Desayuno para 2 personas'],
    ['Half_Board', 'HB', 'Media pensión'],
    ['Full_Board', 'FB', 'Pensión completa'],
    ['All_Inclusive_All_Meal', 'AI', 'Todo incluido'],
    ['BreakFast_Lunch', 'HB', 'Desayuno y almuerzo'],
    ['Lunch', 'RO', 'Almuerzo incluido'],
    ['Dinner', 'RO', 'Cena incluida'],
  ])('%s → %s, "%s"', (raw, board, label) => {
    expect(mapTboMealType(raw)).toEqual({ board, label, raw, known: true });
    expect(BoardTypeSchema.safeParse(board).success).toBe(true);
  });

  it('ignora mayúsculas y guiones bajos: el PDF mezcla BreakFast y Breakfast_For_1', () => {
    expect(mapTboMealType('breakfast_for_1')).toMatchObject({ board: 'BB', known: true });
    expect(mapTboMealType('ROOMONLY')).toMatchObject({ board: 'RO', known: true });
    expect(mapTboMealType('Breakfast-Lunch')).toMatchObject({ board: 'HB', known: true });
  });

  it('conserva el literal tal como vino, sin los espacios del borde', () => {
    expect(mapTboMealType('  half_board ')).toEqual({
      board: 'HB',
      label: 'Media pensión',
      raw: 'half_board',
      known: true,
    });
  });

  it('un valor desconocido → RO con el literal como etiqueta y known: false', () => {
    expect(mapTboMealType('Brunch')).toEqual({
      board: 'RO',
      label: 'Brunch',
      raw: 'Brunch',
      known: false,
    });
  });

  it('sin régimen no se afirma "Solo alojamiento": la etiqueta dice que no se informó', () => {
    for (const value of [undefined, null, '', '   ']) {
      expect(mapTboMealType(value)).toEqual({
        board: 'RO',
        label: 'Régimen no informado',
        raw: undefined,
        known: false,
      });
    }
  });

  it('recorta a los techos del contrato neutral sin romper el pack', () => {
    const long = 'X'.repeat(300);
    const mapped = mapTboMealType(long);
    expect(mapped.label).toHaveLength(120);
    expect(mapped.raw).toHaveLength(80);
  });

  it('RoomOnly (el filtro) no es Room_Only (la tarifa)... pero normalizados coinciden y valen RO', () => {
    expect(mapTboMealType('RoomOnly').board).toBe('RO');
  });
});

describe('Filters.MealType (S-03)', () => {
  it('son los tres valores de MealPlan, como strings (p. 69)', () => {
    expect(TBO_MEAL_PLANS).toEqual(['All', 'WithMeal', 'RoomOnly']);
  });
});
