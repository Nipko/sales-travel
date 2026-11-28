import type { ActivityOffer, ActivityParticipants, Money } from '@sales-travel/canonical';
import type { BookContact, IdentificationType } from '@sales-travel/despegar-hotels';

export type ActivityLanguage = 'es' | 'pt' | 'en';

export interface DiscoveryQuery {
  /** Código IATA de la ciudad (`ORL`, `SAO`). */
  destination: string;
  site?: string;
  language?: ActivityLanguage;
}

export interface ModalitiesQuery {
  /** `tracking_id` que devolvió discovery. */
  id: string;
  site?: string;
  language?: ActivityLanguage;
  /** Rango de fechas de `available_dates`; Despegar exige los dos o ninguno. */
  from?: string;
  to?: string;
}

export interface AvailabilityQuery {
  id: string;
  modality: string;
  /** YYYY-MM-DD. UNA fecha por llamada. */
  date: string;
  participants: ActivityParticipants;
  /** Horario `HH:mm` de un tour. */
  schedule?: string;
  /** Id de un adicional de la modalidad. */
  additional?: string;
  site?: string;
  language?: ActivityLanguage;
}

export interface ShoppingQuery {
  /** `DY_ORL`, `UN_ORL`, `SW_ORL` o `BG_ORL`. */
  park: string;
  from: string;
  /** Si falta, `from + 6`. */
  to?: string;
  participants: ActivityParticipants;
  modalities?: readonly string[];
  site?: string;
  language?: ActivityLanguage;
}

/** Una sugerencia de `/suggestions/activities` (un POI). */
export interface ActivitySuggestion {
  id: string;
  label: string;
  type: string;
  /** gid de la ciudad que lo contiene, si vino. */
  cityGid?: string;
}

/** Un parque de `/shopping` con sus tarifas por día y modalidad, ya canónicas. */
export interface ShoppingPark {
  id: string;
  name: string;
  description?: string;
  logo?: string;
  images: string[];
  offers: ActivityOffer[];
}

// ───────────────────────── Reserva ─────────────────────────

/** Una política de cambio/cancelación del prebook (`extended_info.exchange_policies`). */
export interface ActivityExchangePolicy {
  productType?: string;
  title?: string;
  conditions: { title?: string; answers: { question?: string; answer?: string }[] }[];
  disclaimers: { title?: string; description?: string }[];
  summaries: { title?: string; description?: string; permit?: boolean | string }[];
}

/** Lo que pide un formulario según los `hints` del prebook (p. ej. documento obligatorio). */
export interface ActivityHint {
  modality?: string;
  paymentOption?: string;
  /** Pedazos legibles del hint (`travelers.identification: REQUIRED`), para mostrar y auditar. */
  requirements: string[];
}

export interface ActivityPrebook {
  prebookId: string;
  expiresAt?: string;
  status?: string;
  total?: Money;
  commission?: { amount?: Money; min?: Money; max?: Money };
  exchangePolicies: ActivityExchangePolicy[];
  hints: ActivityHint[];
}

export interface ActivityTraveler {
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD. La edad decide la categoría en Despegar. */
  birthDate: string;
  nationality?: string;
  gender?: 'MALE' | 'FEMALE';
  identification?: { type: IdentificationType; number: string; issueCountry?: string };
}

export interface ActivityBookRequest {
  prebookId: string;
  /** Referencia única del partner: Despegar rechaza un book repetido con la misma. */
  externalBookingReference: string;
  contact: BookContact;
  /** TODOS los participantes; el primero es el titular (referencia 0). */
  travelers: ActivityTraveler[];
}

/** Un producto TICKET/TOUR de `/reservations`. */
export interface ActivityReservation {
  productId: string;
  productType: string;
  transactionId?: string;
  status: 'IN_PROCESS' | 'ISSUED' | 'CANCELLED' | 'UNKNOWN';
  rawStatus: string;
  reservationId?: string;
  pnr?: string;
  purchaseDateTime?: string;
  salePrice?: Money;
  useDate?: string;
  useExpirationDate?: string;
  durationDays?: number;
  ticketType?: string;
  highlights: string[];
  passengers: { type?: string; firstName?: string; lastName?: string }[];
  cancellationRefundable?: boolean;
  /** Voucher de HotelDO, absoluta. Obligatorio entregarlo al cliente. */
  voucherUrl?: string;
}
