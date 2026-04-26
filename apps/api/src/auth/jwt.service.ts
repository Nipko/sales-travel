import { Injectable, type OnModuleInit } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';

export interface JwtPayload {
  sub: string;
}

const ISSUER = 'sales-travel';
const AUDIENCE = 'sales-travel-api';
const ACCESS_TTL = '24h';

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
    return { sub: payload.sub };
  }
}
