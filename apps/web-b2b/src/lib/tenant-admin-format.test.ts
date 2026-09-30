import { describe, expect, it } from 'vitest';
import {
  deviceLabel,
  exactTime,
  lastAccessLabel,
  lockedUntilLabel,
  relativeTime,
} from './tenant-admin-format';

const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.46 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  samsungAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:130.0) Gecko/20100101 Firefox/130.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  operaLinux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
} as const;

describe('deviceLabel', () => {
  it('navegador y sistema a partir del user-agent', () => {
    expect(deviceLabel(UA.chromeWindows)).toBe('Chrome en Windows');
    expect(deviceLabel(UA.edgeWindows)).toBe('Edge en Windows');
    expect(deviceLabel(UA.safariIphone)).toBe('Safari en iOS');
    expect(deviceLabel(UA.chromeIphone)).toBe('Chrome en iOS');
    expect(deviceLabel(UA.chromeAndroid)).toBe('Chrome en Android');
    expect(deviceLabel(UA.samsungAndroid)).toBe('Samsung Internet en Android');
    expect(deviceLabel(UA.firefoxMac)).toBe('Firefox en macOS');
    expect(deviceLabel(UA.safariMac)).toBe('Safari en macOS');
    expect(deviceLabel(UA.operaLinux)).toBe('Opera en Linux');
    expect(deviceLabel(UA.chromebook)).toBe('Chrome en ChromeOS');
  });

  it('sin user-agent, o uno que no dice nada, es un dispositivo desconocido', () => {
    expect(deviceLabel(null)).toBe('Dispositivo desconocido');
    expect(deviceLabel(undefined)).toBe('Dispositivo desconocido');
    expect(deviceLabel('   ')).toBe('Dispositivo desconocido');
    expect(deviceLabel('curl/8.4.0')).toBe('Dispositivo desconocido');
  });

  it('un texto que ya viene legible se muestra tal cual', () => {
    expect(deviceLabel('Chrome en Windows')).toBe('Chrome en Windows');
    expect(deviceLabel('x'.repeat(80))).toHaveLength(58);
  });

  it('sistema sin navegador conocido', () => {
    expect(deviceLabel('SomeApp/1.0 (Windows NT 10.0)')).toBe('Navegador en Windows');
  });
});

describe('relativeTime', () => {
  const NOW = Date.parse('2026-09-29T15:00:00.000Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it('de segundos a días', () => {
    expect(relativeTime(ago(5_000), NOW)).toBe('hace un momento');
    expect(relativeTime(ago(50_000), NOW)).toBe('hace 1 min');
    expect(relativeTime(ago(12 * 60_000), NOW)).toBe('hace 12 min');
    expect(relativeTime(ago(3 * 3_600_000 + 20 * 60_000), NOW)).toBe('hace 3 h');
    expect(relativeTime(ago(26 * 3_600_000), NOW)).toBe('hace 1 día');
    expect(relativeTime(ago(5 * 86_400_000), NOW)).toBe('hace 5 días');
  });

  it('pasado un mes, la fecha', () => {
    expect(relativeTime(ago(45 * 86_400_000), NOW)).toMatch(/^el \d{1,2} /);
  });

  it('un reloj apenas adelantado no es un error', () => {
    expect(relativeTime(new Date(NOW + 20_000).toISOString(), NOW)).toBe('hace un momento');
  });

  it('una fecha ilegible no inventa nada', () => {
    expect(relativeTime('no-es-fecha', NOW)).toBeUndefined();
    expect(relativeTime(null, NOW)).toBeUndefined();
  });
});

describe('lastAccessLabel', () => {
  const NOW = Date.parse('2026-09-29T15:00:00.000Z');

  it('sin fecha es que nunca ingresó', () => {
    expect(lastAccessLabel(null, NOW)).toBe('Nunca ingresó');
    expect(lastAccessLabel('', NOW)).toBe('Nunca ingresó');
  });

  it('con fecha, relativo', () => {
    expect(lastAccessLabel('2026-09-29T14:00:00.000Z', NOW)).toBe('hace 1 h');
  });
});

describe('lockedUntilLabel', () => {
  const NOW = new Date(2026, 8, 29, 10, 0).getTime();

  it('un bloqueo vigente dice hasta cuándo', () => {
    const until = new Date(2026, 8, 29, 10, 15);
    const label = lockedUntilLabel(until.toISOString(), NOW);
    expect(label).toMatch(/^Bloqueado hasta las /);
    expect(label).toContain(
      new Intl.DateTimeFormat('es-CO', { hour: '2-digit', minute: '2-digit' }).format(until),
    );
  });

  it('otro día lleva la fecha', () => {
    const label = lockedUntilLabel(new Date(2026, 8, 30, 9, 0).toISOString(), NOW);
    expect(label).toMatch(/^Bloqueado hasta el \d{1,2} /);
  });

  it('un bloqueo vencido o ausente no se muestra', () => {
    expect(lockedUntilLabel(new Date(2026, 8, 29, 9, 0).toISOString(), NOW)).toBeUndefined();
    expect(lockedUntilLabel(null, NOW)).toBeUndefined();
  });
});

describe('exactTime', () => {
  it('fecha y hora completas para el title, o nada si no se lee', () => {
    expect(exactTime('2026-09-29T15:00:00.000Z')).toMatch(/2026/);
    expect(exactTime('x')).toBeUndefined();
  });
});
