/**
 * Reparto de un nombre completo en nombre(s) y apellido(s).
 *
 * Existe porque el formulario de reserva pide nombre y apellido por separado —el billete los
 * lleva separados— mientras que la ficha del cliente guarda un solo campo. Alguien tiene que
 * decidir dónde corta, y hacerlo con «la última palabra es el apellido» es una regla anglosajona
 * que en LATAM se equivoca en la mayoría de los casos: «Juan Carlos Pérez Gómez» tiene DOS
 * apellidos, y esa regla emite «Gómez» dejando «Pérez» dentro del nombre de pila.
 *
 * Un nombre mal partido en un billete no es cosmético: si no coincide con el documento, la
 * aerolínea puede negar el embarque, y corregirlo después cuesta una reemisión.
 *
 * La heurística NO pretende acertar siempre —es imposible sin preguntar— y por eso los dos campos
 * siguen siendo editables: esto rellena, no decide.
 */
export interface SplitName {
  givenName: string;
  surname: string;
}

/**
 * Reparte por número de palabras:
 *
 * - 1 → todo es nombre; no se inventa un apellido.
 * - 2 → uno y uno, que es lo único razonable.
 * - 3 → el primero es nombre y los dos siguientes apellidos. En Colombia, Perú y Brasil, «Juan
 *   Pérez Gómez» es mucho más frecuente que «Juan Pérez» de apellido «Gómez».
 * - 4 o más → los DOS últimos son apellidos y el resto nombres, que es la forma canónica.
 */
export function splitFullName(full: string): SplitName {
  const partes = full.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return { givenName: '', surname: '' };
  if (partes.length === 1) return { givenName: partes[0]!, surname: '' };
  if (partes.length === 2) return { givenName: partes[0]!, surname: partes[1]! };

  const corte = partes.length === 3 ? 1 : partes.length - 2;
  return {
    givenName: partes.slice(0, corte).join(' '),
    surname: partes.slice(corte).join(' '),
  };
}
