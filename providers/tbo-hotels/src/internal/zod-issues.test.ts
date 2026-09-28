import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { MAX_ISSUE_REFS, zodIssueRef, zodIssueRefs } from './zod-issues';

/** Issues de Zod como `ruta:código`, sin valores (08 RF-01 CA-4). */

function issuesOf(schema: z.ZodTypeAny, value: unknown): z.ZodError {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error('se esperaba un error de Zod');
  return parsed.error;
}

describe('zodIssueRefs', () => {
  it('nunca repite el valor recibido, aunque el mensaje de Zod sí lo haga', () => {
    const error = issuesOf(z.object({ Meal: z.enum(['All', 'RoomOnly']) }), { Meal: 'Juan Pérez' });
    expect(error.issues[0]?.message).toContain('Juan Pérez');
    expect(zodIssueRefs(error)).toEqual(['Meal:invalid_enum_value']);
  });

  it('en un custom usa el motivo propio y no el genérico', () => {
    const schema = z.string().superRefine((_value, ctx) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, params: { reason: 'not_after_checkin' } });
    });
    expect(zodIssueRefs(issuesOf(schema, 'x'), 'CheckOut')).toEqual(['CheckOut:not_after_checkin']);
    const sinMotivo = z.string().refine(() => false);
    expect(zodIssueRefs(issuesOf(sinMotivo, 'x'))).toEqual(['<root>:custom']);
  });

  it('antepone el prefijo a la ruta, índices incluidos', () => {
    const error = issuesOf(z.array(z.object({ Adults: z.number() })), [{ Adults: 'dos' }]);
    expect(zodIssueRef(error.issues[0] as z.ZodIssue, 'PaxRooms')).toBe(
      'PaxRooms.0.Adults:invalid_type',
    );
  });

  it(`corta en ${MAX_ISSUE_REFS} issues`, () => {
    const error = issuesOf(
      z.array(z.number()),
      Array.from({ length: 50 }, () => 'x'),
    );
    expect(error.issues.length).toBe(50);
    expect(zodIssueRefs(error)).toHaveLength(MAX_ISSUE_REFS);
  });
});
