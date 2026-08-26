import { bench, describe } from 'vitest';
import { safeBodySummary } from '../src/redaction';

/**
 * El canario de COSTE del escáner de redacción, fuera de la suite unitaria.
 *
 * ## Por qué vive en `bench/` y no en `src/`
 *
 * Porque `src/` es lo que se COMPILA Y SE PUBLICA. `tsconfig.build.json` excluye `src/**\/*.test.ts`
 * pero no conocía este fichero, así que viajaba al artefacto como `dist/redaction.budget.bench.js`
 * —con su `.d.ts` y su `.map`— y acababa dentro del paquete que `apps/api` carga en producción.
 * No es una fuga de seguridad: es superficie que nadie audita en el programa que corre de verdad,
 * y el paquete ya tiene un guard (`dist-artifact.guard.test.ts`) precisamente porque el artefacto
 * compilado es un segundo programa. Fuera de `src/` no hay lista de exclusiones que mantener: lo
 * que no está en `src/` no se compila ni se publica, y eso no se puede olvidar de actualizar.
 *
 * ## Por qué no es un test
 *
 * Vivía como `expect(msPerOp).toBeLessThan(10)` —primero en `redaction.stream-gaps.test.ts`, y
 * hasta esta ronda también en `redaction.order.test.ts`—, y era un generador de falsos rojos:
 * vitest corre los ficheros de test en paralelo, así que el vecino que cargara la CPU teñía de rojo
 * un test que no había cambiado (medido: 10,43 ms/op sin tocar la redacción). Aquí el número
 * informa y no rompe nada: se ejecuta a propósito con
 * `pnpm --filter @sales-travel/sabre exec vitest bench`, que NO es lo que corre `pnpm test` ni CI.
 *
 * Lo que sustituye a aquellas aserciones son pruebas DETERMINISTAS por la puerta pública, en
 * `src/redaction.order.test.ts` («el presupuesto es de SALIDA y no de entrada»): la trampa detrás
 * del presupuesto y la invariante de escala. El reloj mide; los tests demuestran.
 *
 * Qué se vigila: que el coste siga atado al tamaño del RESUMEN y no al del body. La lectura útil no
 * es el número absoluto sino la COMPARACIÓN entre las tres escalas: 10 KB, 100 KB y 1 MB del mismo
 * cuerpo tienen que costar prácticamente lo mismo. Si el de 1 MB se dispara a ~100× el de 10 KB,
 * alguien ha vuelto a recorrer la entrada entera — que es la forma exacta del hallazgo ALTO de la
 * ronda 1 (el umbral de 20.000 caracteres) mirado por su otra cara.
 *
 * Aquí sí se llama a `safeBodySummary` directamente, y es correcto: esto no verifica la defensa
 * —para eso están los tests por la puerta pública— sino que mide una función. Lo que no se puede
 * hacer nunca es medir aquí y dar por probada la protección.
 */

const PAN = '4111111111111111';
const PASSPORT = 'AB1234567';

function offersBody(minBytes: number): string {
  const item = (index: number): string =>
    `{"id":"OFFER-${index}","totalPrice":1234567.89,"acct":${PAN},"traveler":{"givenName":"Ana","passportNumber":"${PASSPORT}"}}`;
  const chunks: string[] = [];
  let size = 0;
  for (let index = 0; size < minBytes; index++) {
    const next = item(index);
    chunks.push(next);
    size += next.length + 1;
  }
  return `{"items":[${chunks.join(',')}]}`;
}

const SMALL = offersBody(10_000);
const MEDIUM = offersBody(100_000);
const LARGE = offersBody(1_000_000);
/** Un proveedor hostil que manda una CLAVE de 1 MB: el otro lado del mismo presupuesto. */
const GIANT_KEY = `{"${'K'.repeat(1_000_000)}":1,"status":"ERROR"}`;

/**
 * El carril de PROSA a tres escalas. No es JSON, así que cae en `redactLooseText`, que es el otro
 * camino del presupuesto: recorre con un bucle `exec` propio y por eso es el candidato natural a
 * devolver el coste al tamaño de la ENTRADA. Las tres escalas tienen que costar lo mismo.
 */
function proseBody(repeats: number): string {
  return 'no se pudo autenticar: password Pa55w0rd! y clientSecret Pa55w0rd!. '.repeat(repeats);
}

const PROSE_SMALL = proseBody(128);
const PROSE_MEDIUM = proseBody(1_280);
const PROSE_LARGE = proseBody(16_000);

describe('safeBodySummary — el coste sigue el tamaño del resumen, no el de la entrada', () => {
  bench('body de 10 KB', () => {
    safeBodySummary(SMALL);
  });

  bench('body de 100 KB', () => {
    safeBodySummary(MEDIUM);
  });

  bench('body de 1 MB', () => {
    safeBodySummary(LARGE);
  });

  bench('clave de 1 MB', () => {
    safeBodySummary(GIANT_KEY);
  });
});

describe('safeBodySummary — carril de prosa (texto suelto), mismas tres escalas', () => {
  bench('prosa de 8 KB', () => {
    safeBodySummary(PROSE_SMALL);
  });

  bench('prosa de 80 KB', () => {
    safeBodySummary(PROSE_MEDIUM);
  });

  bench('prosa de 1 MB', () => {
    safeBodySummary(PROSE_LARGE);
  });
});
