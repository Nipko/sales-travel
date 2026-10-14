import type { ApiResponse } from '../../../../../lib/api';

/*
 * `POST /api/orders/:id/issue` del panel → `POST /orders/:id/issue` del API (SAB-08).
 *
 * El cuerpo es sólo lo que el vendedor vio al confirmar: el total en unidades menores y la moneda.
 * Se valida aquí, en el borde, con la misma forma estricta que el API: un campo de más (una tarjeta,
 * por ejemplo) no viaja. El estado y el cuerpo de la respuesta se reenvían COMPLETOS: un 409 («ya
 * hay una emisión en curso») o un 503 («no se emitió nada») tienen que llegar con su texto.
 */

export interface IssueProxyReply {
  readonly status: number;
  readonly body: unknown;
}

type ApiCall = (path: string, init: RequestInit) => Promise<ApiResponse>;

export interface IssueBody {
  readonly expectedTotalMinor: number;
  readonly currency: string;
}

/** El cuerpo validado, o `null`. Sin claves de más, total entero y moneda ISO en mayúsculas. */
export function issueBodyOf(raw: unknown): IssueBody | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'currency' || keys[1] !== 'expectedTotalMinor') return null;
  const { expectedTotalMinor, currency } = record;
  if (
    typeof expectedTotalMinor !== 'number' ||
    !Number.isSafeInteger(expectedTotalMinor) ||
    expectedTotalMinor < 0
  ) {
    return null;
  }
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  return { expectedTotalMinor, currency };
}

const INVALIDO = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'El pedido de emisión llegó incompleto. Vuelve a abrir la reserva e inténtalo de nuevo.',
};

export async function proxyOrderIssue(
  req: Request,
  orderId: string,
  call: ApiCall,
): Promise<IssueProxyReply> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { status: 400, body: INVALIDO };
  }
  const body = issueBodyOf(raw);
  if (body === null) return { status: 400, body: INVALIDO };

  const res = await call(`/orders/${encodeURIComponent(orderId)}/issue`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (res.kind === 'json') return { status: res.status, body: res.body };
  // Sin respuesta legible no se sabe si el pedido entró: sale como 5xx, nunca como 2xx o 4xx. La
  // pantalla lo dice y no lo repite sola; el API rechaza un segundo pedido mientras haya uno.
  const status = res.status >= 500 ? res.status : 502;
  return { status, body: { statusCode: status, message: res.message } };
}
