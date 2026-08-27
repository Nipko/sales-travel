import { describe, expect, it } from 'vitest';
import { foldDisclosure, type DisclosureNode } from './provider-disclosure.policy.js';

/**
 * La regla de producto de este ajuste, fijada por tests.
 *
 * Qué protege: en un consolidador, saber que una tarifa vino de Sabre y otra de LATAM
 * directo dice con quién tiene contrato la casa. La cadena decide, y sólo puede decidir
 * hacia el lado de ocultar: una agencia hija no puede destapar lo que su consolidador
 * ocultó, porque la hija es exactamente de quien se lo está ocultando.
 */

const CONSOLIDADOR = 'consolidador';
const AGENCIA = 'agencia';
const SUB = 'sub-agencia';

function nodo(tenantId: string, depth: number, value: boolean | null): DisclosureNode {
  return { tenantId, depth, showProviderInResults: value };
}

describe('foldDisclosure', () => {
  it('sin nadie configurado, no se muestra: el default no filtra nada', () => {
    const view = foldDisclosure(AGENCIA, [nodo(CONSOLIDADOR, 1, null), nodo(AGENCIA, 2, null)]);
    expect(view.effective).toBe(false);
    expect(view.own).toBeNull();
    expect(view.lockedByAncestor).toBe(false);
  });

  it('el consolidador lo enciende y su agencia lo hereda sin configurar nada', () => {
    const view = foldDisclosure(AGENCIA, [nodo(CONSOLIDADOR, 1, true), nodo(AGENCIA, 2, null)]);
    expect(view.effective).toBe(true);
    expect(view.own).toBeNull();
  });

  it('lo que el consolidador oculta NO lo puede destapar su agencia', () => {
    const view = foldDisclosure(AGENCIA, [nodo(CONSOLIDADOR, 1, false), nodo(AGENCIA, 2, true)]);
    expect(view.effective).toBe(false);
    expect(view.lockedByAncestor).toBe(true);
    // El valor propio se conserva tal cual se guardó: el panel tiene que poder decir
    // "lo pediste, pero arriba está bloqueado" en vez de fingir que nunca se tocó.
    expect(view.own).toBe(true);
  });

  it('una agencia SÍ puede ocultárselo a sus vendedores aunque arriba esté encendido', () => {
    const view = foldDisclosure(AGENCIA, [nodo(CONSOLIDADOR, 1, true), nodo(AGENCIA, 2, false)]);
    expect(view.effective).toBe(false);
    // No es un bloqueo heredado: es su propia decisión, y puede deshacerla.
    expect(view.lockedByAncestor).toBe(false);
    expect(view.own).toBe(false);
  });

  it('el "oculto" de cualquier eslabón intermedio alcanza a toda la rama de abajo', () => {
    const view = foldDisclosure(SUB, [
      nodo(CONSOLIDADOR, 1, true),
      nodo(AGENCIA, 2, false),
      nodo(SUB, 3, true),
    ]);
    expect(view.effective).toBe(false);
    expect(view.lockedByAncestor).toBe(true);
  });

  it('`own` es el valor PROPIO, nunca el heredado: guardar no puede fijar lo del padre', () => {
    const view = foldDisclosure(SUB, [nodo(CONSOLIDADOR, 1, true), nodo(SUB, 3, null)]);
    expect(view.own).toBeNull();
    expect(view.effective).toBe(true);
  });

  it('con la cadena vacía —tenant inexistente o ilegible— queda oculto', () => {
    const view = foldDisclosure(AGENCIA, []);
    expect(view.effective).toBe(false);
    expect(view.own).toBeNull();
    expect(view.lockedByAncestor).toBe(false);
  });

  it('el tenant raíz que lo enciende para sí mismo lo ve, y no está bloqueado', () => {
    const view = foldDisclosure(CONSOLIDADOR, [nodo(CONSOLIDADOR, 1, true)]);
    expect(view.effective).toBe(true);
    expect(view.own).toBe(true);
    expect(view.lockedByAncestor).toBe(false);
  });
});
