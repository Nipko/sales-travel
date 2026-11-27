import { describe, expect, it } from 'vitest';
import { UpdateBrandingSchema } from './branding.schemas.js';

describe('UpdateBrandingSchema.supportPhone (QA-H-07)', () => {
  it('con + y código de país se guarda; null hereda', () => {
    expect(UpdateBrandingSchema.safeParse({ supportPhone: '+57 300 123 4567' }).success).toBe(true);
    expect(UpdateBrandingSchema.safeParse({ supportPhone: '+51-1-555-0100' }).success).toBe(true);
    expect(UpdateBrandingSchema.safeParse({ supportPhone: null }).success).toBe(true);
  });

  it('lo que la reserva de hotel no puede usar no se guarda', () => {
    for (const malo of ['300 123 4567', '6012345678', '+0 123', 'llamar al soporte', '+57']) {
      expect(UpdateBrandingSchema.safeParse({ supportPhone: malo }).success, malo).toBe(false);
    }
  });
});
