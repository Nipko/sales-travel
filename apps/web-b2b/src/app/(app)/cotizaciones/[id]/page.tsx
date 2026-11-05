'use client';

import { describePolicy, policyState } from '../../../../lib/fare-policy';
import { saleBreakdown } from '../../../../lib/sale-breakdown';
import { TicketingDeadlineBadge } from '../_components/ticketing-deadline-badge';
import { flightDate, flightTime, formatMoney } from '../../../../lib/flight-format';
import {
  Armchair,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Mail,
  Plane,
  RefreshCw,
  Send,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Button } from '../../../../components/ui/button';
import { Card, CardContent } from '../../../../components/ui/card';
import { describeBaggage, hasAnyBaggageInfo } from '../../../../lib/baggage';
import { readJson } from '../../../../lib/read-json';
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
import { fareComponentsForDisplay, fareFamilySummary } from '../_components/fare-components-view';
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
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
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

/** Sólo `CONFIRMED` es verde. `PARTIAL` y `PENDING` son ámbar: hay reserva, pero no está cerrada. */
const BOOKING_OUTCOME_STYLE: Record<BookingOutcome, { box: string; title: string; text: string }> =
  {
    CONFIRMED: {
      box: 'border-green-200 bg-green-50',
      title: 'Reserva creada exitosamente',
      text: 'text-green-800',
    },
    PARTIAL: {
      box: 'border-amber-200 bg-amber-50',
      title: 'Reserva creada PARCIALMENTE — hay servicios sin confirmar',
      text: 'text-amber-900',
    },
    PENDING: {
      box: 'border-amber-200 bg-amber-50',
      title: 'Reserva enviada — el proveedor todavía no la confirmó',
      text: 'text-amber-900',
    },
    UNCERTAIN: {
      box: 'border-amber-200 bg-amber-50',
      title: 'Creación incierta — requiere conciliación',
      text: 'text-amber-900',
    },
    FAILED: {
      box: 'border-red-200 bg-red-50',
      title: 'No se pudo crear la reserva',
      text: 'text-red-800',
    },
  };

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  draft: {
    label: 'Borrador',
    className: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]',
  },
  sent: {
    label: 'Enviada',
    className: 'bg-blue-50 text-blue-700',
  },
  accepted: {
    label: 'Aceptada',
    className: 'bg-green-50 text-green-700',
  },
  expired: {
    label: 'Expirada',
    className: 'bg-amber-50 text-amber-700',
  },
  cancelled: {
    label: 'Cancelada',
    className: 'bg-red-50 text-red-700',
  },
};

