import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import { NextResponse } from 'next/server';
import { api } from '../../../../../lib/api';
import { describeBaggage, hasAnyBaggageInfo } from '../../../../../lib/baggage';
import { isValidHex } from '../../../../../lib/brand-tokens';
import { getActiveTenant } from '../../../../../lib/session';

/**
 * Identidad efectiva de la agencia que emite la cotización.
 *
 * Este documento lo recibe el CLIENTE FINAL, así que tiene que llevar la marca de SU
 * agencia. Antes decía literalmente "PlaneTour" con un azul #2563eb fijo: cada agencia
 * de la red le mandaba a su cliente un PDF con la marca del consolidador —y encima con
 * un color que ni siquiera era el de la plataforma, cuyo primario es naranja.
 */
interface TenantBranding {
  logoUrl: string | null;
  primaryColor: string | null;
  commercialName: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
}

/** Azul de la plataforma, sólo como último recurso si el tenant no tiene marca. */
const FALLBACK_BRAND_COLOR = '#2563eb';

function brandColor(branding: TenantBranding | null): string {
  return isValidHex(branding?.primaryColor) ? branding.primaryColor : FALLBACK_BRAND_COLOR;
}

interface Quotation {
  id: string;
  quoteNumber: number;
  status: string;
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
  selectedOffer: {
    /** NETO del proveedor. Nunca se le muestra al cliente final. */
    total: { amountMinor: number; currency: string };
    baseFare: { amountMinor: number; currency: string };
    taxes: { amountMinor: number; currency: string };
    /**
     * Pricing waterfall del consolidador. Ausente si el tenant no tiene reglas de markup
     * aplicables (SearchService.withPricing devuelve la oferta sin tocar), en cuyo caso
     * el precio de venta coincide con el neto.
     */
    pricing?: {
      costMinor: number;
      finalMinor: number;
      ownMarkupMinor: number;
      currency: string;
    };
    itineraries?: {
      segments: {
        carrier: string;
        flightNumber: string;
        origin: string;
        destination: string;
        departureAt: string;
        arrivalAt: string;
      }[];
      totalDurationMinutes: number;
      stops: number;
    }[];
    fareFamily?: { name: string; cabin: string };
    baggage?: {
      carryOn: { qty: number; weightKg?: number };
      checked: { qty: number; weightKg?: number };
    };
    policies?: { changeable: boolean; refundable: boolean };
  };
  customerName: string | null;
  customerEmail: string | null;
  expiresAt: string;
  createdAt: string;
}

function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-CO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

const s = StyleSheet.create({
  page: { padding: 40, fontFamily: 'Helvetica', fontSize: 10, color: '#1a1a1a' },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 30 },
  brand: { fontSize: 18, fontFamily: 'Helvetica-Bold', color: '#2563eb' },
  subtitle: { fontSize: 9, color: '#6b7280', marginTop: 2 },
  quoteNumber: { fontSize: 12, fontFamily: 'Helvetica-Bold', textAlign: 'right' },
  quoteDate: { fontSize: 9, color: '#6b7280', textAlign: 'right', marginTop: 2 },
  section: { marginBottom: 20 },
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 8,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  row: { flexDirection: 'row', marginBottom: 4 },
  label: { width: 120, color: '#6b7280', fontSize: 9 },
  value: { flex: 1, fontSize: 10 },
  flightCard: {
    backgroundColor: '#f9fafb',
    borderRadius: 4,
    padding: 12,
    marginBottom: 8,
  },
  flightHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  flightRoute: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  timeBlock: {},
  timeText: { fontSize: 14, fontFamily: 'Helvetica-Bold' },
  airportCode: { fontSize: 9, color: '#6b7280', marginTop: 1 },
  durationBlock: { alignItems: 'center' },
  durationText: { fontSize: 8, color: '#6b7280' },
  line: { width: 60, height: 1, backgroundColor: '#d1d5db', marginVertical: 2 },
  stopsText: { fontSize: 8, color: '#6b7280' },
  priceSection: {
    backgroundColor: '#eff6ff',
    borderRadius: 4,
    padding: 12,
    marginTop: 10,
  },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 },
  priceLabel: { fontSize: 9, color: '#6b7280' },
  priceValue: { fontSize: 9 },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#bfdbfe',
    paddingTop: 6,
    marginTop: 4,
  },
  totalLabel: { fontSize: 11, fontFamily: 'Helvetica-Bold' },
  totalValue: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: '#2563eb' },
  footer: {
    position: 'absolute',
    bottom: 30,
    left: 40,
    right: 40,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerText: { fontSize: 8, color: '#9ca3af' },
  badge: {
    backgroundColor: '#dbeafe',
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 8,
    color: '#1d4ed8',
  },
});

