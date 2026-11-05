'use client';

import { saleBreakdown } from '../../../../lib/sale-breakdown';
import { TicketingDeadlineBadge } from '../_components/ticketing-deadline-badge';
import { formatMoney } from '../../../../lib/flight-format';
import { AlertTriangle, Armchair, ArrowLeft, ArrowRight, Plane } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '../../../../components/ui/button';
import { Card, CardContent } from '../../../../components/ui/card';
import { readJson } from '../../../../lib/read-json';
import { ItineraryTimeline, ItineraryTimelineSkeleton } from '../_components/itinerary-timeline';
import {
  buildTimeline,
  cabinLabel,
  routeTitle,
  travelDates,
} from '../_components/itinerary-timeline-view';
import {
  MobileCheckoutBar,
  OfferConditions,
  PriceBreakdown,
  PriceStatus,
  ShareQuoteMenu,
} from './booking-summary';
import {
  bookingToast,
  createdOrderId,
  paxCountLabel,
  reservationHref,
  totalPassengers,
} from './booking-navigation';
import {
  PassengerForm,
  passengerLabel,
  type ReservationContact,
  type ReservationPassenger,
  type ReservationSubmitOptions,
} from './passenger-form';
import { BillingSection } from './billing-section';
import {
  billingDraftFromQuotation,
  billingIdentity,
  billingProblems,
  describeMissing,
  emptyBillingDraft,
  isValidEmail,
  quotationCustomerPatch,
  resolveBilling,
  type BillingDraft,
  type QuotationCustomerPatch,
} from '../../../../lib/billing';
import {
  billingWithSavedCustomer,
  crmSaveNote,
  crmUpsertPlan,
  upsertedCustomerId,
  type CustomerUpsertBody,
} from '../../../../lib/billing-crm';
import { humanizeProviderError } from '../../../../lib/provider-errors';
import { isTestFare, TEST_BOOKING_NOTICE } from '../../../../lib/test-content';
import { TestContentBadge, TestContentNotice } from '../../../../components/test-content-badge';
import type { Offer } from '../actions';
import { fareFamilySummary } from '../_components/fare-components-view';
import {
  acceptRevalidatedPrice,
  displayedPriceChanged,
  displayedTotal,
  isServerPriceChange,
  offersSeatSelection,
  priceStatusLine,
  readOfferPriceResponse,
  reserveDecision,
  seatsSurviveRevalidation,
  shouldAutoVerifyPrice,
  withRevalidatedOffer,
  type PriceVerificationState,
} from './offer-price-flow';
import {
  createOrderErrorMessage,
  createOrderReconciliationView,
  createOrderTransportFailureView,
  isAmbiguousCreateHttpStatus,
  shouldShowBookingForm,
  type BookingOutcome,
  type BookingOutcomeView,
  type CreateOrderProviderResult,
  type CreateOrderResponseBody,
} from './create-order-reconciliation';
import { createOrderFundingView } from './create-order-funding';
import { SeatMapSheet } from './seat-map-sheet';
import {
  seatOutcomeMessages,
  seatPassengers,
  seatSummary,
  type SeatChoice,
  type SeatTab,
} from './seat-map-view';
import {
  PORTFOLIOS_HREF,
  PORTFOLIOS_LINK_LABEL,
} from '../../hoteles/checkout/_components/funding-view';

interface Quotation {
  id: string;
  status: string;
  quoteNumber: number;
  searchCriteria: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate?: string;
    tripType: string;
    paxCount: { adults: number; children: number; infants: number };
    cabin: string;
    currency: string;
  };
  selectedOffer: Offer;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  /** A nombre de quién se factura (0091); `null` si nunca se guardó. */
  billing?: unknown;
  notes: string | null;
  expiresAt: string;
  createdAt: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Traduce errores crudos del proveedor a mensajes claros (helper compartido). */
function humanizeBookingError(raw: string): string {
  return humanizeProviderError(raw);
}

const ERROR_DESCONOCIDO = 'Error desconocido';

/** Guardar en Clientes o en la cotización nunca debe frenar la reserva más que esto. */
const CRM_TIMEOUT_MS = 8000;

