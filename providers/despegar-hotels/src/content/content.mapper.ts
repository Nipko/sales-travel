/**
 * Contenido estático de HotelDO (`/content-api/hotels/*`). Catálogos de códigos (regímenes,
 * tipos de cargo, amenities) y la ficha de cada hotel. Los textos vienen por idioma.
 */

export type ContentLanguage = 'es' | 'en' | 'pt';

export type LocalizedText = Partial<Record<ContentLanguage, string>>;

export interface CatalogEntry {
  id: string;
  description: LocalizedText;
}

export interface MealPlanEntry extends CatalogEntry {
  subCategories: CatalogEntry[];
}

export interface AmenityEntry extends CatalogEntry {
  categoryId?: string;
}

export interface DespegarHotelContent {
  id: string;
  name?: string;
  stars?: number;
  address?: string;
  zipcode?: string;
  cityId?: string;
  location?: { lat: number; lng: number };
  /** `HH:mm` o como venga. */
  checkInFrom?: string;
  checkInTo?: string;
  checkOutTo?: string;
  information: LocalizedText;
  notices: LocalizedText;
  pictures: string[];
  amenityIds: string[];
  phones: string[];
  email?: string;
  /** `room_types[]`: su `id` es el `room_type_id` de las habitaciones de cada roompack. */
  roomTypes: DespegarRoomTypeContent[];
}

export interface DespegarRoomTypeContent {
  id: string;
  name: LocalizedText;
  description: LocalizedText;
  pictures: string[];
}

function localized(v: unknown): LocalizedText {
  if (typeof v === 'string') return v.trim() ? { es: v.trim() } : {};
  const out: LocalizedText = {};
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const lang of ['es', 'en', 'pt'] as const) {
      const t = o[lang] ?? o[lang.toUpperCase()];
      if (typeof t === 'string' && t.trim()) out[lang] = t.trim();
    }
  }
  return out;
}

const idOf = (v: unknown): string | undefined =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : undefined;

interface RawCatalogEntry {
  id?: string | number;
  description?: unknown;
  sub_categories?: RawCatalogEntry[];
  amenity_category?: { id?: string | number };
}

function entry(raw: RawCatalogEntry): CatalogEntry | undefined {
  const id = idOf(raw.id);
  return id === undefined ? undefined : { id, description: localized(raw.description) };
}

const asArray = (raw: unknown): RawCatalogEntry[] =>
  Array.isArray(raw) ? (raw as RawCatalogEntry[]) : [];

export function mapCatalog(raw: unknown): CatalogEntry[] {
  return asArray(raw)
    .map(entry)
    .filter((e): e is CatalogEntry => e !== undefined);
}

export function mapMealPlans(raw: unknown): MealPlanEntry[] {
  return asArray(raw).flatMap((r) => {
    const e = entry(r);
    if (e === undefined) return [];
    return [{ ...e, subCategories: mapCatalog(r.sub_categories) }];
  });
}

export function mapAmenities(raw: unknown): AmenityEntry[] {
  return asArray(raw).flatMap((r) => {
    const e = entry(r);
    if (e === undefined) return [];
    const categoryId = idOf(r.amenity_category?.id);
    return [categoryId === undefined ? e : { ...e, categoryId }];
  });
}

interface RawHotelContent {
  id?: string | number;
  name?: string;
  stars?: number;
  location?: {
    address?: string;
    zipcode?: string | number;
    city?: { id?: string | number };
    latitude?: number;
    longitude?: number;
  };
  checkin?: { from?: string; to?: string };
  checkout?: { to?: string };
  information?: unknown;
  notices?: unknown;
  main_picture?: { url?: string };
  pictures?: { url?: string }[];
  amenities?: { id?: string | number }[];
  extra_details?: { phone_numbers?: unknown[]; email?: string };
  room_types?: {
    id?: string | number;
    name?: unknown;
    description?: unknown;
    descriptions?: unknown;
    pictures?: { url?: string }[];
  }[];
}

const httpsUrl = (u: unknown): string | undefined =>
  typeof u === 'string' && /^https:\/\//i.test(u) ? u : undefined;

const picturesOf = (list: readonly ({ url?: string } | undefined)[]): string[] => [
  ...new Set(list.map((p) => httpsUrl(p?.url)).filter((u): u is string => u !== undefined)),
];

/** Array suelto o `{ items }`: la spec no publica ejemplo de la respuesta. */
function hotelItems(raw: unknown): RawHotelContent[] {
  if (Array.isArray(raw)) return raw as RawHotelContent[];
  const items = (raw as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as RawHotelContent[]) : [];
}

export function mapHotelContent(raw: unknown): DespegarHotelContent[] {
  const items = hotelItems(raw);
  return items.flatMap((h) => {
    const id = idOf(h.id);
    if (id === undefined) return [];
    const loc = h.location;
    const pictures = picturesOf([h.main_picture, ...(h.pictures ?? [])]);
    const out: DespegarHotelContent = {
      id,
      information: localized(h.information),
      notices: localized(h.notices),
      pictures,
      roomTypes: (h.room_types ?? []).flatMap((rt) => {
        const roomId = idOf(rt.id);
        if (roomId === undefined) return [];
        return [
          {
            id: roomId,
            name: localized(rt.name),
            description: localized(rt.description ?? rt.descriptions),
            pictures: picturesOf(rt.pictures ?? []),
          },
        ];
      }),
      amenityIds: (h.amenities ?? [])
        .map((a) => idOf(a.id))
        .filter((a): a is string => a !== undefined),
      phones: (h.extra_details?.phone_numbers ?? [])
        .map((p) => (typeof p === 'string' ? p : idOf((p as { number?: unknown })?.number)))
        .filter((p): p is string => typeof p === 'string' && p !== ''),
    };
    if (h.name) out.name = h.name;
    if (typeof h.stars === 'number') out.stars = h.stars;
    if (loc?.address) out.address = loc.address;
    if (loc?.zipcode != null && loc.zipcode !== '') out.zipcode = String(loc.zipcode);
    const cityId = idOf(loc?.city?.id);
    if (cityId) out.cityId = cityId;
    if (typeof loc?.latitude === 'number' && typeof loc.longitude === 'number') {
      out.location = { lat: loc.latitude, lng: loc.longitude };
    }
    if (h.checkin?.from) out.checkInFrom = h.checkin.from;
    if (h.checkin?.to) out.checkInTo = h.checkin.to;
    if (h.checkout?.to) out.checkOutTo = h.checkout.to;
    if (h.extra_details?.email) out.email = h.extra_details.email;
    return [out];
  });
}
