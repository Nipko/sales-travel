import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { BlobMetadata, BlobStoragePort } from '@sales-travel/core';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';

/**
 * Adaptador de BlobStoragePort sobre disco local.
 *
 * `BlobStoragePort` existía como abstracción desde el Sprint 0 pero NINGÚN adaptador la
 * implementaba, así que no se podía subir un archivo: el dropzone de logo del panel era
 * decorativo y lo único aceptado era pegar la URL de un tercero. Eso significaba que la
 * marca de una agencia dependía de que un dominio ajeno siguiera sirviendo la imagen.
 *
 * Es disco y no MinIO a propósito: MinIO todavía no está aprovisionado, y un volumen
 * montado en el VPS resuelve la fase 1 sin bloquear la funcionalidad. Cambiar a
 * MinIO/S3 es escribir otro adaptador de esta misma interfaz y cambiar el provider —
 * ningún consumidor se entera, que es justo para lo que existe el puerto.
 */
@Injectable()
export class LocalDiskStorageAdapter implements BlobStoragePort {
  private readonly logger = new Logger(LocalDiskStorageAdapter.name);
  private readonly root: string;
  /** Base pública desde la que se sirven los blobs (Caddy mapea esta ruta al volumen). */
  private readonly publicBaseUrl: string;

  constructor() {
    this.root = resolve(process.env['BLOB_STORAGE_DIR'] ?? '/var/lib/sales-travel/blobs');
    this.publicBaseUrl = (process.env['BLOB_PUBLIC_BASE_URL'] ?? '/blobs').replace(/\/$/, '');
  }

  /**
   * Resuelve la clave a una ruta DENTRO del root, y falla si se escapa.
   *
   * Sin esto, una clave con `../` permitiría escribir en cualquier parte del disco del
   * servidor. Las claves las arma la app, pero el puerto es público y esta garantía tiene
   * que estar del lado del adaptador.
   */
  private pathFor(key: string): string {
    const clean = normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
    const full = resolve(join(this.root, clean));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error('blob key escapes storage root');
    }
    return full;
  }

  async put(key: string, body: Buffer | Uint8Array, metadata?: BlobMetadata): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    if (metadata?.contentType) {
      // El content-type se guarda al lado: el disco no tiene metadatos propios y el
      // servidor estático lo necesita para no mandar todo como octet-stream.
      await writeFile(`${path}.type`, metadata.contentType, 'utf8');
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch {
      throw new NotFoundException(`blob no encontrado: ${key}`);
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.type`, { force: true });
  }

  /**
   * En disco no hay firma: los blobs de marca son PÚBLICOS por definición (un logo se
   * muestra en un PDF que recibe el cliente final). Se devuelve la URL pública directa.
   * El adaptador de S3/MinIO sí firmará de verdad.
   */
  presignGetUrl(key: string): Promise<string> {
    return Promise.resolve(`${this.publicBaseUrl}/${key}`);
  }

  presignPutUrl(): Promise<string> {
    // La subida va por el endpoint de la API, que valida tipo y tamaño antes de escribir.
    // Un presign de PUT sobre disco no aportaría nada y saltearía esa validación.
    return Promise.reject(new Error('presignPutUrl no está soportado en el adaptador de disco'));
  }

  /** Clave estable y sin colisiones para el activo de marca de un tenant. */
  brandKey(tenantId: string, kind: 'logo' | 'favicon', body: Buffer, ext: string): string {
    const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
    return `tenants/${tenantId}/${kind}-${digest}.${ext}`;
  }

  publicUrlFor(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }
}
