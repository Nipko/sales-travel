import type {
  OrderCreateResult,
  OrderItemKind,
  OrderItemResult,
  OrderView,
} from '@sales-travel/domain';
import type { OrderStatus } from '../database/database.types.js';

/**
 * Saga de creación de reserva: **las decisiones, sin nada de I/O** (D9).
 *
 * Este fichero no tiene ni una dependencia en tiempo de ejecución: sus dos únicos `import` son de
 * TIPOS —el desenlace del dominio y el enum de la columna `orders.status`—, que `tsc` borra al
 * compilar. Ni BullMQ, ni Nest, ni la base, ni ningún adapter.
 *
 * Es a propósito y es la mitad cara del encargo: D9 dice que las sagas con dinero corren hoy sobre
 * el BullMQ que ya existe en `apps/api/src/queue/` y que Temporal entra antes del primer reembolso
 * real. Migrar
 * sale barato sólo si la lógica de compensación NO vive pegada al runner — si `decideAfterVerify`
 * viviera dentro del `Worker`, migrar sería reescribirla, y una reescritura de la lógica que
 * decide si se cancela una reserva es exactamente donde se pierde dinero de verdad.
 *
 * El runner de hoy (`OrdersService` + `PostSaleWorker`) y el de mañana (una workflow de Temporal)
 * ejecutan los mismos tres pasos y consultan las mismas funciones:
 *
 *   1. **crear**  — la llamada al proveedor.
 *   2. **verificar** — una lectura de cierre OBLIGATORIA. No es opcional y no es telemetría:
 *      con Sabre, `createBooking` **no** devuelve `bookingSignature`, así que sin esta lectura
 *      no hay forma de modificar ni de compensar nada después. Ver `hasVersionStamp` en
 *      `OrderCreateAudit` y `docs/sabre/04-create-booking.md`.
 *   3. **compensar** — cancelación SELECTIVA por `itemId` de lo que sí entró, y **sólo cuando
 *      falló algo de lo que la compra DEPENDE**. Un accesorio caído no compensa: la reserva se
 *      conserva y el caso escala. Ver {@link ORDER_ITEM_ROLE}.
 *
 * Regla que atraviesa todo el fichero: **ninguna rama termina en silencio**. Cuando no se sabe
 * qué pasó, la decisión es `escalate`, no `settled`. Un desenlace desconocido persistido como
 * `confirmed` es la mentira que se descubre en el mostrador.
 */

/** Estados en los que la fila `orders` puede quedar tras el saga. Nunca `ticketed`: no emitimos aquí. */
export type SagaOrderStatus = Extract<
  OrderStatus,
  'pending' | 'confirmed' | 'cancelled' | 'failed'
>;

/**
 * Traduce el desenlace del proveedor al enum de `orders.status`.
 *
 * `PARTIAL` NO cae en `confirmed`: hay PNR, pero al menos un ítem no quedó confirmado. Cae en
 * `pending`, que es lo más cercano que hoy admite la columna; el motivo concreto queda en
 * `error_message` y en el `domain_event`.
 */
export const ORDER_STATUS_BY_OUTCOME: Readonly<
  Record<OrderCreateResult['outcome'], SagaOrderStatus>
> = {
  CONFIRMED: 'confirmed',
  PARTIAL: 'pending',
  PENDING: 'pending',
  FAILED: 'failed',
};

/**
 * Papel de un ítem DENTRO de la compra. Es el eje de la regla más cara del fichero.
 *
 * El eje **no** es el precio ni «qué producto es»: es de qué DEPENDE la compra. Un ítem es
 * ESENCIAL cuando, si falla, lo que sí entró deja de poder usarse; es ACCESORIO cuando lo demás
 * sigue sirviendo sin él.
 */
export type OrderItemRole = 'ESSENTIAL' | 'ACCESSORY';

