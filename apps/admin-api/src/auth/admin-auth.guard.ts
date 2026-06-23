import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { AdminRequest } from './auth.types';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const rawHeader = request.headers.authorization;
    const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Нужна авторизация администратора');
    }
    request.admin = this.auth.verifySessionToken(header.slice('Bearer '.length));
    return true;
  }
}
