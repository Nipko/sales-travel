import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WALLET_RELEASE_NOTE, walletHoldOf, walletReleaseNote } from './wallet-hold-view';

/*
 * El aviso de la cartera al cancelar o anular una reserva con saldo retenido (SAB-10): sale sólo
 * cuando `/orders` dice que la orden tiene una retención abierta, y dice que se libera el 100 %.
 */

describe('walletHoldOf', () => {
  it('reconoce sólo una retención abierta', () => {
    expect(walletHoldOf('held')).toBe('held');
    expect(walletHoldOf('captured')).toBe('captured');
    for (const otro of [null, undefined, 'released', 'exempt', 'conflict', 1, {}]) {
      expect(walletHoldOf(otro)).toBeUndefined();
    }
  });
});

describe('walletReleaseNote', () => {
  it('con saldo retenido dice que se libera el 100 % y quién registra la penalidad', () => {
    expect(walletReleaseNote({ walletHold: 'captured' })).toBe(WALLET_RELEASE_NOTE);
    expect(walletReleaseNote({ walletHold: 'held' })).toBe(WALLET_RELEASE_NOTE);
    expect(WALLET_RELEASE_NOTE).toContain('se libera el 100 %');
    expect(WALLET_RELEASE_NOTE).toContain('quien te financia la registra aparte');
  });

  it('sin retención abierta no dice nada', () => {
    expect(walletReleaseNote({})).toBeUndefined();
    expect(walletReleaseNote({ walletHold: null })).toBeUndefined();
  });
});

/*
 * La página pide datos al montar y no se pinta sin DOM: se verifica en el código que la
 * confirmación de la cancelación lleva el aviso de la orden que se cancela.
 */
describe('Reservas avisa del saldo retenido al cancelar', () => {
  const page = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');

  it('la confirmación de la cancelación lleva el aviso de esa orden', () => {
    expect(page).toContain('note={walletReleaseNote(confirmCancel)}');
    expect(page).toMatch(/walletHold\?: 'held' \| 'captured' \| null;/);
  });
});
