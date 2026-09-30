import { describe, expect, it } from 'vitest';
import {
  SESSION_MOTIVOS,
  SESSION_REASONS,
  isSessionReason,
  motivoForReason,
  motivoForUnauthorized,
  motivoMessage,
  parseIdleMinutes,
  parseMotivo,
} from './session-reasons';

/*
 * El contrato con la API (SPEC §2: `reason` del 401) y con la URL del login (`?motivo=`). Si la API
 * suma un motivo y acá no, el login lo trata como "expirada" en lugar de explicar qué pasó.
 */

describe('reason de la API → motivo de la URL', () => {
  it.each([
    ['SESSION_IDLE', 'inactividad'],
    ['SESSION_REPLACED', 'otro-dispositivo'],
    ['SESSION_RELEASED', 'liberada'],
    ['SESSION_EXPIRED', 'expirada'],
    ['SESSION_REVOKED', 'cerrada'],
  ] as const)('%s → %s', (reason, motivo) => {
    expect(isSessionReason(reason)).toBe(true);
    expect(motivoForReason(reason)).toBe(motivo);
    expect(motivoForUnauthorized(reason)).toBe(motivo);
  });

  it('cada reason tiene su motivo y no hay dos iguales', () => {
    const motivos = SESSION_REASONS.map((r) => motivoForReason(r));
    expect(new Set(motivos).size).toBe(SESSION_REASONS.length);
    expect([...motivos].sort()).toEqual([...SESSION_MOTIVOS].sort());
  });

  it('un reason que no es de sesión no tiene motivo propio', () => {
    expect(motivoForReason('MFA_CODE_INVALID')).toBeNull();
    expect(motivoForReason(undefined)).toBeNull();
    expect(motivoForReason(42)).toBeNull();
  });

  it('un 401 por segundo factor pendiente cierra la sesión: hay que volver a entrar con el código', () => {
    expect(motivoForUnauthorized('MFA_STEP_UP_REQUIRED')).toBe('cerrada');
  });

  it('un 401 sin reason (token vencido, o de antes de estos códigos) es "expirada"', () => {
    expect(motivoForUnauthorized(undefined)).toBe('expirada');
    expect(motivoForUnauthorized('ALGO_NUEVO')).toBe('expirada');
  });
});

describe('?motivo= de la URL: sólo la lista blanca', () => {
  it.each(SESSION_MOTIVOS.map((m) => [m]))('%s pasa', (motivo) => {
    expect(parseMotivo(motivo)).toBe(motivo);
  });

  it.each([['<script>'], ['Inactividad'], ['SESSION_IDLE'], [''], [undefined], [null], [['nada']]])(
    '%j no pasa',
    (raw) => {
      expect(parseMotivo(raw)).toBeNull();
    },
  );

  it('del parámetro repetido se toma el primero', () => {
    expect(parseMotivo(['liberada', 'cerrada'])).toBe('liberada');
  });
});

describe('?minutos= de la URL: el rango que admite un nodo', () => {
  it.each([
    ['5', 5],
    ['30', 30],
    ['480', 480],
    [30, 30],
    [['45', '10'], 45],
  ])('%j → %i', (raw, minutes) => {
    expect(parseIdleMinutes(raw)).toBe(minutes);
  });

  it.each([['4'], ['481'], ['30.5'], [30.5], ['-30'], ['1e2'], [''], [null], [undefined], ['abc']])(
    '%j no pasa',
    (raw) => {
      expect(parseIdleMinutes(raw)).toBeUndefined();
    },
  );
});

describe('textos', () => {
  it('inactividad con los minutos que rigen, en singular o plural', () => {
    expect(motivoMessage('inactividad', { idleMinutes: 30 })).toBe(
      'Cerramos tu sesión después de 30 minutos sin actividad.',
    );
    expect(motivoMessage('inactividad', { idleMinutes: 1 })).toBe(
      'Cerramos tu sesión después de 1 minuto sin actividad.',
    );
  });

  it('inactividad sin minutos (o con un número que no sirve) no inventa uno', () => {
    expect(motivoMessage('inactividad')).toBe('Cerramos tu sesión por inactividad.');
    expect(motivoMessage('inactividad', { idleMinutes: 0 })).toBe(
      'Cerramos tu sesión por inactividad.',
    );
    expect(motivoMessage('inactividad', { idleMinutes: 2.5 })).toBe(
      'Cerramos tu sesión por inactividad.',
    );
  });

  it.each([
    ['otro-dispositivo', 'Tu sesión se abrió en otro dispositivo.'],
    ['liberada', 'Un administrador liberó tu puesto.'],
    ['expirada', 'Tu sesión venció. Volvé a ingresar.'],
    ['cerrada', 'Tu sesión se cerró. Volvé a ingresar.'],
  ] as const)('%s', (motivo, text) => {
    expect(motivoMessage(motivo)).toBe(text);
  });
});
