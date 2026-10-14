import { z } from 'zod';

/**
 * Plazos del envío por SMTP. Sin ellos nodemailer espera 2 min a conectar, 30 s el saludo y 10 min
 * de silencio: con un servidor colgado, el flujo que avisa después del commit (alta, invitación,
 * aviso de seguridad, prueba de correo) quedaba esperando y el panel veía la operación "sin
 * confirmar" cuando el BFF o Cloudflare (100 s) cortaban antes.
 */
export interface MailTimeouts {
  /** Hasta tener la conexión TCP/TLS abierta (incluye el DNS). */
  readonly connectionTimeoutMs: number;
  /** Desde la conexión hasta el saludo 220 del servidor. */
  readonly greetingTimeoutMs: number;
  /** Silencio máximo del servidor en cualquier paso de la conversación. */
  readonly socketTimeoutMs: number;
  /**
   * Tope del envío completo. Los plazos de arriba son por paso y un servidor que contesta un byte
   * cada pocos segundos nunca los dispara: este corta el envío entero.
   */
  readonly sendTimeoutMs: number;
}

/** 15 s en total: muy por debajo de los 100 s de Cloudflare y de lo que espera el panel. */
export const MAIL_DEFAULT_TIMEOUTS: MailTimeouts = {
  connectionTimeoutMs: 5_000,
  greetingTimeoutMs: 5_000,
  socketTimeoutMs: 10_000,
  sendTimeoutMs: 15_000,
};

export const MAIL_MIN_TIMEOUT_MS = 100;
/** Tope: un correo nunca puede tener tomada una petición cerca de los 100 s de Cloudflare. */
export const MAIL_MAX_TIMEOUT_MS = 60_000;

const ENV_KEYS = {
  connectionTimeoutMs: 'MAIL_CONNECTION_TIMEOUT_MS',
  greetingTimeoutMs: 'MAIL_GREETING_TIMEOUT_MS',
  socketTimeoutMs: 'MAIL_SOCKET_TIMEOUT_MS',
  sendTimeoutMs: 'MAIL_SEND_TIMEOUT_MS',
} as const satisfies Record<keyof MailTimeouts, string>;

// Un 0 no sirve: nodemailer lo toma como "sin valor" y vuelve a sus plazos de minutos.
const TimeoutMsSchema = z
  .string()
  .regex(/^\d{1,6}$/)
  .transform(Number)
  .pipe(z.number().int().min(MAIL_MIN_TIMEOUT_MS).max(MAIL_MAX_TIMEOUT_MS));

export interface MailTimeoutsConfig {
  readonly timeouts: MailTimeouts;
  /** Por qué se ignoró cada valor del entorno. Nombra la variable, nunca repite el valor. */
  readonly invalidReasons: readonly string[];
}

/**
 * Un valor mal escrito cae al de por defecto con aviso en lugar de tumbar el arranque: es una
 * perilla de las notificaciones y no puede dejar sin API a la red.
 */
export function loadMailTimeouts(
  env: Readonly<Record<string, string | undefined>>,
): MailTimeoutsConfig {
  const timeouts: Record<keyof MailTimeouts, number> = { ...MAIL_DEFAULT_TIMEOUTS };
  const invalidReasons: string[] = [];
  for (const field of Object.keys(ENV_KEYS) as (keyof MailTimeouts)[]) {
    const key = ENV_KEYS[field];
    const raw = env[key]?.trim();
    // `${VAR:-}` del compose llega como cadena vacía: vacío es "no configurado", no un error.
    if (raw === undefined || raw.length === 0) continue;
    const parsed = TimeoutMsSchema.safeParse(raw);
    if (parsed.success) {
      timeouts[field] = parsed.data;
    } else {
      invalidReasons.push(
        `${key} debe ser un entero de milisegundos entre ${MAIL_MIN_TIMEOUT_MS} y ${MAIL_MAX_TIMEOUT_MS}; se usa ${MAIL_DEFAULT_TIMEOUTS[field]}`,
      );
    }
  }
  return { timeouts, invalidReasons };
}
