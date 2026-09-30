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
/** Vida del desafío MFA: el JWT y la fila de `mfa_challenges` vencen juntos. */
export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
// Permiso para liberar un puesto y entrar cuando el cupo está lleno. Audiencia propia: no es un
// bearer de API ni un desafío MFA. Un solo uso vía `consumed_tokens` (jti).
const SEAT_RELEASE_AUDIENCE = 'sales-travel-seat-release';
export const SEAT_RELEASE_TTL_MS = 5 * 60 * 1000;

/** Lo que lleva el permiso de liberar un puesto para completar el login igual que el intento original. */
export interface SeatReleaseClaims {
  userId: string;
  /** Nodo del cupo lleno. */
  poolTenantId: string;
  /** Tenant con que se emite la sesión al completar (el del login o el del switch-tenant). */
  tenantId: string | null;
  /** El intento original pasó el segundo factor. */
  mfa: boolean;
  /** El intento original pidió "recordar este equipo". */
  remember: boolean;
  /** Un solo uso: se consume en `consumed_tokens`. */
  jti: string;
  issuedAt: Date;
  expiresAt: Date;
}

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

  /** `expiresIn`: duración (`'12h'`) o el instante exacto, para que el token venza con su sesión. */
  async sign(payload: JwtPayload, expiresIn: string | Date = ACCESS_TTL): Promise<string> {
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

  /**
   * Firma el desafío MFA emitido tras validar la contraseña. `challengeId` es la fila de
   * `mfa_challenges` que lleva los intentos y el consumo: el JWT solo no tiene estado.
   */
  async signMfaChallenge(userId: string, challengeId: string, expiresAt: Date): Promise<string> {
    return new SignJWT({ purpose: 'mfa-challenge' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(MFA_AUDIENCE)
      .setSubject(userId)
      .setJti(challengeId)
      .setExpirationTime(expiresAt)
      .sign(this.secret);
  }

  /**
   * Verifica el desafío MFA. Lanza si es inválido, venció o no trae `jti` (un desafío emitido antes
   * de `mfa_challenges`, que no se puede limitar).
   */
  async verifyMfaChallenge(token: string): Promise<{ userId: string; challengeId: string }> {
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: ISSUER,
      audience: MFA_AUDIENCE,
    });
    if (typeof payload.sub !== 'string') {
      throw new Error('JWT missing subject');
    }
    if (typeof payload.jti !== 'string') {
      throw new Error('MFA challenge without jti');
    }
    return { userId: payload.sub, challengeId: payload.jti };
  }

  /** Firma el permiso de liberar un puesto (5 min, un solo uso por `jti`). */
  async signSeatRelease(
    claims: Omit<SeatReleaseClaims, 'issuedAt' | 'expiresAt'>,
  ): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + SEAT_RELEASE_TTL_MS);
    const token = await new SignJWT({
      purpose: 'seat-release',
      pool: claims.poolTenantId,
      ...(claims.tenantId ? { tid: claims.tenantId } : {}),
      mfa: claims.mfa,
      remember: claims.remember,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(SEAT_RELEASE_AUDIENCE)
      .setSubject(claims.userId)
      .setJti(claims.jti)
      .setExpirationTime(expiresAt)
      .sign(this.secret);
    return { token, expiresAt };
  }

  /** Verifica el permiso de liberar un puesto. Lanza si es inválido, venció o le falta un claim. */
  async verifySeatRelease(token: string): Promise<SeatReleaseClaims> {
    const { payload } = await jwtVerify(token, this.secret, {
      issuer: ISSUER,
      audience: SEAT_RELEASE_AUDIENCE,
    });
    const pool = payload['pool'];
    const tid = payload['tid'];
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.jti !== 'string' ||
      typeof pool !== 'string' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number'
    ) {
      throw new Error('seat release token incompleto');
    }
    return {
      userId: payload.sub,
      poolTenantId: pool,
      tenantId: typeof tid === 'string' ? tid : null,
      mfa: payload['mfa'] === true,
      remember: payload['remember'] === true,
      jti: payload.jti,
      issuedAt: new Date(payload.iat * 1000),
      expiresAt: new Date(payload.exp * 1000),
    };
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
