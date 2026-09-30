import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { currentContext } from '../request-context/request-context.js';
import { Throttle } from '@nestjs/throttler';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { TrustedDeviceNotFoundError } from './auth-errors.js';
import {
  AuthService,
  type AuthResult,
  type LoginResult,
  type SessionInfo,
} from './auth.service.js';
import { MfaService, type MfaEnrollment, type MfaStatus } from './mfa.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { TrustedDeviceService, type TrustedDeviceView } from './trusted-device.service.js';
import { AllowWithoutMfa } from './decorators/allow-without-mfa.decorator.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import {
  ChangePasswordSchema,
  ForgotPasswordSchema,
  LoginSchema,
  LogoutSchema,
  MfaCodeSchema,
  MfaDisableSchema,
  MfaEnrollSchema,
  MfaVerifySchema,
  RegisterSchema,
  ResetPasswordSchema,
  SeatReleaseSchema,
  SwitchTenantSchema,
  VerifyEmailSchema,
  type ChangePasswordDto,
  type ForgotPasswordDto,
  type LoginDto,
  type LogoutDto,
  type MfaCodeDto,
  type MfaDisableDto,
  type MfaEnrollDto,
  type MfaVerifyDto,
  type RegisterDto,
  type ResetPasswordDto,
  type SeatReleaseDto,
  type SwitchTenantDto,
  type VerifyEmailDto,
} from './dto.js';

