import { describe, expect, it } from 'vitest';
import { escapeHtml, invitationEmailHtml, plainText } from './invitations.service.js';

const LINK = 'https://app.planetour.cloud/invitacion?token=abc_DEF-123';

describe('correo de invitación: el nombre del nodo no inyecta HTML', () => {
  it('un nombre con un enlace sale como texto, no como markup', () => {
    const html = invitationEmailHtml(
      LINK,
      'Viajes <a href="https://evil.example/login">Verificá tu cuenta</a>',
      7,
    );

    expect(html).not.toContain('<a href="https://evil.example');
    expect(html).not.toContain('evil.example/login">');
    expect(html).toContain(
      'Te invitaron a Viajes &lt;a href=&quot;https://evil.example/login&quot;&gt;Verificá tu cuenta&lt;/a&gt;',
    );
    // El único enlace del correo es el de la invitación.
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain(`href="${LINK}"`);
  });

  it('ni imágenes ni cierre de atributo', () => {
    const html = invitationEmailHtml(LINK, `"><img src=x onerror=alert(1)>`, 7);
    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapeHtml cubre texto y atributos con comillas simples o dobles', () => {
    expect(escapeHtml(`Tom & Jerry's <b>"viajes"</b>`)).toBe(
      'Tom &amp; Jerry&#39;s &lt;b&gt;&quot;viajes&quot;&lt;/b&gt;',
    );
  });

  it('el asunto y el texto plano no llevan saltos de línea ni caracteres de control', () => {
    expect(plainText('Agencia\r\nBcc: todos@example.com')).toBe('Agencia Bcc: todos@example.com');
    expect(plainText('  Viajes\u0000Sur\t')).toBe('Viajes Sur');
    expect(plainText('Viajes Ñandú')).toBe('Viajes Ñandú');
  });
});
