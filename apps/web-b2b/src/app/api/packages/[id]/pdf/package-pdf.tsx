import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { AgencyBranding } from '../../../../(app)/paquetes/_components/agency-branding';
import { buildItinerary } from '../../../../(app)/paquetes/_components/package-model';
import {
  boardText,
  excludedList,
  formatLongDate,
  formatShortDate,
  includedList,
  placeName,
  travelersText,
  type QuoteModel,
} from '../../../../(app)/paquetes/_components/package-quote';
import { formatMoney } from '../../../../../lib/flight-format';
import { hotelImageSourceOf, sniffImageType } from '../../../../../lib/hotel-image-proxy';

/*
 * La cotización del paquete en PDF, con la marca de la agencia y las fotos del hotel y del auto.
 *
 * Las fotos se bajan ANTES de componer, con plazo y tope de tamaño, y sólo de orígenes conocidos:
 * las del hotel por la misma validación del proxy (nunca una URL arbitraria del snapshot) y las del
 * auto sólo de la CDN de la rentadora. Una que falle o no sea JPEG/PNG (lo único que dibuja
 * react-pdf) se omite: el PDF sale igual.
 */

const IMAGE_TIMEOUT_MS = 6000;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const CAR_IMAGE_HOSTS = /(^|\.)agentcars\.com$/i;

export type PdfImage = { data: Buffer; format: 'png' | 'jpg' };

async function fetchImage(url: string): Promise<PdfImage | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_MAX_BYTES) return undefined;
    const type = sniffImageType(bytes);
    if (type === 'image/jpeg') return { data: Buffer.from(bytes), format: 'jpg' };
    if (type === 'image/png') return { data: Buffer.from(bytes), format: 'png' };
    return undefined;
  } catch {
    return undefined;
  }
}

