/**
 * Las credenciales de la cuenta de test mientras corre el arnés.
 *
 * El header Basic es base64 reversible: vale lo mismo que la contraseña en claro, y el usuario es
 * "la mitad de la credencial que acompaña a la contraseña" (docs/tbo/01 §0 y §11.1). Por eso los
 * tres —usuario, contraseña y token— se buscan en todo lo que el arnés escribe o imprime (guarda
 * G-1 de docs/tbo/07 §6.7), y los valores viven en campos privados: un `JSON.stringify` o un
 * `util.inspect` de esta clase no los muestra.
 */

export const REDACTED = '«REDACTADO»';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * Un secreto puede aparecer escapado dentro de un JSON (una `"` o una `\` en la contraseña): se
 * busca también esa forma, que es la que tendría un RS que lo repitiera.
 */
function variants(value) {
  const escaped = JSON.stringify(value).slice(1, -1);
  return escaped === value ? [value] : [value, escaped];
}

export class HarnessSecrets {
  #username;
  #password;
  #needles;

  constructor(username, password) {
    if (typeof username !== 'string' || username.length === 0) {
      throw new TypeError('HarnessSecrets: usuario vacío');
    }
    if (typeof password !== 'string' || password.length === 0) {
      throw new TypeError('HarnessSecrets: contraseña vacía');
    }
    this.#username = username;
    this.#password = password;
    const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    this.#needles = [
      ['TBO_USERNAME', username],
      ['TBO_PASSWORD', password],
      ['BASIC_TOKEN', token],
    ]
      .flatMap(([name, value]) => variants(value).map((text) => ({ name, text })))
      // Los más largos primero: si la contraseña contiene al usuario, se tapa entera y no queda un
      // resto de la contraseña alrededor del usuario tapado.
      .sort((a, b) => b.text.length - a.text.length)
      .map(({ name, text }) => ({ name, text, bytes: Buffer.from(text, 'utf8') }));
  }

  /** Sólo quien arma la config del ACL llama a esto: el ACL la envuelve en su propio `TboSecret`. */
  revealUsername() {
    return this.#username;
  }

  revealPassword() {
    return this.#password;
  }

  /** Nombres —nunca valores— de los secretos que aparecen en estos bytes. */
  findIn(bytes) {
    const hits = new Set();
    for (const needle of this.#needles) {
      if (bytes.includes(needle.bytes)) hits.add(needle.name);
    }
    return [...hits];
  }

  /** El texto con cada secreto reemplazado por la marca, y qué secretos aparecieron. */
  scrubText(text) {
    let out = String(text);
    const hits = new Set();
    for (const needle of this.#needles) {
      if (out.includes(needle.text)) {
        hits.add(needle.name);
        out = out.split(needle.text).join(REDACTED);
      }
    }
    return { text: out, hits: [...hits] };
  }

  /**
   * Los bytes intactos si no hay secretos (la evidencia es byte a byte, 07 §5); si hay, el texto
   * tapado. Una captura tapada deja de ser exacta y el llamador lo anota.
   */
  scrubBytes(bytes) {
    if (this.findIn(bytes).length === 0) return { bytes, hits: [] };
    const { text, hits } = this.scrubText(bytes.toString('utf8'));
    return { bytes: Buffer.from(text, 'utf8'), hits };
  }

  toJSON() {
    return REDACTED;
  }

  toString() {
    return REDACTED;
  }

  [INSPECT]() {
    return `HarnessSecrets(${REDACTED})`;
  }
}
