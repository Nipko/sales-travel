import { CountryCodeSchema, z } from '@sales-travel/validation';
import { MoneySchema } from './money';
import { PaxCountSchema } from './pax';

export const GeoLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type GeoLocation = z.infer<typeof GeoLocationSchema>;

export const AddressSchema = z.object({
  street: z.string().min(1).max(200).optional(),
  city: z.string().min(1).max(120),
  region: z.string().min(1).max(120).optional(),
  postalCode: z.string().max(20).optional(),
  country: CountryCodeSchema,
});
export type Address = z.infer<typeof AddressSchema>;

export const HotelCategorySchema = z.enum([
  'hotel',
  'apart_hotel',
  'hostel',
  'boutique',
  'resort',
  'villa',
]);
export type HotelCategory = z.infer<typeof HotelCategorySchema>;

export const HotelImageSchema = z.object({
  url: z.string().url(),
  caption: z.string().max(200).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type HotelImage = z.infer<typeof HotelImageSchema>;

/**
 * Un hotel canónico. `code` es el ID del proveedor (HotelDo, Hotelbeds, etc.).
 * `giataId` es opcional pero recomendable para deduplicación cross-provider —
 * Giata Multi-Codes mapea el mismo hotel a códigos de múltiples proveedores.
 */
export const HotelSchema = z.object({
  code: z.string().min(1).max(64),
  giataId: z.string().optional(),
  name: z.string().min(1).max(200),
  category: HotelCategorySchema,
  starRating: z.number().min(0).max(5),
  chainCode: z.string().max(20).optional(),
  address: AddressSchema,
  location: GeoLocationSchema,
  amenities: z.array(z.string().max(50)).optional(),
  images: z.array(HotelImageSchema).optional(),
  description: z.string().max(2000).optional(),
});
export type Hotel = z.infer<typeof HotelSchema>;

export const RoomTypeSchema = z.enum([
  'single',
  'double',
  'twin',
  'triple',
  'quad',
  'suite',
  'family',
  'studio',
]);
export type RoomType = z.infer<typeof RoomTypeSchema>;

export const BedTypeSchema = z.enum(['single', 'double', 'queen', 'king', 'sofa', 'bunk']);
export type BedType = z.infer<typeof BedTypeSchema>;

export const BedConfigurationSchema = z.object({
  type: BedTypeSchema,
  count: z.number().int().min(1).max(6),
});
export type BedConfiguration = z.infer<typeof BedConfigurationSchema>;

export const RoomSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  roomType: RoomTypeSchema,
  capacity: z.object({
    adults: z.number().int().min(1).max(10),
    children: z.number().int().min(0).max(10),
  }),
  beds: z.array(BedConfigurationSchema).min(1),
  sizeSqm: z.number().positive().optional(),
  amenities: z.array(z.string().max(50)).optional(),
  smoking: z.boolean().optional(),
});
export type Room = z.infer<typeof RoomSchema>;

/**
 * RO=Room Only, BB=Bed&Breakfast, HB=Half Board, FB=Full Board, AI=All Inclusive.
 * Estándar usado por Hotelbeds, HotelDo y la mayoría de wholesalers.
 */
export const BoardTypeSchema = z.enum(['RO', 'BB', 'HB', 'FB', 'AI']);
export type BoardType = z.infer<typeof BoardTypeSchema>;

export const CancellationFeeSchema = z.object({
  /** Hasta esta fecha (exclusive) aplica esta penalidad. */
  validUntil: z.string().datetime({ offset: true }),
  amount: MoneySchema,
});

export const CancellationPolicySchema = z.object({
  refundable: z.boolean(),
  freeCancellationUntil: z.string().datetime({ offset: true }).optional(),
  fees: z.array(CancellationFeeSchema).optional(),
});
export type CancellationPolicy = z.infer<typeof CancellationPolicySchema>;

export const RatePlanSchema = z.object({
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(200).optional(),
  boardType: BoardTypeSchema,
  ratePerNight: MoneySchema,
  totalRate: MoneySchema,
  taxes: MoneySchema.optional(),
  cancellation: CancellationPolicySchema,
  paymentDueAtProperty: z.boolean().default(false),
});
export type RatePlan = z.infer<typeof RatePlanSchema>;

/**
 * Estadía en un hotel: hotel + room + ratePlan + fechas + ocupantes.
 * Lo que se muestra al vendedor cuando arma una cotización con hotel.
 */
export const HotelStaySchema = z.object({
  hotel: HotelSchema,
  checkIn: z.string().date(),
  checkOut: z.string().date(),
  nights: z.number().int().positive(),
  occupancy: PaxCountSchema,
  room: RoomSchema,
  ratePlan: RatePlanSchema,
});
export type HotelStay = z.infer<typeof HotelStaySchema>;
