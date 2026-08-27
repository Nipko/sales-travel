import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  calendarKeyAction,
  canApply,
  clampToMin,
  dayAriaLabel,
  dayRole,
  daysInMonth,
  describeDay,
  EMPTY_RANGE,
  focusAfterKey,
  formatDayShort,
  isDisabledDay,
  monthMatrix,
  nextRange,
  openDraft,
  pickerHint,
  previewRange,
  rangeSummary,
  todayIso,
  tripLength,
  tripLengthLabel,
  type DateRange,
  type RangeRules,
} from './date-range-picker';

/** Hoy fijo: la lógica no puede depender de cuándo corran los tests. */
const HOY = '2026-09-10';
const IDA_VUELTA: RangeRules = { mode: 'roundtrip', min: HOY };
const SOLO_IDA: RangeRules = { mode: 'oneway', min: HOY };

const VACIO: DateRange = EMPTY_RANGE;

describe('primer clic, segundo clic', () => {
  it('el primer clic fija la ida y deja la vuelta pendiente', () => {
    expect(nextRange(VACIO, '2026-09-12', IDA_VUELTA)).toEqual({
      start: '2026-09-12',
      end: null,
    });
  });

  it('el segundo clic, posterior, fija la vuelta', () => {
    const conIda = nextRange(VACIO, '2026-09-12', IDA_VUELTA);

    expect(nextRange(conIda, '2026-09-19', IDA_VUELTA)).toEqual({
      start: '2026-09-12',
      end: '2026-09-19',
    });
  });

  it('con el rango ya cerrado, el clic siguiente empieza uno nuevo', () => {
    const cerrado: DateRange = { start: '2026-09-12', end: '2026-09-19' };

    expect(nextRange(cerrado, '2026-10-02', IDA_VUELTA)).toEqual({
      start: '2026-10-02',
      end: null,
    });
  });

  it('el calendario dice en cada paso qué fecha está esperando', () => {
    const conIda = nextRange(VACIO, '2026-09-12', IDA_VUELTA);

    expect(pickerHint(VACIO, IDA_VUELTA)).toBe('Elija la fecha de ida');
    expect(pickerHint(conIda, IDA_VUELTA)).toBe('Elija la fecha de vuelta');
    expect(pickerHint(nextRange(conIda, '2026-09-19', IDA_VUELTA), IDA_VUELTA)).toBe(
      'Elija la fecha de ida',
    );
  });
});

describe('reinicio: tocar antes de la ida no es un error', () => {
  it('un segundo clic anterior a la ida reinicia el rango desde ahí', () => {
    const conIda: DateRange = { start: '2026-09-20', end: null };

    expect(nextRange(conIda, '2026-09-14', IDA_VUELTA)).toEqual({
      start: '2026-09-14',
      end: null,
    });
  });

  it('reiniciar no deja rastro de la ida anterior: la vuelta sigue pendiente', () => {
    const conIda: DateRange = { start: '2026-09-20', end: null };
    const reiniciado = nextRange(conIda, '2026-09-14', IDA_VUELTA);

    expect(canApply(reiniciado, IDA_VUELTA)).toBe(false);
  });

  it('tocar el mismo día de la ida cierra un regreso en el día, no reinicia', () => {
    const conIda: DateRange = { start: '2026-09-12', end: null };

    expect(nextRange(conIda, '2026-09-12', IDA_VUELTA)).toEqual({
      start: '2026-09-12',
      end: '2026-09-12',
    });
  });
});

