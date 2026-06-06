import { Injectable, type OnModuleInit } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';

export interface JwtPayload {
  sub: string;
  /** Tenant activo del usuario (nodo donde está operando). Opcional para compat con tokens viejos. */
  tid?: string;
  /** Rol del usuario en el tenant activo. */
  role?: string;
}

const ISSUER = 'sales-travel';
const AUDIENCE = 'sales-travel-api';
const ACCESS_TTL = '24h';
// Audiencia separada para tokens de verificación de email: así un link de verificación NO sirve
// como bearer de API (verify() lo rechaza por audiencia) y viceversa.
const EMAIL_AUDIENCE = 'sales-travel-email-verify';
const EMAIL_TTL = '2d';

@Injectable()
export class JwtService implements OnModuleInit {
  private secret!: Uint8Array;

  onModuleInit(): void {
    const value = process.env['JWT_SECRET'];
    if (!value || value.length < 32) {
      throw new Error('JWT_SECRET is required and must be at least 32 chars');
    }
    this.secret = new TextEncoder().encode(value);
  }

  async sign(payload: JwtPayload, expiresIn: string = ACCESS_TTL): Promise<string> {
    return new SignJWT({ ...payload })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(payload.sub)
      .setExpirationTime(expiresIn)
      .sign(this.secret);
  }

  async verify(token: string): Promise<JwtPayload> {
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload.sub !== 'string') {
      throw new Error('JWT missing subject');
    }
    return {
      sub: payload.sub,
      tid: typeof payload['tid'] === 'string' ? payload['tid'] : undefined,
      role: typeof payload['role'] === 'string' ? payload['role'] : undefined,
    };
  }

  /** Firma un token de verificación de email (audiencia separada, TTL corto). */
  async signEmailToken(userId: string, expiresIn: string = EMAIL_TTL): Promise<string> {
    return new SignJWT({ purpose: 'email-verify' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(EMAIL_AUDIENCE)
      .setSubject(userId)
      .setExpirationTime(expiresIn)
      .sign(this.secret);
  }

  /** Verifica un token de verificación de email; devuelve el userId. Lanza si es inválido/expirado. */
  async verifyEmailToken(token: string): Promise<string> {
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: ISSUER,
      audience: EMAIL_AUDIENCE,
    });
    if (typeof payload.sub !== 'string') {
      throw new Error('JWT missing subject');
    }
    return payload.sub;
  }
}
