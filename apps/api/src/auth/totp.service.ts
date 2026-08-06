import { Injectable } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648
const STEP_SECONDS = 30;
const DIGITS = 6;
/** Tolerancia de ±1 paso (±30s) para absorber desfases de reloj del teléfono. */
const VERIFY_WINDOW = 1;

/**
 * TOTP (RFC 6238) sobre node:crypto.
 *
 * Implementado en el repo en lugar de sumar una dependencia: el algoritmo es corto y
 * está congelado desde 2011, y para código de autenticación preferimos algo verificable
 * contra los vectores oficiales del RFC (ver totp.service.test.ts) antes que ampliar la
 * superficie de supply-chain de una plataforma que custodia credenciales BYOC de terceros.
 */
@Injectable()
export class TotpService {
  /** Secreto nuevo en base32, listo para el authenticator. 20 bytes = 160 bits (RFC 4226 §4). */
  generateSecret(): string {
    return base32Encode(randomBytes(20));
  }

  /** URI otpauth:// para el QR de enrolamiento. */
  buildUri(secret: string, accountEmail: string, issuer = 'Planetour'): string {
    const label = encodeURIComponent(`${issuer}:${accountEmail}`);
    const params = new URLSearchParams({
      secret,
      issuer,
      algorithm: 'SHA1',
      digits: String(DIGITS),
      period: String(STEP_SECONDS),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
  }

  /** Paso TOTP actual. Se persiste para impedir que un código se reutilice en su ventana. */
  currentStep(at: Date = new Date()): number {
    return Math.floor(at.getTime() / 1000 / STEP_SECONDS);
  }

  generate(secret: string, step: number): string {
    return hotp(base32Decode(secret), step, DIGITS);
  }

  /**
   * Verifica un código. Devuelve el paso consumido (para guardarlo como
   * mfa_last_used_step y bloquear el replay) o null si no valida.
   *
   * `minStep` descarta pasos ya usados: sin eso, un código interceptado sigue siendo
   * válido durante el resto de su ventana de 30s.
   */
  verify(secret: string, code: string, opts: { at?: Date; minStep?: number } = {}): number | null {
    const normalized = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(normalized)) return null;

    const current = this.currentStep(opts.at ?? new Date());
    const key = base32Decode(secret);

    for (let drift = -VERIFY_WINDOW; drift <= VERIFY_WINDOW; drift++) {
      const step = current + drift;
      if (opts.minStep !== undefined && step <= opts.minStep) continue;
      if (constantTimeEquals(hotp(key, step, DIGITS), normalized)) return step;
    }
    return null;
  }
}

/** HOTP — RFC 4226 §5.3: HMAC-SHA1 del contador + truncamiento dinámico. */
function hotp(key: Buffer, counter: number, digits: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', key).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('invalid base32 character in TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
