import { createHmac } from 'node:crypto';

const STEP_SECONDS = 30;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = '';
  for (const ch of clean) {
    const value = BASE32.indexOf(ch);
    if (value < 0) throw new Error(`Clave TOTP con un carácter que no es base32: «${ch}»`);
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

/** Código RFC 6238 (SHA-1, 6 dígitos, 30 s), el mismo que muestra una app de autenticación. */
export function totp(secret: string, step = currentStep()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

/**
 * El api rechaza reusar el código de un paso ya usado (`mfa_last_used_step`). Si `lastUsedStep` es el
 * paso actual, espera al siguiente. Devuelve el código y el paso para guardarlo.
 */
export async function freshTotp(
  secret: string,
  lastUsedStep: number | undefined,
): Promise<{ code: string; step: number }> {
  let step = currentStep();
  if (lastUsedStep !== undefined && step <= lastUsedStep) {
    const waitMs = (lastUsedStep + 1) * STEP_SECONDS * 1000 - Date.now() + 250;
    await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 0)));
    step = currentStep();
  }
  return { code: totp(secret, step), step };
}
