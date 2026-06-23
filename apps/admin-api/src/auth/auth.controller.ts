import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parseInput } from '../common/validation';
import { AuthService } from './auth.service';
import { AdminAuthGuard } from './admin-auth.guard';
import type { AdminRequest } from './auth.types';

const usernameSchema = z.string().trim().regex(/^@?[A-Za-z0-9_]{1,32}$/);

const requestCodeSchema = z.object({
  username: usernameSchema,
});

const verifyCodeSchema = z.object({
  username: usernameSchema,
  code: z.string().trim().regex(/^\d{6}$/),
});

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('request-code')
  requestCode(@Body() body: unknown): Promise<{ expiresInSeconds: number }> {
    const input = parseInput(requestCodeSchema, body);
    return this.auth.requestLoginCode(input.username);
  }

  @Post('verify-code')
  verifyCode(@Body() body: unknown): Promise<Awaited<ReturnType<AuthService['verifyLoginCode']>>> {
    const input = parseInput(verifyCodeSchema, body);
    return this.auth.verifyLoginCode(input.username, input.code);
  }

  @Get('me')
  @UseGuards(AdminAuthGuard)
  me(@Req() request: AdminRequest) {
    return request.admin;
  }
}
