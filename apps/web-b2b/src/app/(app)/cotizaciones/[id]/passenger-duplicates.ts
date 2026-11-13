/**
 * Pasajeros repetidos en la misma reserva: el mismo nombre con la misma fecha de nacimiento, o el
 * mismo documento. La aerolínea los rechaza (o, peor, emite dos tiquetes a la misma persona) y la
 * respuesta llegaba como un error técnico. Se dice antes de enviar, en palabras del vendedor.
 */

export interface DuplicateCheckPassenger {
  readonly paxId: string;
  readonly givenName: string;
  readonly surname: string;
  readonly birthdate: string;
  readonly identityDoc: { readonly type: string; readonly number: string };
}

export interface DuplicateProblem {
  /** El pasajero que repite (el de más abajo): ahí se marcan los campos. */
  readonly paxId: string;
  readonly fields: readonly ('nombre' | 'apellido' | 'número de documento')[];
  readonly message: string;
}

const norm = (value: string): string =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

const docKey = (p: DuplicateCheckPassenger): string => {
  const number = p.identityDoc.number.replace(/[\s.-]/g, '').toUpperCase();
  return number ? `${p.identityDoc.type}:${number}` : '';
};

export function duplicatePassengerProblems<P extends DuplicateCheckPassenger>(
  passengers: readonly P[],
  labelOf: (p: P) => string,
): DuplicateProblem[] {
  const out: DuplicateProblem[] = [];
  for (let i = 1; i < passengers.length; i += 1) {
    const current = passengers[i]!;
    for (let j = 0; j < i; j += 1) {
      const earlier = passengers[j]!;
      const sameDoc = docKey(current) !== '' && docKey(current) === docKey(earlier);
      const sameName =
        norm(current.givenName) !== '' &&
        norm(current.surname) !== '' &&
        norm(current.givenName) === norm(earlier.givenName) &&
        norm(current.surname) === norm(earlier.surname) &&
        current.birthdate !== '' &&
        current.birthdate === earlier.birthdate;
      if (!sameDoc && !sameName) continue;
      const what = sameDoc
        ? 'el mismo número de documento'
        : 'el mismo nombre y fecha de nacimiento';
      out.push({
        paxId: current.paxId,
        fields: sameDoc ? ['número de documento'] : ['nombre', 'apellido'],
        message: `${labelOf(current)} tiene ${what} que ${labelOf(earlier)}. Cada pasajero tiene que ser una persona distinta: corrige sus datos o quítalo de la búsqueda.`,
      });
      break;
    }
  }
  return out;
}
