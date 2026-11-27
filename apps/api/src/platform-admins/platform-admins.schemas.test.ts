import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { REQUIRE_RECENT_MFA_KEY } from '../auth/decorators/require-recent-mfa.decorator.js';
import { ChangeRequestsController } from './platform-admins.controller.js';
import { DecisionSchema } from './platform-admins.schemas.js';

/**
 * SUP-21 (QA-H-26): la nota de quien decide una solicitud sigue las reglas del panel, 3 a 500
 * caracteres ya recortados, y sólo aprobar (que aplica el cambio) pide el 2FA reciente.
 */
describe('DecisionSchema', () => {
  it('sin nota o en blanco es null; con nota, de 3 a 500', () => {
    expect(DecisionSchema.parse({})).toEqual({ note: null });
    expect(DecisionSchema.parse({ note: null })).toEqual({ note: null });
    expect(DecisionSchema.parse({ note: '  de acuerdo  ' })).toEqual({ note: 'de acuerdo' });
    expect(DecisionSchema.safeParse({ note: 'ok' }).success).toBe(false);
    expect(DecisionSchema.safeParse({ note: 'x'.repeat(501) }).success).toBe(false);
    expect(DecisionSchema.safeParse({ note: 'x'.repeat(500) }).success).toBe(true);
  });

  it('no acepta campos de más', () => {
    expect(DecisionSchema.safeParse({ note: 'de acuerdo', approve: true }).success).toBe(false);
  });
});

describe('ChangeRequestsController: qué pide 2FA reciente', () => {
  const reflector = new Reflector();
  const pide = (m: 'approve' | 'reject' | 'cancel') =>
    reflector.get<number | undefined>(
      REQUIRE_RECENT_MFA_KEY,

      ChangeRequestsController.prototype[m],
    ) !== undefined;

  it('aprobar aplica el cambio: sí; rechazar y cancelar no cambian nada: no', () => {
    expect(pide('approve')).toBe(true);
    expect(pide('reject')).toBe(false);
    expect(pide('cancel')).toBe(false);
  });
});
