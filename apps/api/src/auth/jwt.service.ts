import { Injectable, type OnModuleInit } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';

export interface JwtPayload {
  sub: string;
  /** Tenant activo del usuario (nodo donde está operando). Opcional para compat con tokens viejos. */
  tid?: string;
  /**
   * Rol en el tenant activo. INFORMATIVO: la autorización usa el rol efectivo que
   * RequestContextMiddleware resuelve contra la base en cada request, para que degradar
   * un rol surta efecto sin esperar a que expire el token.
   */
  role?: string;
  /** Id de la fila en `sessions`. Habilita la revocación inmediata (0026). */
  jti?: string;
  /** Emisión en segundos unix. Se contrasta contra users.password_changed_at. */
  iat?: number;
}

const ISSUER = 'sales-travel';
const AUDIENCE = 'sales-travel-api';
// Con sesiones revocables (0026) el TTL dejó de ser la única defensa: revocar surte
// efecto en el acto. Aun así se acorta de 24h a 12h para limitar la ventana de un token
// robado si la base de sesiones no estuviera disponible.
const ACCESS_TTL = '12h';
export const ACCESS_TTL_MS = 12 * 60 * 60 * 1000;
// Audiencia separada para tokens de verificación de email: así un link de verificación NO sirve
// como bearer de API (verify() lo rechaza por audiencia) y viceversa.
const EMAIL_AUDIENCE = 'sales-travel-email-verify';
const EMAIL_TTL = '2d';
// Token intermedio entre "contraseña correcta" y "segundo factor verificado". Audiencia
// propia para que NO sirva como bearer de API: si se filtra, sin el código TOTP no abre nada.
const MFA_AUDIENCE = 'sales-travel-mfa-challenge';
const MFA_TTL = '5m';

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
    const { jti, ...claims } = payload;
    let builder = new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(payload.sub)
      .setExpirationTime(expiresIn);
    if (jti) builder = builder.setJti(jti);
    return builder.sign(this.secret);
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
      jti: typeof payload.jti === 'string' ? payload.jti : undefined,
      iat: typeof payload.iat === 'number' ? payload.iat : undefined,
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

  /** Firma el desafío MFA emitido tras validar la contraseña. */
  async signMfaChallenge(userId: string): Promise<string> {
    return new SignJWT({ purpose: 'mfa-challenge' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(MFA_AUDIENCE)
      .setSubject(userId)
      .setExpirationTime(MFA_TTL)
      .sign(this.secret);
  }

  /** Verifica el desafío MFA; devuelve el userId. Lanza si es inválido/expirado. */
  async verifyMfaChallenge(token: string): Promise<string> {
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: ISSUER,
      audience: MFA_AUDIENCE,
    });
    if (typeof payload.sub !== 'string') {
      throw new Error('JWT missing subject');
    }
    return payload.sub;
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
