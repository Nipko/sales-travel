import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { AuthService, type AuthResult } from './auth.service.js';
import { Public } from './decorators/public.decorator.js';
import { LoginSchema, RegisterSchema, type LoginDto, type RegisterDto } from './dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(201)
  register(@Body(new ZodValidationPipe(RegisterSchema)) dto: RegisterDto): Promise<AuthResult> {
    return this.auth.register(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodValidationPipe(LoginSchema)) dto: LoginDto): Promise<AuthResult> {
    return this.auth.login(dto);
  }
}
