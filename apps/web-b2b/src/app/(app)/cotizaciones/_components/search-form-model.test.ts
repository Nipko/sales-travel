import { describe, expect, it } from 'vitest';
import {
  adjustPax,
  cabinLabel,
  canAddPax,
  canRemovePax,
  DEFAULT_PAX,
  paxComposition,
  paxLabel,
  paxTotal,
  returnDateForMode,
  searchEcho,
  validateSearch,
  type PaxCounts,
  type SearchDraft,
} from './search-form-model';

/** Hoy fijo: la validación no puede depender de cuándo corran los tests. */
const HOY = '2026-09-10';

function draft(over: Partial<SearchDraft> = {}): SearchDraft {
  return {
    origin: 'BOG',
    destination: 'MDE',
    departureDate: '2026-09-12',
    returnDate: '2026-09-19',
    mode: 'roundtrip',
    pax: DEFAULT_PAX,
    ...over,
  };
}

function pax(adults: number, children: number, infants: number): PaxCounts {
  return { adults, children, infants };
}

describe('validateSearch — ruta', () => {
  it('acepta una búsqueda completa', () => {
    expect(validateSearch(draft(), HOY)).toBeNull();
  });

  it('reclama el origen cuando no hay código IATA', () => {
    expect(validateSearch(draft({ origin: '' }), HOY)).toEqual({
      field: 'origin',
      message: 'Elegí el aeropuerto de origen.',
    });
  });

  it('reclama el origen cuando el código está a medio escribir', () => {
    expect(validateSearch(draft({ origin: 'BO' }), HOY)?.field).toBe('origin');
  });

  it('reclama el destino cuando falta', () => {
    expect(validateSearch(draft({ destination: '' }), HOY)?.field).toBe('destination');
  });

  it('rechaza origen y destino iguales', () => {
    const problem = validateSearch(draft({ destination: 'BOG' }), HOY);
    expect(problem?.field).toBe('destination');
    expect(problem?.message).toContain('distintos');
  });

  it('normaliza mayúsculas y espacios antes de comparar', () => {
    expect(validateSearch(draft({ origin: ' bog ', destination: 'mde' }), HOY)).toBeNull();
    expect(validateSearch(draft({ origin: ' bog ', destination: 'bog' }), HOY)?.field).toBe(
      'destination',
    );
  });

  it('señala el primer problema del recorrido, no el último', () => {
    // Sin origen Y sin fechas: quien no eligió origen no necesita enterarse de la vuelta.
    expect(
      validateSearch(draft({ origin: '', departureDate: '', returnDate: '' }), HOY)?.field,
    ).toBe('origin');
  });

  it('con la ruta entera vacía reclama el origen, que es por donde se empieza', () => {
    // Es el caso del formulario recién abierto: el foco tiene que ir al primer campo, no al
    // segundo. Si el orden de las comprobaciones se invierte, el usuario recibe el foco en
    // el destino y el origen vacío queda a su espalda.
    expect(validateSearch(draft({ origin: '', destination: '' }), HOY)?.field).toBe('origin');
  });
});

describe('validateSearch — fechas', () => {
  it('reclama la ida cuando el control de fechas está vacío', () => {
    expect(validateSearch(draft({ departureDate: '', returnDate: '' }), HOY)).toEqual({
      field: 'dates',
      message: 'Elegí la fecha de ida.',
    });
  });

  it('rechaza una ida anterior a hoy', () => {
    const problem = validateSearch(draft({ departureDate: '2026-09-09' }), HOY);
    expect(problem?.field).toBe('dates');
    expect(problem?.message).toContain('pasó');
  });

  it('acepta salir hoy mismo', () => {
    expect(validateSearch(draft({ departureDate: HOY, returnDate: '2026-09-19' }), HOY)).toBeNull();
  });

  it('rechaza una fecha con formato inválido aunque no esté vacía', () => {
    expect(validateSearch(draft({ departureDate: '12/09/2026' }), HOY)?.field).toBe('dates');
  });

  it('exige la vuelta en ida y vuelta', () => {
    const problem = validateSearch(draft({ returnDate: '' }), HOY);
    expect(problem?.field).toBe('dates');
    expect(problem?.message).toContain('solo ida');
  });

  it('no exige vuelta en solo ida', () => {
    expect(validateSearch(draft({ mode: 'oneway', returnDate: '' }), HOY)).toBeNull();
  });

  it('rechaza la vuelta anterior a la ida', () => {
    const problem = validateSearch(draft({ returnDate: '2026-09-11' }), HOY);
    expect(problem?.field).toBe('dates');
    expect(problem?.message).toContain('anterior');
  });

  it('acepta ida y vuelta el mismo día', () => {
    expect(
      validateSearch(draft({ departureDate: '2026-09-12', returnDate: '2026-09-12' }), HOY),
    ).toBeNull();
  });

  it('ignora una vuelta vieja si el viaje es solo ida', () => {
    // El modo manda sobre el dato residual: si no, un cambio a "solo ida" quedaba bloqueado
    // por una vuelta que el usuario ya no ve.
    expect(validateSearch(draft({ mode: 'oneway', returnDate: '2026-09-01' }), HOY)).toBeNull();
  });
});

describe('returnDateForMode', () => {
  it('borra la vuelta al pasar a solo ida', () => {
    expect(returnDateForMode('2026-09-19', 'oneway')).toBe('');
  });

  it('conserva la vuelta en ida y vuelta', () => {
    expect(returnDateForMode('2026-09-19', 'roundtrip')).toBe('2026-09-19');
  });
});

