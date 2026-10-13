import { describe, expect, it } from 'vitest';
import { operationStatusView, operationTypeLabel } from './order-operations-view';

describe('operationTypeLabel', () => {
  it('los jobs de post-venta de hotel tienen nombre legible, no su código', () => {
    for (const type of ['hcn-check', 'hcn-ticket', 'reconcile']) {
      const label = operationTypeLabel(type);
      expect(label).not.toBe(type);
      expect(label).not.toMatch(/hcn-|reconcile/);
    }
    expect(operationTypeLabel('hcn-ticket')).toMatch(/^Tarea de operaciones/);
    expect(operationTypeLabel('reconcile')).toBe('Conciliación con el proveedor');
  });

  it('las de siempre no cambian', () => {
    expect(operationTypeLabel('cancel')).toBe('Cancelación');
    expect(operationTypeLabel('retrieve')).toBe('Consulta de estado');
  });

  it('un tipo desconocido sale por su código', () => {
    expect(operationTypeLabel('algo-nuevo')).toBe('algo-nuevo');
  });
});

describe('operationStatusView', () => {
  it('la tarea de operaciones está abierta o resuelta', () => {
    expect(operationStatusView({ type: 'hcn-ticket', status: 'pending' })).toEqual({
      label: 'Abierta',
      tone: 'pending',
    });
    expect(operationStatusView({ type: 'hcn-ticket', status: 'success' })).toEqual({
      label: 'Resuelta',
      tone: 'ok',
    });
  });

  it('un job automático en marcha está en curso, no pendiente de alguien', () => {
    expect(operationStatusView({ type: 'reconcile', status: 'pending' }).label).toBe('En curso');
    expect(operationStatusView({ type: 'hcn-check', status: 'failed' })).toEqual({
      label: 'Falló',
      tone: 'failed',
    });
  });

  it('las operaciones del vendedor, como antes', () => {
    expect(operationStatusView({ type: 'cancel', status: 'pending' })).toEqual({
      label: 'Pendiente',
      tone: 'pending',
    });
    expect(operationStatusView({ type: 'cancel', status: 'success' }).label).toBe('OK');
  });
});

describe('la emisión de tiquetes en el historial (SAB-08)', () => {
  it('se llama Emisión', () => {
    expect(operationTypeLabel('issue')).toBe('Emisión');
  });

  it('en curso, emitida o fallida', () => {
    expect(operationStatusView({ type: 'issue', status: 'pending' })).toEqual({
      label: 'En curso',
      tone: 'pending',
    });
    expect(operationStatusView({ type: 'issue', status: 'success' })).toEqual({
      label: 'Emitida',
      tone: 'ok',
    });
    expect(
      operationStatusView({ type: 'issue', status: 'failed', reconciliationRequired: false }),
    ).toEqual({ label: 'Falló', tone: 'failed' });
  });

  it('una emisión en duda no es un fallo: sin confirmar, y se revisa', () => {
    expect(
      operationStatusView({ type: 'issue', status: 'failed', reconciliationRequired: true }),
    ).toEqual({ label: 'Sin confirmar', tone: 'pending' });
  });
});
