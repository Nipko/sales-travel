import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { currentContext } from '../request-context/request-context.js';
import { NetworkService } from './network.service.js';
import { SuperadminRequiredError } from './superadmin.errors.js';

/**
 * Las herramientas de la plataforma son sólo del superadmin. Va a nivel de clase, junto con
 * `@Roles(...PLATFORM_ROLES)`: RolesGuard deja fuera a los roles de nodo y esta guarda a
 * `platform_admin` (retirado, D7 B), que pasa RolesGuard por ser un rol de plataforma.
 *
 * Corre después de los guards globales (AuthGuard, RolesGuard) y antes de los pipes: quien no es
 * superadmin recibe 403 aunque la query sea inválida, y la ruta no le describe su contrato.
 *
 * Es la puerta de la app; las lecturas de toda la red la vuelven a exigir en la base
 * (`is_platform_superadmin()`, 0075).
 */
@Injectable()
export class SuperadminGuard implements CanActivate {
  constructor(private readonly network: NetworkService) {}

  async canActivate(_ctx: ExecutionContext): Promise<boolean> {
    const userId = currentContext()?.userId;
    if (!userId) throw new UnauthorizedException();
    if (!(await this.network.isSuperadmin(userId))) throw new SuperadminRequiredError();
    return true;
  }
}
