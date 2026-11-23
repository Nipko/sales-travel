import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { SELLING_ROLES } from '../auth/roles.js';
import { ActivitiesController } from './activities.controller.js';
import {
  ActivitySearchQuerySchema,
  AvailabilityBodySchema,
  BookBodySchema,
  ModalitiesQuerySchema,
  ShoppingBodySchema,
} from './activities.schemas.js';

const OFFER = {
  choiceId: 'c-1',
  activityId: 'UN_ORL',
  name: 'Universal',
  category: 'tour' as const,
  date: '2026-12-10',
  currency: 'usd',
  netMinor: 41700,
};

const TRAVELER = { firstName: 'Iñaki', lastName: "O'Connor-Peña", birthDate: '2025-06-01' };

describe('schemas de actividades', () => {
  it('destino IATA en mayúsculas', () => {
    expect(ActivitySearchQuerySchema.parse({ destination: 'orl' })).toEqual({ destination: 'ORL' });
    expect(ActivitySearchQuerySchema.safeParse({ destination: 'Orlando' }).success).toBe(false);
  });

  it('modalidades: las dos fechas o ninguna', () => {
    expect(ModalitiesQuerySchema.safeParse({ from: '2026-12-01' }).success).toBe(false);
    expect(ModalitiesQuerySchema.safeParse({ from: '2026-12-01', to: '2026-12-31' }).success).toBe(
      true,
    );
    expect(ModalitiesQuerySchema.safeParse({ from: '2026-12-31', to: '2026-12-01' }).success).toBe(
      false,
    );
  });

  it('participantes por edad: al menos 1 adulto, menores 0–17, máximo 10', () => {
    const base = { activityId: 'UN_ORL', modalityId: 'M', date: '2026-12-10' };
    expect(
      AvailabilityBodySchema.safeParse({
        ...base,
        participants: { adults: 2, childrenAges: [7, 1] },
      }).success,
    ).toBe(true);
    expect(AvailabilityBodySchema.safeParse({ ...base, participants: { adults: 0 } }).success).toBe(
      false,
    );
    expect(
      AvailabilityBodySchema.safeParse({ ...base, participants: { adults: 1, childrenAges: [18] } })
        .success,
    ).toBe(false);
    expect(
      AvailabilityBodySchema.safeParse({
        ...base,
        participants: { adults: 9, childrenAges: [1, 2] },
      }).success,
    ).toBe(false);
    expect(
      AvailabilityBodySchema.safeParse({ ...base, participants: { adults: 1 }, schedule: '9:30' })
        .success,
    ).toBe(false);
  });

  it('shopping sólo para los cuatro parques de Orlando', () => {
    const p = { adults: 2, childrenAges: [] };
    expect(
      ShoppingBodySchema.safeParse({ park: 'UN_ORL', from: '2026-12-10', participants: p }).success,
    ).toBe(true);
    expect(
      ShoppingBodySchema.safeParse({ park: 'XX_ORL', from: '2026-12-10', participants: p }).success,
    ).toBe(false);
  });

  it('book: nombres con tildes, ñ y apóstrofos (ISO-8859-1); sin dígitos', () => {
    const ok = BookBodySchema.safeParse({
      prebookId: 'pb',
      offer: OFFER,
      contact: { email: 'a@example.com' },
      travelers: [TRAVELER],
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.offer.currency).toBe('USD');
    expect(
      BookBodySchema.safeParse({
        prebookId: 'pb',
        offer: OFFER,
        contact: { email: 'a@example.com' },
        travelers: [{ ...TRAVELER, firstName: 'R2D2' }],
      }).success,
    ).toBe(false);
  });

  it('book de un ticket pide el documento de cada participante', () => {
    const r = BookBodySchema.safeParse({
      prebookId: 'pb',
      offer: { ...OFFER, category: 'ticket' },
      contact: { email: 'a@example.com' },
      travelers: [TRAVELER],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['travelers', 0, 'identification']);
  });
});

describe('rutas de actividades', () => {
  it('cuelgan de /activities y sólo las usan roles que venden', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ActivitiesController)).toBe('activities');
    expect(Reflect.getMetadata(ROLES_KEY, ActivitiesController)).toEqual([...SELLING_ROLES]);
    const proto = ActivitiesController.prototype as unknown as Record<string, object>;
    const paths = [
      'status',
      'search',
      'modalities',
      'availability',
      'shopping',
      'prebook',
      'book',
      'reservation',
      'cancelPreview',
      'cancel',
    ].map((m) => Reflect.getMetadata(PATH_METADATA, proto[m]!) as string);
    expect(paths).toEqual([
      'status',
      'search',
      ':id/modalities',
      'availability',
      'shopping',
      'prebook',
      'book',
      'reservations/:reservationId',
      'reservations/:reservationId/cancel-preview',
      'reservations/:reservationId/cancel',
    ]);
  });
});