function hotelSource(proxyPath: string): string | undefined {
  const key = proxyPath.replace(/^\/api\/hotels\/images\//, '');
  return key === proxyPath ? undefined : hotelImageSourceOf(key);
}

function carSource(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.port && CAR_IMAGE_HOSTS.test(u.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}

function logoSource(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.port ? url : undefined;
  } catch {
    return undefined;
  }
}

export interface PdfImages {
  hotel: PdfImage[];
  car?: PdfImage;
  logo?: PdfImage;
}

export async function loadImages(model: QuoteModel, branding: AgencyBranding): Promise<PdfImages> {
  const hotel = model.hotel?.snapshot.kind === 'hotel' ? model.hotel.snapshot : undefined;
  const car = model.car?.snapshot.kind === 'car' ? model.car.snapshot : undefined;
  const hotelUrls = (hotel?.images ?? [])
    .slice(0, 4)
    .map(hotelSource)
    .filter((u): u is string => !!u);
  const carUrl = carSource(car?.imageUrl);
  const logoUrl = logoSource(branding.logoUrl);
  const [hotelImgs, carImg, logoImg] = await Promise.all([
    Promise.all(hotelUrls.map(fetchImage)),
    carUrl ? fetchImage(carUrl) : Promise.resolve(undefined),
    logoUrl ? fetchImage(logoUrl) : Promise.resolve(undefined),
  ]);
  return {
    hotel: hotelImgs.filter((i): i is PdfImage => !!i),
    ...(carImg ? { car: carImg } : {}),
    ...(logoImg ? { logo: logoImg } : {}),
  };
}

const INK = '#1a1d24';
const MUTED = '#5b6170';
const SUBTLE = '#8a90a0';
const LINE = '#e6e8ee';
const SOFT = '#f6f7f9';

const s = StyleSheet.create({
  page: { fontFamily: 'Helvetica', fontSize: 9.5, color: INK, paddingBottom: 48 },
  cover: { height: 250, position: 'relative', backgroundColor: '#1d2a44' },
  coverImg: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: 250,
    objectFit: 'cover',
  },
  coverShade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
    opacity: 0.42,
  },
  coverTop: {
    position: 'absolute',
    top: 24,
    left: 36,
    right: 36,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  brandBox: { backgroundColor: '#fff', borderRadius: 6, paddingVertical: 6, paddingHorizontal: 10 },
  brandName: { fontFamily: 'Helvetica-Bold', fontSize: 11 },
  logo: { height: 22, objectFit: 'contain' },
  ref: { color: '#fff', fontSize: 8.5, opacity: 0.9 },
  coverBottom: { position: 'absolute', left: 36, right: 36, bottom: 26, color: '#fff' },
  kicker: { fontSize: 8, letterSpacing: 1.6, opacity: 0.8, textTransform: 'uppercase' },
  title: { fontFamily: 'Helvetica-Bold', fontSize: 26, marginTop: 4 },
  coverMeta: { fontSize: 10, marginTop: 8, opacity: 0.92 },
  body: { paddingHorizontal: 36, paddingTop: 22 },
  summary: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: LINE,
    marginBottom: 18,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', maxWidth: 290 },
  chip: {
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 10,
    paddingVertical: 3,
    paddingHorizontal: 8,
    marginRight: 5,
    marginBottom: 5,
    fontSize: 8.5,
  },
  totalLabel: { fontSize: 8, color: SUBTLE, textAlign: 'right' },
  total: { fontFamily: 'Helvetica-Bold', fontSize: 20, textAlign: 'right' },
  perPerson: { fontSize: 9, color: MUTED, textAlign: 'right' },
  section: { marginBottom: 18 },
  sectionTitle: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 8.5,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  card: { borderWidth: 1, borderColor: LINE, borderRadius: 6, padding: 10, marginBottom: 6 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between' },
  small: { fontSize: 8.5, color: MUTED },
  tiny: { fontSize: 7.5, color: SUBTLE },
  time: { fontFamily: 'Helvetica-Bold', fontSize: 15 },
  bold: { fontFamily: 'Helvetica-Bold' },
  gallery: { flexDirection: 'row', marginBottom: 8 },
  galleryMain: { width: 300, height: 170, objectFit: 'cover', borderRadius: 6 },
  galleryCol: { marginLeft: 6, flex: 1 },
  gallerySmall: { width: '100%', height: 82, objectFit: 'cover', borderRadius: 6, marginBottom: 6 },
  facts: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },
  fact: { width: '33.3%', paddingRight: 8, marginBottom: 6 },
  carRow: { flexDirection: 'row', alignItems: 'center' },
  carImg: { width: 120, height: 70, objectFit: 'contain', marginRight: 12 },
  dayRow: { flexDirection: 'row', marginBottom: 6 },
  dayLabel: { width: 92, fontFamily: 'Helvetica-Bold', fontSize: 9 },
  twoCol: { flexDirection: 'row' },
  col: { flex: 1, paddingRight: 10 },
  listItem: { fontSize: 9, marginBottom: 3 },
  priceBox: { backgroundColor: SOFT, borderRadius: 8, padding: 14 },
  footer: {
    position: 'absolute',
    bottom: 18,
    left: 36,
    right: 36,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 7.5,
    color: SUBTLE,
    borderTopWidth: 1,
    borderTopColor: LINE,
    paddingTop: 6,
  },
});

function clock(iso: string): string {
  return /T(\d{2}:\d{2})/.exec(iso)?.[1] ?? '';
}

