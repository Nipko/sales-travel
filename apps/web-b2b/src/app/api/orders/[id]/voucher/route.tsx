import { Document, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import { NextResponse } from 'next/server';
import { Fragment } from 'react';
import {
  parseHotelContent,
  type HotelContent,
} from '../../../../(app)/hoteles/[hotelKey]/_components/hotel-content-view';
import { hotelRefOf } from '../../../../(app)/reservas/hotel-order-view';
import { api } from '../../../../../lib/api';
import { isValidHex } from '../../../../../lib/brand-tokens';
import { getActiveTenant } from '../../../../../lib/session';
import {
  VOUCHER_NON_REFUNDABLE,
  hotelVoucherOf,
  pdfText,
  type HotelVoucher,
} from './hotel-voucher';

/*
 * El voucher de una reserva de hotel en PDF (docs/tbo/09 PR-6.5; U-15), con la marca de la agencia
 * como la cotización (`api/quotations/[id]/pdf`). Qué lleva y qué no lo decide `hotelVoucherOf`;
 * acá sólo se dibuja.
 *
 * Lleva los nombres de los huéspedes: no se cachea en ningún intermediario y no se registra nada
 * de su contenido.
 */

interface TenantBranding {
  logoUrl: string | null;
  primaryColor: string | null;
  commercialName: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
}

const FALLBACK_BRAND_COLOR = '#2563eb';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const s = StyleSheet.create({
  page: { padding: 40, paddingBottom: 64, fontFamily: 'Helvetica', fontSize: 10, color: '#1a1a1a' },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  brand: { fontSize: 18, fontFamily: 'Helvetica-Bold' },
  subtitle: { fontSize: 9, color: '#6b7280', marginTop: 2 },
  number: { fontSize: 12, fontFamily: 'Helvetica-Bold', textAlign: 'right' },
  issued: { fontSize: 9, color: '#6b7280', textAlign: 'right', marginTop: 2 },
  keyBox: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 4,
    marginBottom: 18,
  },
  keyCell: { flex: 1, padding: 10 },
  keyCellDivider: { borderLeftWidth: 1, borderLeftColor: '#e5e7eb' },
  keyLabel: { fontSize: 8, color: '#6b7280', marginBottom: 3 },
  keyValue: { fontSize: 12, fontFamily: 'Helvetica-Bold' },
  keyHint: { fontSize: 7.5, color: '#6b7280', marginTop: 3 },
  section: { marginBottom: 16 },
  gap: { height: 12 },
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 6,
    paddingBottom: 3,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  hotelName: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginBottom: 2 },
  row: { flexDirection: 'row', marginBottom: 3 },
  label: { width: 110, color: '#6b7280', fontSize: 9 },
  value: { flex: 1, fontSize: 10 },
  room: { backgroundColor: '#f9fafb', borderRadius: 4, padding: 10, marginBottom: 6 },
  roomTitle: { fontSize: 10, fontFamily: 'Helvetica-Bold' },
  muted: { fontSize: 8.5, color: '#6b7280' },
  guest: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  atHotel: {
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fcd34d',
    borderRadius: 4,
    padding: 10,
    marginBottom: 16,
  },
  atHotelTitle: { fontSize: 10, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  nonRefundable: {
    backgroundColor: '#fffbeb',
    borderWidth: 1.5,
    borderColor: '#f59e0b',
    borderRadius: 4,
    padding: 10,
    marginBottom: 16,
  },
  nonRefundableTitle: { fontSize: 11, fontFamily: 'Helvetica-Bold', marginBottom: 3 },
  tier: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  groupTitle: { fontSize: 9, fontFamily: 'Helvetica-Bold', marginTop: 4, marginBottom: 2 },
  paragraph: { fontSize: 8.5, color: '#374151', marginBottom: 2, lineHeight: 1.35 },
  footer: {
    position: 'absolute',
    bottom: 28,
    left: 40,
    right: 40,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  footerText: { fontSize: 8, color: '#9ca3af' },
});

function issuedAt(): string {
  return new Date().toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.row}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.value}>{pdfText(value)}</Text>
    </View>
  );
}

