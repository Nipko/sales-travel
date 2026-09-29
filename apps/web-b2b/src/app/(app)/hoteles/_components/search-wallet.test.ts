import { describe, expect, it } from 'vitest';
import { searchWalletNotice, searchWalletsOf } from './search-wallet';
import { parseAgencyWallets } from '../../../../lib/wallets';

const WALLETS = {
  enabled: ['COP', 'EUR', 'PEN'],
  operating: ['COP'],
  suspended: ['EUR'],
  financierName: 'Consolidador Andino',
};

describe('searchWalletNotice — el aviso temprano en la búsqueda de hoteles', () => {
  it('sin cartera en la moneda elegida: se puede cotizar, no reservar, y a quién pedírsela', () => {
    expect(searchWalletNotice(WALLETS, 'USD')).toBe(
      'Tu agencia no tiene cartera en USD: podés cotizar, pero no reservar. Pedile a Consolidador Andino que la habilite.',
    );
  });

  it('con la cartera suspendida: lo mismo, hasta que la reactiven', () => {
    expect(searchWalletNotice(WALLETS, 'EUR')).toMatch(/cartera EUR de tu agencia está suspendida/);
  });

  it('en otro estado que no retiene (sobre el cupo), no la llama suspendida', () => {
    const notice = searchWalletNotice(WALLETS, 'PEN');
    expect(notice).toMatch(/cartera PEN de tu agencia no está activa: podés cotizar/);
    expect(notice).not.toMatch(/suspendida/);
  });

  it('con cartera activa, sin moneda elegida o sin saber las carteras: nada', () => {
    expect(searchWalletNotice(WALLETS, 'COP')).toBeUndefined();
    expect(searchWalletNotice(WALLETS, '')).toBeUndefined();
    expect(searchWalletNotice(null, 'USD')).toBeUndefined();
    expect(searchWalletNotice(undefined, 'USD')).toBeUndefined();
  });

  it('sin quien financie (la raíz): Planetour', () => {
    expect(searchWalletNotice({ ...WALLETS, financierName: null }, 'USD')).toMatch(
      /Pedile a Planetour/,
    );
  });
});

describe('searchWalletsOf', () => {
  it('sólo las monedas y su estado: ni saldo ni cupo', () => {
    const wallets = parseAgencyWallets({
      portfolios: [
        {
          id: '20000000-0000-4000-8000-000000000001',
          tenantId: '10000000-0000-4000-8000-000000000001',
          currency: 'COP',
          exponent: 2,
          creditLimitMinor: 5,
          balanceMinor: 7,
          status: 'suspended',
        },
      ],
      financier: null,
    })!;
    const out = searchWalletsOf(wallets);
    expect(out).toEqual({
      enabled: ['COP'],
      operating: [],
      suspended: ['COP'],
      financierName: null,
    });
  });
});
