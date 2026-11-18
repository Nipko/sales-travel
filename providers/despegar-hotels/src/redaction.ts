/**
 * Copia de un cuerpo de Despegar con los datos personales y de pago enmascarados, para exportar
 * desde la bóveda de payloads los RQ/RS de una cuenta `live`. Las claves son las del contrato de
 * Despegar (snake_case); los objetos enteros de personas (`purchase_customer`,
 * `card_holder_identification`, `fiscal_identification`, `fiscal_address`, `identification`) se
 * enmascaran completos.
 */

export const DESPEGAR_REDACTED = '[REDACTED]';

const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'first_name',
  'last_name',
  'full_name',
  'holder_first_name',
  'holder_last_name',
  'fiscal_name',
  'email',
  'phones',
  'phone_number',
  'birth_date',
  'secure_token',
  'client_ip',
  'user_agent',
  'identification',
  'card_holder_identification',
  'fiscal_identification',
  'fiscal_address',
  'purchase_customer',
  'credit_cards',
  'document_number',
  'document_type',
]);

const MAX_DEPTH = 32;

function redactNode(node: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return DESPEGAR_REDACTED;
  if (Array.isArray(node)) return node.map((n) => redactNode(n, depth + 1));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? DESPEGAR_REDACTED : redactNode(v, depth + 1);
    }
    return out;
  }
  return node;
}

export function redactDespegarPayload(payload: unknown): unknown {
  return redactNode(payload, 0);
}
