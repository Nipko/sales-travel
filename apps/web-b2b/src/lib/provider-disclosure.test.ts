import { describe, expect, it } from 'vitest';
import { PROVIDER_METADATA } from './provider-display';
import {
  choiceFromOwn,
  disclosureStatusLabel,
  ownFromChoice,
  parseDisclosureView,
  providerTagFor,
  type ProviderDisclosureView,
} from './provider-disclosure';

/**
 * Lo que la pantalla de resultados puede y no puede decir sobre el origen de una tarifa.
 *
 * Es información comercial del consolidador: de quién compra y con quién tiene contrato.
 * Todo lo que se pruebe acá se prueba en la dirección segura — ante la duda, no se muestra.
 */

function view(over: Partial<ProviderDisclosureView> = {}): ProviderDisclosureView {
  return { effective: false, own: null, lockedByAncestor: false, ...over };
}

describe('providerTagFor', () => {
  it('con el ajuste apagado no hay nada que pintar', () => {
    expect(providerTagFor('sabre', false)).toBeNull();
  });

  it('con el ajuste encendido devuelve el nombre legible, no el código', () => {
    expect(providerTagFor('sabre', true)?.label).toBe('Sabre GDS');
    expect(providerTagFor('latam-ndc', true)?.label).toBe('LATAM NDC');
  });

  it('usa la MISMA pastilla que el panel de proveedores', () => {
    // Si esto se separa, el panel dice "Sabre GDS" en rojo y el resultado lo dice en gris.
    expect(providerTagFor('sabre', true)?.badgeClass).toBe(PROVIDER_METADATA['sabre']?.badgeClass);
  });

  it('un proveedor que todavía no tiene ficha se muestra por su código, no en blanco', () => {
    expect(providerTagFor('proveedor-nuevo', true)).toEqual({
      label: 'proveedor-nuevo',
      badgeClass: expect.any(String),
    });
  });

  it('sin código de proveedor no se inventa una etiqueta', () => {
    expect(providerTagFor('', true)).toBeNull();
  });
});

describe('parseDisclosureView', () => {
  it('lee la vista que manda el API', () => {
    expect(parseDisclosureView({ effective: true, own: true, lockedByAncestor: false })).toEqual({
      effective: true,
      own: true,
      lockedByAncestor: false,
    });
  });

  it('una respuesta incompleta se lee como OCULTO, no como visible', () => {
    // API viejo, endpoint caído, cuerpo de error: ninguno puede destapar el proveedor.
    expect(parseDisclosureView({ effective: true }).effective).toBe(false);
    expect(parseDisclosureView({ error: 'boom' }).effective).toBe(false);
    expect(parseDisclosureView(null).effective).toBe(false);
    expect(parseDisclosureView(undefined).effective).toBe(false);
    expect(parseDisclosureView('true').effective).toBe(false);
  });

  it('`own` puede ser null —hereda— pero no cualquier cosa', () => {
    expect(parseDisclosureView({ effective: false, own: null }).own).toBeNull();
    expect(parseDisclosureView({ effective: true, own: 'sí' }).effective).toBe(false);
  });

  it('el bloqueo del ancestro sólo es cierto si viene dicho', () => {
    expect(parseDisclosureView({ effective: false, own: true }).lockedByAncestor).toBe(false);
    expect(
      parseDisclosureView({ effective: false, own: true, lockedByAncestor: true }).lockedByAncestor,
    ).toBe(true);
  });
});

describe('control de tres posiciones', () => {
  it('heredar y guardar son distinguibles en los dos sentidos', () => {
    expect(choiceFromOwn(null)).toBe('inherit');
    expect(choiceFromOwn(true)).toBe('show');
    expect(choiceFromOwn(false)).toBe('hide');

    expect(ownFromChoice('inherit')).toBeNull();
    expect(ownFromChoice('show')).toBe(true);
    expect(ownFromChoice('hide')).toBe(false);
  });

  it('heredar NO se confunde con ocultar al ida y vuelta', () => {
    expect(ownFromChoice(choiceFromOwn(null))).toBeNull();
    expect(ownFromChoice(choiceFromOwn(false))).toBe(false);
  });
});

describe('disclosureStatusLabel', () => {
  it('cuando un ancestro lo bloquea, lo dice: el interruptor propio no manda', () => {
    const texto = disclosureStatusLabel(view({ own: true, lockedByAncestor: true }));
    expect(texto).toContain('nivel superior');
  });

  it('sin nada configurado avisa que es el valor por defecto', () => {
    expect(disclosureStatusLabel(view())).toContain('por defecto');
  });

  it('visible por herencia se distingue de visible por decisión propia', () => {
    const heredado = disclosureStatusLabel(view({ effective: true, own: null }));
    const propio = disclosureStatusLabel(view({ effective: true, own: true }));
    expect(heredado).not.toBe(propio);
    expect(heredado).toContain('heredado');
  });
});
