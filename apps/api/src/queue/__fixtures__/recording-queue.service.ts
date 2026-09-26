import {
  POST_SALE_JOBS,
  cancelRetryJobId,
  POST_SALE_SWEEP_EVERY_MS,
  compensationJobId,
  isValidDelayMs,
  verifyHotelBookingJobId,
  type CancelRetryJob,
  type CompensateJob,
  type PostSaleEnqueueOptions,
  type PostSaleJobName,
  type PostSaleQueueService,
  type VerifyCreationJob,
  type VerifyHotelBookingJob,
} from '../post-sale-queue.service.js';

/**
 * La regla de `jobId` de BullMQ 5.78.0, copiada de `Job.validateOptions`
 * (`node_modules/.pnpm/bullmq@5.78.0/node_modules/bullmq/dist/cjs/classes/job.js`, ~l. 1041-1050).
 * Devuelve el mensaje con el que BullMQ rechazaría el id, o `undefined` si lo acepta.
 *
 * Vive en el doble porque el doble no pasa por BullMQ, y por eso el `cancel:<orderId>` de dos
 * segmentos pasó todos los tests mientras en producción no se encolaba nada.
 * `post-sale-queue.integration.test.ts` la compara con la de BullMQ: si una versión nueva cambia
 * la regla, ese test cae antes que la cola.
 */
export function bullMqJobIdRejection(jobId: string): string | undefined {
  if (`${parseInt(jobId, 10)}` === jobId) return 'Custom Id cannot be integers';
  if (jobId.includes(':') && jobId.split(':').length !== 3) return 'Custom Id cannot contain :';
  return undefined;
}

export interface RecordedPostSaleJob {
  name: PostSaleJobName;
  data: CancelRetryJob | VerifyCreationJob | CompensateJob | VerifyHotelBookingJob;
  jobId?: string;
  delayMs?: number;
  /** Por qué la cola real no lo habría encolado; ausente si lo habría aceptado. */
  rejection?: string;
}

/**
 * Cola de post-venta que no toca Redis y GUARDA lo que se le encola.
 *
 * Los pasos diferidos del saga —la lectura de cierre que hubo que reintentar y la compensación
 * selectiva— sólo existen si alguien los encola, y "se encoló" es la mitad del criterio: la otra
 * mitad es CON QUÉ ítems. Un doble que devolviera `true` sin guardar nada dejaría pasar una
 * compensación encolada con la lista vacía, que es justo la que no deshace nada.
 *
 * `cancels`, `verifications` y `compensations` son lo que se PIDIÓ encolar. `jobs` es lo que
 * recibiría BullMQ —nombre, `jobId` armado igual que en la cola real, retardo— y si lo rechazaría;
 * un encolado rechazado devuelve `false`, como la cola real.
 */
export class RecordingQueueService {
  readonly cancels: CancelRetryJob[] = [];
  readonly verifications: VerifyCreationJob[] = [];
  readonly compensations: CompensateJob[] = [];
  readonly hotelVerifications: VerifyHotelBookingJob[] = [];
  /** Intervalos con que se pidió programar el barrido. */
  readonly sweeperSchedules: number[] = [];
  readonly jobs: RecordedPostSaleJob[] = [];

  /** `false` simula "no hay Redis": el saga tiene que registrarlo, no darlo por hecho. */
  constructor(private readonly accepted = true) {}

  enqueueCancelRetry(data: CancelRetryJob, options: PostSaleEnqueueOptions = {}): Promise<boolean> {
    this.cancels.push(data);
    return this.record(POST_SALE_JOBS.cancel, data, cancelRetryJobId(data), options);
  }

  enqueueVerifyCreation(
    data: VerifyCreationJob,
    options: PostSaleEnqueueOptions = {},
  ): Promise<boolean> {
    this.verifications.push(data);
    return this.record(POST_SALE_JOBS.verifyCreation, data, undefined, options);
  }

  enqueueCompensation(data: CompensateJob, options: PostSaleEnqueueOptions = {}): Promise<boolean> {
    this.compensations.push(data);
    return this.record(POST_SALE_JOBS.compensate, data, compensationJobId(data), options);
  }

  enqueueVerifyHotelBooking(
    data: VerifyHotelBookingJob,
    options: PostSaleEnqueueOptions = {},
  ): Promise<boolean> {
    this.hotelVerifications.push(data);
    return this.record(
      POST_SALE_JOBS.verifyHotelBooking,
      data,
      verifyHotelBookingJobId(data),
      options,
    );
  }

  scheduleSweeper(everyMs: number = POST_SALE_SWEEP_EVERY_MS): Promise<boolean> {
    this.sweeperSchedules.push(everyMs);
    return Promise.resolve(this.accepted);
  }

  asService(): PostSaleQueueService {
    return this as unknown as PostSaleQueueService;
  }

  private record(
    name: PostSaleJobName,
    data: RecordedPostSaleJob['data'],
    jobId: string | undefined,
    { delayMs }: PostSaleEnqueueOptions,
  ): Promise<boolean> {
    const rejection =
      delayMs !== undefined && !isValidDelayMs(delayMs)
        ? `retardo inválido (${delayMs} ms)`
        : jobId === undefined
          ? undefined
          : bullMqJobIdRejection(jobId);
    this.jobs.push({
      name,
      data,
      ...(jobId === undefined ? {} : { jobId }),
      ...(delayMs === undefined ? {} : { delayMs }),
      ...(rejection === undefined ? {} : { rejection }),
    });
    return Promise.resolve(this.accepted && rejection === undefined);
  }
}
