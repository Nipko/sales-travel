import { describe, expect, it } from 'vitest';
import {
  compactSecret,
  describeDevice,
  formatRelative,
  isActiveNow,
  isMobileDevice,
  localTimestamp,
  recoveryCodesFilename,
  recoveryCodesText,
  secretBlocks,
} from './security-format';

const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.46 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
};

describe('describeDevice', () => {
  it.each([
    [UA.chromeWindows, 'Chrome en Windows'],
    [UA.edgeWindows, 'Edge en Windows'],
    [UA.safariMac, 'Safari en macOS'],
    // El UA del iPhone dice "like Mac OS X": antes salía "Safari en macOS".
    [UA.safariIphone, 'Safari en iPhone'],
    [UA.chromeIphone, 'Chrome en iPhone'],
    // El de Android dice "Linux".
    [UA.chromeAndroid, 'Chrome en Android'],
    [UA.firefoxLinux, 'Firefox en Linux'],
    [UA.samsung, 'Samsung Internet en Android'],
  ])('%s → %s', (ua, expected) => {
    expect(describeDevice(ua)).toBe(expected);
  });

  it('sin user-agent', () => {
    expect(describeDevice(null)).toBe('Dispositivo desconocido');
    expect(describeDevice('')).toBe('Dispositivo desconocido');
    expect(describeDevice('curl/8.0')).toBe('Navegador');
  });

  it('isMobileDevice', () => {
    expect(isMobileDevice(UA.safariIphone)).toBe(true);
    expect(isMobileDevice(UA.chromeAndroid)).toBe(true);
    expect(isMobileDevice(UA.chromeWindows)).toBe(false);
    expect(isMobileDevice(null)).toBe(false);
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const at = (ms: number) => new Date(now + ms).toISOString();

  it('pasado', () => {
    expect(formatRelative(at(-20_000), now)).toBe('recién');
    expect(formatRelative(at(-5 * 60_000), now)).toBe('hace 5 min');
    expect(formatRelative(at(-3 * 3_600_000), now)).toBe('hace 3 h');
    expect(formatRelative(at(-1 * 86_400_000), now)).toBe('hace 1 día');
    expect(formatRelative(at(-12 * 86_400_000), now)).toBe('hace 12 días');
    expect(formatRelative(at(-65 * 86_400_000), now)).toBe('hace 2 meses');
    expect(formatRelative(at(-400 * 86_400_000), now)).toBe('hace 1 año');
  });

  it('futuro', () => {
    expect(formatRelative(at(30_000), now)).toBe('en menos de un minuto');
    expect(formatRelative(at(29 * 86_400_000), now)).toBe('en 29 días');
    expect(formatRelative(at(2 * 3_600_000), now)).toBe('en 2 h');
  });

  it('no depende de la zona horaria (mismo texto en servidor y navegador)', () => {
    expect(formatRelative('2026-09-29T11:00:00-01:00', now)).toBe('recién');
  });

  it('fecha inválida', () => {
    expect(formatRelative('no-es-fecha', now)).toBe('fecha desconocida');
  });

  it('isActiveNow: menos de 5 minutos', () => {
    expect(isActiveNow(at(-4 * 60_000), now)).toBe(true);
    expect(isActiveNow(at(-6 * 60_000), now)).toBe(false);
  });
});

describe('clave manual', () => {
  it('bloques de 4 en mayúsculas, sin espacios previos', () => {
    expect(secretBlocks('jbswy3dpehpk3pxp')).toEqual(['JBSW', 'Y3DP', 'EHPK', '3PXP']);
    expect(secretBlocks('JBSW Y3DP EH')).toEqual(['JBSW', 'Y3DP', 'EH']);
    expect(secretBlocks('')).toEqual([]);
  });

  it('se copia sin espacios', () => {
    expect(compactSecret('JBSW Y3DP-EHPK')).toBe('JBSWY3DPEHPK');
  });
});

describe('archivo de códigos de recuperación', () => {
  const generatedAt = new Date(2026, 8, 29, 9, 5);

  it('lleva la cuenta, la fecha y los códigos numerados', () => {
    const text = recoveryCodesText(['AAAAA-11111', 'BBBBB-22222'], {
      email: 'ana@agencia.co',
      generatedAt,
    });
    expect(text).toContain('Cuenta: ana@agencia.co');
    expect(text).toContain('Generados: 2026-09-29 09:05');
    expect(text).toContain(' 1. AAAAA-11111');
    expect(text).toContain(' 2. BBBBB-22222');
    expect(text).toContain('una sola vez');
  });

  it('sin email, sin la línea de cuenta', () => {
    expect(recoveryCodesText(['X'], { generatedAt })).not.toContain('Cuenta:');
  });

  it('localTimestamp rellena con ceros', () => {
    expect(localTimestamp(new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02 03:04');
  });

  it('nombre del archivo: con el email saneado y sin la marca', () => {
    expect(recoveryCodesFilename('Ana.Pérez@Agencia.co')).toBe(
      'codigos-recuperacion-ana.p-rez-at-agencia.co.txt',
    );
    expect(recoveryCodesFilename()).toBe('codigos-recuperacion.txt');
    expect(recoveryCodesFilename('../../etc')).not.toContain('/');
  });
});