/**
 * El papel de cada tipo de ítem, decidido una vez y en un solo sitio.
 *
 * Es un `Record` **completo** sobre `OrderItemKind` a propósito, no un `Set` con un `default`: el
 * día que el puerto del dominio añada un tipo de ítem, este fichero deja de compilar hasta que
 * alguien decida si el fallo de esa cosa puede cancelar una reserva. Un `default: 'ACCESSORY'`
 * dejaría entrar en silencio productos que sí sostienen el viaje; un `default: 'ESSENTIAL'`
 * convertiría cualquier extra nuevo en un motivo para cancelar un vuelo.
 *
 * ⚠️ **`hotel` como ACCESORIO es la entrada discutible de esta tabla**, y está así a sabiendas.
 * Un hotel no es un extra —es medio paquete y a veces el motivo del viaje—, pero el criterio de
 * la tabla no es la importancia comercial:
 *
 *  1. **La dependencia va en un solo sentido.** Sin el vuelo, el hotel de Lima no se puede usar;
 *     sin el hotel, el vuelo a Lima sigue volando y el cliente duerme en otro sitio. Cancelar el
 *     vuelo porque cayó el hotel destruye lo único que seguía sirviendo.
 *  2. **Los dos errores no cuestan lo mismo.** No compensar deja la reserva viva y ESCALA: una
 *     persona la ve y la deshace a mano si hay que deshacerla. Compensar de más devuelve al
 *     inventario una tarifa aérea que puede no volver a existir, y eso no tiene vuelta.
 *  3. **Cambiarlo es una línea con nombre.** Si negocio decide que un paquete cae entero cuando
 *     cae el hotel, se cambia esta entrada y el test que la fija dice exactamente qué se cambió.
 */
export const ORDER_ITEM_ROLE: Readonly<Record<OrderItemKind, OrderItemRole>> = {
  /** Sin vuelo el cliente no está en la ciudad: el hotel, el coche y el asiento sobran. */
  flight: 'ESSENTIAL',
  /** Ver la nota de arriba: la compra no depende de él, y equivocarse aquí es reversible. */
  hotel: 'ACCESSORY',
  /** Se sustituye en el mostrador del destino; su fallo jamás justifica tirar la tarifa aérea. */
  car: 'ACCESSORY',
  /** Equipaje, comidas y demás extras: cuelgan del vuelo y el viaje ocurre sin ellos. */
  ancillary: 'ACCESSORY',
  /**
   * El caso que originó la regla. El asiento cuelga de SU vuelo, y el contrato de Sabre ni
   * siquiera le da `itemId` ni carril en `CancelBookingRequest`: no hay forma de cancelarlo, sólo
   * de cancelar el vuelo entero en su lugar.
   */
  seat: 'ACCESSORY',
};

/**
 * Los ítems FALLIDOS de los que la compra depende. Vacío ⇒ no se cayó nada esencial.
 *
 * Sólo cuenta `FAILED`. Un esencial `UNCONFIRMED` **no** es un fallo: el ítem existe en la
 * reserva y todavía puede confirmarse solo (lista de espera, `NN` sin respuesta), y tratarlo como
 * caído dispararía una compensación que cancela justo lo que aún podía salir bien.
 */
export function failedEssentialItems(result: OrderCreateResult): readonly OrderItemResult[] {
  return result.items.filter(
    (item) => item.status === 'FAILED' && ORDER_ITEM_ROLE[item.kind] === 'ESSENTIAL',
  );
}

/** Por qué hay que deshacer parte de lo que se creó. Vocabulario cerrado: va al `domain_event`. */
export type CompensationReason =
  /** `PARTIAL`: la reserva existe y se cayó al menos un ítem **esencial**. */
  | 'partial-items-failed'
  /** La lectura de cierre dice que el proveedor ya la tiene por cancelada, y nosotros no. */
  | 'verified-cancelled-upstream';

