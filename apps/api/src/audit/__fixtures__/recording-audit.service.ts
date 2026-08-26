import type { AuditEvent, AuditService } from '../audit.service.js';

/**
 * `AuditService` que no toca la base y GUARDA lo que se le emite.
 *
 * Existe para que los tests de las operaciones con dinero puedan afirmar sobre el `domain_event`
 * —que es un requisito (RNF-08), no telemetría— por la puerta pública del servicio, sin montar
 * Postgres. Un doble que sólo cuente llamadas no sirve: la mitad del criterio es QUÉ lleva el
 * payload (la `errorHandlingPolicy` con la que se pidió la reserva) y qué NO lleva (PII).
 */
export class RecordingAuditService {
  readonly events: AuditEvent[] = [];

  emit(event: AuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }

  ofType(eventType: string): AuditEvent[] {
    return this.events.filter((e) => e.eventType === eventType);
  }

  /** El primero de ese tipo, o `undefined`. Azúcar para las aserciones. */
  first(eventType: string): AuditEvent | undefined {
    return this.ofType(eventType)[0];
  }

  types(): string[] {
    return this.events.map((e) => e.eventType);
  }

  /** Serializado entero: para afirmar que un dato PROHIBIDO no aparece en NINGÚN payload. */
  dump(): string {
    return JSON.stringify(this.events);
  }

  asService(): AuditService {
    return this as unknown as AuditService;
  }
}