export default function QuotationDetailPage() {
  const params = useParams<{ id: string }>();
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
  // Una sola revalidación en vuelo: la automática al abrir y la del clic en «Crear reserva»
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

  useEffect(() => {
    fetch(`/api/quotations/${params.id}`)
      .then((res) => res.json() as Promise<{ quotation: Quotation }>)
      .then((data) => {
        setQuotation(data.quotation);
        setBillingDraft(billingDraftFromQuotation(data.quotation.billing, data.quotation));
        setNotes(data.quotation.notes ?? '');
      })
      .catch(() => setError('No se pudo cargar la cotización.'))
      .finally(() => setLoading(false));
  }, [params.id]);

  /*
   * El precio se revalida solo al abrir la cotización. Antes era un botón «Verificar precio» que
   * había que pulsar antes de poder reservar: un paso que el vendedor no necesita decidir, porque
   * la reserva no puede salir sin él. Ahora corre en segundo plano, y si al reservar ya es viejo o
   * falló, el propio clic en «Crear reserva» lo repite.
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
   * El clic en «Crear reserva». Si el precio no está confirmado hace poco, se revalida primero y
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
          : 'La aerolínea cambió la tarifa mientras se creaba la reserva y no se reservó nada. Vuelve a pulsar «Crear reserva».',
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
    setBookingResult({
      outcome,
      pnr: data.providerResult?.pnr,
      error:
        outcome === 'CONFIRMED' || seatNotices.length > 0
          ? undefined
          : humanizeBookingError(
              describeIssues(data.providerResult?.issues) ??
                createOrderErrorMessage(data) ??
                ERROR_DESCONOCIDO,
            ),
      ...(seatNotices.length > 0 ? { seatNotices } : {}),
    });
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

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-5 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 rounded bg-[var(--color-surface-muted)]" />
          <div className="h-64 rounded-xl bg-[var(--color-surface-muted)]" />
          <div className="h-48 rounded-xl bg-[var(--color-surface-muted)]" />
        </div>
      </div>
    );
  }

  if (error || !quotation) {
    return (
      <div className="mx-auto max-w-6xl px-5 py-8">
        <p className="text-sm text-[var(--color-danger)]">{error || 'Cotización no encontrada.'}</p>
        <Link
          href="/cotizaciones"
          className="mt-4 inline-flex items-center gap-1 text-sm text-[var(--color-primary)] hover:underline"
        >
          <ArrowLeft className="size-4" /> Volver a búsqueda
        </Link>
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
  const totalPax =
    searchCriteria.paxCount.adults +
    searchCriteria.paxCount.children +
    searchCriteria.paxCount.infants;
  const fareComponents = fareComponentsForDisplay(selectedOffer);
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

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/cotizaciones"
            className="flex size-8 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-fg)]">
              Cotización #{quotation.quoteNumber}
            </h1>
            <p className="text-xs text-[var(--color-fg-muted)]">
              Creada {formatDate(quotation.createdAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${statusInfo.className}`}>
            {statusInfo.label}
          </span>
          {isExpired && quotation.status === 'draft' && (
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
              Precio expirado
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* Main column */}
        <div className="space-y-5">
          {/* Flight details */}
          <Card>
            <CardContent className="p-5">
              <div className="mb-4 flex items-center gap-2">
                <Plane className="size-4 text-[var(--color-primary)]" />
                <h2 className="text-sm font-semibold text-[var(--color-fg)]">Vuelo</h2>
                {fareComponents.length === 0 && selectedOffer.fareFamily && (
                  <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
                    {selectedOffer.fareFamily.name}
                  </span>
                )}
                {testFare ? <TestContentBadge /> : null}
              </div>

              <div className="space-y-4">
                {selectedOffer.itineraries?.map((it, idx) => {
                  const first = it.segments[0]!;
                  const last = it.segments[it.segments.length - 1]!;
                  const stopAirports = it.segments.slice(0, -1).map((s) => s.destination);
                  const faresForLeg = fareComponents.filter((component) =>
                    component.itineraryIndexes.includes(idx),
                  );
                  return (
                    <div key={idx} className="rounded-lg border border-[var(--color-border)] p-4">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg-subtle)]">
                            {selectedOffer.itineraries!.length > 1
                              ? idx === 0
                                ? 'Ida'
                                : 'Vuelta'
                              : 'Vuelo'}
                          </span>
                          <span className="text-[10px] text-[var(--color-fg-subtle)]">
                            {first.carrier} {first.flightNumber}
                          </span>
                        </div>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            it.stops === 0
                              ? 'bg-green-50 text-green-700'
                              : 'bg-amber-50 text-amber-700'
                          }`}
                        >
                          {it.stops === 0
                            ? 'Directo'
                            : `${it.stops} escala${it.stops > 1 ? 's' : ''}${
                                stopAirports.length ? ` · ${stopAirports.join(', ')}` : ''
                              }`}
                        </span>
                      </div>
                      <div className="flex items-center gap-4">
                        <div>
                          <p className="font-mono text-base font-semibold tabular-nums text-[var(--color-fg)]">
                            {flightTime(first.departureAt)}
                          </p>
                          <p className="text-xs text-[var(--color-fg-muted)]">{first.origin}</p>
                          <p className="text-[10px] text-[var(--color-fg-subtle)]">
                            {flightDate(first.departureAt)}
                          </p>
                        </div>
                        <div className="flex flex-1 flex-col items-center gap-0.5">
                          <p className="text-[10px] text-[var(--color-fg-subtle)]">
                            {formatDuration(it.totalDurationMinutes)}
                          </p>
                          <div className="flex w-full items-center">
                            <span className="h-px flex-1 bg-[var(--color-border-strong)]" />
                            <ArrowRight className="mx-1 size-3 text-[var(--color-fg-subtle)]" />
                            <span className="h-px flex-1 bg-[var(--color-border-strong)]" />
                          </div>
                          <p className="text-[10px] text-[var(--color-fg-subtle)]">
                            {it.stops === 0
                              ? 'Directo'
                              : `${it.stops} escala${it.stops > 1 ? 's' : ''}`}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono text-base font-semibold tabular-nums text-[var(--color-fg)]">
                            {flightTime(last.arrivalAt)}
                          </p>
                          <p className="text-xs text-[var(--color-fg-muted)]">{last.destination}</p>
                          <p className="text-[10px] text-[var(--color-fg-subtle)]">
                            {flightDate(last.arrivalAt)}
                          </p>
                        </div>
                      </div>

                      {faresForLeg.length > 0 && (
                        <div className="mt-3 space-y-2 border-t border-[var(--color-border)] pt-3">
                          {faresForLeg.map((fare) => (
                            <div
                              key={fare.key}
                              className="rounded-md bg-[var(--color-surface-muted)] px-2.5 py-2 text-xs"
                            >
                              <p className="font-semibold text-[var(--color-fg)]">
                                {fare.name}{' '}
                                <span className="font-normal text-[var(--color-fg-muted)]">
                                  · {fare.route}
                                </span>
                              </p>
                              {fare.details.length > 0 && (
                                <p className="mt-0.5 text-[10px] text-[var(--color-fg-subtle)]">
                                  {fare.details.join(' · ')}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Detalle de tramos y escalas */}
                      {it.stops > 0 && (
                        <div className="mt-3 space-y-2 border-t border-[var(--color-border)] pt-3">
                          {it.segments.map((seg, sIdx) => {
                            const next = it.segments[sIdx + 1];
                            const layoverMin = next
                              ? Math.max(
                                  0,
                                  Math.round(
                                    (new Date(next.departureAt).getTime() -
                                      new Date(seg.arrivalAt).getTime()) /
                                      60000,
                                  ),
                                )
                              : null;
                            return (
                              <div key={sIdx}>
                                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-mono font-medium text-[var(--color-fg)]">
                                      {seg.origin}
                                    </span>
                                    <span className="text-[var(--color-fg-subtle)]">
                                      {flightTime(seg.departureAt)}
                                    </span>
                                    <ArrowRight className="size-3 text-[var(--color-fg-subtle)]" />
                                    <span className="font-mono font-medium text-[var(--color-fg)]">
                                      {seg.destination}
                                    </span>
                                    <span className="text-[var(--color-fg-subtle)]">
                                      {flightTime(seg.arrivalAt)}
                                    </span>
                                  </div>
                                  <span className="text-[10px] text-[var(--color-fg-subtle)]">
                                    {seg.carrier} {seg.flightNumber} ·{' '}
                                    {formatDuration(seg.durationMinutes)}
                                  </span>
                                </div>
                                {layoverMin != null && (
                                  <div className="my-1 inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-800">
                                    <Clock className="size-3" />
                                    Escala en {seg.destination} · {formatDuration(layoverMin)}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Baggage & policies */}
              {(hasAnyBaggageInfo(selectedOffer.baggage) || selectedOffer.policies) && (
                <div className="mt-4 grid grid-cols-2 gap-3 border-t border-[var(--color-border)] pt-4 sm:grid-cols-4">
                  {hasAnyBaggageInfo(selectedOffer.baggage) && (
                    <>
                      <div className="text-center">
                        <p className="text-[10px] uppercase text-[var(--color-fg-subtle)]">
                          Carry-on
                        </p>
                        {/* Un `—` se lee como «nada»: el vendedor tiene que poder distinguir que
                            el proveedor no informó de que la tarifa no lo incluye. */}
                        <p className="text-sm font-medium text-[var(--color-fg)]">
                          {describeBaggage(selectedOffer.baggage?.carryOn)}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] uppercase text-[var(--color-fg-subtle)]">
                          Maleta
                        </p>
                        <p className="text-sm font-medium text-[var(--color-fg)]">
                          {describeBaggage(selectedOffer.baggage?.checked)}
                        </p>
                      </div>
                    </>
                  )}
                  {selectedOffer.policies && (
                    <>
                      <div className="text-center">
                        <p className="text-[10px] uppercase text-[var(--color-fg-subtle)]">
                          Cambios
                        </p>
                        <p className="text-sm font-medium text-[var(--color-fg)]">
                          {describePolicy(
                            policyState(selectedOffer.policies, 'change'),
                            'change',
                            formatMoney,
                          )}
                        </p>
                      </div>
                      <div className="text-center">
                        <p className="text-[10px] uppercase text-[var(--color-fg-subtle)]">
                          Reembolso
                        </p>
                        <p className="text-sm font-medium text-[var(--color-fg)]">
                          {describePolicy(
                            policyState(selectedOffer.policies, 'refund'),
                            'refund',
                            formatMoney,
                          )}
                        </p>
                      </div>
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Con la reserva ya creada, «Facturación» queda aquí para enviar la cotización. */}
          {!shouldShowBookingForm(bookingResult) && (
            <Card>
              <CardContent className="p-5">{renderBilling(false)}</CardContent>
            </Card>
          )}
        </div>

        {/* Right sidebar */}
        <div className="space-y-5">
          {/* Price summary */}
          <Card>
            <CardContent className="p-5">
              <h3 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">Resumen</h3>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
                  <span>Ruta</span>
                  <span className="font-medium text-[var(--color-fg)]">
                    {searchCriteria.origin} → {searchCriteria.destination}
                    {searchCriteria.tripType === 'roundtrip' ? ' (ida y vuelta)' : ''}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
                  <span>Pasajeros</span>
                  <span className="font-medium text-[var(--color-fg)]">{totalPax}</span>
                </div>
                <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
                  <span>Cabina</span>
                  <span className="font-medium capitalize text-[var(--color-fg)]">
                    {searchCriteria.cabin.replace('_', ' ')}
                  </span>
                </div>
              </div>

              <div className="my-3 border-t border-[var(--color-border)]" />

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
                  <span>Base</span>
                  <span>{formatMoney(venta.baseMinor, venta.currency)}</span>
                </div>
                <div className="flex items-center justify-between text-xs text-[var(--color-fg-muted)]">
                  <span>Impuestos</span>
                  <span>{formatMoney(venta.taxesMinor, venta.currency)}</span>
                </div>
                <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-2 text-sm font-semibold text-[var(--color-fg)]">
                  <span>Total</span>
                  <span className="font-mono tabular-nums">
                    {formatMoney(venta.sellMinor, venta.currency)}
                  </span>
                </div>
                {/* Sólo para el vendedor: lo que paga su agencia y lo que gana. El neto del
                    proveedor no se enseña (ver lib/sale-breakdown.ts). */}
                {venta.ownMarginMinor !== undefined && venta.costMinor !== undefined && (
                  <div className="flex items-center justify-between pt-1 text-[11px] text-[var(--color-fg-subtle)]">
                    <span>Tu costo {formatMoney(venta.costMinor, venta.currency)}</span>
                    <span>Margen {formatMoney(venta.ownMarginMinor, venta.currency)}</span>
                  </div>
                )}
              </div>

              <div className="mt-3 space-y-1.5 text-[11px]">
                <TicketingDeadlineBadge raw={quotation.selectedOffer.provider.raw} />
                <p className="flex items-center gap-1.5 text-[var(--color-fg-subtle)]">
                  {priceFromProvider
                    ? `${isExpired ? 'Precio vencido el' : 'Precio garantizado hasta el'} ${new Date(
                        quotation.expiresAt,
                      ).toLocaleString('es-CO', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}`
                    : 'Precio sujeto a revalidación al reservar'}
                </p>
                {/* Región viva siempre presente: el lector de pantalla anuncia el cambio de estado
                    aunque la revalidación termine mientras se mira otra parte de la página. */}
                <div role="status" aria-live="polite" className="min-h-4">
                  {priceLine && (
                    <p
                      className={`flex items-start gap-1.5 ${
                        priceLine.tone === 'error'
                          ? 'text-red-700'
                          : priceLine.tone === 'warning'
                            ? 'text-amber-700'
                            : priceLine.tone === 'ok'
                              ? 'text-emerald-700'
                              : 'text-[var(--color-fg-muted)]'
                      }`}
                    >
                      {priceLine.tone === 'pending' ? (
                        <RefreshCw
                          aria-hidden="true"
                          className="mt-px size-3 shrink-0 animate-spin"
                        />
                      ) : priceLine.tone === 'ok' ? (
                        <CheckCircle2 aria-hidden="true" className="mt-px size-3 shrink-0" />
                      ) : null}
                      <span>
                        {priceLine.text}
                        {priceLine.retry && (
                          <>
                            {' '}
                            <button
                              type="button"
                              onClick={() => void revalidatePrice()}
                              className="font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40"
                            >
                              Reintentar
                            </button>
                          </>
                        )}
                      </span>
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Actions */}
          <Card>
            <CardContent className="space-y-2 p-5">
              <h3 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">Acciones</h3>
              <Button
                variant="secondary"
                size="sm"
                className="w-full gap-2"
                disabled={!isValidEmail(contactEmail) || emailSending}
                onClick={() => void handleSendEmail()}
              >
                <Mail className="size-4" /> {emailSending ? 'Enviando…' : 'Enviar por email'}
              </Button>
              {emailResult && (
                <div
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    emailResult.ok
                      ? 'border-green-200 bg-green-50 text-green-800'
                      : 'border-red-200 bg-red-50 text-red-800'
                  }`}
                >
                  {emailResult.text}
                </div>
              )}
              <Button
                variant="secondary"
                size="sm"
                className="w-full gap-2"
                disabled={!contactPhone}
                onClick={() => {
                  if (contactPhone) {
                    const phone = contactPhone.replace(/\D/g, '');
                    const text = `Hola ${contactName || ''}! Te envío cotización #${quotation.quoteNumber}:\n\n✈️ ${searchCriteria.origin} → ${searchCriteria.destination}\n📅 ${searchCriteria.departureDate}\n💰 ${formatMoney(selectedOffer.pricing?.finalMinor ?? selectedOffer.total.amountMinor, selectedOffer.total.currency)}\n🎫 ${fareSummary ?? 'Standard'}\n\n¿Te interesa?`;
                    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`);
                  }
                }}
              >
                <Send className="size-4" /> Enviar por WhatsApp
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="w-full gap-2"
                onClick={handleCopyLink}
              >
                {copied ? (
                  <>
                    <CheckCircle2 className="size-4" /> Copiado
                  </>
                ) : (
                  <>
                    <Copy className="size-4" /> Copiar enlace
                  </>
                )}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="w-full gap-2"
                onClick={() => window.open(`/api/quotations/${quotation.id}/pdf`, '_blank')}
              >
                <Download className="size-4" /> Descargar PDF
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Reserva — ancho completo para dar más espacio a los datos de pasajeros */}
      {bookingResult && (
        <div
          className={`mt-5 rounded-xl border p-4 ${BOOKING_OUTCOME_STYLE[bookingResult.outcome].box}`}
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
            {bookingResult.orderId && (
              <p className="font-mono text-xs text-[var(--color-fg-muted)]">
                Reserva local: {bookingResult.orderId}
              </p>
            )}
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
          </div>
        </div>
      )}

      {crmNote && (
        <p
          role="status"
          className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-fg-muted)]"
        >
          {crmNote}
        </p>
      )}

      {/*
        El formulario vuelve SÓLO si no quedó nada reservado. Con `PARTIAL` o `PENDING` hay PNR
        en el proveedor: reofrecer "reservar" ahí es invitar a crear una segunda reserva encima
        de una que ya existe.
      */}
      {shouldShowBookingForm(bookingResult) && (
        <div className="mt-5">
          {/* Se puede reservar igual —sirve para probar el flujo—, pero quien lo hace lo sabe
              antes de cargar a un pasajero real. */}
          {testFare ? (
            <TestContentNotice className="mb-3">{TEST_BOOKING_NOTICE}</TestContentNotice>
          ) : null}
          {offerSeats ? (
            <Card className="mb-3">
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
            priceChangeTotal={
              priceStatus?.kind === 'acceptance-required' ? priceStatus.newTotal : undefined
            }
            onSubmit={handleCreateOrder}
            onGivenNamesChange={setPassengerNames}
          />
        </div>
      )}
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
