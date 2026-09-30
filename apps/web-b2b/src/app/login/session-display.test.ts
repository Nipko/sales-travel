import { describe, expect, it } from 'vitest';
import { parseSeatsFull } from './login-state';
import {
  describeDevice,
  lastActivityLabel,
  seatsHeadline,
  seatsTenantLabel,
  sessionDisplayName,
} from './session-display';

describe('describeDevice', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Chrome en Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
      'Edge en Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      'Safari en Mac',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Safari en iPhone',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0 Mobile/15E148 Safari/604.1',
      'Chrome en iPhone',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
      'Samsung Internet en Android',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
      'Chrome en Android',
    ],
    [
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
      'Firefox en Linux',
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Chrome en ChromeOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/113.0.0.0',
      'Opera en Windows',
    ],
  ])('%s → %s', (ua, expected) => {
    expect(describeDevice(ua)).toBe(expected);
  });

  it('sin User-Agent o con uno raro', () => {
    expect(describeDevice(null)).toBe('Dispositivo desconocido');
    expect(describeDevice('   ')).toBe('Dispositivo desconocido');
    expect(describeDevice('curl/8.4.0')).toBe('Navegador desconocido');
    expect(describeDevice('SomeApp (Windows NT 10.0)')).toBe('Navegador en Windows');
  });
});

describe('lastActivityLabel', () => {
  const now = Date.parse('2026-09-29T12:00:00.000Z');

  it('relativa a ahora', () => {
    expect(lastActivityLabel('2026-09-29T11:59:30.000Z', now)).toBe('Activo ahora');
    expect(lastActivityLabel('2026-09-29T11:57:00.000Z', now)).toBe('Activo hace 3 min');
    expect(lastActivityLabel('2026-09-29T09:30:00.000Z', now)).toBe('Activo hace 2 h');
    expect(lastActivityLabel('2026-09-28T11:00:00.000Z', now)).toBe('Activo hace 1 día');
    expect(lastActivityLabel('2026-09-26T11:00:00.000Z', now)).toBe('Activo hace 3 días');
  });

  it('un reloj del servidor adelantado no da tiempos negativos', () => {
    expect(lastActivityLabel('2026-09-29T12:05:00.000Z', now)).toBe('Activo ahora');
  });

  it('sin fecha o ilegible', () => {
    expect(lastActivityLabel(null, now)).toBeNull();
    expect(lastActivityLabel('ayer', now)).toBeNull();
  });
});

describe('textos del cupo', () => {
  it('singular, plural y sin número', () => {
    expect(seatsHeadline(parseSeatsFull({ tenantName: 'Norte', limit: 1 }))).toBe(
      'El único puesto de Norte está en uso.',
    );
    expect(seatsHeadline(parseSeatsFull({ tenantName: 'Norte', limit: 5 }))).toBe(
      'Los 5 puestos de Norte están en uso.',
    );
    expect(seatsHeadline(parseSeatsFull({}))).toBe('Todos los puestos de tu agencia están en uso.');
    expect(seatsTenantLabel(parseSeatsFull({}))).toBe('tu agencia');
  });

  it('el nombre de la persona, o su email', () => {
    expect(sessionDisplayName({ name: 'Ana', email: 'ana@x.co' })).toBe('Ana');
    expect(sessionDisplayName({ name: null, email: 'ana@x.co' })).toBe('ana@x.co');
    expect(sessionDisplayName({ name: null, email: null })).toBe('Usuario sin nombre');
  });
});
