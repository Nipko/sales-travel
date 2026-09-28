import type { ZodError, ZodIssue } from 'zod';

/**
 * Issues de Zod como `ruta:código`, el vocabulario de todos los errores del ACL (08 RF-01 CA-4).
 *
 * Nunca `issue.message`: en algunos códigos de Zod repite el valor recibido, y aquí los valores
 * son importes, nombres de habitación o la nacionalidad del huésped. En los `custom` se usa el
 * motivo propio (`params.reason`) en lugar del genérico `custom`, que no dice qué regla falló.
 */

/** Techo de issues por error: uno roto suele arrastrar a los demás y el log no necesita cien. */
export const MAX_ISSUE_REFS = 20;

export function zodIssueRef(issue: ZodIssue, prefix?: string): string {
  const segments = [...(prefix === undefined ? [] : [prefix]), ...issue.path.map(String)];
  const path = segments.length > 0 ? segments.join('.') : '<root>';
  const reason: unknown = issue.code === 'custom' ? issue.params?.['reason'] : undefined;
  return `${path}:${typeof reason === 'string' ? reason : issue.code}`;
}

export function zodIssueRefs(error: ZodError, prefix?: string): string[] {
  return error.issues.slice(0, MAX_ISSUE_REFS).map((issue) => zodIssueRef(issue, prefix));
}
