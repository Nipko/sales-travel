import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { isPlatformRole } from '../auth/roles.js';
import { currentRole, currentTenantId } from '../request-context/request-context.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import {
  ProviderPayloadsService,
  type ProviderPayloadExportOptions,
} from './provider-payloads.service.js';
import {
  PROVIDER_PAYLOAD_READER_ROLES,
  type ProviderPayloadExport,
  type ProviderPayloadReader,
} from './provider-payloads.types.js';

/** Los formatos los valida el servicio; aquí sólo se eligen las claves que existen. */
const ExportQuerySchema = z.object({
  provider: z.string().optional(),
  supportTicket: z.string().optional(),
});

type ExportQuery = z.infer<typeof ExportQuerySchema>;

/**
 * Exportación de la bóveda de payloads para un ticket de soporte del proveedor (D-TBO-31 A).
 *
 * Tres filtros, de afuera hacia adentro: el rol (`consolidator_admin` o plataforma, con MFA
 * obligatorio), la RLS de 0043 (sólo las filas de cuentas cuyo dueño administra quien lee) y la
 * redacción de `live`. Sin redactar sale sólo con `supportTicket` y sólo para la plataforma: un
 * consolidador que necesite el dato real lo pide a la plataforma, que deja el ticket en el rastro.
 *
 * `no-store`: la respuesta puede traer datos de huéspedes y no debe quedar en ninguna caché.
 */
@Roles(...PROVIDER_PAYLOAD_READER_ROLES)
@Controller('provider-payloads')
export class ProviderPayloadsController {
  constructor(private readonly payloads: ProviderPayloadsService) {}

  @Get('requests/:requestId')
  @Header('Cache-Control', 'no-store')
  async byRequest(
    @CurrentUser() userId: string | undefined,
    @Param('requestId') requestId: string,
    @Query(new ZodValidationPipe(ExportQuerySchema)) query: ExportQuery,
  ): Promise<ProviderPayloadExport> {
    const reader = readerOf(userId);
    return found(await this.payloads.exportByRequestId(requestId, reader, optionsOf(query)));
  }

  @Get('orders/:orderId')
  @Header('Cache-Control', 'no-store')
  async byOrder(
    @CurrentUser() userId: string | undefined,
    @Param('orderId') orderId: string,
    @Query(new ZodValidationPipe(ExportQuerySchema)) query: ExportQuery,
  ): Promise<ProviderPayloadExport> {
    const reader = readerOf(userId);
    return found(await this.payloads.exportByOrderId(orderId, reader, optionsOf(query)));
  }
}

function readerOf(userId: string | undefined): ProviderPayloadReader {
  if (userId === undefined) throw new UnauthorizedException();
  const tenantId = currentTenantId();
  return tenantId === undefined ? { userId } : { userId, tenantId };
}

function optionsOf(query: ExportQuery): ProviderPayloadExportOptions {
  if (query.supportTicket !== undefined) {
    const role = currentRole();
    if (role === undefined || !isPlatformRole(role)) {
      throw new ForbiddenException(
        'Sólo la plataforma exporta sin redactar. Pedíselo con la referencia del ticket del proveedor.',
      );
    }
  }
  return {
    ...(query.provider === undefined ? {} : { providerCode: query.provider }),
    ...(query.supportTicket === undefined
      ? {}
      : { reveal: { supportTicket: query.supportTicket } }),
  };
}

/** 404 sin distinguir "no existe" de "no es tuya": la RLS devuelve lo mismo en los dos casos. */
function found(result: ProviderPayloadExport): ProviderPayloadExport {
  if (result.entries.length === 0) {
    throw new NotFoundException('No hay payloads guardados para esa búsqueda, o ya vencieron.');
  }
  return result;
}
