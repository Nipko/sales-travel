import { Body, Controller, Get, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { currentContext } from '../request-context/request-context.js';
import { Throttle } from '@nestjs/throttler';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { AuthService, type AuthResult, type LoginResult } from './auth.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import {
  ChangePasswordSchema,
  ForgotPasswordSchema,
  LoginSchema,
  MfaCodeSchema,
  MfaDisableSchema,
  MfaVerifySchema,
  RegisterSchema,
  ResetPasswordSchema,
  SwitchTenantSchema,
  VerifyEmailSchema,
  type ChangePasswordDto,
  type ForgotPasswordDto,
  type LoginDto,
  type MfaCodeDto,
  type MfaDisableDto,
  type MfaVerifyDto,
  type RegisterDto,
  type ResetPasswordDto,
  type SwitchTenantDto,
  type VerifyEmailDto,
} from './dto.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly reset: PasswordResetService,
  ) {}

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
  login(@Body(new ZodValidationPipe(LoginSchema)) dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto);
  }

  /** Cambia el tenant activo (emite token nuevo con el `tid` validado). Requiere auth. */
  @Post('switch-tenant')
  @HttpCode(200)
  switchTenant(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(SwitchTenantSchema)) body: SwitchTenantDto,
  ): Promise<AuthResult> {
    if (!userId) throw new UnauthorizedException();
    return this.auth.switchTenant(userId, body.tenantId);
  }

  /** Cierra la sesión actual revocándola en la base (no sólo borrando la cookie). */
  @Post('logout')
  @HttpCode(200)
  logout(@CurrentUser() userId: string | undefined): Promise<{ ok: true }> {
    const sessionId = currentContext()?.sessionId;
    if (!userId || !sessionId) throw new UnauthorizedException();
    return this.auth.logout(userId, sessionId);
  }

  /** Revoca todas las sesiones del usuario en todos sus dispositivos. */
  @Post('logout-all')
  @HttpCode(200)
  logoutAll(@CurrentUser() userId: string | undefined): Promise<{ revoked: number }> {
    if (!userId) throw new UnauthorizedException();
    return this.auth.logoutAll(userId);
  }

  /** Dispositivos con sesión activa del usuario. */
  @Get('sessions')
  sessions(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new UnauthorizedException();
    return this.auth.listSessions(userId, currentContext()?.sessionId);
  }

  // ==========================================================================
  // Contraseña
  // ==========================================================================

  /**
   * Pide un enlace de restablecimiento. Público y con throttle agresivo: es un endpoint
   * no autenticado que dispara envío de correo.
   */
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Public()
  @Post('forgot-password')
  @HttpCode(200)
  forgotPassword(
    @Body(new ZodValidationPipe(ForgotPasswordSchema)) dto: ForgotPasswordDto,
  ): Promise<{ sent: true }> {
    return this.reset.request(dto.email);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Public()
  @Post('reset-password')
  @HttpCode(200)
  resetPassword(
    @Body(new ZodValidationPipe(ResetPasswordSchema)) dto: ResetPasswordDto,
  ): Promise<{ ok: true }> {
    return this.reset.reset(dto.token, dto.newPassword);
  }

  @Post('change-password')
  @HttpCode(200)
  changePassword(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(ChangePasswordSchema)) dto: ChangePasswordDto,
  ): Promise<{ ok: true }> {
    if (!userId) throw new UnauthorizedException();
    return this.reset.change(userId, dto.currentPassword, dto.newPassword);
  }

  // ==========================================================================
  // MFA (TOTP)
  // ==========================================================================

  /** Canjea el desafío MFA por una sesión. Público: todavía no hay bearer. */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  verifyMfa(@Body(new ZodValidationPipe(MfaVerifySchema)) dto: MfaVerifyDto): Promise<AuthResult> {
    return this.auth.completeMfa(dto.mfaToken, dto.code);
  }

  @Get('mfa')
  mfaStatus(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new UnauthorizedException();
    return this.mfa.status(userId);
  }

  /** Paso 1: genera el secreto y el QR. Todavía no activa MFA. */
  @Post('mfa/enroll')
  @HttpCode(200)
  async enrollMfa(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new UnauthorizedException();
    const email = await this.auth.emailOf(userId);
    return this.mfa.beginEnrollment(userId, email);
  }

  /** Paso 2: confirma con el primer código y entrega los códigos de recuperación. */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('mfa/confirm')
  @HttpCode(200)
  confirmMfa(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(MfaCodeSchema)) dto: MfaCodeDto,
  ): Promise<{ recoveryCodes: string[] }> {
    if (!userId) throw new UnauthorizedException();
    return this.mfa.confirmEnrollment(userId, dto.code);
  }

  @Post('mfa/disable')
  @HttpCode(200)
  disableMfa(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(MfaDisableSchema)) dto: MfaDisableDto,
  ): Promise<{ ok: true }> {
    if (!userId) throw new UnauthorizedException();
    return this.mfa.disable(userId, dto.currentPassword);
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