describe('mínimo: el pasado no se puede elegir, ni con el ratón ni con el teclado', () => {
  it('el día anterior al mínimo está deshabilitado y el mínimo no', () => {
    expect(isDisabledDay('2026-09-09', IDA_VUELTA)).toBe(true);
    expect(isDisabledDay(HOY, IDA_VUELTA)).toBe(false);
  });

  it('un clic en una fecha pasada no cambia nada', () => {
    expect(nextRange(VACIO, '2026-09-09', IDA_VUELTA)).toEqual(VACIO);
  });

  it('una fecha pasada tampoco puede cerrar un rango ya empezado', () => {
    const conIda: DateRange = { start: '2026-09-12', end: null };

    expect(nextRange(conIda, '2026-08-30', IDA_VUELTA)).toEqual(conIda);
  });

  it('el teclado se frena en el mínimo en vez de entrar al pasado', () => {
    expect(focusAfterKey(HOY, 'ArrowLeft', IDA_VUELTA)).toBe(HOY);
    expect(focusAfterKey('2026-09-12', 'ArrowUp', IDA_VUELTA)).toBe(HOY);
    expect(focusAfterKey('2026-09-12', 'PageUp', IDA_VUELTA)).toBe(HOY);
  });

  it('hacia adelante el teclado se mueve libre', () => {
    expect(focusAfterKey('2026-09-12', 'ArrowRight', IDA_VUELTA)).toBe('2026-09-13');
    expect(focusAfterKey('2026-09-12', 'ArrowDown', IDA_VUELTA)).toBe('2026-09-19');
    expect(focusAfterKey('2026-09-12', 'PageDown', IDA_VUELTA)).toBe('2026-10-12');
  });

  it('Home y End van a los extremos de la semana, que empieza en lunes', () => {
    expect(focusAfterKey('2026-09-16', 'Home', IDA_VUELTA)).toBe('2026-09-14');
    expect(focusAfterKey('2026-09-16', 'End', IDA_VUELTA)).toBe('2026-09-20');
  });

  it('clampToMin no toca lo que ya es válido', () => {
    expect(clampToMin('2026-12-25', IDA_VUELTA)).toBe('2026-12-25');
    expect(clampToMin('2020-01-01', IDA_VUELTA)).toBe(HOY);
  });
});

describe('navegar no es elegir', () => {
  it('cambiar de mes sólo mueve el foco: la tecla no selecciona', () => {
    expect(calendarKeyAction('PageDown')).toEqual({ kind: 'month', months: 1 });
    expect(calendarKeyAction('PageUp')).toEqual({ kind: 'month', months: -1 });
  });

  it('sólo Enter y espacio eligen', () => {
    expect(calendarKeyAction('Enter')).toEqual({ kind: 'select' });
    expect(calendarKeyAction(' ')).toEqual({ kind: 'select' });
    expect(calendarKeyAction('ArrowRight')).toEqual({ kind: 'move', days: 1 });
  });

  it('Escape cierra y cualquier otra tecla no hace nada', () => {
    expect(calendarKeyAction('Escape')).toEqual({ kind: 'close' });
    expect(calendarKeyAction('a')).toEqual({ kind: 'none' });
    expect(calendarKeyAction('Tab')).toEqual({ kind: 'none' });
  });

  it('recorrer el calendario entero no elige nada ni aterriza en el pasado', () => {
    const teclas = [
      'ArrowLeft',
      'PageUp',
      'ArrowUp',
      'Home',
      'ArrowRight',
      'PageDown',
      'ArrowDown',
      'End',
    ];
    let foco = HOY;

    for (const tecla of teclas) {
      expect(calendarKeyAction(tecla).kind).not.toBe('select');
      foco = focusAfterKey(foco, tecla, IDA_VUELTA);
      expect(isDisabledDay(foco, IDA_VUELTA)).toBe(false);
    }
  });
});

describe('previsualización: lo que se ve al pasar el ratón es lo que va a pasar', () => {
  it('con la ida puesta, el hover posterior pinta el rango completo', () => {
    const conIda: DateRange = { start: '2026-09-12', end: null };

    expect(previewRange(conIda, '2026-09-19', IDA_VUELTA)).toEqual({
      start: '2026-09-12',
      end: '2026-09-19',
    });
  });

  it('el hover anterior a la ida anticipa el reinicio, no un rango invertido', () => {
    const conIda: DateRange = { start: '2026-09-20', end: null };

    expect(previewRange(conIda, '2026-09-14', IDA_VUELTA)).toEqual({
      start: '2026-09-14',
      end: null,
    });
  });

  it('lo previsualizado coincide con lo elegido, día por día', () => {
    const conIda: DateRange = { start: '2026-09-20', end: null };

    for (let i = 0; i < 40; i++) {
      const dia = addDays(HOY, i);
      expect(previewRange(conIda, dia, IDA_VUELTA)).toEqual(nextRange(conIda, dia, IDA_VUELTA));
    }
  });

  it('con el rango cerrado el hover no repinta nada', () => {
    const cerrado: DateRange = { start: '2026-09-12', end: '2026-09-19' };

    expect(previewRange(cerrado, '2026-09-30', IDA_VUELTA)).toEqual(cerrado);
  });

  it('una fecha pasada no se previsualiza', () => {
    const conIda: DateRange = { start: '2026-09-12', end: null };

    expect(previewRange(conIda, '2026-09-01', IDA_VUELTA)).toEqual(conIda);
  });

  it('en solo ida no hay rango que anticipar', () => {
    const conIda: DateRange = { start: '2026-09-12', end: null };

    expect(previewRange(conIda, '2026-09-19', SOLO_IDA)).toEqual(conIda);
  });
});

