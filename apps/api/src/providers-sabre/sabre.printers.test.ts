import { describe, expect, it } from 'vitest';
import { sabrePrintersFromAccountConfig } from './sabre.factory.js';

/** Sin impresora designada Sabre no emite (PRINTER_NOT_ASSIGNED, CERT 2026-11-12). */
describe('impresoras de la emisión desde la config de la cuenta', () => {
  it('sin configurar: no se manda nada', () => {
    expect(sabrePrintersFromAccountConfig({})).toEqual({ invalidFields: [] });
  });

  it('el país del stock y la copia, normalizados', () => {
    expect(
      sabrePrintersFromAccountConfig({ ticketPrinterCountry: ' co ', hardcopyPrinter: 'a1b2c3' }),
    ).toEqual({
      printers: { ticketCountryCode: 'CO', hardcopyAddress: 'A1B2C3' },
      invalidFields: [],
    });
  });

  it('un valor inválido se ignora y se nombra el campo, sin el valor', () => {
    expect(
      sabrePrintersFromAccountConfig({ ticketPrinterCountry: 'COL', hardcopyPrinter: 'A1B2C3' }),
    ).toEqual({ printers: { hardcopyAddress: 'A1B2C3' }, invalidFields: ['ticketPrinterCountry'] });
    expect(sabrePrintersFromAccountConfig({ hardcopyPrinter: 7 })).toEqual({
      invalidFields: ['hardcopyPrinter'],
    });
  });
});
