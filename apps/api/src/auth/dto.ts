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
