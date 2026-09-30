import { describe, expect, it } from 'vitest';
import { searchWalletNotice, searchWalletsOf } from './search-wallet';
import { PROVIDERS_WITH_WALLET_HOLD, parseAgencyWallets } from '../../../../lib/wallets';

const WALLETS = {
  enabled: ['COP', 'EUR', 'PEN'],
  operating: ['COP'],
  suspended: ['EUR'],
  financierName: 'Consolidador Andino',
  ownHotelAccounts: false,
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

  it('con su propia cuenta de hoteles no retiene nada (2026-09-30): sin cartera tampoco avisa', () => {
    const own = { ...WALLETS, ownHotelAccounts: true };
    expect(searchWalletNotice(own, 'USD')).toBeUndefined();
    expect(searchWalletNotice(own, 'EUR')).toBeUndefined();
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
      ownHotelAccounts: false,
    });
  });

  it('reserva hoteles con su propia cuenta si es suya la de cada proveedor que retiene', () => {
    const base = { portfolios: [], financier: null };
    const withOwn = (ownProviderAccounts: unknown) =>
      searchWalletsOf(parseAgencyWallets({ ...base, ownProviderAccounts })!).ownHotelAccounts;
    expect(PROVIDERS_WITH_WALLET_HOLD).toEqual(['tbo-hotels']);
    expect(withOwn(['latam-ndc', 'tbo-hotels'])).toBe(true);
    // Despegar no retiene: tenerla propia no cambia nada; una ajena o ninguna, tampoco.
    expect(withOwn(['despegar-hotels'])).toBe(false);
    // El correo no reserva, y vuelos y autos no graban la cuenta en la orden: no eximen.
    expect(withOwn(['agent-cars', 'email', 'latam-ndc'])).toBe(false);
    expect(withOwn([])).toBe(false);
    expect(withOwn(undefined)).toBe(false);
  });
});
