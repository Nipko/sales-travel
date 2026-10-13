import { describe, expect, it } from 'vitest';
import { escapeHtml, plainText } from './mail-text.js';
import * as invitations from '../tenants/invitations.service.js';

describe('mail-text: lo que un nodo escribe no inyecta nada en un correo', () => {
  it('escapeHtml cubre texto y atributos con comillas simples o dobles', () => {
    expect(escapeHtml(`Tom & Jerry's <b>"viajes"</b>`)).toBe(
      'Tom &amp; Jerry&#39;s &lt;b&gt;&quot;viajes&quot;&lt;/b&gt;',
    );
    expect(escapeHtml('Viajes Ñandú')).toBe('Viajes Ñandú');
  });

  it('plainText deja una sola línea, sin caracteres de control', () => {
    expect(plainText('Agencia\r\nBcc: todos@example.com')).toBe('Agencia Bcc: todos@example.com');
    expect(plainText('  Viajes\u0000Sur\t')).toBe('Viajes Sur');
    expect(plainText('Viajes Ñandú')).toBe('Viajes Ñandú');
  });

  it('invitations.service los sigue exportando: son las mismas funciones', () => {
    expect(invitations.escapeHtml).toBe(escapeHtml);
    expect(invitations.plainText).toBe(plainText);
  });
});
