import { request } from '@playwright/test';
import { E2E } from './env';

/**
 * INF-3 (docs/qa/01 §7): leer lo que la API mandó por correo. Todo cae en Mailpit, en la Mac
 * (`infrastructure/pruebas`) y en el stack E2E local; nunca sale a un buzón real.
 */

export interface Correo {
  readonly id: string;
  readonly asunto: string;
  readonly texto: string;
  readonly html: string;
  readonly enlaces: readonly string[];
}

interface Resumen {
  readonly ID: string;
  readonly Created: string;
}

/** ¿Hay Mailpit en este stack? Sin él, los casos de correo se saltan con su motivo. */
export async function hayBuzon(): Promise<boolean> {
  const ctx = await request.newContext();
  try {
    const r = await ctx.get(`${E2E.mailUrl}/api/v1/info`, {
      failOnStatusCode: false,
      timeout: 3_000,
    });
    return r.ok();
  } catch {
    return false;
  } finally {
    await ctx.dispose();
  }
}

/**
 * El correo más nuevo para `para` llegado después de `desde`. Espera hasta `esperaMs`: el envío es
 * asíncrono. `undefined` si no llegó ninguno.
 */
export async function ultimoCorreo(
  para: string,
  opts: { desde?: Date; esperaMs?: number } = {},
): Promise<Correo | undefined> {
  const desde = opts.desde?.getTime() ?? 0;
  const limite = Date.now() + (opts.esperaMs ?? 10_000);
  const ctx = await request.newContext();
  try {
    for (;;) {
      const q = encodeURIComponent(`to:"${para}"`);
      const r = await ctx.get(`${E2E.mailUrl}/api/v1/search?query=${q}&limit=20`);
      const { messages = [] } = (await r.json()) as { messages?: Resumen[] };
      const nuevo = messages.find((m) => new Date(m.Created).getTime() >= desde);
      if (nuevo) {
        const m = (await (await ctx.get(`${E2E.mailUrl}/api/v1/message/${nuevo.ID}`)).json()) as {
          Subject?: string;
          Text?: string;
          HTML?: string;
        };
        const html = m.HTML ?? '';
        const texto = m.Text ?? '';
        const enlaces = [
          ...new Set(
            [...`${html} ${texto}`.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((x) =>
              x[0].replace(/&amp;/g, '&'),
            ),
          ),
        ];
        return { id: nuevo.ID, asunto: m.Subject ?? '', texto, html, enlaces };
      }
      if (Date.now() > limite) return undefined;
      await new Promise((res) => setTimeout(res, 500));
    }
  } finally {
    await ctx.dispose();
  }
}

/** Cuántos correos le llegaron a `para` después de `desde`. */
export async function correosPara(para: string, desde: Date): Promise<number> {
  const ctx = await request.newContext();
  try {
    const q = encodeURIComponent(`to:"${para}"`);
    const r = await ctx.get(`${E2E.mailUrl}/api/v1/search?query=${q}&limit=50`);
    const { messages = [] } = (await r.json()) as { messages?: Resumen[] };
    return messages.filter((m) => new Date(m.Created).getTime() >= desde.getTime()).length;
  } finally {
    await ctx.dispose();
  }
}
