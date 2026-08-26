import type {
  CancelRetryJob,
  CompensateJob,
  PostSaleQueueService,
  VerifyCreationJob,
} from '../post-sale-queue.service.js';

/**
 * Cola de post-venta que no toca Redis y GUARDA lo que se le encola.
 *
 * Los pasos diferidos del saga —la lectura de cierre que hubo que reintentar y la compensación
 * selectiva— sólo existen si alguien los encola, y "se encoló" es la mitad del criterio: la otra
 * mitad es CON QUÉ ítems. Un doble que devolviera `true` sin guardar nada dejaría pasar una
 * compensación encolada con la lista vacía, que es justo la que no deshace nada.
 */
export class RecordingQueueService {
  readonly cancels: CancelRetryJob[] = [];
  readonly verifications: VerifyCreationJob[] = [];
  readonly compensations: CompensateJob[] = [];

  /** `false` simula "no hay Redis": el saga tiene que registrarlo, no darlo por hecho. */
  constructor(private readonly accepted = true) {}

  enqueueCancelRetry(data: CancelRetryJob): Promise<boolean> {
    this.cancels.push(data);
    return Promise.resolve(this.accepted);
  }

  enqueueVerifyCreation(data: VerifyCreationJob): Promise<boolean> {
    this.verifications.push(data);
    return Promise.resolve(this.accepted);
  }

  enqueueCompensation(data: CompensateJob): Promise<boolean> {
    this.compensations.push(data);
    return Promise.resolve(this.accepted);
  }

  asService(): PostSaleQueueService {
    return this as unknown as PostSaleQueueService;
  }
}
