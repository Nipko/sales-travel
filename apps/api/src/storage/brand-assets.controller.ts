import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { AGENCY_ADMIN_ROLES } from '../auth/roles.js';
import { DatabaseService } from '../database/database.service.js';
import { NetworkService } from '../network/network.service.js';
import { ZodValidationPipe } from '../zod/zod-validation.pipe.js';
import { UploadBrandAssetSchema, type UploadBrandAssetDto } from './brand-assets.schemas.js';
import { LocalDiskStorageAdapter } from './local-disk-storage.adapter.js';

/** 512 KB. Un logo de panel no necesita más, y acota el abuso del endpoint. */
const MAX_BYTES = 512 * 1024;

/**
 * Firmas mágicas de los formatos admitidos.
 *
 * Se valida el CONTENIDO, no el content-type declarado: el cliente puede decir
 * `image/png` y mandar cualquier cosa. Sin esto, el endpoint sería un subidor de
 * archivos arbitrarios a un directorio servido públicamente.
 */
const SIGNATURES: { ext: string; mime: string; test: (b: Buffer) => boolean }[] = [
  {
    ext: 'png',
    mime: 'image/png',
    test: (b) => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
  },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: 'webp',
    mime: 'image/webp',
    test: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  },
  {
    ext: 'svg',
    mime: 'image/svg+xml',
    test: (b) => {
      const head = b.subarray(0, 512).toString('utf8').toLowerCase();
      // Un SVG puede contener <script>: se rechaza en vez de servirlo desde nuestro
      // dominio, donde ejecutaría con nuestro origen.
      if (/<script|onload=|javascript:/.test(head)) return false;
      return head.includes('<svg');
    },
  },
];

@Roles(...AGENCY_ADMIN_ROLES)
@Controller('tenants/:id/brand-assets')
export class BrandAssetsController {
  constructor(
    private readonly storage: LocalDiskStorageAdapter,
    private readonly db: DatabaseService,
    private readonly network: NetworkService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Sube el logo o el favicon de una agencia.
   *
   * Recibe el archivo en base64 en el body en vez de multipart: el panel ya manda JSON
   * en todos sus endpoints y el tamaño está acotado a 512 KB, así que no compensa sumar
   * un parser de multipart sólo para esto.
   */
  @Post()
  async upload(
    @CurrentUser() userId: string | undefined,
    @Param('id') tenantId: string,
    @Body(new ZodValidationPipe(UploadBrandAssetSchema)) dto: UploadBrandAssetDto,
  ): Promise<{ url: string }> {
    if (!userId) throw new UnauthorizedException();

    const superadmin = await this.network.isSuperadmin(userId);
    if (!superadmin && !(await this.network.canManageTenant(userId, tenantId))) {
      throw new ForbiddenException('target tenant is outside your network');
    }

    const body = Buffer.from(dto.dataBase64, 'base64');
    if (body.length === 0) throw new BadRequestException('el archivo está vacío');
    if (body.length > MAX_BYTES) {
      throw new BadRequestException(`el archivo supera el máximo de ${MAX_BYTES / 1024} KB`);
    }

    const match = SIGNATURES.find((s) => s.test(body));
    if (!match) {
      throw new BadRequestException(
        'formato no admitido. Usá PNG, JPG, WebP o SVG (sin scripts embebidos).',
      );
    }

    const key = this.storage.brandKey(tenantId, dto.kind, body, match.ext);
    await this.storage.put(key, body, {
      contentType: match.mime,
      cacheControl: 'public, max-age=31536000, immutable',
    });

    // La clave incluye el hash del contenido, así que la URL cambia al cambiar la
    // imagen y puede cachearse para siempre sin invalidación.
    const url = this.storage.publicUrlFor(key);
    const column = dto.kind === 'logo' ? 'logo_url' : 'favicon_url';

    await this.db.withRequestContext({ userId, tenantId }, (trx) =>
      trx
        .updateTable('tenants')
        .set({ [column]: url })
        .where('id', '=', tenantId)
        .execute(),
    );

    await this.audit.emit({
      eventType: 'tenant.brand_asset.uploaded',
      tenantId,
      actorUserId: userId,
      aggregateType: 'tenant',
      aggregateId: tenantId,
      payload: { kind: dto.kind, bytes: body.length, format: match.ext },
    });

    return { url };
  }
}
