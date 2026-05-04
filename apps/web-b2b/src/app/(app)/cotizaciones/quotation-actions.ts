'use server';

import { api } from '../../../lib/api';
import type { Offer } from './actions';

interface QuotationResponse {
  quotation: {
    id: string;
    quoteNumber: number;
    status: string;
    createdAt: string;
  };
}

export interface CreateQuotationResult {
  ok: boolean;
  quotationId?: string;
  quoteNumber?: number;
  error?: string;
}

export async function createQuotationAction(
  offer: Offer,
  searchCriteria: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate?: string;
    tripType: string;
    paxCount: { adults: number; children: number; infants: number };
    cabin: string;
    currency: string;
  },
): Promise<CreateQuotationResult> {
  const expiresAt = offer.expiresAt || new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const res = await api<QuotationResponse>('/quotations', {
    method: 'POST',
    body: JSON.stringify({
      searchCriteria,
      selectedOffer: offer,
      expiresAt,
    }),
  });

  if (!res.ok) {
    return { ok: false, error: res.error.message };
  }

  return {
    ok: true,
    quotationId: res.data.quotation.id,
    quoteNumber: res.data.quotation.quoteNumber,
  };
}