/** Cabecera con el token de "recordar este equipo" que manda el panel (cookie `st_trusted`). */
const TRUSTED_DEVICE_HEADER = 'x-trusted-device';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly reset: PasswordResetService,
    private readonly trustedDevices: TrustedDeviceService,
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

  /**
   * Cupo lleno: quien administra el nodo del cupo desconecta a alguien y completa su ingreso.
   * Público (todavía no hay sesión): lo que autoriza es el permiso de un solo uso del 409.
   */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Public()
  @Post('seats/release')
  @HttpCode(200)
  releaseSeat(
    @Body(new ZodValidationPipe(SeatReleaseSchema)) dto: SeatReleaseDto,
  ): Promise<AuthResult> {
    return this.auth.releaseSeat(dto.releaseToken, dto.sessionId);
  }

  /** Cambia el tenant activo (emite token nuevo con el `tid` validado). Requiere auth. */
  @Post('switch-tenant')
  @HttpCode(200)
  switchTenant(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(SwitchTenantSchema)) body: SwitchTenantDto,
  ): Promise<AuthResult> {
    if (!userId) throw new UnauthorizedException();
    return this.auth.switchTenant(userId, body.tenantId, currentContext()?.sessionId);
  }

  /**
   * La sesión actual: inactividad, vencimiento y reloj del servidor, para la cuenta regresiva del
   * panel. Con `x-session-ping: passive` se valida sin contar como actividad.
   */
  @AllowWithoutMfa()
  @Get('session')
  session(): SessionInfo {
    return this.auth.sessionInfo();
  }

  /** Cierra la sesión actual revocándola en la base (no sólo borrando la cookie). */
  @AllowWithoutMfa()
  @Post('logout')
  @HttpCode(200)
  logout(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(LogoutSchema)) body: LogoutDto,
  ): Promise<{ ok: true }> {
    const sessionId = currentContext()?.sessionId;
    if (!userId || !sessionId) throw new UnauthorizedException();
    return this.auth.logout(userId, sessionId, body.reason);
  }

  /** Revoca todas las sesiones del usuario en todos sus dispositivos. */
  @AllowWithoutMfa()
  @Post('logout-all')
  @HttpCode(200)
  logoutAll(@CurrentUser() userId: string | undefined): Promise<{ revoked: number }> {
    if (!userId) throw new UnauthorizedException();
    return this.auth.logoutAll(userId);
  }

  /** Dispositivos con sesión activa del usuario. */
  @AllowWithoutMfa()
  @Get('sessions')
  sessions(@CurrentUser() userId: string | undefined) {
    if (!userId) throw new UnauthorizedException();
    return this.auth.listSessions(userId, currentContext()?.sessionId);
  }

  /** Cierra UNA sesión propia (otro dispositivo). La actual no: 400. */
  @Post('sessions/:id/revoke')
  @HttpCode(200)
  revokeSession(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ParseUUIDPipe()) sessionId: string,
  ): Promise<{ ok: true }> {
    if (!userId) throw new UnauthorizedException();
    return this.auth.revokeOwnSession(userId, currentContext()?.sessionId, sessionId);
  }

  // ==========================================================================
  // Equipos de confianza ("recordar este equipo")
  // ==========================================================================

  @Get('trusted-devices')
  listTrustedDevices(
    @CurrentUser() userId: string | undefined,
    @Headers(TRUSTED_DEVICE_HEADER) currentToken: string | undefined,
  ): Promise<TrustedDeviceView[]> {
    if (!userId) throw new UnauthorizedException();
    return this.trustedDevices.list(userId, currentToken);
  }

  @Post('trusted-devices/revoke-all')
  @HttpCode(200)
  async revokeAllTrustedDevices(
    @CurrentUser() userId: string | undefined,
  ): Promise<{ revoked: number }> {
    if (!userId) throw new UnauthorizedException();
    return { revoked: await this.trustedDevices.revokeAll(userId) };
  }

  @Post('trusted-devices/:id/revoke')
  @HttpCode(200)
  async revokeTrustedDevice(
    @CurrentUser() userId: string | undefined,
    @Param('id', new ParseUUIDPipe()) deviceId: string,
  ): Promise<{ ok: true }> {
    if (!userId) throw new UnauthorizedException();
    if (!(await this.trustedDevices.revoke(userId, deviceId))) {
      throw new TrustedDeviceNotFoundError();
    }
    return { ok: true };
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

  /**
   * Cambia la contraseña y cierra TODAS las sesiones; el dispositivo actual sigue con la sesión
   * nueva que devuelve esta respuesta (el panel guarda el token).
   */
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(ChangePasswordSchema)) dto: ChangePasswordDto,
  ): Promise<{ ok: true; token: string; expiresAt: string }> {
    if (!userId) throw new UnauthorizedException();
    const sessionId = currentContext()?.sessionId;
    await this.reset.change(userId, dto.currentPassword, dto.newPassword);
    const next = await this.auth.reissueAfterPasswordChange(userId, sessionId);
    return { ok: true, ...next };
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
    return this.auth.completeMfa(dto.mfaToken, dto.code, dto.rememberDevice);
  }

  @AllowWithoutMfa()
  @Get('mfa')
  mfaStatus(@CurrentUser() userId: string | undefined): Promise<MfaStatus> {
    if (!userId) throw new UnauthorizedException();
    return this.mfa.status(userId);
  }

  /**
   * Paso 1: genera un secreto PENDIENTE y el QR. Con MFA activo es "cambiar de teléfono" y exige
   * la contraseña y un código vigente (si no, 409 MFA_ALREADY_ENABLED).
   */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @AllowWithoutMfa()
  @Post('mfa/enroll')
  @HttpCode(200)
  async enrollMfa(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(MfaEnrollSchema)) dto: MfaEnrollDto,
  ): Promise<MfaEnrollment> {
    if (!userId) throw new UnauthorizedException();
    const email = await this.auth.emailOf(userId);
    return this.mfa.beginEnrollment(userId, email, {
      ...(dto.currentPassword ? { currentPassword: dto.currentPassword } : {}),
      ...(dto.code ? { code: dto.code } : {}),
    });
  }

  /** Paso 2: confirma con el primer código y entrega los códigos de recuperación. */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @AllowWithoutMfa()
  @Post('mfa/confirm')
  @HttpCode(200)
  confirmMfa(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(MfaCodeSchema)) dto: MfaCodeDto,
  ): Promise<{ recoveryCodes: string[] }> {
    if (!userId) throw new UnauthorizedException();
    return this.mfa.confirmEnrollment(userId, currentContext()?.sessionId, dto.code);
  }

  /** Códigos de recuperación nuevos (los anteriores dejan de servir). Pide un TOTP vigente. */
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @AllowWithoutMfa()
  @Post('mfa/recovery-codes')
  @HttpCode(200)
  regenerateRecoveryCodes(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(MfaCodeSchema)) dto: MfaCodeDto,
  ): Promise<{ recoveryCodes: string[] }> {
    if (!userId) throw new UnauthorizedException();
    return this.mfa.regenerateRecoveryCodes(userId, dto.code);
  }

  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @AllowWithoutMfa()
  @Post('mfa/disable')
  @HttpCode(200)
  disableMfa(
    @CurrentUser() userId: string | undefined,
    @Body(new ZodValidationPipe(MfaDisableSchema)) dto: MfaDisableDto,
  ): Promise<{ ok: true }> {
    if (!userId) throw new UnauthorizedException();
    return this.mfa.disable(userId, currentContext()?.sessionId, dto.currentPassword, dto.code);
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