function HotelVoucherPDF({ v, branding }: { v: HotelVoucher; branding: TenantBranding | null }) {
  const color = isValidHex(branding?.primaryColor) ? branding.primaryColor : FALLBACK_BRAND_COLOR;
  const agencyName = branding?.commercialName ?? 'PlaneTour';
  const agencyContact = [branding?.supportPhone, branding?.supportEmail, branding?.websiteUrl]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .join(' · ');
  const hotel = v.hotel;

  return (
    <Document title={`Voucher de hotel ${v.orderNumber}`}>
      <Page size="A4" style={s.page}>
        <View style={s.header} fixed>
          <View>
            <Text style={[s.brand, { color }]}>{agencyName}</Text>
            <Text style={s.subtitle}>Voucher de hotel</Text>
          </View>
          <View>
            <Text style={s.number}>Reserva N.º {v.orderNumber}</Text>
            <Text style={s.issued}>Emitido el {issuedAt()}</Text>
          </View>
        </View>

        <View style={s.keyBox}>
          <View style={s.keyCell}>
            <Text style={s.keyLabel}>Localizador del proveedor</Text>
            <Text style={s.keyValue}>{v.locator}</Text>
          </View>
          <View style={[s.keyCell, s.keyCellDivider]}>
            <Text style={s.keyLabel}>Confirmación del hotel</Text>
            <Text style={s.keyValue}>{v.hcn.label}</Text>
            {v.hcn.value === undefined ? (
              <Text style={s.keyHint}>
                El hotel la asigna más cerca de la fecha de entrada. El localizador del proveedor
                identifica la reserva mientras tanto.
              </Text>
            ) : null}
          </View>
          <View style={[s.keyCell, s.keyCellDivider]}>
            <Text style={s.keyLabel}>Estado</Text>
            <Text style={s.keyValue}>{v.statusLabel}</Text>
          </View>
        </View>

        <View style={s.section} wrap={false}>
          <Text style={s.sectionTitle}>Hotel</Text>
          {hotel.name ? (
            <Text style={s.hotelName}>
              {pdfText(hotel.name)}
              {hotel.stars ? `  ·  ${hotel.stars} estrellas` : ''}
            </Text>
          ) : null}
          {hotel.address ? <Line label="Dirección" value={hotel.address} /> : null}
          {hotel.phone ? <Line label="Teléfono" value={hotel.phone} /> : null}
          {v.stay ? (
            <>
              <Line
                label="Entrada"
                value={`${v.stay.checkinLabel}${hotel.checkInTime ? `, desde las ${hotel.checkInTime}` : ''}`}
              />
              <Line
                label="Salida"
                value={`${v.stay.checkoutLabel}${hotel.checkOutTime ? `, hasta las ${hotel.checkOutTime}` : ''}`}
              />
              <Line label="Estadía" value={v.stay.summary} />
            </>
          ) : null}
          {v.board ? <Line label="Régimen" value={v.board} /> : null}
        </View>

        {v.nonRefundable ? (
          <View style={s.nonRefundable} wrap={false}>
            <Text style={s.nonRefundableTitle}>{VOUCHER_NON_REFUNDABLE.title.toUpperCase()}</Text>
            <Text>{VOUCHER_NON_REFUNDABLE.detail}</Text>
          </View>
        ) : null}

        {/*
          De acá en adelante, títulos y contenido van como hijos directos de la página: el corte de
          página de @react-pdf sólo respeta `minPresenceAhead` entre hermanos de la página, y un
          `wrap={false}` anidado se comprime en lugar de pasar a la hoja siguiente.
        */}
        <Text style={s.sectionTitle} minPresenceAhead={90}>
          Habitaciones y huéspedes
        </Text>
        {v.rooms.map((room) => (
          <View key={room.number} style={s.room} wrap={false}>
            <Text style={s.roomTitle}>
              Habitación {room.number} · {pdfText(room.name)}
            </Text>
            {room.occupancy ? <Text style={s.muted}>{room.occupancy}</Text> : null}
            {room.guests.map((g, i) => (
              <View key={i} style={s.guest}>
                <View>
                  <Text>{g.name}</Text>
                  {g.registeredAs ? (
                    <Text style={s.muted}>En la reserva del hotel: {g.registeredAs}</Text>
                  ) : null}
                </View>
                <Text style={s.muted}>{g.type}</Text>
              </View>
            ))}
          </View>
        ))}
        <View style={s.gap} />

        {v.atHotel.length > 0 ? (
          <View style={s.atHotel} wrap={false}>
            <Text style={s.atHotelTitle}>A pagar en el hotel</Text>
            {v.atHotel.map((c, i) => (
              <View key={i} style={s.tier}>
                <Text>
                  {pdfText(c.description)}
                  {c.room === undefined ? '' : ` (habitación ${c.room})`}
                </Text>
                <Text>{c.amount}</Text>
              </View>
            ))}
            <Text style={[s.muted, { marginTop: 4 }]}>
              No están incluidos en el precio de la reserva: se pagan en el hotel, en su moneda.
            </Text>
          </View>
        ) : null}

        {v.included.length > 0 ? (
          <View style={s.section} wrap={false}>
            <Text style={s.sectionTitle}>Incluido en la reserva</Text>
            {v.included.map((item, i) => (
              <Text key={i} style={s.paragraph}>
                {pdfText(item)}
              </Text>
            ))}
          </View>
        ) : null}

        {v.policy ? (
          <>
            <Text style={s.sectionTitle} minPresenceAhead={40}>
              Política de cancelación
            </Text>
            <Text style={{ marginBottom: 4 }}>{pdfText(v.policy.headline)}</Text>
            {v.policy.tiers.map((t, i) => (
              <View key={i} style={s.tier} wrap={false}>
                <Text style={s.muted}>{pdfText(t.when)}</Text>
                <Text>{pdfText(t.charge)}</Text>
              </View>
            ))}
            {v.policy.hotelLocalTime ? (
              <Text style={[s.muted, { marginTop: 4 }]}>
                Fechas y horas en hora local del hotel.
              </Text>
            ) : null}
            {v.policy.notes ? <Text style={s.paragraph}>{pdfText(v.policy.notes)}</Text> : null}
            <View style={s.gap} />
          </>
        ) : null}

        {v.conditions.length > 0 ? (
          <Text style={s.sectionTitle} minPresenceAhead={60}>
            Condiciones del hotel
          </Text>
        ) : null}
        {v.conditions.map((group) => (
          <Fragment key={group.category}>
            <Text style={s.groupTitle} minPresenceAhead={30}>
              {group.label}
            </Text>
            {group.items.map((item, i) => (
              <Text key={i} style={s.paragraph}>
                {pdfText(item)}
              </Text>
            ))}
          </Fragment>
        ))}

        <View style={s.footer} fixed>
          <Text style={s.footerText}>Presentar en la recepción del hotel.</Text>
          <Text style={s.footerText}>
            {agencyName}
            {agencyContact ? ` · ${agencyContact}` : ''}
          </Text>
        </View>
      </Page>
    </Document>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** La ficha del hotel, si se consigue: el voucher sale igual sin ella. */
async function hotelContentOf(order: Record<string, unknown>): Promise<HotelContent | undefined> {
  const ref = hotelRefOf({
    ...(typeof order['provider'] === 'string' ? { provider: order['provider'] } : {}),
    searchCriteria: order['searchCriteria'],
    selectedOffer: order['selectedOffer'],
  });
  if (ref === undefined) return undefined;
  const res = await api<unknown>(
    `/hotels/content/${encodeURIComponent(ref.provider)}/${encodeURIComponent(ref.hotelId)}?lang=es`,
  );
  return res.ok ? parseHotelContent(res.data, ref) : undefined;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'No encontramos la reserva.' }, { status: 404 });
  }
  const tenantId = await getActiveTenant();

  // El branding EFECTIVO, como en la cotización: el propio o el heredado de su red.
  const [res, brandingRes] = await Promise.all([
    api<{ order?: unknown }>(`/orders/${id}`),
    tenantId
      ? api<TenantBranding>(`/tenants/${tenantId}/branding`).catch(() => null)
      : Promise.resolve(null),
  ]);
  if (!res.ok) {
    return NextResponse.json({ error: res.error.message }, { status: res.error.status });
  }

  const order = res.data.order;
  // Primero si hay voucher: la ficha puede salir al proveedor, y no se gasta para nada.
  const gate = hotelVoucherOf(order);
  if (!gate.ok || !isRecord(order)) {
    const failure = gate.ok ? { status: 404, message: 'No encontramos la reserva.' } : gate;
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }

  const content = await hotelContentOf(order).catch(() => undefined);
  const result = hotelVoucherOf(order, content);
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status });
  }

  const branding = brandingRes?.ok ? brandingRes.data : null;
  const buffer = await renderToBuffer(<HotelVoucherPDF v={result.voucher} branding={branding} />);

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="voucher-hotel-${result.voucher.orderNumber}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
