import { z } from '@sales-travel/validation';

/**
 * Hex de 6 dígitos, y nada más.
 *
 * El COMMENT original de 0006 decía "OKLCH or hex", pero la UI edita con
 * <input type="color"> (que emite hex) y la derivación de tokens del cliente
 * (web-b2b/src/lib/brand-tokens.ts) sólo entiende hex: un OKLCH guardado en la base se
 * descartaría en silencio y el tenant vería los colores de la plataforma sin saber por
 * qué. La migración 0030 impone el mismo CHECK del lado de la base.
 */
const HexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'debe ser un color hexadecimal de 6 dígitos, por ejemplo #e37b23');

/**
 * URL de imagen servida por HTTPS.
 *
 * Se exige https porque el panel va por https y un recurso mixto no carga. El límite de
 * 2048 es el que el esquema prometía en un COMMENT desde 0006 sin hacerlo cumplir.
 */
const ImageUrl = z
  .string()
  .url()
  .max(2048)
  .startsWith('https://', 'la URL debe empezar con https://');

export const UpdateBrandingSchema = z
  .object({
    logoUrl: ImageUrl.nullable().optional(),
    faviconUrl: ImageUrl.nullable().optional(),
    primaryColor: HexColor.nullable().optional(),
    accentColor: HexColor.nullable().optional(),
    commercialName: z.string().min(1).max(120).nullable().optional(),
    supportEmail: z.string().email().max(160).nullable().optional(),
    supportPhone: z.string().min(4).max(40).nullable().optional(),
    websiteUrl: z.string().url().max(2048).nullable().optional(),
  })
  .strict();
export type UpdateBrandingDto = z.infer<typeof UpdateBrandingSchema>;

export const UpdateConfigSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    countryCode: z
      .string()
      .length(2)
      .regex(/^[A-Z]{2}$/)
      .optional(),
    defaultCurrency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/)
      .optional(),
    defaultLanguage: z.enum(['es', 'pt', 'en']).optional(),
  })
  .strict();
export type UpdateConfigDto = z.infer<typeof UpdateConfigSchema>;
