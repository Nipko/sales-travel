import { Global, Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtService } from './jwt.service.js';
import { LoginAttemptsService } from './login-attempts.service.js';
import { MfaChallengeService } from './mfa-challenge.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { PasswordService } from './password.service.js';
import { PgSeatRepository, SeatRepository } from './seat.repository.js';
import { SeatService } from './seat.service.js';
import { SessionService } from './session.service.js';
import { TotpService } from './totp.service.js';
import { TrustedDeviceService } from './trusted-device.service.js';

@Global()
@Module({
  // NetworkService: SeatService decide si quien quedó afuera por cupo lleno administra el nodo.
  imports: [NetworkModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtService,
    PasswordService,
    SessionService,
    TotpService,
    MfaService,
    MfaChallengeService,
    LoginAttemptsService,
    PasswordResetService,
    TrustedDeviceService,
    SeatService,
    { provide: SeatRepository, useClass: PgSeatRepository },
  ],
  // SessionService se exporta para RequestContextMiddleware (valida la sesión en cada
  // request) y para los caminos administrativos que revocan sesiones al suspender. SeatService,
  // para la gestión de puestos del módulo de tenants.
  exports: [JwtService, PasswordService, SessionService, TotpService, SeatService],
})
export class AuthModule {}
