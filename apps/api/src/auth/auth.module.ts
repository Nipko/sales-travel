import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtService } from './jwt.service.js';
import { PasswordService } from './password.service.js';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, JwtService, PasswordService],
  exports: [JwtService],
})
export class AuthModule {}
