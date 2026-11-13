import { describe, expect, it } from 'vitest';
import { duplicatePassengerProblems } from './passenger-duplicates';

const pax = (
  paxId: string,
  givenName: string,
  surname: string,
  birthdate: string,
  number: string,
) => ({ paxId, givenName, surname, birthdate, identityDoc: { type: 'CC', number } });
const label = (p: { paxId: string }) => (p.paxId === 'ADT_1' ? 'Adulto 1' : 'Adulto 2');

describe('pasajeros repetidos', () => {
  it('el mismo documento se dice en palabras y marca el documento del segundo', () => {
    const [problem] = duplicatePassengerProblems(
      [
        pax('ADT_1', 'Ana', 'Pérez', '1990-01-01', '1.234.567'),
        pax('ADT_2', 'Luis', 'Gómez', '1985-05-05', '1234567'),
      ],
      label,
    );
    expect(problem?.paxId).toBe('ADT_2');
    expect(problem?.fields).toEqual(['número de documento']);
    expect(problem?.message).toMatch(/^Adulto 2 tiene el mismo número de documento que Adulto 1\./);
  });

  it('el mismo nombre y fecha, sin importar tildes ni mayúsculas', () => {
    const problems = duplicatePassengerProblems(
      [
        pax('ADT_1', 'Ana', 'Pérez', '1990-01-01', '1'),
        pax('ADT_2', 'ANA', 'perez', '1990-01-01', '2'),
      ],
      label,
    );
    expect(problems[0]?.fields).toEqual(['nombre', 'apellido']);
  });

  it('homónimos con otra fecha y otro documento no son el mismo pasajero; vacíos tampoco', () => {
    expect(
      duplicatePassengerProblems(
        [
          pax('ADT_1', 'Ana', 'Pérez', '1990-01-01', '1'),
          pax('ADT_2', 'Ana', 'Pérez', '2015-01-01', '2'),
        ],
        label,
      ),
    ).toEqual([]);
    expect(
      duplicatePassengerProblems(
        [pax('ADT_1', '', '', '', ''), pax('ADT_2', '', '', '', '')],
        label,
      ),
    ).toEqual([]);
  });
});
