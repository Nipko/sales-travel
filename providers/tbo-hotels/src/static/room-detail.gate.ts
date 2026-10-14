import { z } from 'zod';

/**
 * Las dos llaves del detalle por habitación de HotelDetails (`IsRoomDetailRequired`, p. 56-57;
 * docs/tbo/05 §2.6.3; Q-65). El contenido del HOTEL —las fotos y textos que producción ya sirve—
 * nunca puede empeorar por pedir las habitaciones:
 *
 * - **Interruptor** (`TBO_ROOM_DETAILS`, `on` por defecto): con `off` la clave no sale nunca y el
 *   pedido es el de siempre. El paquete no lee `process.env`: el valor lo lee quien arma el cliente
 *   (el factory de `apps/api`) con {@link parseTboRoomDetailsSwitch}.
 * - **Compuerta del proceso** ({@link TboRoomDetailGate}): si TBO rechaza la clave —error, "No
 *   Hotels Found" o hoteles que faltan y que el mismo lote SIN la clave sí trae— el cliente repite
 *   el lote sin ella, y tras {@link TBO_ROOM_DETAIL_REJECTION_LIMIT} rechazos seguidos deja de
 *   mandarla hasta que el proceso se reinicie, con UN `warn`.
 */

export const TBO_ROOM_DETAILS_SWITCH_VALUES = ['on', 'off'] as const;
export type TboRoomDetailsSwitch = (typeof TBO_ROOM_DETAILS_SWITCH_VALUES)[number];

const SwitchSchema = z.string().trim().toLowerCase().pipe(z.enum(TBO_ROOM_DETAILS_SWITCH_VALUES));

export interface TboRoomDetailsSwitchRead {
  readonly value: TboRoomDetailsSwitch;
  /** Vino un valor que no es `on` ni `off`: quien lo leyó lo avisa y queda apagado. */
  readonly invalid: boolean;
}

/**
 * `TBO_ROOM_DETAILS`: ausente o vacío es `on`; `on`/`off` sin distinguir mayúsculas ni espacios.
 * Cualquier otro valor es `off`: ante la duda, el pedido de siempre, que es el que ya funciona.
 */
export function parseTboRoomDetailsSwitch(raw: unknown): TboRoomDetailsSwitchRead {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { value: 'on', invalid: false };
  }
  const parsed = SwitchSchema.safeParse(raw);
  return parsed.success ? { value: parsed.data, invalid: false } : { value: 'off', invalid: true };
}

/**
 * Qué pasó con el detalle por habitación en una llamada a HotelDetails:
 *
 * - `not_requested`: no se pidió.
 * - `switched_off`: se pidió y el interruptor está en `off`; salió el pedido de siempre.
 * - `suspended`: se pidió y la compuerta ya la suspendió en este proceso; ídem.
 * - `served`: salió con la clave y la respuesta es ésa (`roomContents` dice lo que trajo).
 * - `fallback`: salió con la clave, TBO no la aceptó y el contenido es el del lote sin ella;
 *   `roomContents` sólo lleva lo que llegó con la clave de los hoteles que siguen en el resultado.
 *
 * Sólo `served` dice algo de las habitaciones de un hotel: con los demás no se sabe y quien guarda
 * el resultado no puede leerlo como "este hotel no tiene habitaciones".
 */
export type TboRoomDetailStatus =
  | 'not_requested'
  | 'switched_off'
  | 'suspended'
  | 'served'
  | 'fallback';

/** Por qué no sirvió la respuesta con la clave. Vocabulario cerrado para el log y la métrica. */
export type TboRoomDetailRejectionReason = 'error' | 'no_hotels_found' | 'missing_hotels';

/** Rechazos seguidos que suspenden el `IsRoomDetailRequired` en el proceso. */
export const TBO_ROOM_DETAIL_REJECTION_LIMIT = 3;

/**
 * La racha de rechazos del `IsRoomDetailRequired`. Un rechazo es un lote al que la clave le QUITÓ
 * contenido de hotel: el mismo lote sin ella trajo hoteles que con ella no vinieron. Un lote que
 * vuelve igual con y sin la clave no cuenta (TBO no tiene ese contenido), y uno completo con la
 * clave corta la racha. Una vez suspendida, sólo un reinicio la vuelve a abrir.
 */
export class TboRoomDetailGate {
  readonly limit: number;
  #consecutive = 0;
  #suspended = false;

  constructor(limit: number = TBO_ROOM_DETAIL_REJECTION_LIMIT) {
    this.limit =
      Number.isSafeInteger(limit) && limit >= 1 ? limit : TBO_ROOM_DETAIL_REJECTION_LIMIT;
  }

  get suspended(): boolean {
    return this.#suspended;
  }

  get consecutiveRejections(): number {
    return this.#consecutive;
  }

  recordSuccess(): void {
    if (!this.#suspended) this.#consecutive = 0;
  }

  /** `true` sólo la vez que la racha llega al tope: quien llama escribe UN `warn`. */
  recordRejection(): boolean {
    if (this.#suspended) return false;
    this.#consecutive += 1;
    if (this.#consecutive < this.limit) return false;
    this.#suspended = true;
    return true;
  }
}

/**
 * La compuerta del proceso: la comparten todos los clientes de contenido, porque la clave la acepta
 * o la rechaza TBO, no una cuenta. Los tests le pasan al cliente una propia.
 */
export const TBO_PROCESS_ROOM_DETAIL_GATE = new TboRoomDetailGate();
