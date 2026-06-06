import { Body, Controller, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { AuthService, type AuthResult } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import {
  LoginSchema,
  RegisterSchema,
  VerifyEmailSchema,
  type LoginDto,
  type RegisterDto,
  type VerifyEmailDto,
} from './dto.js';

interface SwitchTenantBody {
  tenantId: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Public()
  @Post('register')
  @HttpCode(201)
  register(@Body(new ZodValidationPipe(RegisterSchema)) dto: RegisterDto): Promise<AuthResult> {
    return this.auth.register(dto);
  }

  // Anti brute-force: 10 intentos de login por minuto por IP.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodValidationPipe(LoginSchema)) dto: LoginDto): Promise<AuthResult> {
    return this.auth.login(dto);
  }

  /** Cambia el tenant activo (emite token nuevo con el `tid` validado). Requiere auth. */
  @Post('switch-tenant')
  @HttpCode(200)
  switchTenant(
    @CurrentUser() userId: string | undefined,
    @Body() body: SwitchTenantBody,
  ): Promise<AuthResult> {
    if (!userId) throw new UnauthorizedException();
    return this.auth.switchTenant(userId, body.tenantId);
  }

  /** Verifica el email a partir del token del enlace enviado por correo. Público. */
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Public()
  @Post('verify-email')
  @HttpCode(200)
  verifyEmail(
    @Body(new ZodValidationPipe(VerifyEmailSchema)) dto: VerifyEmailDto,
  ): Promise<{ verified: boolean }> {
    return this.auth.verifyEmail(dto.token);
  }

  /** Reenvía el correo de verificación al usuario autenticado. */
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('resend-verification')
  @HttpCode(200)
  resendVerification(
    @CurrentUser() userId: string | undefined,
  ): Promise<{ sent: boolean; alreadyVerified: boolean }> {
    if (!userId) throw new UnauthorizedException();
    return this.auth.resendVerification(userId);
  }
}
