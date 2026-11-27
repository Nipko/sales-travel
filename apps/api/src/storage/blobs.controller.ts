import { Controller, Get, Header, NotFoundException, Param, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator.js';
import { LocalDiskStorageAdapter } from './local-disk-storage.adapter.js';

/**
 * Los activos de marca subidos (logo, favicon), servidos por la API (QA-H-38). Antes la URL
 * apuntaba a `/blobs/*`, que nadie servía: ni Caddy ni el panel, así que ningún logo se veía.
 *
 * Público a propósito: un logo aparece en el PDF y el correo que recibe el cliente final. Sólo se
 * sirve lo que tiene la forma de una clave de marca (`tenants/<uuid>/<logo|favicon>-<hash>.<ext>`)
 * y con el tipo que dice su extensión, que la subida ya validó por contenido. El hash va en la
 * clave: cambiar la imagen cambia la URL, así que se cachea para siempre.
 */
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE = /^(logo|favicon)-[0-9a-f]{16}\.(png|jpg|webp|svg)$/;
const MIME: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

@Public()
@SkipThrottle()
@Controller('blobs')
export class BlobsController {
  constructor(private readonly storage: LocalDiskStorageAdapter) {}

  @Get('tenants/:tenantId/:file')
  // Lo embebe el panel (otro origen) y lo abre un cliente de correo: helmet deja same-origin.
  @Header('Cross-Origin-Resource-Policy', 'cross-origin')
  @Header('Cache-Control', 'public, max-age=31536000, immutable')
  // Abierto directo, un SVG no ejecuta nada ni carga nada de afuera; los estilos internos sí.
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
  async brandAsset(
    @Param('tenantId') tenantId: string,
    @Param('file') file: string,
    @Res() res: Response,
  ): Promise<void> {
    const m = FILE.exec(file);
    if (!KEY.test(tenantId) || m === null) throw new NotFoundException();
    const body = await this.storage.get(`tenants/${tenantId}/${file}`);
    res.setHeader('Content-Type', MIME[m[2]!]!);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(body);
  }
}
