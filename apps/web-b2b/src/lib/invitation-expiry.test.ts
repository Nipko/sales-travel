import { describe, expect, it } from 'vitest';
import { invitationExpiry } from './invitation-expiry';

const NOW = new Date('2026-09-29T15:00:00.000Z');
const inHours = (h: number) => new Date(NOW.getTime() + h * 60 * 60_000).toISOString();

describe('invitationExpiry', () => {
  it('recién enviada: vence en 7 días', () => {
    expect(invitationExpiry(inHours(7 * 24), NOW)).toEqual({
      label: 'vence en 7 días',
      expired: false,
    });
  });

  it('cuenta días completos: a 47 h es mañana, a 5 h es hoy', () => {
    expect(invitationExpiry(inHours(47), NOW)?.label).toBe('vence mañana');
    expect(invitationExpiry(inHours(49), NOW)?.label).toBe('vence en 2 días');
    expect(invitationExpiry(inHours(5), NOW)?.label).toBe('vence hoy');
  });

  it('vencida: se distingue para ofrecer reenviarla', () => {
    expect(invitationExpiry(inHours(-1), NOW)).toEqual({ label: 'venció', expired: true });
    expect(invitationExpiry(NOW.toISOString(), NOW)?.expired).toBe(true);
  });

  it('una fecha ilegible no se inventa', () => {
    expect(invitationExpiry('mañana', NOW)).toBeUndefined();
    expect(invitationExpiry('', NOW)).toBeUndefined();
  });
});
