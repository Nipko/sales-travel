/**
 * El rastro del barrido de post-venta en `domain_events`: una fila por corrida, en la raíz `platform`
 * y sin actor. Es lo que lee Plataforma → Sistema › Procesos para decir si el barrido corre, sin que
 * el superadmin tenga que leer los logs del api.
 *
 * Sólo conteos y códigos: nunca un id de orden, un localizador ni el mensaje de un error.
 *
 * El prefijo `system.` los deja fuera de la actividad de la red (AuditService.networkAudit): cada 15
 * minutos taparían lo que hicieron las personas.
 */
export const POST_SALE_SWEEP_EVENTS = {
  /** `{ durationMs, tenants, tenantsFailed, examined, adopted, staleCancelClaims, cancellations, hcn, reconciliation, ticketIssues, deadlineAlerts }`. */
  completed: 'system.post_sale_sweep.completed',
  /**
   * `{ errorClass }`: el nombre de la clase del error, nunca su mensaje. Una corrida que terminó sin
   * poder revisar ningún nodo también es una caída: `{ errorClass: 'AllTenantsFailed', durationMs,
   * tenants, tenantsFailed }` ({@link POST_SALE_SWEEP_ALL_TENANTS_FAILED}).
   */
  failed: 'system.post_sale_sweep.failed',
} as const;

/**
 * La "clase" del `failed` de una corrida que recorrió la lista pero no pudo revisar ningún nodo (una
 * migración a medias, la RLS que rechaza a `app_user`): si contara como correcta, Sistema › Procesos
 * diría "Corriendo" mientras el barrido no hace nada, y el Resumen nunca avisaría.
 */
export const POST_SALE_SWEEP_ALL_TENANTS_FAILED = 'AllTenantsFailed';

/** El agregado de las tareas automáticas en `domain_events`. */
export const SYSTEM_JOB_AGGREGATE = 'system_job';

/** El id del barrido como agregado. */
export const POST_SALE_SWEEP_JOB_ID = 'post-sale-sweep';
