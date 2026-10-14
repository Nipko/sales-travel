/**
 * Escapa un valor para interpolarlo en HTML, en texto o dentro de un atributo entre comillas.
 *
 * El nombre del nodo lo elige su propio admin (PATCH /tenants/:id/config sólo valida el largo) y los
 * correos salen con la identidad de la plataforma a cualquier email: sin escapar, una agencia metía
 * enlaces o markup en un correo legítimo, que es phishing servido.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Texto de una sola línea para el asunto y el cuerpo en texto plano: sin caracteres de control. Un
 * salto de línea en el asunto es la puerta a inyectar cabeceras si algún día el correo no pasa por
 * un cliente que las codifique.
 */
export function plainText(value: string): string {
  return value.replace(/\p{Cc}+/gu, ' ').trim();
}