/** `PATCH /api/quotations/:id/customer`. Lanza si no se pudo guardar, con el texto del API. */
async function patchQuotationCustomer(
  quotationId: string,
  patch: QuotationCustomerPatch,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/quotations/${quotationId}/customer`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal,
  });
  if (!res.ok) {
    const read = await readJson<{ error?: string; message?: string }>(res);
    const d = read.ok ? read.data : {};
    throw new Error(d.error ?? d.message ?? 'No se pudo guardar la facturación.');
  }
}

/** Guarda a alguien en Clientes. `null` si no se pudo: nunca lanza. */
async function upsertCustomer(body: CustomerUpsertBody): Promise<string | null> {
  try {
    const res = await fetch('/api/customers/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CRM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const read = await readJson<unknown>(res);
    return read.ok ? upsertedCustomerId(read.data) : null;
  } catch {
    return null;
  }
}

/** Lo que deja una revalidación: el estado, la oferta nueva si la hubo y si los asientos siguen. */
interface PriceCheck {
  readonly state: PriceVerificationState;
  readonly offer?: Offer;
  readonly seatsKept: boolean;
}

/**
 * Desenlace de la reserva tal como lo devuelve `POST /api/orders`.
 *
 * Los cuatro desenlaces del proveedor son una COPIA de `OrderCreateOutcome` de `packages/domain`,
 * no un import: `apps/web-b2b` no depende de paquetes del workspace. `UNCERTAIN` es deliberadamente
 * sólo nuestro: significa que el backend prohíbe repetir el create hasta conciliar el intento.
 *
 * Antes esto era un `success: boolean`, y con un booleano una reserva con el vuelo dentro y el
 * asiento fuera se pintaba en verde con su PNR: la mentira que el pasajero descubre en el
 * mostrador. Cada desenlace se pinta distinto.
 */
/** Resume las incidencias del proveedor en una línea. `undefined` si no hay ninguna de error. */
function describeIssues(issues: CreateOrderProviderResult['issues']): string | undefined {
  const errores = (issues ?? []).filter((i) => i.severity === 'ERROR');
  if (errores.length === 0) return undefined;
  return errores.map((i) => `${i.category}: ${i.type}`).join(' | ');
}

/**
 * Sólo `CONFIRMED` es verde. `PARTIAL` y `PENDING` son ámbar: hay reserva, pero no está cerrada.
 * Los colores salen de los tokens (con transparencia) para seguir al tema oscuro; el texto va en
 * `--color-fg`, porque los colores de estado no llegan a AA como texto.
 */
const BOOKING_OUTCOME_STYLE: Record<BookingOutcome, { box: string; title: string; text: string }> =
  {
    CONFIRMED: {
      box: 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10',
      title: 'Reserva creada',
      text: 'text-[var(--color-fg)]',
    },
    PARTIAL: {
      box: 'border-[var(--color-warning)]/50 bg-[var(--color-warning)]/12',
      title: 'Reserva creada PARCIALMENTE — hay servicios sin confirmar',
      text: 'text-[var(--color-fg)]',
    },
    PENDING: {
      box: 'border-[var(--color-warning)]/50 bg-[var(--color-warning)]/12',
      title: 'Reserva enviada — el proveedor todavía no la confirmó',
      text: 'text-[var(--color-fg)]',
    },
    UNCERTAIN: {
      box: 'border-[var(--color-warning)]/50 bg-[var(--color-warning)]/12',
      title: 'Creación incierta — requiere conciliación',
      text: 'text-[var(--color-fg)]',
    },
    FAILED: {
      box: 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/8',
      title: 'No se pudo crear la reserva',
      text: 'text-[var(--color-fg)]',
    },
  };

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  draft: {
    label: 'Borrador',
    className: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
  },
  sent: {
    label: 'Enviada',
    className: 'bg-[var(--color-primary)]/10 text-[var(--color-fg)]',
  },
  accepted: {
    label: 'Aceptada',
    className: 'bg-[var(--color-success)]/12 text-[var(--color-fg)]',
  },
  expired: {
    label: 'Expirada',
    className: 'bg-[var(--color-warning)]/15 text-[var(--color-fg)]',
  },
  cancelled: {
    label: 'Cancelada',
    className: 'bg-[var(--color-danger)]/10 text-[var(--color-fg)]',
  },
};

export default function QuotationDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [quotation, setQuotation] = useState<Quotation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [billingDraft, setBillingDraft] = useState<BillingDraft>(emptyBillingDraft);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveInfo, setSaveInfo] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [billingTouched, setBillingTouched] = useState(false);
  // Los pasajeros tal como se escriben: «Facturación» usa al pasajero 1.
  const [paxSnapshot, setPaxSnapshot] = useState<{
    passengers: readonly ReservationPassenger[];
    customerIds: readonly (string | null)[];
  }>({ passengers: [], customerIds: [] });
  const [saveToCrm, setSaveToCrm] = useState(true);
  const [crmNote, setCrmNote] = useState<string | null>(null);
  const [emailSending, setEmailSending] = useState(false);
  const [emailResult, setEmailResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [priceStatus, setPriceStatus] = useState<PriceVerificationState | null>(null);
  const [bookingResult, setBookingResult] = useState<BookingOutcomeView | null>(null);
  // Una sola revalidación en vuelo: la automática al abrir y la del clic en «Reservar»
  // comparten la misma promesa en vez de pedirle dos veces el precio al proveedor.
  const pendingCheck = useRef<Promise<PriceCheck> | null>(null);
  // La cotización cuyo precio ya se revalidó solo. Un ref y no estado: en modo estricto React monta
  // dos veces el efecto, y la segunda no debe volver a llamar al proveedor.
  const autoVerifiedId = useRef<string | null>(null);
  // SAB-16: elegir asientos. Sólo se ofrece si la revalidación dice que el proveedor lo permite, y
  // se descarta si una revalidación cambia la oferta: los asientos cuelgan de la oferta a reservar.
  const [seatSelection, setSeatSelection] = useState(false);
  const [seatChoices, setSeatChoices] = useState<SeatChoice[]>([]);
  const [seatTabsSeen, setSeatTabsSeen] = useState<SeatTab[]>([]);
  const [seatSheetOpen, setSeatSheetOpen] = useState(false);
  const [passengerNames, setPassengerNames] = useState<readonly string[]>([]);
  // La barra inferior del teléfono reserva con el mismo envío que el botón del formulario.
  const submitRef = useRef<((acceptNewPrice?: boolean) => void) | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/quotations/${encodeURIComponent(params.id)}`)
      .then(async (res) => {
        const read = await readJson<{ quotation?: Quotation | null }>(res);
        const loaded = read.ok && res.ok ? read.data.quotation : null;
        if (!loaded) {
          setError(
            res.status === 404
              ? 'No encontramos esta cotización. Puede que ya no exista.'
              : 'No se pudo cargar la cotización.',
          );
          return;
        }
        setQuotation(loaded);
        setBillingDraft(billingDraftFromQuotation(loaded.billing, loaded));
        setNotes(loaded.notes ?? '');
      })
      .catch(() => setError('No se pudo cargar la cotización.'))
      .finally(() => setLoading(false));
  }, [params.id]);

  /*
   * El precio se revalida solo al abrir la cotización. Antes era un botón «Verificar precio» que
   * había que pulsar antes de poder reservar: un paso que el vendedor no necesita decidir, porque
   * la reserva no puede salir sin él. Ahora corre en segundo plano, y si al reservar ya es viejo o
   * falló, el propio clic en «Reservar» lo repite.
   */
  useEffect(() => {
    if (quotation === null || autoVerifiedId.current === quotation.id) return;
    if (!shouldAutoVerifyPrice(quotation.status)) return;
    autoVerifiedId.current = quotation.id;
    void revalidatePrice();
    // Sólo al cargar otra cotización: `revalidatePrice` cambia en cada render y la revalidación
    // misma reemplaza la oferta de `quotation`, lo que no debe volver a dispararla.
  }, [quotation?.id]);

  function handleCopyLink() {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const handlePassengersChange = useCallback(
    (passengers: readonly ReservationPassenger[], customerIds: readonly (string | null)[]) =>
      setPaxSnapshot({ passengers, customerIds }),
    [],
  );

  const passenger1 = paxSnapshot.passengers[0];
  const passenger1CustomerId = paxSnapshot.customerIds[0] ?? null;
  const resolvedBilling = resolveBilling(billingDraft, passenger1, passenger1CustomerId);
  // Lo que usan «Enviar por email» y «Enviar por WhatsApp»: el contacto de quien factura.
  const contactName = billingIdentity(billingDraft, passenger1).name;
  const contactEmail = billingDraft.email.trim();
  const contactPhone = billingDraft.phone.trim();

  function changeBilling(draft: BillingDraft) {
    setBillingDraft(draft);
    setSaveInfo(null);
    setSaveError(null);
  }

  /** Guarda la facturación (si está completa) y el contacto que la refleja. Lanza si falla. */
  async function persistBilling(current: Quotation): Promise<void> {
    const { patch } = quotationCustomerPatch(billingDraft, passenger1, notes, passenger1CustomerId);
    await patchQuotationCustomer(current.id, patch);
    setQuotation((latest) =>
      latest === null
        ? latest
        : {
            ...latest,
            customerName: patch.customerName,
            customerEmail: patch.customerEmail,
            customerPhone: patch.customerPhone,
            notes: patch.notes,
            ...(patch.billing ? { billing: patch.billing } : {}),
          },
    );
  }

  async function handleSaveBilling() {
    if (!quotation) return;
    setBillingTouched(true);
    setSaveInfo(null);
    setSaveError(null);
    if (contactEmail && !isValidEmail(contactEmail)) {
      setSaveError('Escribe un email válido.');
      return;
    }
    setSaving(true);
    try {
      const missing = resolvedBilling.missing;
      await persistBilling(quotation);
      setSaveInfo(
        missing.length === 0
          ? 'Guardado'
          : `Contacto guardado. Para la factura falta: ${describeMissing(missing)}.`,
      );
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Error de conexión.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSendEmail() {
    if (!quotation || !isValidEmail(contactEmail)) return;
    setEmailSending(true);
    setEmailResult(null);
    try {
      // El correo sale al email de «Facturación»: se guarda antes de enviar.
      await persistBilling(quotation);
      const res = await fetch(`/api/quotations/${quotation.id}/send-email`, { method: 'POST' });
      const data = (await res.json()) as {
        sent?: boolean;
        to?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        setEmailResult({ ok: false, text: data.error ?? data.message ?? 'No se pudo enviar.' });
        return;
      }
      setEmailResult(
        data.sent
          ? { ok: true, text: `Cotización enviada a ${data.to ?? contactEmail}` }
          : {
              ok: false,
              text: 'No hay correo configurado para enviar. Configura el email de la agencia (Mi Red → Email) o el del sistema.',
            },
      );
    } catch (err) {
      setEmailResult({
        ok: false,
        text: err instanceof Error ? err.message : 'Error de conexión.',
      });
    } finally {
      setEmailSending(false);
    }
  }

  /**
   * Antes de reservar: guarda en Clientes a quien no salió de la búsqueda (si el vendedor no lo
   * desmarcó) y la facturación en la cotización. Nada de esto frena la reserva: lo que falle
   * queda en una nota junto al resultado.
   */
  async function saveBeforeBooking(
    current: Quotation,
    passengers: readonly ReservationPassenger[],
    customerIds: readonly (string | null)[],
  ): Promise<void> {
    const resolved = resolveBilling(billingDraft, passengers[0], customerIds[0] ?? null);
    const plan = crmUpsertPlan({
      enabled: saveToCrm,
      passengers: passengers.map((p) => ({ ...p, label: passengerLabel(p) })),
      customerIds,
      billing: resolved.billing,
    });
    const results = await Promise.all(plan.items.map((item) => upsertCustomer(item.body)));
    const billing = billingWithSavedCustomer(resolved.billing, plan, results);
    if (billing?.mode === 'other' && billing.customerId) {
      const id = billing.customerId;
      setBillingDraft((d) => (d.mode === 'other' && !d.customerId ? { ...d, customerId: id } : d));
    }
    const lines: string[] = [];
    const saved = crmSaveNote(plan, results);
    if (saved) lines.push(saved);
    try {
      const { patch } = quotationCustomerPatch(billingDraft, passengers[0], notes, null);
      await patchQuotationCustomer(
        current.id,
        { ...patch, ...(billing ? { billing } : {}) },
        AbortSignal.timeout(CRM_TIMEOUT_MS),
      );
    } catch {
      lines.push('No se pudo guardar la facturación en la cotización; usa «Guardar facturación».');
    }
    setCrmNote(lines.length > 0 ? lines.join(' ') : null);
  }

  /**
   * El clic en «Reservar». Si el precio no está confirmado hace poco, se revalida primero y
   * se espera; si cambió, se para y el formulario pregunta (con lo escrito intacto); si se confirmó,
   * la reserva sale en el mismo clic. Un error de revalidación se lanza para que el formulario lo
   * muestre junto al botón.
   */
  async function handleCreateOrder(
    passengers: ReservationPassenger[],
    contactInfo: ReservationContact,
    options: ReservationSubmitOptions,
  ) {
    if (!quotation) return;
    let offer = quotation.selectedOffer;
    let withSeats = seatSelection && seatChoices.length > 0;

    if (options.acceptNewPrice === true && priceStatus?.kind === 'acceptance-required') {
      // La oferta de `quotation` ya es la revalidada: aceptar sólo cambia el estado.
      setPriceStatus(acceptRevalidatedPrice(priceStatus));
    } else {
      const decision = reserveDecision(priceStatus, Date.now());
      if (decision === 'ask') return;
      if (decision === 'revalidate') {
        const check = await revalidatePrice();
        if (check.state.kind === 'error') throw new Error(check.state.message);
        // `acceptance-required`: el formulario ya pregunta por el precio nuevo.
        if (check.state.kind !== 'confirmed' || check.offer === undefined) return;
        offer = check.offer;
        withSeats = withSeats && check.seatsKept;
      }
    }

    await saveBeforeBooking(quotation, passengers, options.customerIds);

    // Nunca lleva `payment`: createOrder no cobra y el API rechaza el campo (D1). Los asientos van
    // sin precio ni oferta: el servidor vuelve a leer el mapa y sólo reserva los sin cargo.
    const body = {
      offer,
      searchCriteria: quotation.searchCriteria,
      passengers,
      contactInfo,
      quotationId: quotation.id,
      ...(withSeats ? { seats: seatChoices } : {}),
    };
    let res: Response;
    try {
      res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // El navegador no sabe si el servidor alcanzó a enviar el write antes de perder la red.
      setBookingResult(createOrderTransportFailureView());
      return;
    }
    // `readJson` y no `res.json()`: cuando el fallo ocurre ANTES de llegar a la aplicación —el
    // 502 de un balanceador, el 504 de Cloudflare si la llamada al proveedor tarda de más— la
    // respuesta es una página HTML, `res.json()` lanza, y lo que el vendedor leía en mitad de una
    // reserva era «Unexpected token '<', "<!DOCTYPE "... is not valid JSON»: un error del parser
    // de JavaScript que no dice qué pasó ni si la reserva se creó.
    const leido = await readJson<CreateOrderResponseBody>(res);
    if (!leido.ok) {
      // Un 502/504 HTML puede llegar después de que Sabre creó el PNR. El texto del parser no
      // demuestra un rechazo y nunca debe reabrir el formulario.
      setBookingResult(createOrderTransportFailureView());
      return;
    }
    const data = leido.data;
    const reconciliation = createOrderReconciliationView(data);
    if (reconciliation !== null) {
      setBookingResult(reconciliation);
      return;
    }
    if (isAmbiguousCreateHttpStatus(res.status)) {
      setBookingResult(createOrderTransportFailureView());
      return;
    }
    if (isServerPriceChange(res.status, createOrderErrorMessage(data))) {
      // El servidor revalidó por su cuenta y vio otro precio: no se reservó nada. Se revalida
      // aquí para traer la oferta nueva y preguntar, igual que si lo hubiera visto el navegador.
      const check = await revalidatePrice();
      if (check.state.kind === 'acceptance-required') return;
      throw new Error(
        check.state.kind === 'error'
          ? check.state.message
          : 'La aerolínea cambió la tarifa mientras se creaba la reserva y no se reservó nada. Vuelve a pulsar «Reservar».',
      );
    }
    if (!res.ok) {
      // La cartera de la agencia o de su red no cubre la reserva: no salió nada hacia la aerolínea
      // y se puede volver a reservar una vez resuelto. El texto ya viene del API.
      const funding = createOrderFundingView(res.status, data);
      setBookingResult(
        funding === undefined
          ? {
              outcome: 'FAILED',
              error: humanizeBookingError(createOrderErrorMessage(data) ?? ERROR_DESCONOCIDO),
            }
          : { outcome: 'FAILED', funding },
      );
      return;
    }
    const outcome = data.providerResult?.outcome;
    if (!outcome) {
      setBookingResult({
        outcome: 'FAILED',
        error: humanizeBookingError(createOrderErrorMessage(data) ?? ERROR_DESCONOCIDO),
      });
      return;
    }
    // El vuelo quedó y algún asiento no: se dice cuál, en vez de los códigos del proveedor.
    const seatNotices = seatOutcomeMessages(data.providerResult?.items, data.saga);
    const orderId = createdOrderId(data);
    const view: BookingOutcomeView = {
      outcome,
      pnr: data.providerResult?.pnr,
      ...(orderId === undefined ? {} : { orderId }),
      error:
        outcome === 'CONFIRMED' || seatNotices.length > 0
          ? undefined
          : humanizeBookingError(
              describeIssues(data.providerResult?.issues) ??
                createOrderErrorMessage(data) ??
                ERROR_DESCONOCIDO,
            ),
      ...(seatNotices.length > 0 ? { seatNotices } : {}),
    };
    // El estado se fija igual: oculta el formulario mientras se abre el detalle, y si la
    // navegación tarda, el aviso con el enlace sigue a la vista.
    setBookingResult(view);
    const href = reservationHref(view);
    if (href !== null) {
      const aviso = bookingToast(view);
      const options = aviso.description === undefined ? {} : { description: aviso.description };
      if (aviso.tone === 'success') toast.success(aviso.title, options);
      else toast.warning(aviso.title, options);
      router.push(href);
    }
  }

  /** Revalida el precio. Si ya hay una revalidación en vuelo, devuelve esa misma. */
  function revalidatePrice(): Promise<PriceCheck> {
    if (pendingCheck.current !== null) return pendingCheck.current;
    if (!quotation) {
      return Promise.resolve({
        state: { kind: 'error', message: 'La cotización todavía no cargó.' },
        seatsKept: false,
      });
    }
    const run = runPriceCheck(quotation).finally(() => {
      pendingCheck.current = null;
    });
    pendingCheck.current = run;
    return run;
  }

  async function runPriceCheck(current: Quotation): Promise<PriceCheck> {
    const selectedBeforeRequest = current.selectedOffer;
    setVerifying(true);
    try {
      const res = await fetch('/api/search/offer-price', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offer: current.selectedOffer,
          searchCriteria: current.searchCriteria,
        }),
      });
      const read = await readOfferPriceResponse(res, selectedBeforeRequest);
      if (!read.ok) {
        // La oferta no se tocó: los asientos elegidos siguen colgando de ella.
        const state: PriceVerificationState = { kind: 'error', message: read.message };
        setPriceStatus(state);
        return { state, seatsKept: true };
      }

      const changed = displayedPriceChanged(
        selectedBeforeRequest,
        read.data.offer,
        read.data.priceChanged,
      );
      const newTotal = displayedTotal(read.data.offer);
      const checkedAt = Date.now();
      const state: PriceVerificationState = changed
        ? {
            kind: 'acceptance-required',
            newTotal: formatMoney(newTotal.amountMinor, newTotal.currency),
            checkedAt,
          }
        : { kind: 'confirmed', changed: false, checkedAt };

      // La Offer de precio trae nuevos handles, TTL, desglose y familias. Parchear sólo `total`
      // deja la reserva usando identificadores vencidos; se reemplaza el objeto entero.
      setQuotation((latest) =>
        latest === null ? latest : withRevalidatedOffer(latest, read.data.offer),
      );
      const seatsOffered = offersSeatSelection(read.data);
      const seatsKept = seatsSurviveRevalidation(state, seatsOffered);
      setSeatSelection(seatsOffered);
      if (!seatsKept) {
        setSeatChoices([]);
        setSeatTabsSeen([]);
      }
      setBookingResult(null);
      setPriceStatus(state);
      return { state, offer: read.data.offer, seatsKept };
    } catch {
      const state: PriceVerificationState = {
        kind: 'error',
        message: 'No se pudo conectar para revalidar la tarifa. Inténtalo de nuevo.',
      };
      setPriceStatus(state);
      return { state, seatsKept: true };
    } finally {
      setVerifying(false);
    }
  }

  const selectedForTimeline = quotation?.selectedOffer;
  const legs = useMemo(
    () => (selectedForTimeline ? buildTimeline(selectedForTimeline, formatMoney) : []),
    [selectedForTimeline],
  );

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-5 sm:py-8" aria-busy="true">
        <span className="sr-only" role="status">
          Cargando la reserva…
        </span>
        <div className="mb-6 animate-pulse space-y-2">
          <div className="h-3 w-28 rounded bg-[var(--color-surface-muted)]" />
          <div className="h-7 w-56 rounded bg-[var(--color-surface-muted)]" />
          <div className="h-4 w-72 max-w-full rounded bg-[var(--color-surface-muted)]" />
        </div>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-5">
            <ItineraryTimelineSkeleton legs={2} />
            <div className="h-72 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]" />
          </div>
          <div className="hidden h-80 animate-pulse rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] lg:block" />
        </div>
      </div>
    );
  }

  if (error || !quotation) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center sm:px-5">
        <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-[var(--color-danger)]/10">
          <AlertTriangle aria-hidden="true" className="size-5 text-[var(--color-danger)]" />
        </span>
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">
          No pudimos abrir esta reserva
        </h1>
        <p role="alert" className="mt-1 text-sm text-[var(--color-fg-muted)]">
          {error || 'Cotización no encontrada.'}
        </p>
        <Button asChild variant="secondary" size="md" className="mt-6">
          <Link href="/cotizaciones">
            <ArrowLeft aria-hidden="true" /> Volver a buscar vuelos
          </Link>
        </Button>
      </div>
    );
  }

  const { searchCriteria, selectedOffer } = quotation;
  const statusInfo = STATUS_LABELS[quotation.status] ?? STATUS_LABELS.draft!;
  // Sólo una vigencia que declaró el PROVEEDOR puede vencer el precio. La de contenido ATPCO es
  // nuestro TTL de caché (90 s): marcarla «Precio expirado» a los 90 s de guardar era falso, la
  // reserva revalida el precio de todas formas.
  const priceFromProvider = quotation.selectedOffer.expiresAtSource === 'provider';
  const isExpired = priceFromProvider && new Date(quotation.expiresAt) < new Date();
  const totalPax = totalPassengers(searchCriteria.paxCount);
  const fareSummary = fareFamilySummary(selectedOffer);
  const venta = saleBreakdown(selectedOffer);
  // La oferta guardada, o la revalidada por el API si ya se verificó el precio: la marca de la
  // revalidada sale de la cuenta que la cotizó, no de lo que guardó el navegador.
  const testFare = isTestFare(selectedOffer);
  const priceLine = priceStatusLine(priceStatus, verifying);
  const seatHolders = seatPassengers(searchCriteria.paxCount, passengerNames);
  const seatLine = seatSummary(seatChoices, seatHolders, seatTabsSeen);
  // Los asientos salen de la revalidación automática: se ofrecen cuando el proveedor los permite
  // y la oferta vigente está confirmada, no mientras se revalida.
  const offerSeats =
    seatSelection && !verifying && priceStatus?.kind === 'confirmed' && seatHolders.length > 0;
  const showForm = shouldShowBookingForm(bookingResult);
  const totalText = formatMoney(venta.sellMinor, venta.currency);
  const paxText = paxCountLabel(searchCriteria.paxCount);
  const priceChangeTotal =
    priceStatus?.kind === 'acceptance-required' ? priceStatus.newTotal : undefined;
  const subtitle = [
    routeTitle(legs) || `${searchCriteria.origin} → ${searchCriteria.destination}`,
    travelDates(legs),
    paxText,
    cabinLabel(searchCriteria.cabin),
  ]
    .filter(Boolean)
    .join(' · ');
  const createdHref = bookingResult?.orderId
    ? `/reservas/${encodeURIComponent(bookingResult.orderId)}`
    : null;

  function sendWhatsApp() {
    if (!contactPhone) return;
    const phone = contactPhone.replace(/\D/g, '');
    const text = `Hola ${contactName || ''}! Te envío cotización #${quotation!.quoteNumber}:\n\n✈️ ${searchCriteria.origin} → ${searchCriteria.destination}\n📅 ${searchCriteria.departureDate}\n💰 ${formatMoney(selectedOffer.pricing?.finalMinor ?? selectedOffer.total.amountMinor, selectedOffer.total.currency)}\n🎫 ${fareSummary ?? 'Standard'}\n\n¿Te interesa?`;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`);
  }

  function reserveFromBar() {
    submitRef.current?.(priceChangeTotal !== undefined);
    // Lo que falte o falle se dice junto al botón del formulario: se lleva la vista hasta ahí.
    document
      .getElementById('checkout-reservar')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderBilling(attempted: boolean) {
    return (
      <BillingSection
        draft={billingDraft}
        onChange={changeBilling}
        passenger1={passenger1}
        missing={resolvedBilling.missing}
        showErrors={attempted || billingTouched}
        notes={notes}
        onNotesChange={setNotes}
        onSave={() => void handleSaveBilling()}
        saving={saving}
        saveInfo={saveInfo}
        saveError={saveError}
      />
    );
  }

  /** El cuerpo del resumen: la columna derecha en escritorio y el panel de la barra en el teléfono. */
  function renderSummaryBody() {
    return (
      <div className="space-y-4">
        <div>
          <p className="text-xs font-medium text-[var(--color-fg-muted)]">
            Total · {totalPax === 1 ? '1 pasajero' : `${totalPax} pasajeros`}
          </p>
          <p className="mt-0.5 font-mono text-2xl font-bold tabular-nums tracking-tight text-[var(--color-fg)]">
            {totalText}
          </p>
          <p className="text-[11px] text-[var(--color-fg-subtle)]">Impuestos y tasas incluidos</p>
        </div>
        <PriceBreakdown offer={selectedOffer} />
        <div className="border-t border-[var(--color-border)] pt-4">
          <h3 className="mb-2 text-xs font-semibold text-[var(--color-fg)]">Condiciones</h3>
          <OfferConditions offer={selectedOffer} />
        </div>
        <div className="space-y-1.5 border-t border-[var(--color-border)] pt-4 text-[11px]">
          <TicketingDeadlineBadge raw={quotation!.selectedOffer.provider.raw} />
          <p className="text-[var(--color-fg-subtle)]">
            {priceFromProvider
              ? `${isExpired ? 'Precio vencido el' : 'Precio garantizado hasta el'} ${new Date(
                  quotation!.expiresAt,
                ).toLocaleString('es-CO', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}`
              : 'Precio sujeto a revalidación al reservar'}
          </p>
          <PriceStatus line={priceLine} onRetry={() => void revalidatePrice()} />
        </div>
      </div>
    );
  }

  const shareMenu = (
    <ShareQuoteMenu
      quoteNumber={quotation.quoteNumber}
      emailDisabledReason={
        isValidEmail(contactEmail) ? undefined : 'Escribe el email en «Facturación»'
      }
      emailSending={emailSending}
      onEmail={() => void handleSendEmail()}
      whatsappDisabledReason={contactPhone ? undefined : 'Escribe el teléfono en «Facturación»'}
      onWhatsApp={sendWhatsApp}
      copied={copied}
      onCopyLink={handleCopyLink}
      pdfHref={`/api/quotations/${quotation.id}/pdf`}
    />
  );

  return (
    <div
      className={`mx-auto max-w-6xl px-4 py-6 sm:px-5 sm:py-8 ${showForm ? 'pb-32 lg:pb-8' : ''}`}
    >
      {/* Encabezado: qué se está reservando, en una línea. La cotización queda como dato chico. */}
      <header className="mb-6">
        <Link
          href="/cotizaciones"
          className="mb-3 inline-flex min-h-8 items-center gap-1.5 rounded-md text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" /> Volver a la búsqueda
        </Link>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-fg-subtle)]">
              <span>
                Cotización #{quotation.quoteNumber} · {formatDate(quotation.createdAt)}
              </span>
              <span className={`rounded-full px-2 py-0.5 font-medium ${statusInfo.className}`}>
                {statusInfo.label}
              </span>
              {isExpired && quotation.status === 'draft' ? (
                <span className="rounded-full bg-[var(--color-warning)]/15 px-2 py-0.5 font-medium text-[var(--color-fg)]">
                  Precio expirado
                </span>
              ) : null}
              {testFare ? <TestContentBadge /> : null}
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)] sm:text-2xl">
              Reservar vuelo
            </h1>
            <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{subtitle}</p>
          </div>
          <div className="shrink-0">{shareMenu}</div>
        </div>
        {emailResult ? (
          <p
            role={emailResult.ok ? 'status' : 'alert'}
            className={`mt-3 rounded-lg border px-3 py-2 text-xs text-[var(--color-fg)] ${
              emailResult.ok
                ? 'border-[var(--color-success)]/40 bg-[var(--color-success)]/10'
                : 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/8'
            }`}
          >
            {emailResult.text}
          </p>
        ) : null}
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        {/* Columna principal: el vuelo, y debajo todo lo que pide reservarlo. */}
        <div className="min-w-0 space-y-5">
          <section aria-labelledby="checkout-itinerario">
            <div className="mb-2.5 flex items-center gap-2">
              <Plane aria-hidden="true" className="size-4 text-[var(--color-primary)]" />
              <h2 id="checkout-itinerario" className="text-sm font-semibold text-[var(--color-fg)]">
                Itinerario
              </h2>
            </div>
            <ItineraryTimeline legs={legs} />
          </section>

          {bookingResult ? (
            <div
              role={bookingResult.outcome === 'FAILED' ? 'alert' : 'status'}
              className={`rounded-xl border p-4 ${BOOKING_OUTCOME_STYLE[bookingResult.outcome].box}`}
            >
              <div className="space-y-1">
                <p
                  className={`text-sm font-semibold ${BOOKING_OUTCOME_STYLE[bookingResult.outcome].text}`}
                >
                  {BOOKING_OUTCOME_STYLE[bookingResult.outcome].title}
                </p>
                {bookingResult.pnr && (
                  <p className="font-mono text-lg font-bold text-[var(--color-fg)]">
                    PNR: {bookingResult.pnr}
                  </p>
                )}
                {bookingResult.orderId && !createdHref ? (
                  <p className="font-mono text-xs text-[var(--color-fg-muted)]">
                    Reserva local: {bookingResult.orderId}
                  </p>
                ) : null}
                {bookingResult.error && (
                  <p className={`text-sm ${BOOKING_OUTCOME_STYLE[bookingResult.outcome].text}`}>
                    {bookingResult.error}
                  </p>
                )}
                {bookingResult.seatNotices?.map((notice) => (
                  <p
                    key={notice}
                    className={`text-sm ${BOOKING_OUTCOME_STYLE[bookingResult.outcome].text}`}
                  >
                    {notice}
                  </p>
                ))}
                {bookingResult.funding && (
                  <div
                    role="alert"
                    className={`space-y-1 text-sm ${BOOKING_OUTCOME_STYLE[bookingResult.outcome].text}`}
                  >
                    <p className="font-medium">{bookingResult.funding.title}</p>
                    <p>{bookingResult.funding.detail}</p>
                    <p>No se hizo ninguna reserva con la aerolínea ni se retuvo saldo.</p>
                    {bookingResult.funding.action === 'portfolios' && (
                      <Link
                        href={PORTFOLIOS_HREF}
                        className="inline-flex font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
                      >
                        {PORTFOLIOS_LINK_LABEL}
                      </Link>
                    )}
                  </div>
                )}
                {createdHref ? (
                  <Link
                    href={createdHref}
                    className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-primary)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
                  >
                    {reservationHref(bookingResult) ? 'Abriendo la reserva…' : 'Ver la reserva'}
                    <ArrowRight aria-hidden="true" className="size-3.5" />
                  </Link>
                ) : null}
              </div>
            </div>
          ) : null}

          {crmNote && (
            <p
              role="status"
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-fg-muted)]"
            >
              {crmNote}
            </p>
          )}

          {/*
            El formulario vuelve SÓLO si no quedó nada reservado. Con `PARTIAL` o `PENDING` hay PNR
            en el proveedor: reofrecer "reservar" ahí es invitar a crear una segunda reserva encima
            de una que ya existe.
          */}
          {showForm ? (
            <div className="space-y-3">
              {/* Se puede reservar igual —sirve para probar el flujo—, pero quien lo hace lo sabe
                  antes de cargar a un pasajero real. */}
              {testFare ? <TestContentNotice>{TEST_BOOKING_NOTICE}</TestContentNotice> : null}
              {offerSeats ? (
                <Card>
                  <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-2.5">
                      <Armchair
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-[var(--color-primary)]"
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-[var(--color-fg)]">
                          {seatLine ?? 'Sin asientos elegidos'}
                        </p>
                        <p className="text-xs text-[var(--color-fg-muted)]">
                          Opcional. Sólo asientos sin cargo; se confirman al reservar.
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {seatChoices.length > 0 ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="h-10 flex-1 sm:h-9 sm:flex-none"
                          onClick={() => setSeatChoices([])}
                        >
                          Quitar asientos
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-10 flex-1 gap-2 sm:h-9 sm:flex-none"
                        onClick={() => setSeatSheetOpen(true)}
                      >
                        <Armchair aria-hidden="true" className="size-4" />
                        {seatChoices.length > 0 ? 'Cambiar asientos' : 'Elegir asientos (opcional)'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ) : null}
              <PassengerForm
                paxCount={searchCriteria.paxCount}
                contactEmail={contactEmail || undefined}
                contactPhone={contactPhone || undefined}
                billingSection={({ attempted }) => renderBilling(attempted)}
                billingProblems={billingProblems(billingDraft.mode, resolvedBilling.missing)}
                saveToCrm={saveToCrm}
                onSaveToCrmChange={setSaveToCrm}
                onPassengersChange={handlePassengersChange}
                priceChangeTotal={priceChangeTotal}
                onSubmit={handleCreateOrder}
                onGivenNamesChange={setPassengerNames}
                submitRef={submitRef}
                onSubmittingChange={setSubmitting}
              />
            </div>
          ) : (
            // Con la reserva ya creada, «Facturación» queda aquí para enviar la cotización.
            <Card>
              <CardContent className="p-5">{renderBilling(false)}</CardContent>
            </Card>
          )}
        </div>

        {/* Resumen: fijo a la vista en escritorio. En el teléfono baja a la barra inferior. */}
        <aside aria-labelledby="checkout-resumen" className="hidden lg:sticky lg:top-6 lg:block">
          <Card>
            <CardContent className="p-5">
              <h2
                id="checkout-resumen"
                className="mb-4 text-sm font-semibold text-[var(--color-fg)]"
              >
                Resumen del precio
              </h2>
              {renderSummaryBody()}
            </CardContent>
          </Card>
        </aside>
      </div>

      {showForm ? (
        <MobileCheckoutBar
          total={totalText}
          caption={priceLine?.tone === 'pending' ? 'Verificando precio…' : `Total · ${paxText}`}
          reserveLabel={priceChangeTotal ? 'Aceptar y reservar' : 'Reservar'}
          reserving={submitting}
          onReserve={reserveFromBar}
        >
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">Resumen del precio</h2>
          {renderSummaryBody()}
        </MobileCheckoutBar>
      ) : null}

      {seatSheetOpen ? (
        <SeatMapSheet
          offer={quotation.selectedOffer}
          searchCriteria={quotation.searchCriteria}
          passengers={seatHolders}
          initialChoices={seatChoices}
          onClose={() => setSeatSheetOpen(false)}
          onSave={(choices, tabs) => {
            setSeatChoices(choices);
            setSeatTabsSeen(tabs);
            setSeatSheetOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
