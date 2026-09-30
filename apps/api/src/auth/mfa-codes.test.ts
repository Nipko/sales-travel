import { describe, expect, it } from 'vitest';
import { classifyMfaCode, formatRecoveryCode, generateRecoveryCode } from './mfa-codes.js';

describe('classifyMfaCode', () => {
  it.each(['123456', ' 123 456 ', '123-456'])('%j es un TOTP', (raw) => {
    expect(classifyMfaCode(raw)).toEqual({ kind: 'totp', value: '123456' });
  });

  it.each([
    ['ABCDE-12345', 'ABCDE12345'],
    ['abcde12345', 'ABCDE12345'],
    [' ab cde-123 45 ', 'ABCDE12345'],
    ['0123456789', '0123456789'],
  ])('%j es un código de recuperación (%s)', (raw, value) => {
    expect(classifyMfaCode(raw)).toEqual({ kind: 'recovery', value });
  });

  it.each(['12345', '1234567', 'ABCDE-1234', 'GHIJK-12345', '', '------'])(
    '%j no es ninguno: no se prueba nada',
    (raw) => {
      expect(classifyMfaCode(raw)).toEqual({ kind: 'invalid' });
    },
  );
});

describe('códigos de recuperación', () => {
  it('se generan como 10 hex en mayúscula', () => {
    for (let i = 0; i < 20; i++) expect(generateRecoveryCode()).toMatch(/^[0-9A-F]{10}$/);
  });

  it('se muestran como XXXXX-XXXXX y vuelven a la forma hasheada al tipearlos', () => {
    const code = generateRecoveryCode();
    const shown = formatRecoveryCode(code);
    expect(shown).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
    expect(classifyMfaCode(shown)).toEqual({ kind: 'recovery', value: code });
  });
});
