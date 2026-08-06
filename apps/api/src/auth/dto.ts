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

export const LoginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1).max(128),
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

/** Código de 6 dígitos (TOTP) o código de recuperación de 10 hex. */
export const MfaCodeSchema = z.object({
  code: z.string().min(6).max(32),
});
export type MfaCodeDto = z.infer<typeof MfaCodeSchema>;

export const MfaVerifySchema = z.object({
  mfaToken: z.string().min(10).max(4096),
  code: z.string().min(6).max(32),
});
export type MfaVerifyDto = z.infer<typeof MfaVerifySchema>;

export const MfaDisableSchema = z.object({
  currentPassword: z.string().min(1).max(128),
});
export type MfaDisableDto = z.infer<typeof MfaDisableSchema>;

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
