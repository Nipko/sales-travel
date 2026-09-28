import { describe, expect, it } from 'vitest';
import { TBO_OPERATIONS } from '../http/operations';
import {
  TBO_OFFER_SAFETY_MARGIN_MS,
  TBO_OFFER_TTL_MS,
  TBO_SEARCH_TO_BOOK_WINDOW_MS,
  tboOfferExpiresAt,
} from './offer-window';

/** Ventana de Search a Book (docs/tbo/01 §6.3; 08 RF-09). */

describe('vida útil de una oferta de TBO', () => {
  it('30 min (p. 8) − 120 s del Book − 60 s de margen = 27 min', () => {
    expect(TBO_SEARCH_TO_BOOK_WINDOW_MS).toBe(30 * 60_000);
    expect(TBO_OPERATIONS.book.timeoutMs).toBe(120_000);
    expect(TBO_OFFER_SAFETY_MARGIN_MS).toBe(60_000);
    expect(TBO_OFFER_TTL_MS).toBe(27 * 60_000);
  });

  it('expiresAt es un instante ISO con zona, contado desde el ENVÍO del Search', () => {
    const sentAt = Date.parse('2026-09-25T23:50:30.250Z');
    expect(tboOfferExpiresAt(sentAt)).toBe('2026-09-26T00:17:30.250Z');
  });

  it('un instante inválido no produce un RangeError plano: devuelve undefined', () => {
    expect(tboOfferExpiresAt(Number.NaN)).toBeUndefined();
    expect(tboOfferExpiresAt(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(tboOfferExpiresAt(8.64e15)).toBeUndefined();
  });
});