/** Por qué esto necesita una persona. También vocabulario cerrado. */
export type EscalationReason =
  /** La llamada de creación lanzó: **no sabemos** si hay reserva del otro lado. */
  | 'create-uncertain'
  /** El proveedor respondió, pero no se pudo consolidar ese resultado en el intent durable. */
  | 'result-persistence-unavailable'
  /** El resultado se consolidó, pero falló la verificación/aplicación posterior al write. */
  | 'post-create-finalization-unavailable'
  /** Hay reserva pero el proveedor no la devuelve como localizador utilizable. */
  | 'created-without-locator'
  /** El proveedor no sabe leer reservas, o la lectura de cierre falló: la creación no se cerró. */
  | 'verification-unavailable'
  /** Leímos y el proveedor dice que esa reserva no existe. */
  | 'verified-not-found'
  /** Hay que compensar y el proveedor no dijo QUÉ ítems se pueden cancelar. */
  | 'compensation-targets-unknown'
  /**
   * El desenlace es parcial pero **no se cayó nada de lo que la compra depende**: un accesorio
   * fuera (el asiento, un extra) o un `errors[]` sin ningún ítem caído.
   *
   * La reserva se CONSERVA. Cancelar un vuelo confirmado porque no había asiento es indefendible:
   * la tarifa puede haber desaparecido y el cliente se queda sin viaje por un extra. Perder el
   * asiento es recuperable; perder el vuelo no. Así que no se compensa, y lo mira una persona —que
   * es quien puede pedir otro asiento, o deshacer la reserva si el cliente no la quiere así.
   */
  | 'partial-without-essential-failure'
  /** Se canceló y el proveedor no confirmó el resultado (`UNVERIFIED`). */
  | 'cancellation-unverified';

/**
 * Lo que el runner tiene que hacer a continuación.
 *
 * `status` viaja en las tres ramas porque la fila `orders` se escribe siempre, incluso —sobre
 * todo— cuando hay que escalar: una orden que necesita intervención humana y no está en la
 * base es una orden que nadie va a encontrar.
 */
export type SagaDecision =
  | { readonly kind: 'settled'; readonly status: SagaOrderStatus }
  | {
      readonly kind: 'compensate';
      readonly reason: CompensationReason;
      /** Ítems a cancelar, uno a uno. **Nunca vacío**: si estuviera vacío la decisión es `escalate`. */
      readonly cancellableItemIds: readonly string[];
      readonly status: SagaOrderStatus;
    }
  | {
      readonly kind: 'escalate';
      readonly reason: EscalationReason;
      readonly status: SagaOrderStatus;
    };

/** Qué hacer con la lectura de cierre, decidido ANTES de gastar una llamada. */
export type VerificationPlan =
  | { readonly kind: 'verify'; readonly locator: string }
  /** No hay nada que verificar y no es una anomalía: la creación falló sin dejar reserva. */
  | { readonly kind: 'skip'; readonly status: SagaOrderStatus }
  | {
      readonly kind: 'escalate';
      readonly reason: EscalationReason;
      readonly status: SagaOrderStatus;
    };

/** Estados con los que un proveedor declara una reserva muerta. Comparación en mayúsculas. */
export const CANCELLED_STATUSES: readonly string[] = ['CANCELLED', 'CANCELED', 'VOID', 'VOIDED'];

/**
 * El localizador con el que se relee la reserva.
 *
 * El PNR manda sobre el `orderId` porque es el identificador con el que `getBooking` direcciona
 * (`confirmationId`); el `orderId` NDC sólo se usa si no hubo PNR. No se inventa ninguno.
 */
export function locatorOf(result: OrderCreateResult): string | undefined {
  const pnr = result.pnr?.trim();
  if (pnr !== undefined && pnr.length > 0) return pnr;
  const orderId = result.orderId?.trim();
  return orderId !== undefined && orderId.length > 0 ? orderId : undefined;
}

/**
 * ¿Hay que cerrar esta creación con una lectura?
 *
 * `caps.retrieve === false` **no** convierte la verificación en opcional: convierte la creación
 * en no cerrable, y eso se escala. Es la diferencia entre "no hace falta comprobarlo" y "no
 * pudimos comprobarlo", y colapsarlas es lo que deja reservas huérfanas que nadie mira.
 */
export function planVerification(
  result: OrderCreateResult,
  caps: { readonly retrieve: boolean },
): VerificationPlan {
  const status = ORDER_STATUS_BY_OUTCOME[result.outcome];
  const locator = locatorOf(result);

  if (locator === undefined) {
    // Sin localizador y con `FAILED` no hay nada del otro lado: es el único cierre limpio sin leer.
    if (result.outcome === 'FAILED') return { kind: 'skip', status };
    // Con cualquier otro desenlace, el proveedor dice que creó algo que no sabemos nombrar.
    return { kind: 'escalate', reason: 'created-without-locator', status };
  }

  if (!caps.retrieve) return { kind: 'escalate', reason: 'verification-unavailable', status };

  return { kind: 'verify', locator };
}

