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
    test: (b) => isSafeSvg(b.toString('utf8')),
  },
];

/**
 * Lo que puede ejecutar código o traer contenido de afuera dentro de un SVG servido desde nuestro
 * dominio. Antes sólo se miraban los primeros 512 bytes y tres patrones: un `<script>` después de
 * un comentario largo, un `onclick`, un `<foreignObject>` o un `href` a `javascript:` pasaban y
 * quedaban guardados como logo (QA-H-34). Se rechaza el archivo entero ante cualquiera de estos;
 * un logo legítimo no los necesita.
 */
const SVG_ACTIVE_CONTENT = [
  /<script/i,
  /<foreignobject/i,
  /<(iframe|embed|object|animate|set|handler|listener)\b/i,
  /<!entity/i,
  /\son[a-z]+\s*=/i,
  /javascript:/i,
  /&#/,
  /@import/i,
  /url\s*\(\s*["']?(?!#|data:image\/)/i,
];

/**
 * `href` sólo a un elemento del mismo archivo (`#id`) o a una imagen embebida: es lo que exportan
 * Figma o Illustrator con `<use>` e `<image>`. Cualquier otra cosa trae contenido de afuera.
 */
const SAFE_HREF = /^(#|data:image\/(png|jpeg|webp|gif);base64,)/i;

export function isSafeSvg(text: string): boolean {
  if (!/<svg[\s>]/i.test(text)) return false;
  if (SVG_ACTIVE_CONTENT.some((re) => re.test(text))) return false;
  for (const m of text.matchAll(/\bhref\s*=\s*(["']?)([^"'\s>]*)/gi)) {
    if (!SAFE_HREF.test(m[2] ?? '')) return false;
  }
  return true;
}

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
      throw new ForbiddenException('Ese nodo no está en tu red.');
    }

    const body = Buffer.from(dto.dataBase64, 'base64');
    if (body.length === 0) throw new BadRequestException('el archivo está vacío');
    if (body.length > MAX_BYTES) {
      throw new BadRequestException(`el archivo supera el máximo de ${MAX_BYTES / 1024} KB`);
    }

    const match = SIGNATURES.find((s) => s.test(body));
    if (!match) {
      throw new BadRequestException(
        'formato no admitido. Usa PNG, JPG, WebP o SVG (sin scripts embebidos).',
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
