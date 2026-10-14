import { Logger } from '@nestjs/common';
import { z } from '@sales-travel/validation';

/**
 * Interruptor del contenido por habitación (`HOTEL_ROOM_CONTENT`, docs/tbo/05 §2.6.3): con `off` la
 * ruta `GET /hotels/content/:proveedor/:hotel/rooms` responde lo que el catálogo ya tiene, aunque
 * esté vencido, y nunca sale al proveedor. Es el kill-switch del API; el del ACL de TBO
 * (`TBO_ROOM_DETAILS`) apaga la clave `IsRoomDetailRequired` aunque alguien la pida.
 *
 * Se lee al arrancar, como `PROVIDERS_DISABLED`: cambiarlo es un redeploy (deploy.yml lo escribe en
 * el .env y docker-compose lo pasa al api con `on` por defecto).
 */

/** Token DI del interruptor ya leído. */
export const HOTEL_ROOM_CONTENT_SWITCH = 'HOTEL_ROOM_CONTENT_SWITCH';

export const HOTEL_ROOM_CONTENT_SWITCH_VALUES = ['on', 'off'] as const;
export type HotelRoomContentSwitch = (typeof HOTEL_ROOM_CONTENT_SWITCH_VALUES)[number];

const SwitchSchema = z.string().trim().toLowerCase().pipe(z.enum(HOTEL_ROOM_CONTENT_SWITCH_VALUES));

export interface HotelRoomContentSwitchRead {
  readonly value: HotelRoomContentSwitch;
  /** Vino un valor que no es `on` ni `off`: se avisa y queda apagado. */
  readonly invalid: boolean;
}

/**
 * Ausente o vacío es `on`; `on`/`off` sin distinguir mayúsculas ni espacios. Cualquier otro valor
 * es `off`: ante la duda, la ficha como era antes, sin llamadas nuevas al proveedor.
 */
export function parseHotelRoomContentSwitch(raw: unknown): HotelRoomContentSwitchRead {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { value: 'on', invalid: false };
  }
  const parsed = SwitchSchema.safeParse(raw);
  return parsed.success ? { value: parsed.data, invalid: false } : { value: 'off', invalid: true };
}

/**
 * El interruptor del proceso, leído de `HOTEL_ROOM_CONTENT`. Un valor inválido se avisa UNA vez y
 * sin repetirlo: una variable mal escrita puede ser un secreto pegado en el lugar equivocado.
 */
export function readHotelRoomContentSwitch(
  logger: Pick<Logger, 'warn'> = new Logger('HotelRoomContent'),
): HotelRoomContentSwitch {
  const read = parseHotelRoomContentSwitch(process.env['HOTEL_ROOM_CONTENT']);
  if (read.invalid) {
    logger.warn(
      'HOTEL_ROOM_CONTENT no es "on" ni "off": el contenido por habitación queda apagado',
    );
  }
  return read.value;
}
