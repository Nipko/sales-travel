/**
 * Un tope de llamadas por ventana deslizante y por clave (el código del proveedor): las llamadas
 * EXTRA del contenido por lote, las que parten un lote que el proveedor contestó vacío entero
 * (docs/tbo/05 CE-23). Sin él, una ráfaga de pantallas de resultados con hoteles sin contenido
 * gastaría el cupo de fondo de la cuenta en particiones.
 *
 * En memoria del proceso, como el breaker y el limitador: hay un solo contenedor de API. Con dos,
 * cada uno tendría su tope y el total se duplicaría; va al mismo port que el limitador el día que
 * se escale (docs/tbo/01 §7.2 punto 6).
 */
export class SlidingWindowBudget {
  private readonly taken = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Toma un lugar de la ventana de `key`; `false` si está llena, y entonces no toma nada. */
  tryTake(key: string): boolean {
    const now = this.now();
    const recent = (this.taken.get(key) ?? []).filter((at) => now - at < this.windowMs);
    const allowed = recent.length < this.max;
    if (allowed) recent.push(now);
    this.taken.set(key, recent);
    return allowed;
  }
}