describe('duración: la cifra que manda es noches', () => {
  it('del 12 al 19 son 7 noches y 8 días', () => {
    expect(tripLength({ start: '2026-09-12', end: '2026-09-19' })).toEqual({
      nights: 7,
      days: 8,
    });
  });

  it('el regreso en el día son 0 noches y 1 día', () => {
    expect(tripLength({ start: '2026-09-12', end: '2026-09-12' })).toEqual({
      nights: 0,
      days: 1,
    });
  });

  it('cuenta bien cruzando de mes y de año', () => {
    expect(tripLength({ start: '2026-12-28', end: '2027-01-04' })?.nights).toBe(7);
    expect(tripLength({ start: '2028-02-27', end: '2028-03-01' })?.nights).toBe(3);
  });

  it('sin rango cerrado no hay duración', () => {
    expect(tripLength({ start: '2026-09-12', end: null })).toBeNull();
    expect(tripLength(VACIO)).toBeNull();
  });

  it('la etiqueta del contador nunca deja la unidad implícita', () => {
    expect(tripLengthLabel({ start: '2026-09-12', end: '2026-09-19' })).toBe('7 noches');
    expect(tripLengthLabel({ start: '2026-09-12', end: '2026-09-13' })).toBe('1 noche');
    expect(tripLengthLabel({ start: '2026-09-12', end: '2026-09-12' })).toBe('Mismo día');
    expect(tripLengthLabel({ start: '2026-09-12', end: null })).toBeNull();
  });

  it('el resumen en texto dice las dos unidades, para que nadie cotice 8 noches de hotel', () => {
    const resumen = rangeSummary({ start: '2026-09-12', end: '2026-09-19' }, IDA_VUELTA);

    expect(resumen).toContain('7 noches');
    expect(resumen).toContain('8 días');
  });

  it('el resumen del regreso en el día no se lee como un error', () => {
    expect(rangeSummary({ start: '2026-09-12', end: '2026-09-12' }, IDA_VUELTA)).toBe(
      'El 12 de septiembre · ida y vuelta el mismo día',
    );
  });

  it('el resumen avisa cuando falta la vuelta', () => {
    expect(rangeSummary({ start: '2026-09-12', end: null }, IDA_VUELTA)).toContain(
      'falta la fecha de vuelta',
    );
    expect(rangeSummary(VACIO, IDA_VUELTA)).toBe('Sin fechas seleccionadas');
  });
});

describe('solo ida: el mismo control con una sola fecha', () => {
  it('cada clic mueve la ida y nunca aparece una vuelta', () => {
    const primero = nextRange(VACIO, '2026-09-12', SOLO_IDA);
    const segundo = nextRange(primero, '2026-09-19', SOLO_IDA);

    expect(primero).toEqual({ start: '2026-09-12', end: null });
    expect(segundo).toEqual({ start: '2026-09-19', end: null });
  });

  it('un clic anterior también es sólo mover la ida', () => {
    const conIda: DateRange = { start: '2026-09-20', end: null };

    expect(nextRange(conIda, '2026-09-14', SOLO_IDA)).toEqual({ start: '2026-09-14', end: null });
  });

  it('con una sola fecha ya se puede aplicar', () => {
    expect(canApply({ start: '2026-09-12', end: null }, SOLO_IDA)).toBe(true);
    expect(canApply({ start: '2026-09-12', end: null }, IDA_VUELTA)).toBe(false);
    expect(canApply(VACIO, SOLO_IDA)).toBe(false);
  });

  it('sigue respetando el mínimo', () => {
    expect(nextRange(VACIO, '2026-09-09', SOLO_IDA)).toEqual(VACIO);
  });

  it('al abrirlo se descarta cualquier vuelta heredada de un ida y vuelta anterior', () => {
    const heredado: DateRange = { start: '2026-09-12', end: '2026-09-19' };

    expect(openDraft(heredado, 'start', SOLO_IDA)).toEqual({ start: '2026-09-12', end: null });
  });
});

