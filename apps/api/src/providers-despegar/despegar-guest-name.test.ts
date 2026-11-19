import { describe, expect, it } from 'vitest';
import { DESPEGAR_GUEST_NAME_RE, despegarGuestName } from './despegar-guest-name.js';

describe('despegarGuestName — el nombre como lo acepta HotelDO', () => {
  it.each([
    ['García-López', 'García López'],
    ["O'Brien", 'OBrien'],
    ['O’Brien', 'OBrien'],
    ['D´Alessandro', 'DAlessandro'],
    ['Ana‐María', 'Ana María'],
    ['  María   José ', 'María José'],
    ['Muñoz Peña', 'Muñoz Peña'],
    ['Łukasz', 'Lukasz'],
    ['Dvořák', 'Dvorák'],
    ['José', 'José'],
  ])('%s → %s', (raw, expected) => {
    const out = despegarGuestName(raw);
    expect(out).toBe(expected);
    expect(DESPEGAR_GUEST_NAME_RE.test(out ?? '')).toBe(true);
  });

  it('una tilde combinada se compone: mide lo mismo que la precompuesta', () => {
    expect(despegarGuestName('José')).toBe('José');
  });

  it.each(['Ана', 'Ana2', 'Ana.', '李', '😀', '', "'-"])(
    '%j no se puede adaptar sin inventar',
    (raw) => {
      expect(despegarGuestName(raw)).toBeUndefined();
    },
  );
});
