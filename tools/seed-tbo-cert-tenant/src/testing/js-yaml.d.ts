// js-yaml 4 no publica tipos y sólo lo usan los tests de contrato del stack para leer los compose.
declare module 'js-yaml' {
  export function load(input: string): unknown;
}
