import {
  POST_SALE_JOBS,
  cancelRetryJobId,
  POST_SALE_SWEEP_EVERY_MS,
  RECONCILIATION_DAILY_CRON,
  compensationJobId,
  hcnCheckJobId,
  isValidDelayMs,
  issueTicketsJobId,
  reconcileAccountJobId,
  verifyCancellationJobId,
  verifyHotelBookingJobId,
  verifyIssueJobId,
  type CancelRetryJob,
  type CompensateJob,
  type HcnCheckJob,
  type IssueTicketsJob,
  type PostSaleEnqueueOptions,
  type PostSaleJobName,
  type PostSaleQueueService,
  type ReconcileProviderAccountJob,
  type VerifyCancellationJob,
  type VerifyCreationJob,
  type VerifyHotelBookingJob,
  type VerifyIssueJob,
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
  data:
    | CancelRetryJob
    | VerifyCreationJob
    | CompensateJob
    | VerifyHotelBookingJob
    | VerifyCancellationJob
    | HcnCheckJob
    | ReconcileProviderAccountJob
    | IssueTicketsJob
    | VerifyIssueJob;
  jobId?: string;
  delayMs?: number;
  /** Intentos que pediría a BullMQ. Ausente = los 5 de siempre. */
  attempts?: number;
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
  readonly cancelVerifications: VerifyCancellationJob[] = [];
  readonly hcnChecks: HcnCheckJob[] = [];
  readonly reconciliations: ReconcileProviderAccountJob[] = [];
  readonly issues: IssueTicketsJob[] = [];
  readonly issueVerifications: { data: VerifyIssueJob; delayMs?: number }[] = [];
  /** Intervalos con que se pidió programar el barrido. */
  readonly sweeperSchedules: number[] = [];
  /** Patrones con que se pidió programar la conciliación diaria. */
  readonly reconciliationSchedules: string[] = [];
  readonly jobs: RecordedPostSaleJob[] = [];

  /** `false` simula "no hay Redis": el saga tiene que registrarlo, no darlo por hecho. */
  constructor(private accepted = true) {}

  /** Cambia la respuesta de la cola a mitad del test (Redis que se cae o vuelve). */
  accept(accepted: boolean): void {
    this.accepted = accepted;
  }

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

  enqueueVerifyCancellation(
    data: VerifyCancellationJob,
    options: PostSaleEnqueueOptions = {},
  ): Promise<boolean> {
    this.cancelVerifications.push(data);
    return this.record(
      POST_SALE_JOBS.verifyCancellation,
      data,
      verifyCancellationJobId(data),
      options,
    );
  }

  enqueueHcnCheck(data: HcnCheckJob, options: PostSaleEnqueueOptions = {}): Promise<boolean> {
    this.hcnChecks.push(data);
    return this.record(POST_SALE_JOBS.hcnCheck, data, hcnCheckJobId(data), options);
  }

  enqueueIssue(data: IssueTicketsJob): Promise<boolean> {
    this.issues.push(data);
    return this.record(POST_SALE_JOBS.issue, data, issueTicketsJobId(data), {}, 1);
  }

  enqueueVerifyIssue(data: VerifyIssueJob, options: PostSaleEnqueueOptions = {}): Promise<boolean> {
    this.issueVerifications.push({
      data,
      ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
    });
    return this.record(POST_SALE_JOBS.verifyIssue, data, verifyIssueJobId(data), options);
  }

  enqueueReconcileAccount(data: ReconcileProviderAccountJob): Promise<boolean> {
    this.reconciliations.push(data);
    return this.record(POST_SALE_JOBS.reconcileAccount, data, reconcileAccountJobId(data), {});
  }

  scheduleReconciliation(pattern: string = RECONCILIATION_DAILY_CRON): Promise<boolean> {
    this.reconciliationSchedules.push(pattern);
    return Promise.resolve(this.accepted);
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
    attempts?: number,
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
      ...(attempts === undefined ? {} : { attempts }),
      ...(rejection === undefined ? {} : { rejection }),
    });
    return Promise.resolve(this.accepted && rejection === undefined);
  }
}
