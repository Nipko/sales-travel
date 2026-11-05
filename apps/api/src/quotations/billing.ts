import { z } from '@sales-travel/validation';
import { decryptPii, encryptPii } from '../customers/pii-cipher.js';

/**
 * A nombre de quién se factura una cotización (0091): el pasajero 1 u otra persona o empresa, con
 * los datos que pide la factura electrónica. El número de documento se guarda CIFRADO con la clave
 * de PII de clientes; el resto va en claro (no es más sensible que el contacto que ya guarda).
 */
export const BillingSchema = z
  .object({
    mode: z.enum(['passenger', 'other']),
    /** Cliente del CRM elegido en la búsqueda, si lo hay. */
    customerId: z.string().uuid().nullish(),
    customerType: z.enum(['person', 'company']).default('person'),
    /** Nombre completo o razón social. */
    name: z.string().trim().min(2).max(200),
    documentType: z.string().trim().min(1).max(30),
    documentNumber: z.string().trim().min(3).max(40),
    email: z.string().trim().email().max(200),
    phone: z.string().trim().min(5).max(40),
    address: z.string().trim().max(300).nullish(),
    city: z.string().trim().max(120).nullish(),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/)
      .nullish(),
  })
  .strict();
export type Billing = z.infer<typeof BillingSchema>;

type StoredBilling = Omit<Billing, 'documentNumber'> & { documentNumberEnc: string };

export function encodeBilling(billing: Billing): string {
  const { documentNumber, ...rest } = billing;
  const stored: StoredBilling = {
    ...rest,
    documentNumberEnc: encryptPii(documentNumber).toString('base64'),
  };
  return JSON.stringify(stored);
}

/** Lo guardado → lo que ve la pantalla. Un registro roto se lee como «sin facturación». */
export function decodeBilling(raw: unknown): Billing | null {
  const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!value || typeof value !== 'object') return null;
  const { documentNumberEnc, ...rest } = value as StoredBilling;
  let documentNumber = '';
  try {
    documentNumber = documentNumberEnc ? decryptPii(Buffer.from(documentNumberEnc, 'base64')) : '';
  } catch {
    documentNumber = '';
  }
  const parsed = BillingSchema.safeParse({ ...rest, documentNumber });
  return parsed.success ? parsed.data : null;
}
