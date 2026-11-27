import { Global, Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module.js';
import { BlobsController } from './blobs.controller.js';
import { BrandAssetsController } from './brand-assets.controller.js';
import { LocalDiskStorageAdapter } from './local-disk-storage.adapter.js';

/**
 * Almacenamiento de blobs.
 *
 * El adaptador se resuelve acá: cambiar a MinIO/S3 en la fase 2 es reemplazar el
 * provider por otra implementación de BlobStoragePort, sin tocar a los consumidores.
 */
@Global()
@Module({
  imports: [NetworkModule],
  controllers: [BrandAssetsController, BlobsController],
  providers: [LocalDiskStorageAdapter],
  exports: [LocalDiskStorageAdapter],
})
export class StorageModule {}
