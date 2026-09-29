import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '../../database/database.types.js';
import { currentContext } from '../../request-context/request-context.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import { SALES_OPERATION_KEY } from '../decorators/sales-operation.decorator.js';
import { canSell, isPlatformRole } from '../roles.js';
import { PlatformRoleCannotSellError } from '../sales-operation-errors.js';

/**
 * Autorización declarativa por rol. Complementa a AuthGuard, que sólo verifica que haya
 * usuario autenticado.
 *
 * Contrasta contra el rol EFECTIVO en el tenant activo (resuelto por
 * RequestContextMiddleware contra la base en cada request), no contra el claim del JWT:
 * degradar a un usuario o suspender su membership surte efecto de inmediato.
 *
 * Los roles de plataforma pasan los controles de administración: su alcance es global. En una
 * operación de venta (`@SalesOperation()`) no hay ese pase: se exige un rol de SELLING_ROLES, que
 * no incluye a la plataforma, porque el superadmin cuadra la red pero no vende. Tampoco vende el
 * usuario que es superadmin en otro nodo (`platformUser`), aunque en el tenant activo tenga otro rol.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const isSale =
      this.reflector.getAllAndOverride<boolean | undefined>(SALES_OPERATION_KEY, targets) === true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets);
    // Una venta nunca es pública: si alguien marcara las dos cosas, gana la venta y se exige rol.
    if (isPublic && !isSale) return true;

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    // Sin @Roles() ni @SalesOperation(), este guard no opina: la ruta queda gobernada por AuthGuard.
    if (!isSale && (!required || required.length === 0)) return true;

    const context = currentContext();
    if (!context?.userId) throw new UnauthorizedException();

    const role = context.role;
    // El superadmin es una identidad del USUARIO (NetworkService.isSuperadmin mira cualquier nodo),
    // no sólo el rol del tenant activo. Por eso se mira antes que la membership: ni con una de
    // vendedor en una sucursal, ni entrando a un nodo donde no es miembro, llega a vender.
    if (isSale && (context.platformUser === true || (role !== undefined && isPlatformRole(role)))) {
      throw new PlatformRoleCannotSellError();
    }
    if (!role) {
      // Autenticado pero sin membership activa en el tenant del request.
      throw new ForbiddenException('no active membership in the current tenant');
    }

    if (isSale) return this.assertSeller(role, required);

    if (isPlatformRole(role)) return true;
    if (required?.includes(role)) return true;

    throw new ForbiddenException('insufficient role for this operation');
  }

  /**
   * Venta: un rol de SELLING_ROLES y, si la ruta declara @Roles, también de esa lista. Ningún rol de
   * plataforma llega acá (se cortó antes) y SELLING_ROLES no los tiene: sin pase libre.
   */
  private assertSeller(role: Role, required: Role[] | undefined): true {
    const declared = !required || required.length === 0 || required.includes(role);
    if (canSell(role) && declared) return true;
    throw new ForbiddenException('insufficient role for this operation');
  }
}
