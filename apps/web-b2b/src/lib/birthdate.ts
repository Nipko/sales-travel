/**
 * Fecha de nacimiento como UN campo que se teclea, no como tres desplegables.
 *
 * Los tres `<select>` (día / mes / año) se eligieron porque el date-picker nativo obliga a
 * recorrer décadas para llegar a 1978. El diagnóstico era correcto y la solución tenía el mismo
 * problema por otro lado: cargar un pasajero son tres aperturas de desplegable y tres búsquedas
 * visuales en listas de 31, 12 y 101 elementos. Para un vendedor que carga cuatro pasajeros
 * seguidos, eso son doce interacciones donde deberían ser ocho pulsaciones de teclado.
 *
 * Un campo de texto con formato asistido se teclea de corrido —`09071978`— sin soltar el teclado
 * ni levantar la vista, y sigue admitiendo pegar. Lo que hay aquí es la lógica pura, separada del
 * componente para poder fijarla con tests: es un parser de fechas escritas por humanos y esa clase
 * de código falla por los bordes, no por el caso feliz.
 */

/** Lo que se enseña mientras se escribe: hasta `DD/MM/AAAA`. */
export function formatBirthdateInput(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  const dia = digits.slice(0, 2);
  const mes = digits.slice(2, 4);
  const anio = digits.slice(4, 8);

  // Los separadores los pone esta función, nunca el usuario: si se conservara el `/` tecleado,
  // borrar hacia atrás dejaría `12/` y el siguiente dígito produciría `12/3` en vez de `12/03`.
  if (digits.length <= 2) return dia;
  if (digits.length <= 4) return `${dia}/${mes}`;
  return `${dia}/${mes}/${anio}`;
}

/** ¿Existe ese día en ese mes de ese año? Cubre bisiestos sin tabla de meses. */
function esFechaReal(anio: number, mes: number, dia: number): boolean {
  if (mes < 1 || mes > 12 || dia < 1) return false;
  // Día 0 del mes siguiente = último día de este mes. `Date.UTC` para no depender del huso.
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return dia <= ultimo;
}

/**
 * `DD/MM/AAAA` → `YYYY-MM-DD`, o `null` si todavía no es una fecha usable.
 *
 * `null` cubre tres casos distintos a propósito —incompleta, imposible (`31/02`) y futura— porque
 * quien llama sólo necesita saber si puede emitirla. El motivo lo da {@link birthdateIssue}.
 *
 * `hoyIso` entra por parámetro y no se lee del reloj: una fecha de nacimiento se compara contra
 * hoy, y una función que lee el reloj por dentro no se puede fijar con un test.
 */
export function parseBirthdate(input: string, hoyIso: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length !== 8) return null;

  const dia = Number(digits.slice(0, 2));
  const mes = Number(digits.slice(2, 4));
  const anio = Number(digits.slice(4, 8));

  // 1900 como suelo: por debajo es un año mal tecleado, no un pasajero de 130 años.
  if (anio < 1900) return null;
  if (!esFechaReal(anio, mes, dia)) return null;

  const iso = `${String(anio).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  // Comparación de cadenas ISO: ordena igual que las fechas y no arrastra husos horarios.
  return iso > hoyIso ? null : iso;
}

/** `YYYY-MM-DD` → `DD/MM/AAAA`, para rellenar el campo con un valor ya guardado. */
export function formatBirthdateValue(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m === null ? '' : `${m[3]!}/${m[2]!}/${m[1]!}`;
}

/**
 * Qué le pasa a lo tecleado, en una frase, o `null` si está bien (o todavía a medias).
 *
 * Callar mientras se escribe es deliberado: marcar en rojo `09/0` porque «aún no es una fecha»
 * regaña al usuario por ir a mitad de camino.
 */
export function birthdateIssue(input: string, hoyIso: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 0 || digits.length < 8) return null;
  if (digits.length > 8) return 'La fecha tiene demasiados dígitos.';

  const dia = Number(digits.slice(0, 2));
  const mes = Number(digits.slice(2, 4));
  const anio = Number(digits.slice(4, 8));

  if (anio < 1900) return 'Revisá el año.';
  if (!esFechaReal(anio, mes, dia)) return 'Esa fecha no existe.';
  if (parseBirthdate(input, hoyIso) === null) return 'La fecha de nacimiento no puede ser futura.';
  return null;
}