function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export function PackagePDF({
  model,
  branding,
  images,
  quoteRef,
}: {
  model: QuoteModel;
  branding: AgencyBranding;
  images: PdfImages;
  quoteRef: string;
}) {
  const brand = branding.color;
  const money = (n: number) => formatMoney(n, model.currency);
  const flight = model.flight?.snapshot.kind === 'flight' ? model.flight.snapshot : undefined;
  const hotel = model.hotel?.snapshot.kind === 'hotel' ? model.hotel.snapshot : undefined;
  const car = model.car?.snapshot.kind === 'car' ? model.car.snapshot : undefined;
  const days =
    model.start && model.end
      ? buildItinerary(
          model.start,
          model.end,
          model.items.map((i) => i.snapshot),
          placeName,
        )
      : [];
  const [mainImg, ...restImgs] = images.hotel;
  const contact = [branding.supportPhone, branding.supportEmail, branding.websiteUrl]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <Document title={model.title} author={branding.name}>
      <Page size="A4" style={s.page}>
        <View style={s.cover}>
          {mainImg ? <Image src={mainImg} style={s.coverImg} /> : null}
          <View style={[s.coverShade, mainImg ? {} : { backgroundColor: brand, opacity: 0.35 }]} />
          <View style={s.coverTop}>
            <View style={s.brandBox}>
              {images.logo ? (
                <Image src={images.logo} style={s.logo} />
              ) : (
                <Text style={s.brandName}>{branding.name}</Text>
              )}
            </View>
            <Text style={s.ref}>Cotización {quoteRef}</Text>
          </View>
          <View style={s.coverBottom}>
            <Text style={s.kicker}>Tu próximo viaje</Text>
            <Text style={s.title}>{model.title}</Text>
            <Text style={s.coverMeta}>
              {model.start && model.end
                ? `${formatShortDate(model.start)} – ${formatShortDate(model.end)}   ·   `
                : ''}
              {travelersText(model)}
              {model.originCode ? `   ·   Saliendo de ${placeName(model.originCode)}` : ''}
            </Text>
          </View>
        </View>

        <View style={s.body}>
          <View style={s.summary}>
            <View style={s.chips}>
              {flight ? <Text style={s.chip}>Vuelos</Text> : null}
              {hotel ? <Text style={s.chip}>{`${model.nights} noches de hotel`}</Text> : null}
              {car ? <Text style={s.chip}>Auto</Text> : null}
              {model.extras.map((e) =>
                e.snapshot.kind === 'manual' ? (
                  <Text key={e.id} style={s.chip}>
                    {e.snapshot.title}
                  </Text>
                ) : null,
              )}
            </View>
            <View>
              <Text style={s.totalLabel}>Precio total del paquete</Text>
              <Text style={s.total}>{money(model.totalMinor)}</Text>
              {model.travelers > 1 ? (
                <Text style={s.perPerson}>{money(model.perPersonMinor)} por persona</Text>
              ) : null}
            </View>
          </View>

          {flight ? (
            <View style={s.section} wrap={false}>
              <Text style={[s.sectionTitle, { color: brand }]}>Vuelos</Text>
              {flight.itineraries.map((it, i) => {
                const first = it.segments[0];
                const last = it.segments.at(-1);
                if (!first || !last) return null;
                return (
                  <View key={i} style={s.card}>
                    <Text style={s.tiny}>
                      {i === 0 ? 'Ida' : 'Regreso'} · {formatLongDate(first.departureAt)} ·{' '}
                      {it.segments.map((x) => `${x.carrier} ${x.flightNumber}`).join(', ')}
                    </Text>
                    <View style={[s.rowBetween, { marginTop: 4, alignItems: 'center' }]}>
                      <View>
                        <Text style={s.time}>{clock(first.departureAt)}</Text>
                        <Text style={s.small}>
                          {placeName(first.origin)} ({first.origin})
                        </Text>
                      </View>
                      <View style={{ alignItems: 'center' }}>
                        <Text style={s.tiny}>{duration(it.totalDurationMinutes)}</Text>
                        <Text style={s.tiny}>
                          {it.stops === 0
                            ? 'Directo'
                            : `${it.stops} ${it.stops === 1 ? 'escala' : 'escalas'}`}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={s.time}>{clock(last.arrivalAt)}</Text>
                        <Text style={s.small}>
                          {placeName(last.destination)} ({last.destination})
                        </Text>
                      </View>
                    </View>
                  </View>
                );
              })}
              <Text style={s.small}>
                {[
                  flight.fareFamily ? `Tarifa ${flight.fareFamily}` : null,
                  flight.baggage?.carryOn?.qty ? 'Equipaje de mano' : null,
                  flight.baggage?.checked?.qty
                    ? `${flight.baggage.checked.qty} ${flight.baggage.checked.qty === 1 ? 'maleta' : 'maletas'} en bodega`
                    : null,
                ]
                  .filter(Boolean)
                  .join('  ·  ')}
              </Text>
            </View>
          ) : null}

          {hotel ? (
            <View style={s.section}>
              <Text style={[s.sectionTitle, { color: brand }]} minPresenceAhead={180}>
                Alojamiento
              </Text>
              {restImgs.length > 0 && mainImg ? (
                <View style={s.gallery} wrap={false}>
                  <Image src={restImgs[0] ?? mainImg} style={s.galleryMain} />
                  <View style={s.galleryCol}>
                    {restImgs.slice(1, 3).map((img, i) => (
                      <Image key={i} src={img} style={s.gallerySmall} />
                    ))}
                  </View>
                </View>
              ) : null}
              <Text style={[s.bold, { fontSize: 13 }]}>
                {hotel.name}
                {hotel.stars ? `  ·  ${Math.round(hotel.stars)} estrellas` : ''}
              </Text>
              {hotel.address ? <Text style={s.small}>{hotel.address}</Text> : null}
              <View style={s.facts} wrap={false}>
                <View style={s.fact}>
                  <Text style={s.tiny}>Entrada</Text>
                  <Text>{formatLongDate(hotel.checkin)}</Text>
                </View>
                <View style={s.fact}>
                  <Text style={s.tiny}>Salida</Text>
                  <Text>{formatLongDate(hotel.checkout)}</Text>
                </View>
                <View style={s.fact}>
                  <Text style={s.tiny}>Régimen</Text>
                  <Text>{boardText(hotel)}</Text>
                </View>
                {hotel.roomName ? (
                  <View style={s.fact}>
                    <Text style={s.tiny}>Habitación</Text>
                    <Text>{hotel.roomName}</Text>
                  </View>
                ) : null}
                <View style={s.fact}>
                  <Text style={s.tiny}>Cancelación</Text>
                  <Text>{hotel.refundable ? 'Reembolsable' : 'No reembolsable'}</Text>
                </View>
              </View>
              {hotel.description ? (
                <Text style={[s.small, { lineHeight: 1.45 }]}>{hotel.description}</Text>
              ) : null}
            </View>
          ) : null}

          {car ? (
            <View style={s.section} wrap={false}>
              <Text style={[s.sectionTitle, { color: brand }]}>Auto</Text>
              <View style={[s.card, s.carRow]}>
                {images.car ? <Image src={images.car} style={s.carImg} /> : null}
                <View style={{ flex: 1 }}>
                  <Text style={s.bold}>
                    {car.model} <Text style={s.small}>o similar · {car.category}</Text>
                  </Text>
                  <Text style={s.small}>
                    {car.passengers} pasajeros · {car.bags} {car.bags === 1 ? 'maleta' : 'maletas'}{' '}
                    · {car.automatic ? 'Automático' : 'Manual'}
                    {car.air ? ' · Aire acondicionado' : ''}
                  </Text>
                  <Text style={s.tiny}>
                    Retiro {formatShortDate(car.pickUp.date)} {car.pickUp.hour.slice(0, 2)}:
                    {car.pickUp.hour.slice(2)} en {placeName(car.pickUp.code)} · Devolución{' '}
                    {formatShortDate(car.dropOff.date)} {car.dropOff.hour.slice(0, 2)}:
                    {car.dropOff.hour.slice(2)}
                  </Text>
                </View>
              </View>
            </View>
          ) : null}

          {model.extras.length > 0 ? (
            <View style={s.section} wrap={false}>
              <Text style={[s.sectionTitle, { color: brand }]}>Experiencias y traslados</Text>
              {model.extras.map((e) =>
                e.snapshot.kind === 'manual' ? (
                  <View key={e.id} style={s.card}>
                    <Text style={s.bold}>{e.snapshot.title}</Text>
                    {e.snapshot.description ? (
                      <Text style={s.small}>{e.snapshot.description}</Text>
                    ) : null}
                    {e.snapshot.date ? (
                      <Text style={s.tiny}>{formatLongDate(e.snapshot.date)}</Text>
                    ) : null}
                  </View>
                ) : null,
              )}
            </View>
          ) : null}

          {days.length > 0 ? (
            <View style={s.section}>
              <Text style={[s.sectionTitle, { color: brand }]}>Tu viaje, día a día</Text>
              {days.map((d) => (
                <View key={d.date} style={s.dayRow} wrap={false}>
                  <Text style={s.dayLabel}>
                    Día {d.dayNumber} <Text style={s.tiny}>· {formatShortDate(d.date)}</Text>
                  </Text>
                  <View style={{ flex: 1 }}>
                    {d.events.length === 0 ? (
                      <Text style={s.small}>Día libre.</Text>
                    ) : (
                      d.events.map((ev, i) => (
                        <Text key={i} style={s.small}>
                          {ev.time ? `${ev.time}  ` : ''}
                          {ev.text.replace(/→/g, '–')}
                        </Text>
                      ))
                    )}
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          <View style={[s.section, s.twoCol]} wrap={false}>
            <View style={s.col}>
              <Text style={[s.sectionTitle, { color: brand }]}>Incluye</Text>
              {includedList(model).map((t) => (
                <Text key={t} style={s.listItem}>
                  • {t}
                </Text>
              ))}
            </View>
            <View style={s.col}>
              <Text style={[s.sectionTitle, { color: brand }]}>No incluye</Text>
              {excludedList(model).map((t) => (
                <Text key={t} style={[s.listItem, { color: MUTED }]}>
                  – {t}
                </Text>
              ))}
            </View>
          </View>

          <View style={[s.section, s.priceBox]} wrap={false}>
            <Text style={[s.sectionTitle, { color: brand, marginBottom: 4 }]}>Inversión</Text>
            <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 20 }}>
              {money(model.totalMinor)}
            </Text>
            <Text style={s.small}>
              {model.travelers > 1 ? `${money(model.perPersonMinor)} por persona · ` : ''}
              Impuestos incluidos · Válida hasta el {formatLongDate(model.expiresAt)}
            </Text>
            {model.showBreakdown ? (
              <View
                style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: LINE, paddingTop: 6 }}
              >
                {model.items.map((item) => (
                  <View key={item.id} style={s.rowBetween}>
                    <Text style={s.small}>
                      {item.snapshot.kind === 'manual'
                        ? item.snapshot.title
                        : item.snapshot.kind === 'hotel'
                          ? item.snapshot.name
                          : item.snapshot.kind === 'flight'
                            ? 'Vuelos'
                            : 'Auto'}
                    </Text>
                    <Text style={s.small}>{money(item.totalMinor)}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>

          <View style={s.section} wrap={false}>
            <Text style={[s.tiny, { lineHeight: 1.5 }]}>
              Precios sujetos a disponibilidad y a cambios del proveedor hasta confirmar la reserva
              y emitir los servicios. Las tarifas aéreas pueden tener restricciones de cambios y
              reembolsos. Los pasajeros deben viajar con documentos vigentes y cumplir los
              requisitos migratorios y sanitarios del destino.
              {model.hasTestContent
                ? ' Esta cotización incluye tarifas de prueba: no corresponden a servicios reales.'
                : ''}
            </Text>
          </View>
        </View>

        <View style={s.footer} fixed>
          <Text>{branding.name}</Text>
          <Text>{contact}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
