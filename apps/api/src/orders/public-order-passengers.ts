import { last4 } from './order-travelers.plan.js';

/*
 * Los pasajeros de una orden tal como cruzan el borde HTTP (`GET /orders`, `GET /orders/:id`,
 * `POST /orders`): el número del documento y el del viajero frecuente salen ENMASCARADOS, por sus
 * últimos caracteres (nunca más de la mitad), igual que la lectura de «Datos de pasajeros» (SAB-25).
 *
 * `orders.passengers` guarda el documento entero de la reserva tal como se creó, y la pantalla sólo
 * lo muestra para reconocerlo. Ningún flujo del navegador lo necesita entero: lo que habla con el
 * proveedor (emitir, pagar, cancelar, modificar) lo lee de la base en el servidor, nunca del
 * navegador. Un número completo en la lista de Reservas era un pasaporte en el caché del navegador,
 * en una captura de pantalla o en la extensión de turno.
 */

type Json = Record<string, unknown>;

/** Lo que ya viene enmascarado (una orden corregida guarda sólo esto). */
const TAIL = /^[A-Z0-9]{0,4}$/;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `record` sin `fullKey`, con `tailKey` = sus últimos caracteres (o el que ya traía). */
function masked(record: Json, fullKey: string, tailKey: string): Json {
  const { [fullKey]: full, [tailKey]: tail, ...rest } = record;
  const fromFull = typeof full === 'string' && full.length > 0 ? last4(full) : undefined;
  const kept = typeof tail === 'string' && TAIL.test(tail) ? tail : undefined;
  const value = fromFull ?? kept;
  return value === undefined ? rest : { ...rest, [tailKey]: value };
}

/**
 * Lo que un pasajero de la orden publica: todo igual salvo `identityDoc.number` →
 * `identityDoc.numberLast4` y `loyaltyProgramAccount.accountNumber` →
 * `loyaltyProgramAccount.accountNumberLast4`. Un documento o un programa que no es un objeto no sale
 * (no se sabe qué lleva). Lo que no es una lista se devuelve tal cual.
 */
export function publicOrderPassengers(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((item: unknown) => {
    if (!isRecord(item)) return item;
    const { identityDoc, loyaltyProgramAccount, ...rest } = item;
    return {
      ...rest,
      ...(isRecord(identityDoc)
        ? { identityDoc: masked(identityDoc, 'number', 'numberLast4') }
        : {}),
      ...(isRecord(loyaltyProgramAccount)
        ? {
            loyaltyProgramAccount: masked(
              loyaltyProgramAccount,
              'accountNumber',
              'accountNumberLast4',
            ),
          }
        : {}),
    };
  });
}