describe('abrir por una mitad u otra del disparador', () => {
  it('abrir por «Ida» conserva el rango tal cual', () => {
    const valor: DateRange = { start: '2026-09-12', end: '2026-09-19' };

    expect(openDraft(valor, 'start', IDA_VUELTA)).toEqual(valor);
  });

  it('abrir por «Vuelta» deja la vuelta pendiente, para que el próximo clic sea esa fecha', () => {
    const valor: DateRange = { start: '2026-09-12', end: '2026-09-19' };
    const borrador = openDraft(valor, 'end', IDA_VUELTA);

    expect(borrador).toEqual({ start: '2026-09-12', end: null });
    expect(nextRange(borrador, '2026-09-25', IDA_VUELTA)).toEqual({
      start: '2026-09-12',
      end: '2026-09-25',
    });
  });

  it('el borrador es un borrador: no puede aplicarse a medias', () => {
    const valor: DateRange = { start: '2026-09-12', end: '2026-09-19' };

    expect(canApply(openDraft(valor, 'end', IDA_VUELTA), IDA_VUELTA)).toBe(false);
  });
});

describe('el papel de cada día también viaja como texto', () => {
  const rango: DateRange = { start: '2026-09-12', end: '2026-09-19' };

  it('distingue ida, interior y vuelta', () => {
    expect(dayRole('2026-09-12', rango)).toBe('start');
    expect(dayRole('2026-09-15', rango)).toBe('inside');
    expect(dayRole('2026-09-19', rango)).toBe('end');
    expect(dayRole('2026-09-20', rango)).toBeNull();
  });

  it('un rango de un solo día es ida y vuelta a la vez', () => {
    expect(dayRole('2026-09-12', { start: '2026-09-12', end: '2026-09-12' })).toBe('both');
  });

  it('con la vuelta pendiente, ningún día posterior queda dentro del rango', () => {
    expect(dayRole('2026-09-15', { start: '2026-09-12', end: null })).toBeNull();
  });

  it('el lector de pantalla recibe el día, su papel y si está deshabilitado', () => {
    expect(dayAriaLabel('2026-09-12', rango, IDA_VUELTA)).toBe(
      'sábado 12 de septiembre de 2026, ida',
    );
    expect(dayAriaLabel('2026-09-15', rango, IDA_VUELTA)).toBe(
      'martes 15 de septiembre de 2026, dentro del viaje',
    );
    expect(dayAriaLabel('2026-09-19', rango, IDA_VUELTA)).toBe(
      'sábado 19 de septiembre de 2026, vuelta',
    );
    expect(dayAriaLabel('2026-09-05', rango, IDA_VUELTA)).toBe(
      'sábado 5 de septiembre de 2026, no disponible',
    );
  });

  it('en solo ida no se anuncia una vuelta que no existe', () => {
    const sola: DateRange = { start: '2026-09-12', end: null };

    expect(dayAriaLabel('2026-09-12', sola, SOLO_IDA)).toBe(
      'sábado 12 de septiembre de 2026, fecha de ida',
    );
  });
});

describe('calendario en español, sin depender del runtime', () => {
  it('nombra el día tal como se lee en voz alta', () => {
    expect(describeDay('2026-09-12')).toBe('sábado 12 de septiembre de 2026');
    expect(describeDay('2027-01-01')).toBe('viernes 1 de enero de 2027');
  });

  it('el disparador muestra la fecha corta', () => {
    expect(formatDayShort('2026-09-12')).toBe('sáb 12 sep');
    expect(formatDayShort('2026-12-01')).toBe('mar 1 dic');
  });
});

describe('la grilla del mes', () => {
  it('empieza en lunes y deja huecos antes del día 1', () => {
    const semanas = monthMatrix(2026, 9); // 1/9/2026 es martes

    expect(semanas[0]).toEqual([
      null,
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
      '2026-09-06',
    ]);
  });

  it('todas las filas tienen siete celdas y ningún día se pierde', () => {
    const semanas = monthMatrix(2026, 9);
    const dias = semanas.flat().filter((d) => d !== null);

    expect(semanas.every((s) => s.length === 7)).toBe(true);
    expect(dias).toHaveLength(30);
    expect(dias[0]).toBe('2026-09-01');
    expect(dias[dias.length - 1]).toBe('2026-09-30');
  });

  it('un febrero bisiesto tiene 29 días', () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(monthMatrix(2028, 2).flat().filter(Boolean)).toHaveLength(29);
  });
});

describe('aritmética de fechas', () => {
  it('sumar días cruza meses y años', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('sumar meses cae en el último día cuando el destino es más corto', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-03-15', -3)).toBe('2025-12-15');
    expect(addMonths('2026-12-10', 1)).toBe('2027-01-10');
  });

  it('«hoy» es el día del calendario local, no el de UTC', () => {
    // 22:00 en Bogotá (UTC-5) del 31/12 ya es 1/1 en UTC; para el vendedor sigue siendo 31.
    const nocheVieja = new Date(2026, 11, 31, 22, 0, 0);

    expect(todayIso(nocheVieja)).toBe('2026-12-31');
  });
});
