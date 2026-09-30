import { describe, expect, it } from 'vitest';
import { MIN_STAY_NIGHTS, searchingEcho, stayDatesProblem } from './stay-dates';

const HOY = '2026-10-01';

describe('stayDatesProblem: lo que frena la búsqueda antes del servidor', () => {
  it('sin fechas pide las dos y lleva el foco a la entrada', () => {
    expect(stayDatesProblem('', '', HOY)).toEqual({
      edge: 'start',
      message: 'Elige las fechas de entrada y salida.',
    });
  });

  it('con la entrada sola pide la salida y lleva el foco ahí', () => {
    expect(stayDatesProblem('2026-10-12', '', HOY)).toEqual({
      edge: 'end',
      message: 'Elige la fecha de salida.',
    });
  });

  it('una entrada que quedó en el pasado (la pantalla abierta desde ayer) no sale', () => {
    expect(stayDatesProblem('2026-09-30', '2026-10-03', HOY)?.edge).toBe('start');
  });

  it('hoy todavía vale como entrada: es el día del calendario local', () => {
    expect(stayDatesProblem(HOY, '2026-10-02', HOY)).toBeNull();
  });

  it('mínimo una noche', () => {
    expect(MIN_STAY_NIGHTS).toBe(1);
    expect(stayDatesProblem('2026-10-12', '2026-10-12', HOY)?.edge).toBe('end');
    expect(stayDatesProblem('2026-10-12', '2026-10-10', HOY)?.edge).toBe('end');
    expect(stayDatesProblem('2026-10-12', '2026-10-13', HOY)).toBeNull();
  });

  it('no hay tope de noches: ningún proveedor ni el API lo declaran', () => {
    expect(stayDatesProblem('2026-10-12', '2027-03-12', HOY)).toBeNull();
  });

  it('los mensajes van en tú, no en voseo', () => {
    const mensajes = [
      stayDatesProblem('', '', HOY),
      stayDatesProblem('2026-10-12', '', HOY),
      stayDatesProblem('2026-09-30', '2026-10-03', HOY),
      stayDatesProblem('2026-10-12', '2026-10-12', HOY),
    ].map((p) => p?.message ?? '');
    for (const m of mensajes) expect(m).not.toMatch(/Elegí|Ingresá|Indicá/);
  });
});

describe('searchingEcho: qué se está buscando, mientras se busca', () => {
  it('destino, fechas y noches', () => {
    expect(
      searchingEcho({
        destinationLabel: 'Cartagena, Colombia',
        checkinDate: '2026-10-12',
        checkoutDate: '2026-10-15',
      }),
    ).toBe('Cartagena, Colombia · 12 – 15 oct 2026 · 3 noches');
  });

  it('sin destino, los hoteles pedidos por ID', () => {
    expect(
      searchingEcho({ hotelIdsCount: 2, checkinDate: '2026-10-12', checkoutDate: '2026-10-13' }),
    ).toBe('2 hoteles por ID · 12 – 13 oct 2026 · 1 noche');
  });

  it('con fechas ilegibles no inventa nada', () => {
    expect(searchingEcho({ destinationLabel: 'Lima', checkinDate: '', checkoutDate: '' })).toBe(
      'Lima',
    );
  });
});