/**
 * Ítems que se pueden deshacer, en el orden en que el proveedor los declaró.
 *
 * Primero lo que el proveedor dijo explícitamente (`compensation.cancellableItemIds`); si no lo
 * dijo, los ítems que SÍ quedaron confirmados y tienen id — que son los que sobreviven a un
 * parcial y por tanto los únicos que hay que deshacer. `UNCONFIRMED` no entra: el ítem existe y
 * todavía puede confirmarse, y cancelarlo es tirar lo que aún podía salir bien.
 */
export function compensationTargets(result: OrderCreateResult): readonly string[] {
  const declared = result.compensation?.cancellableItemIds ?? [];
  if (declared.length > 0) return [...declared];
  return result.items
    .filter((item) => item.status === 'CONFIRMED' && item.providerItemId !== undefined)
    .map((item) => item.providerItemId as string);
}

/** ¿El proveedor declara esta reserva muerta? */
function isCancelledUpstream(view: OrderView): boolean {
  const status = view.status?.toUpperCase();
  return status !== undefined && CANCELLED_STATUSES.includes(status);
}

/**
 * Convierte "hay que compensar" en una decisión concreta. Sólo se llama cuando ya está decidido
 * QUE hay que compensar; el filtro de si el fallo lo merece vive en {@link decideAfterVerify}.
 *
 * Si no hay ítems que cancelar, la decisión **no** es un `cancelAll` ciego: es `escalate`. Tirar
 * de la manta en un éxito parcial cancela también lo que sí quedó bien.
 */
function compensateOrEscalate(
  result: OrderCreateResult,
  reason: CompensationReason,
  status: SagaOrderStatus,
): SagaDecision {
  const cancellableItemIds = compensationTargets(result);
  if (cancellableItemIds.length === 0) {
    return { kind: 'escalate', reason: 'compensation-targets-unknown', status };
  }
  return { kind: 'compensate', reason, cancellableItemIds, status };
}

/**
 * La decisión final, con la lectura de cierre ya hecha.
 *
 * `view === null` significa que la lectura **no se pudo hacer** (el proveedor lanzó). No es lo
 * mismo que `view.found === false`, que es el proveedor contestando que esa reserva no existe:
 * lo primero es ignorancia nuestra y lo segundo es una contradicción con lo que acabamos de
 * crear. Las dos escalan, con motivos distintos, y ninguna de las dos se persiste como
 * `confirmed`.
 */
export function decideAfterVerify(input: {
  readonly created: OrderCreateResult;
  readonly view: OrderView | null;
}): SagaDecision {
  const { created, view } = input;
  const outcome = created.outcome;
  const status = ORDER_STATUS_BY_OUTCOME[outcome];

  if (view === null) return { kind: 'escalate', reason: 'verification-unavailable', status };

  if (!view.found) {
    // Nunca `failed`: el proveedor pudo devolver `found: false` por una lectura degradada, y
    // marcar como fallida una reserva que existe es lo que produce un billete sin dueño.
    return { kind: 'escalate', reason: 'verified-not-found', status: 'pending' };
  }

  if (isCancelledUpstream(view)) {
    // Creamos algo que el proveedor ya da por muerto. Si hay ítems vivos hay que deshacerlos;
    // si no los hay, es una orden cancelada del otro lado y se registra como tal.
    //
    // Esta rama NO pasa por la puerta de {@link failedEssentialItems}, y es deliberado: aquí no
    // se cancela nada por culpa de un accesorio: la reserva entera ya está muerta del otro lado y
    // lo que queda es limpiar los restos. Dejar un ítem vivo colgando de una reserva cancelada es
    // como aparece un segmento fantasma que se emite solo.
    const targets = compensationTargets(created);
    if (targets.length === 0) return { kind: 'settled', status: 'cancelled' };
    return {
      kind: 'compensate',
      reason: 'verified-cancelled-upstream',
      cancellableItemIds: targets,
      status,
    };
  }

  if (outcome === 'PARTIAL') {
    // **UN FALLO DE ACCESORIO NUNCA CANCELA EL PRODUCTO.** La compensación se dispara por el
    // fallo de algo de lo que la compra DEPENDE, no por cualquier desenlace parcial: un asiento
    // denegado, un extra caído o un `errors[]` sin ítem caído dejan la reserva intacta y escalan.
    //
    // Sin esta puerta, `compensationTargets` de un parcial con el asiento fuera devuelve
    // exactamente un id —el del VUELO CONFIRMADO, porque es el único ítem vivo con id— y el saga
    // cancela el vuelo del cliente porque no había asiento.
    if (failedEssentialItems(created).length === 0) {
      return { kind: 'escalate', reason: 'partial-without-essential-failure', status };
    }
    return compensateOrEscalate(created, 'partial-items-failed', status);
  }

  // `CONFIRMED` y `PENDING` verificados: no hay nada que deshacer. `PENDING` sigue en `pending`
  // a propósito — la reserva existe y el proveedor todavía no la resolvió.
  return { kind: 'settled', status };
}

