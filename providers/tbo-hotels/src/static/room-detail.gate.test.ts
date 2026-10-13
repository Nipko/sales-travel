import { describe, expect, it } from 'vitest';
import {
  TBO_PROCESS_ROOM_DETAIL_GATE,
  TBO_ROOM_DETAIL_REJECTION_LIMIT,
  TboRoomDetailGate,
  parseTboRoomDetailsSwitch,
} from './room-detail.gate';

/** Las dos llaves del detalle por habitación: el interruptor `TBO_ROOM_DETAILS` y la compuerta. */

describe('parseTboRoomDetailsSwitch (`TBO_ROOM_DETAILS`)', () => {
  it.each([[undefined], [null], [''], ['   ']])('%j → `on`: el valor por defecto', (raw) => {
    expect(parseTboRoomDetailsSwitch(raw)).toEqual({ value: 'on', invalid: false });
  });

  it.each([
    ['on', 'on'],
    ['ON', 'on'],
    [' On ', 'on'],
    ['off', 'off'],
    ['OFF', 'off'],
    ['\toff\n', 'off'],
  ] as const)('%j → `%s`', (raw, value) => {
    expect(parseTboRoomDetailsSwitch(raw)).toEqual({ value, invalid: false });
  });

  it.each([['false'], ['0'], ['yes'], ['apagado'], [1], [true], [{}]])(
    '%j no es un valor: `off` y avisado como inválido (ante la duda, el pedido de siempre)',
    (raw) => {
      expect(parseTboRoomDetailsSwitch(raw)).toEqual({ value: 'off', invalid: true });
    },
  );
});

describe('TboRoomDetailGate', () => {
  it('se suspende al llegar al tope de rechazos SEGUIDOS y lo dice una sola vez', () => {
    const gate = new TboRoomDetailGate(3);
    expect(gate.recordRejection()).toBe(false);
    expect(gate.recordRejection()).toBe(false);
    expect(gate.suspended).toBe(false);
    expect(gate.recordRejection()).toBe(true);
    expect(gate.suspended).toBe(true);
    expect(gate.consecutiveRejections).toBe(3);
    expect(gate.recordRejection()).toBe(false);
    expect(gate.consecutiveRejections).toBe(3);
  });

  it('un lote completo con la clave corta la racha', () => {
    const gate = new TboRoomDetailGate(2);
    gate.recordRejection();
    gate.recordSuccess();
    expect(gate.consecutiveRejections).toBe(0);
    expect(gate.recordRejection()).toBe(false);
    expect(gate.suspended).toBe(false);
  });

  it('suspendida, sólo un reinicio la abre: un éxito posterior no la reabre', () => {
    const gate = new TboRoomDetailGate(1);
    expect(gate.recordRejection()).toBe(true);
    gate.recordSuccess();
    expect(gate.suspended).toBe(true);
    expect(gate.consecutiveRejections).toBe(1);
  });

  it.each([[0], [-1], [1.5], [Number.NaN]])('un tope inválido (%j) usa el de siempre', (limit) => {
    expect(new TboRoomDetailGate(limit).limit).toBe(TBO_ROOM_DETAIL_REJECTION_LIMIT);
  });

  it('la del proceso arranca abierta, con el tope por defecto', () => {
    expect(TBO_PROCESS_ROOM_DETAIL_GATE.limit).toBe(TBO_ROOM_DETAIL_REJECTION_LIMIT);
    expect(TBO_PROCESS_ROOM_DETAIL_GATE.suspended).toBe(false);
  });
});