describe('adjustPax', () => {
  it('suma y resta de a uno', () => {
    expect(adjustPax(DEFAULT_PAX, 'children', 1)).toEqual(pax(1, 1, 0));
    expect(adjustPax(pax(1, 2, 0), 'children', -1)).toEqual(pax(1, 1, 0));
  });

  it('nunca baja de un adulto', () => {
    expect(adjustPax(DEFAULT_PAX, 'adults', -1)).toEqual(DEFAULT_PAX);
  });

  it('nunca baja de cero niños ni infantes', () => {
    expect(adjustPax(DEFAULT_PAX, 'children', -1)).toEqual(DEFAULT_PAX);
    expect(adjustPax(DEFAULT_PAX, 'infants', -1)).toEqual(DEFAULT_PAX);
  });

  it('no deja más infantes que adultos', () => {
    expect(adjustPax(pax(1, 0, 1), 'infants', 1)).toEqual(pax(1, 0, 1));
  });

  it('arrastra los infantes al quitar un adulto', () => {
    // Un infante viaja en el regazo de un adulto: si el adulto se va, el infante no se queda.
    expect(adjustPax(pax(2, 0, 2), 'adults', -1)).toEqual(pax(1, 0, 1));
  });

  it('respeta el tope de 9 pasajeros del GDS', () => {
    const lleno = pax(9, 0, 0);
    expect(paxTotal(lleno)).toBe(9);
    expect(adjustPax(lleno, 'children', 1)).toEqual(lleno);
  });

  it('rechaza el incremento entero en vez de recortarlo', () => {
    // Devolver el mismo objeto es la señal de "no pasó nada"; recortar mostraría un número
    // que nadie pidió.
    const lleno = pax(8, 1, 0);
    expect(adjustPax(lleno, 'adults', 1)).toBe(lleno);
  });

  it('deja llegar justo al tope', () => {
    expect(adjustPax(pax(8, 0, 0), 'children', 1)).toEqual(pax(8, 1, 0));
  });
});

describe('canAddPax / canRemovePax', () => {
  it('apaga el + en el tope total', () => {
    expect(canAddPax(pax(9, 0, 0), 'children')).toBe(false);
    expect(canAddPax(pax(8, 0, 0), 'children')).toBe(true);
  });

  it('apaga el + de infantes cuando ya hay uno por adulto', () => {
    expect(canAddPax(pax(2, 0, 2), 'infants')).toBe(false);
    expect(canAddPax(pax(2, 0, 1), 'infants')).toBe(true);
  });

  it('apaga el − en los mínimos', () => {
    expect(canRemovePax(DEFAULT_PAX, 'adults')).toBe(false);
    expect(canRemovePax(DEFAULT_PAX, 'children')).toBe(false);
    expect(canRemovePax(pax(2, 0, 0), 'adults')).toBe(true);
  });
});

describe('paxLabel', () => {
  it('usa singular con un solo pasajero', () => {
    expect(paxLabel(DEFAULT_PAX)).toBe('1 pasajero');
  });

  it('suma los tres tipos', () => {
    expect(paxLabel(pax(2, 1, 1))).toBe('4 pasajeros');
  });
});

describe('paxComposition', () => {
  it('nombra sólo a los adultos cuando viajan solos', () => {
    expect(paxComposition(DEFAULT_PAX)).toBe('1 adulto');
    expect(paxComposition(pax(2, 0, 0))).toBe('2 adultos');
  });

  it('no nombra los tipos vacíos', () => {
    // "2 adultos · 0 niños · 0 infantes" es el caso de casi todas las búsquedas y no dice nada.
    expect(paxComposition(pax(2, 0, 0))).not.toContain('niño');
    expect(paxComposition(pax(2, 1, 0))).not.toContain('infante');
  });

  it('nombra a los niños y a los infantes cuando los hay', () => {
    expect(paxComposition(pax(2, 1, 0))).toBe('2 adultos · 1 niño');
    expect(paxComposition(pax(2, 3, 1))).toBe('2 adultos · 3 niños · 1 infante');
  });
});

describe('cabinLabel', () => {
  it('traduce los valores del contrato', () => {
    expect(cabinLabel('economy')).toBe('Económica');
    expect(cabinLabel('business')).toBe('Ejecutiva');
  });

  it('devuelve el valor crudo si no lo conoce, en vez de mentir', () => {
    expect(cabinLabel('cabina_nueva')).toBe('cabina_nueva');
  });
});

describe('searchEcho', () => {
  it('describe la ida y vuelta con las dos fechas', () => {
    expect(searchEcho(draft())).toBe('BOG → MDE · sáb 12 sep – sáb 19 sep · 1 pasajero');
  });

  it('dice «solo ida» cuando no hay vuelta', () => {
    expect(searchEcho(draft({ mode: 'oneway', returnDate: '' }))).toBe(
      'BOG → MDE · sáb 12 sep · solo ida · 1 pasajero',
    );
  });

  it('no muestra una vuelta que el viaje ya no tiene', () => {
    expect(searchEcho(draft({ mode: 'oneway', returnDate: '2026-09-19' }))).toContain('solo ida');
  });

  it('lleva los códigos en mayúscula aunque se hayan tecleado en minúscula', () => {
    expect(searchEcho(draft({ origin: 'bog', destination: 'mde' }))).toContain('BOG → MDE');
  });
});