/**
 * La creación LANZÓ. No es lo mismo que `FAILED`.
 *
 * Un `FAILED` es el proveedor diciendo "no reservé nada". Un timeout es el proveedor no diciendo
 * nada: la reserva puede existir. Por eso el estado sigue `pending` y la decisión es `escalate`
 * con `create-uncertain`, para que quede una fila que una persona pueda buscar en el PCC. Marcarla
 * `failed` habilitaría otro intento aunque el primero quizá sí creó el PNR: así aparecen reservas
 * duplicadas que siguen ocupando asiento y se emiten solas.
 */
export function decideAfterCreateThrew(): SagaDecision {
  return { kind: 'escalate', reason: 'create-uncertain', status: 'pending' };
}

/**
 * Lo que se persiste en `orders.provider_raw` cuando el adapter NO entrega una vista auditada.
 *
 * Lista BLANCA, no un volcado con campos quitados. `message` y `fieldValue` se quedan fuera:
 * `fieldValue` es el valor que MANDAMOS devuelto tal cual —el documento del pasajero, y un PAN
 * el día que alguien encendiera el flag de tarjeta— y `message` es texto libre del proveedor.
 * `provider_raw` se persiste para siempre.
 */
export function fallbackProviderRaw(
  providerCode: string,
  result: OrderCreateResult,
): Record<string, unknown> {
  return {
    provider: providerCode,
    audited: false,
    outcome: result.outcome,
    ...(result.pnr === undefined ? {} : { pnr: result.pnr }),
    ...(result.orderId === undefined ? {} : { orderId: result.orderId }),
    items: result.items.map((item) => ({
      kind: item.kind,
      status: item.status,
      ...(item.providerItemId === undefined ? {} : { providerItemId: item.providerItemId }),
      ...(item.statusCode === undefined ? {} : { statusCode: item.statusCode }),
    })),
    issues: result.issues.map((issue) => ({
      severity: issue.severity,
      category: issue.category,
      type: issue.type,
      ...(issue.fieldPath === undefined ? {} : { fieldPath: issue.fieldPath }),
    })),
  };
}

/**
 * Resumen de la lectura de cierre para el `domain_event`.
 *
 * `warnings` del proveedor NO entran: en la lectura de Sabre son códigos nuestros, pero el
 * puerto del dominio los declara `string[]` y cualquier adapter podría meter ahí una frase del
 * vendor. Se cuenta, no se copia.
 */
export function verificationSummary(view: OrderView | null): Record<string, unknown> {
  if (view === null) return { verified: false, reason: 'read-failed' };
  return {
    verified: true,
    found: view.found,
    ...(view.status === undefined ? {} : { providerStatus: view.status }),
    airlineLocators: view.airlineLocators.length,
    ticketNumbers: view.ticketNumbers?.length ?? 0,
    warnings: view.warnings.length,
  };
}
