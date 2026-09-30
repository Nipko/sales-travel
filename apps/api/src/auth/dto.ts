import { z } from '@sales-travel/validation';

export const RegisterSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(12).max(128),
  name: z.string().min(1).max(120),
  tenant: z.object({
    slug: z
      .string()
      .min(2)
      .max(50)
      .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
    name: z.string().min(2).max(120),
    countryCode: z
      .string()
      .length(2)
      .regex(/^[A-Z]{2}$/),
    defaultCurrency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/),
    defaultLanguage: z.enum(['es', 'pt', 'en']).default('es'),
  }),
});
export type RegisterDto = z.infer<typeof RegisterSchema>;

/**
 * Token de "recordar este equipo" (cookie `st_trusted`). Laxo a propósito: una cookie vieja o
 * rota no puede hacer fallar el login, sólo deja de ahorrar el código. Lo que no es un string
 * razonable se descarta en vez de dar 400.
 */
const TrustedDeviceTokenSchema = z
  .string()
  .max(512)
  .optional()
  .catch(undefined)
  .transform((v) => (v && v.length > 0 ? v : undefined));

export const LoginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1).max(128),
  trustedDeviceToken: TrustedDeviceTokenSchema,
});
export type LoginDto = z.infer<typeof LoginSchema>;

export const VerifyEmailSchema = z.object({
  token: z.string().min(10).max(4096),
});
export type VerifyEmailDto = z.infer<typeof VerifyEmailSchema>;

export const SwitchTenantSchema = z.object({
  tenantId: z.string().uuid(),
});
export type SwitchTenantDto = z.infer<typeof SwitchTenantSchema>;

/**
 * Código de 6 dígitos (TOTP) o código de recuperación de 10 hex (`XXXXX-XXXXX`, admite guiones y
 * espacios). La forma la decide classifyMfaCode; acá sólo se acota el largo.
 */
const MfaCode = z.string().trim().min(6).max(32);

export const MfaCodeSchema = z.object({
  code: MfaCode,
});
export type MfaCodeDto = z.infer<typeof MfaCodeSchema>;

export const MfaVerifySchema = z.object({
  mfaToken: z.string().min(10).max(4096),
  code: MfaCode,
  rememberDevice: z.boolean().optional().default(false),
});
export type MfaVerifyDto = z.infer<typeof MfaVerifySchema>;

/** Con MFA activo, enrolar es "cambiar de teléfono" y exige la contraseña y un código vigente. */
export const MfaEnrollSchema = z
  .object({
    currentPassword: z.string().min(1).max(128).optional(),
    code: MfaCode.optional(),
  })
  .default({});
export type MfaEnrollDto = z.infer<typeof MfaEnrollSchema>;

export const MfaDisableSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  code: MfaCode,
});
export type MfaDisableDto = z.infer<typeof MfaDisableSchema>;

export const SeatReleaseSchema = z.object({
  releaseToken: z.string().min(10).max(4096),
  sessionId: z.string().uuid(),
});
export type SeatReleaseDto = z.infer<typeof SeatReleaseSchema>;

/**
 * `idle`: la cerró la cuenta regresiva de inactividad del panel. Cualquier otro valor se ignora: un
 * logout nunca debe fallar por el cuerpo.
 */
export const LogoutSchema = z
  .object({
    reason: z.literal('idle').optional().catch(undefined),
  })
  .default({});
export type LogoutDto = z.infer<typeof LogoutSchema>;

export const ForgotPasswordSchema = z.object({
  email: z.string().email().toLowerCase(),
});
export type ForgotPasswordDto = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  token: z.string().min(10).max(512),
  newPassword: z.string().min(12).max(128),
});
export type ResetPasswordDto = z.infer<typeof ResetPasswordSchema>;

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
});
export type ChangePasswordDto = z.infer<typeof ChangePasswordSchema>;
