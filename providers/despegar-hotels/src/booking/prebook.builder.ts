import type { PrebookQuery } from './types';

/** Cuerpo del POST /prebook. `choice_id` es obligatorio; lang/include son opcionales. */
export function buildPrebookBody(q: PrebookQuery): Record<string, unknown> {
  const body: Record<string, unknown> = { choice_id: q.choiceId };
  if (q.lang) body['lang'] = q.lang;
  if (q.include && q.include.length > 0) body['include'] = q.include;
  return body;
}
