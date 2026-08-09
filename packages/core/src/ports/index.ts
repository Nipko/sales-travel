// 15 puertos de infraestructura — interfaces que aíslan el dominio de proveedores concretos.
// Implementaciones concretas viven en /providers/* o /apps/api/src/infrastructure/*.
// Ver docs/research/05-arquitectura-referencia.md §"Hexagonal + ACL".

export type { BlobMetadata, BlobStoragePort } from './blob-storage.port.js';
export type { CachePort } from './cache.port.js';
export type { ClockPort } from './clock.port.js';
export type { CryptoPort } from './crypto.port.js';
export type { EventBusPort } from './event-bus.port.js';
export type { FeatureFlagsPort } from './feature-flags.port.js';
export type { IdGeneratorPort } from './id-generator.port.js';
export type { JobQueuePort } from './job-queue.port.js';
export type { LoggerPort } from './logger.port.js';
export type { MetricsPort } from './metrics.port.js';
export type { NotificationPort } from './notification.port.js';
export type { SearchIndexPort } from './search-index.port.js';
export type { SecretsManagerPort } from './secrets-manager.port.js';
export type { TracerPort } from './tracer.port.js';
export type { WorkflowEnginePort } from './workflow-engine.port.js';