function QuotationPDF({ q, branding }: { q: Quotation; branding: TenantBranding | null }) {
  // Los estilos se crean a nivel de módulo, así que el color de marca —que depende del
  // tenant— se superpone en línea sobre los pocos elementos que lo llevan.
  const color = brandColor(branding);
  const agencyName = branding?.commercialName ?? 'PlaneTour';
  const agencyContact =
    branding?.websiteUrl ?? branding?.supportEmail ?? branding?.supportPhone ?? 'planetour.cloud';

  const { searchCriteria, selectedOffer } = q;
  const totalPax =
    searchCriteria.paxCount.adults +
    searchCriteria.paxCount.children +
    searchCriteria.paxCount.infants;

  // Este documento lo recibe el CLIENTE FINAL, así que muestra el precio de VENTA, no el
  // neto del proveedor. El markup se absorbe en la tarifa base para que las tres líneas
  // sigan cuadrando y el cliente no pueda inferir el margen de su agencia restando.
  // Sin reglas de markup aplicables, `pricing` no existe y venta == neto.
  const netMinor = selectedOffer.total.amountMinor;
  const finalMinor = selectedOffer.pricing?.finalMinor ?? netMinor;
  const displayBaseFareMinor = selectedOffer.baseFare.amountMinor + (finalMinor - netMinor);
  const currency = selectedOffer.total.currency;

  return (
    <Document>
      <Page size="A4" style={s.page}>
        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={[s.brand, { color }]}>{agencyName}</Text>
            <Text style={s.subtitle}>Cotización de vuelo</Text>
          </View>
          <View>
            <Text style={s.quoteNumber}>#{q.quoteNumber}</Text>
            <Text style={s.quoteDate}>{formatDate(q.createdAt)}</Text>
          </View>
        </View>

        {/* Customer */}
        {q.customerName && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Cliente</Text>
            <View style={s.row}>
              <Text style={s.label}>Nombre</Text>
              <Text style={s.value}>{q.customerName}</Text>
            </View>
            {q.customerEmail && (
              <View style={s.row}>
                <Text style={s.label}>Email</Text>
                <Text style={s.value}>{q.customerEmail}</Text>
              </View>
            )}
          </View>
        )}

        {/* Flight details */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Detalle del vuelo</Text>
          <View style={s.row}>
            <Text style={s.label}>Ruta</Text>
            <Text style={s.value}>
              {searchCriteria.origin} → {searchCriteria.destination}
              {searchCriteria.tripType === 'roundtrip' ? ' (ida y vuelta)' : ' (solo ida)'}
            </Text>
          </View>
          <View style={s.row}>
            <Text style={s.label}>Pasajeros</Text>
            <Text style={s.value}>
              {searchCriteria.paxCount.adults} adulto{searchCriteria.paxCount.adults > 1 ? 's' : ''}
              {searchCriteria.paxCount.children > 0
                ? `, ${searchCriteria.paxCount.children} niño${searchCriteria.paxCount.children > 1 ? 's' : ''}`
                : ''}
              {searchCriteria.paxCount.infants > 0
                ? `, ${searchCriteria.paxCount.infants} infante${searchCriteria.paxCount.infants > 1 ? 's' : ''}`
                : ''}
            </Text>
          </View>
          {selectedOffer.fareFamily && (
            <View style={s.row}>
              <Text style={s.label}>Tarifa</Text>
              <Text style={s.value}>{selectedOffer.fareFamily.name}</Text>
            </View>
          )}

          {/* Itineraries */}
          {selectedOffer.itineraries?.map((it, idx) => {
            const first = it.segments[0]!;
            const last = it.segments[it.segments.length - 1]!;
            return (
              <View key={idx} style={s.flightCard}>
                <View style={s.flightHeader}>
                  <Text style={s.badge}>
                    {selectedOffer.itineraries!.length > 1
                      ? idx === 0
                        ? 'IDA'
                        : 'VUELTA'
                      : 'VUELO'}
                  </Text>
                  <Text style={{ fontSize: 9, color: '#6b7280' }}>
                    {first.carrier} {first.flightNumber} ·{' '}
                    {it.stops === 0 ? 'Directo' : `${it.stops} escala${it.stops > 1 ? 's' : ''}`}
                  </Text>
                </View>
                <View style={s.flightRoute}>
                  <View style={s.timeBlock}>
                    <Text style={s.timeText}>{formatTime(first.departureAt)}</Text>
                    <Text style={s.airportCode}>{first.origin}</Text>
                    <Text style={{ fontSize: 8, color: '#9ca3af' }}>
                      {formatDate(first.departureAt)}
                    </Text>
                  </View>
                  <View style={s.durationBlock}>
                    <Text style={s.durationText}>{formatDuration(it.totalDurationMinutes)}</Text>
                    <View style={s.line} />
                    <Text style={s.stopsText}>→</Text>
                  </View>
                  <View style={[s.timeBlock, { alignItems: 'flex-end' }]}>
                    <Text style={s.timeText}>{formatTime(last.arrivalAt)}</Text>
                    <Text style={s.airportCode}>{last.destination}</Text>
                    <Text style={{ fontSize: 8, color: '#9ca3af' }}>
                      {formatDate(last.arrivalAt)}
                    </Text>
                  </View>
                </View>
              </View>
            );
          })}
        </View>

        {/* Includes */}
        {(hasAnyBaggageInfo(selectedOffer.baggage) || selectedOffer.policies) && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Incluye</Text>
            {/*
              Este PDF lo recibe el CLIENTE FINAL, así que acá está la diferencia entre informar
              y prometer. Antes se pintaba «No incluido» siempre que la cantidad no fuera mayor
              que cero — incluidos los casos en que el proveedor sencillamente no lo informó—: es
              decirle por escrito a un pasajero que su tarifa no lleva equipaje de mano sin
              saberlo. `describeBaggage` distingue «No informado» de «No incluye».
            */}
            {hasAnyBaggageInfo(selectedOffer.baggage) && (
              <>
                <View style={s.row}>
                  <Text style={s.label}>Carry-on</Text>
                  <Text style={s.value}>{describeBaggage(selectedOffer.baggage?.carryOn)}</Text>
                </View>
                <View style={s.row}>
                  <Text style={s.label}>Maleta facturada</Text>
                  <Text style={s.value}>{describeBaggage(selectedOffer.baggage?.checked)}</Text>
                </View>
              </>
            )}
            {selectedOffer.policies && (
              <>
                <View style={s.row}>
                  <Text style={s.label}>Cambios</Text>
                  <Text style={s.value}>
                    {selectedOffer.policies.changeable ? 'Permitidos' : 'No permitidos'}
                  </Text>
                </View>
                <View style={s.row}>
                  <Text style={s.label}>Reembolso</Text>
                  <Text style={s.value}>
                    {selectedOffer.policies.refundable ? 'Reembolsable' : 'No reembolsable'}
                  </Text>
                </View>
              </>
            )}
          </View>
        )}

        {/* Price */}
        <View style={s.priceSection}>
          <View style={s.priceRow}>
            <Text style={s.priceLabel}>Tarifa base ({totalPax} pax)</Text>
            <Text style={s.priceValue}>{formatMoney(displayBaseFareMinor, currency)}</Text>
          </View>
          <View style={s.priceRow}>
            <Text style={s.priceLabel}>Impuestos y tasas</Text>
            <Text style={s.priceValue}>
              {formatMoney(selectedOffer.taxes.amountMinor, selectedOffer.taxes.currency)}
            </Text>
          </View>
          <View style={s.totalRow}>
            <Text style={s.totalLabel}>Total</Text>
            <Text style={[s.totalValue, { color }]}>{formatMoney(finalMinor, currency)}</Text>
          </View>
        </View>

        {/* Footer */}
        <View style={s.footer}>
          <Text style={s.footerText}>
            Vigente hasta{' '}
            {new Date(q.expiresAt).toLocaleDateString('es-CO', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
          <Text style={s.footerText}>
            Generado por {agencyName} · {agencyContact}
          </Text>
        </View>
      </Page>
    </Document>
  );
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenantId = await getActiveTenant();

  // El branding EFECTIVO: si la agencia no configuró marca propia, hereda la de su
  // agencia padre y en última instancia la del consolidador (resolve_tenant_branding).
  const [res, brandingRes] = await Promise.all([
    api<{ quotation: Quotation }>(`/quotations/${id}`),
    tenantId
      ? api<TenantBranding>(`/tenants/${tenantId}/branding`).catch(() => null)
      : Promise.resolve(null),
  ]);

  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }

  const branding = brandingRes?.ok ? brandingRes.data : null;
  const q = res.data.quotation;
  const buffer = await renderToBuffer(<QuotationPDF q={q} branding={branding} />);

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="cotizacion-${q.quoteNumber}.pdf"`,
    },
  });
}
