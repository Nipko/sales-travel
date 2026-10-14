import { parseArgs } from 'node:util';
import { z } from '@sales-travel/validation';

/**
 * Los argumentos del CLI del arnés, validados con Zod antes de tocar nada. Son pocos y todos tienen
 * forma cerrada: el CLI también lo dispara un workflow, y nada de lo que llega por aquí puede
 * terminar en una ruta de disco ni en una URL sin pasar por un patrón.
 */

export const CERT_RUN_DEFAULT_ROUTES = 'BOG-LIM,LIM-GRU,BOG-MIA';
export const CERT_RUN_DEFAULT_OUT = '/tmp/sabre-cert-run';

export const CERT_RUN_USAGE = [
  'Uso: node dist/providers-sabre/cert-run/sabre-cert-run.js --owner-tenant <uuid> --scenarios <lista> [opciones]',
  '',
  '  --owner-tenant <uuid>  tenant desde el que se resuelve la cuenta de Sabre CERT en la bóveda',
  '  --scenarios <lista>    auth, shop, book-cancel, book-issue-void, seatmap, book-with-seat,',
  '                         ancillaries, shop-ndc, book-issue-refund, o los atajos sab-12, sab-13,',
  '                         sab-21, sab-22, sab-24 (separados por comas)',
  `  --routes <lista>       rutas de búsqueda (default ${CERT_RUN_DEFAULT_ROUTES})`,
  '  --book-route <ruta>    ruta de las reservas (default: la primera de --routes)',
  '  --pax <pasajeros>      1ADT, 2ADT1CHD, 1ADT1INF… (default 1ADT)',
  '  --days <n>             salida dentro de n días (default 30)',
  '  --return-days <n>      ida y vuelta: la vuelta n días después de la salida',
  '  --allow-money          permite emitir, anular, reembolsar y cobrar EMD en CERT',
  '  --account <uuid>       exige que la cuenta resuelta sea ésta',
  `  --out <carpeta>        dónde se escribe la evidencia (default ${CERT_RUN_DEFAULT_OUT})`,
  '  --run-id <id>          nombre de la carpeta de la corrida (default: la fecha y hora)',
  '  --plan                 imprime el plan y sale: sin base y sin red',
  '',
  'Salida: 0 todo bien · 1 un escenario falló · 2 quedó algo sin limpiar · 3 la corrida se negó a correr',
].join('\n');

const UUID = z.string().uuid();

const ArgsSchema = z
  .object({
    'owner-tenant': UUID.optional(),
    account: UUID.optional(),
    scenarios: z
      .string()
      .regex(/^[a-z0-9,-]{0,200}$/, 'escenarios: letras, dígitos, comas y guiones'),
    routes: z.string().regex(/^[A-Za-z,-]{7,100}$/, 'rutas: como BOG-LIM,LIM-GRU'),
    'book-route': z
      .string()
      .regex(/^[A-Za-z]{3}-[A-Za-z]{3}$/, 'ruta: como BOG-LIM')
      .optional(),
    pax: z.string().regex(/^[0-9A-Za-z]{4,12}$/, 'pasajeros: como 1ADT o 2ADT1CHD'),
    days: z.string().regex(/^\d{1,3}$/, 'días: un entero'),
    'return-days': z
      .string()
      .regex(/^\d{1,3}$/, 'días de vuelta: un entero')
      .optional(),
    'allow-money': z.boolean(),
    out: z
      .string()
      .regex(/^\/[A-Za-z0-9._/-]{1,200}$/, 'carpeta: una ruta absoluta sin espacios')
      .refine((path) => !path.split('/').includes('..'), 'carpeta: sin ".."'),
    'run-id': z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/, 'run-id: letras, dígitos, punto, guion y guion bajo')
      .refine((id) => id !== '.' && id !== '..', 'run-id: no puede ser "." ni ".."')
      .optional(),
    plan: z.boolean(),
    help: z.boolean(),
  })
  .superRefine((args, ctx) => {
    if (!args.plan && !args.help && args['owner-tenant'] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['owner-tenant'],
        message: 'falta --owner-tenant: el tenant desde el que se resuelve la cuenta CERT',
      });
    }
  });

export interface CertRunArgs {
  readonly ownerTenant?: string;
  readonly account?: string;
  readonly scenarios: readonly string[];
  readonly routes: readonly string[];
  readonly bookRoute?: string;
  readonly pax: string;
  readonly days: number;
  readonly returnDays?: number;
  readonly allowMoney: boolean;
  readonly out: string;
  readonly runId?: string;
  readonly planOnly: boolean;
  readonly help: boolean;
}

/** Los argumentos no se entienden. `problems` dice cuáles y por qué, sin eco del valor. */
export class CertRunArgsError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`argumentos inválidos: ${problems.join('; ')}`);
    this.name = 'CertRunArgsError';
  }
}

export function parseCertRunArgs(argv: readonly string[]): CertRunArgs {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        'owner-tenant': { type: 'string' },
        account: { type: 'string' },
        scenarios: { type: 'string', default: '' },
        routes: { type: 'string', default: CERT_RUN_DEFAULT_ROUTES },
        'book-route': { type: 'string' },
        pax: { type: 'string', default: '1ADT' },
        days: { type: 'string', default: '30' },
        'return-days': { type: 'string' },
        'allow-money': { type: 'boolean', default: false },
        out: { type: 'string', default: CERT_RUN_DEFAULT_OUT },
        'run-id': { type: 'string' },
        plan: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    // El mensaje de `parseArgs` nombra la opción desconocida, no su valor.
    throw new CertRunArgsError([err instanceof Error ? err.message : 'argumentos ilegibles']);
  }

  const parsed = ArgsSchema.safeParse(values);
  if (!parsed.success) {
    throw new CertRunArgsError(
      parsed.error.issues.map((issue) => `--${issue.path.join('.')}: ${issue.message}`),
    );
  }
  const a = parsed.data;
  const list = (raw: string) =>
    raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  return {
    ...(a['owner-tenant'] === undefined ? {} : { ownerTenant: a['owner-tenant'] }),
    ...(a.account === undefined ? {} : { account: a.account }),
    scenarios: list(a.scenarios),
    routes: list(a.routes),
    ...(a['book-route'] === undefined ? {} : { bookRoute: a['book-route'] }),
    pax: a.pax,
    days: Number(a.days),
    ...(a['return-days'] === undefined ? {} : { returnDays: Number(a['return-days']) }),
    allowMoney: a['allow-money'],
    out: a.out,
    ...(a['run-id'] === undefined ? {} : { runId: a['run-id'] }),
    planOnly: a.plan,
    help: a.help,
  };
}
