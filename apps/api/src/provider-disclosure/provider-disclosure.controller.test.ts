import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { NetworkService } from '../network/network.service.js';
import { ProviderDisclosureController } from './provider-disclosure.controller.js';
import type { DisclosureView } from './provider-disclosure.policy.js';
import type { ProviderDisclosureService } from './provider-disclosure.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const AJENO = '22222222-2222-4222-8222-222222222222';

interface Banco {
  controller: ProviderDisclosureController;
  setOwn: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
}

function banco(
  { puedeGestionar = true, esSuperadmin = false } = {},
  vista: DisclosureView = { effective: true, own: true, lockedByAncestor: false },
): Banco {
  const setOwn = vi.fn(() => Promise.resolve(vista));
  const emit = vi.fn(() => Promise.resolve());
  const service = {
    view: () => Promise.resolve(vista),
    setOwn,
  } as unknown as ProviderDisclosureService;
  const network = {
    isSuperadmin: () => Promise.resolve(esSuperadmin),
    canManageTenant: () => Promise.resolve(puedeGestionar),
  } as unknown as NetworkService;
  const audit = { emit } as unknown as AuditService;

  return { controller: new ProviderDisclosureController(service, network, audit), setOwn, emit };
}

describe('GET /provider-disclosure', () => {
  it('devuelve la vista completa: lo efectivo, lo propio y si está bloqueado arriba', async () => {
    const { controller } = banco({}, { effective: false, own: true, lockedByAncestor: true });
    const out = await controller.get('u1', TENANT);
    expect(out).toEqual({ effective: false, own: true, lockedByAncestor: true });
  });

  it('un admin no puede leer el ajuste de un tenant fuera de su red', async () => {
    const { controller } = banco({ puedeGestionar: false });
    await expect(controller.get('u1', AJENO)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('sin tenantId no contesta: leerlo del tenant activo enmascararía el error', async () => {
    const { controller } = banco();
    await expect(controller.get('u1', '')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('PATCH /provider-disclosure', () => {
  it('guarda el valor propio y devuelve lo que quedó efectivo', async () => {
    const { controller, setOwn } = banco();
    const out = await controller.update('u1', { tenantId: TENANT, showProviderInResults: true });
    expect(setOwn).toHaveBeenCalledWith(TENANT, true, 'u1');
    expect(out.effective).toBe(true);
  });

  it('`null` vuelve a heredar: no se traduce a `false` por el camino', async () => {
    const { controller, setOwn } = banco();
    await controller.update('u1', { tenantId: TENANT, showProviderInResults: null });
    expect(setOwn).toHaveBeenCalledWith(TENANT, null, 'u1');
  });

  it('un admin NO puede cambiar el ajuste de una agencia fuera de su red', async () => {
    const { controller, setOwn } = banco({ puedeGestionar: false });
    await expect(
      controller.update('u1', { tenantId: AJENO, showProviderInResults: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(setOwn).not.toHaveBeenCalled();
  });

  it('el superadmin pasa aunque no gestione el nodo por jerarquía', async () => {
    const { controller, setOwn } = banco({ puedeGestionar: false, esSuperadmin: true });
    await controller.update('u1', { tenantId: AJENO, showProviderInResults: false });
    expect(setOwn).toHaveBeenCalledWith(AJENO, false, 'u1');
  });

  it('queda auditado con quién, dónde y qué quedó vigente', async () => {
    const { controller, emit } = banco({}, { effective: false, own: true, lockedByAncestor: true });
    await controller.update('u1', { tenantId: TENANT, showProviderInResults: true });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'tenant.provider_disclosure.updated',
        tenantId: TENANT,
        actorUserId: 'u1',
        payload: { own: true, effective: false },
      }),
    );
  });
});
