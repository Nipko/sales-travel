import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtService } from './jwt.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { PasswordService } from './password.service.js';
import { SessionService } from './session.service.js';
import { TotpService } from './totp.service.js';

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtService,
    PasswordService,
    SessionService,
    TotpService,
    MfaService,
    PasswordResetService,
  ],
  // SessionService se exporta para RequestContextMiddleware (valida la sesión en cada
  // request) y para los caminos administrativos que revocan sesiones al suspender.
  exports: [JwtService, PasswordService, SessionService, TotpService],
})
export class AuthModule {}
