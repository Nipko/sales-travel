import { BadRequestException } from '@nestjs/common';
import { z } from '@sales-travel/validation';
import type { CompiledQuery } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { scriptedKysely } from '../__fixtures__/scripted-kysely.js';
import { AuditService } from '../audit/audit.service.js';
import { DatabaseService } from '../database/database.service.js';
import { approvalContextStorage } from './approval-context.js';
import {
  ChangeRequestNotPendingError,
  ChangeRequestPendingError,
  FullSuperadminRequiredError,
  NotRequesterError,
  OwnChangeRequestError,
} from './platform-admins.errors.js';
import {
  CHANGE_REQUEST_EVENTS,
  failureMessage,
  SupervisionService,
} from './supervision.service.js';

const PLENO = '11111111-1111-4111-8111-111111111111';
const OTRO_PLENO = '22222222-2222-4222-8222-222222222222';
const SUPERVISADO = '33333333-3333-4333-8333-333333333333';
const NADIE = '44444444-4444-4444-8444-444444444444';
const SOLICITUD = '55555555-5555-4555-8555-555555555555';
const PLATAFORMA = '66666666-6666-4666-8666-666666666666';

const KIND = 'governance.rule.set';
const Input = z.object({ provider: z.string(), enabled: z.boolean() }).strict();

/**
 * El servicio sobre un Kysely que compila de verdad. Quién es qué sale de los ids; la solicitud
 * guardada, de `solicitud`.
 */
function banco(
  opts: {
    solicitud?: { status: string; requested_by: string; kind?: string; input?: unknown } | null;
  } = {},
) {
  const solicitud =
    opts.solicitud === null
      ? null
      : {
          kind: KIND,
          summary: 'Gobierno: apagar sabre',
          input: { provider: 'sabre', enabled: false },
          ...(opts.solicitud ?? { status: 'pending', requested_by: SUPERVISADO }),
        };
  const scripted = scriptedKysely((q: CompiledQuery) => {
    const s = q.sql;
    if (s.includes('"m"."platform_supervised"') && s.includes('from "memberships"')) {
      const who = q.parameters[0];
      if (who === PLENO || who === OTRO_PLENO) return [{ platform_supervised: false }];
      if (who === SUPERVISADO) return [{ platform_supervised: true }];
      return [];
    }
    if (s.startsWith('insert into "platform_change_requests"')) return [{ id: SOLICITUD }];
    if (s.includes('"tenant_type" =')) return [{ id: PLATAFORMA }];
    if (s.includes('from "platform_change_requests" as "r"')) {
      return [
        {
          id: SOLICITUD,
          ...solicitud,
          requested_email: 'sup@plataforma.com',
          decided_by: PLENO,
          decided_email: 'pleno@plataforma.com',
          decided_at: new Date('2026-11-05T12:00:00Z'),
          decision_note: null,
          error: null,
          created_at: new Date('2026-11-05T11:00:00Z'),
        },
      ];
    }
    if (s.includes('from "platform_change_requests"') && s.includes('for update')) {
      return solicitud === null ? [] : [solicitud];
    }
    return [];
  });
  const database = new DatabaseService();
  database.db = scripted.db;
  const audit = new AuditService(database);
  const service = new SupervisionService(database, audit);
  const execute = vi.fn(async (actor: string, input: z.infer<typeof Input>) => {
    await audit.emit({
      eventType: 'platform.provider_governance.rule.updated',
      actorUserId: actor,
      payload: input,
    });
    return { ok: true };
  });
  service.register(KIND, { schema: Input, summary: (i) => `Gobierno: ${i.provider}`, execute });
  const eventos = () =>
    scripted.queries
      .filter((q) => q.sql.startsWith('insert into "domain_events"'))
      .map((q) => ({
        actor: q.parameters[1],
        eventType: q.parameters[2],
        payload: JSON.parse(String(q.parameters[5])) as Record<string, unknown>,
      }));
  const actualizaciones = () =>
    scripted.queries.filter((q) => q.sql.startsWith('update "platform_change_requests"'));
  return { service, scripted, execute, eventos, actualizaciones };
}

describe('SupervisionService.standing', () => {
  it('pleno, supervisado o nada', async () => {
    const { service } = banco();
    await expect(service.standing(PLENO)).resolves.toBe('full');
    await expect(service.standing(SUPERVISADO)).resolves.toBe('supervised');
    await expect(service.standing(NADIE)).resolves.toBeNull();
  });
});

describe('SupervisionService.gate', () => {
  it('un pleno sigue de largo: no deja solicitud', async () => {
    const { service, scripted } = banco();
    await expect(service.gate(PLENO, KIND, { provider: 'sabre', enabled: false })).resolves.toBe(
      undefined,
    );
    expect(scripted.indexOf('insert into "platform_change_requests"')).toBe(-1);
  });

  it('quien no es superadmin sigue de largo: la ruta tiene su propia autorización', async () => {
    const { service, scripted } = banco();
    await service.gate(NADIE, KIND, { provider: 'sabre', enabled: false });
    expect(scripted.indexOf('insert into "platform_change_requests"')).toBe(-1);
  });

  it('un supervisado deja la solicitud y su evento, y recibe 409 con el id', async () => {
    const { service, scripted, eventos } = banco();
    const err = await service
      .gate(SUPERVISADO, KIND, { provider: 'sabre', enabled: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChangeRequestPendingError);
    expect((err as ChangeRequestPendingError).publicDetails).toEqual({
      changeRequestId: SOLICITUD,
    });
    expect((err as ChangeRequestPendingError).getStatus()).toBe(409);

    const insert = scripted.queries[scripted.indexOf('insert into "platform_change_requests"')]!;
    expect(insert.parameters).toContain(SUPERVISADO);
    expect(insert.parameters).toContain('Gobierno: sabre');
    // La solicitud y su evento, en la misma transacción.
    expect(eventos()).toEqual([
      {
        actor: SUPERVISADO,
        eventType: CHANGE_REQUEST_EVENTS.created,
        payload: {
          kind: KIND,
          summary: 'Gobierno: sabre',
          input: { provider: 'sabre', enabled: false },
        },
      },
    ]);
  });

  it('un tipo sin registrar es un error de programación, no una solicitud', async () => {
    const { service, scripted } = banco();
    await expect(service.gate(SUPERVISADO, 'algo.nuevo', {})).rejects.toThrow(/sin registrar/);
    expect(scripted.indexOf('insert into "platform_change_requests"')).toBe(-1);
  });

  it('al aplicar la aprobación no vuelve a frenar ese mismo cambio de quien lo pidió', async () => {
    const { service, scripted } = banco();
    await approvalContextStorage.run(
      {
        changeRequestId: SOLICITUD,
        kind: KIND,
        requestedBy: SUPERVISADO,
        approvedBy: PLENO,
        note: null,
      },
      () => service.gate(SUPERVISADO, KIND, { provider: 'sabre', enabled: false }),
    );
    expect(scripted.indexOf('insert into "platform_change_requests"')).toBe(-1);
  });

  it('repetir un tipo al registrar falla al arrancar', () => {
    const { service } = banco();
    expect(() =>
      service.register(KIND, {
        schema: Input,
        summary: () => '',
        execute: () => Promise.resolve(),
      }),
    ).toThrow(/repetido/);
  });
});

describe('SupervisionService.approve', () => {
  it('un supervisado no aprueba: 403 sin tocar la solicitud', async () => {
    const { service, actualizaciones, execute } = banco();
    await expect(service.approve(SUPERVISADO, SOLICITUD, null)).rejects.toBeInstanceOf(
      FullSuperadminRequiredError,
    );
    expect(actualizaciones()).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('nadie aprueba lo que pidió', async () => {
    const { service, execute } = banco({
      solicitud: { status: 'pending', requested_by: PLENO },
    });
    await expect(service.approve(PLENO, SOLICITUD, null)).rejects.toBeInstanceOf(
      OwnChangeRequestError,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('una solicitud ya decidida: 409', async () => {
    const { service } = banco({ solicitud: { status: 'rejected', requested_by: SUPERVISADO } });
    await expect(service.approve(PLENO, SOLICITUD, null)).rejects.toBeInstanceOf(
      ChangeRequestNotPendingError,
    );
  });

  it('la aplica con el actor de quien la pidió; el evento del cambio lleva quién aprobó', async () => {
    const { service, execute, eventos, actualizaciones } = banco();
    const view = await service.approve(PLENO, SOLICITUD, 'ok, era urgente');

    expect(execute).toHaveBeenCalledWith(SUPERVISADO, { provider: 'sabre', enabled: false });
    expect(actualizaciones()[0]?.parameters).toContain('approved');
    expect(view.id).toBe(SOLICITUD);

    const [aprobada, cambio] = eventos();
    expect(aprobada).toMatchObject({
      actor: PLENO,
      eventType: CHANGE_REQUEST_EVENTS.approved,
      payload: { kind: KIND, requestedBy: SUPERVISADO, note: 'ok, era urgente' },
    });
    expect(cambio).toMatchObject({
      actor: SUPERVISADO,
      eventType: 'platform.provider_governance.rule.updated',
      payload: {
        provider: 'sabre',
        approval: {
          changeRequestId: SOLICITUD,
          requestedBy: SUPERVISADO,
          approvedBy: PLENO,
          note: 'ok, era urgente',
        },
      },
    });
  });

  it('si aplicarla falla, queda failed con el motivo, deja el evento y el error sale', async () => {
    const { service, execute, eventos, actualizaciones } = banco();
    execute.mockRejectedValueOnce(new BadRequestException('el perfil ya no existe'));
    await expect(service.approve(PLENO, SOLICITUD, null)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const ultima = actualizaciones().at(-1)!;
    expect(ultima.parameters).toContain('failed');
    expect(ultima.parameters).toContain('el perfil ya no existe');
    expect(eventos().map((e) => e.eventType)).toEqual([
      CHANGE_REQUEST_EVENTS.approved,
      CHANGE_REQUEST_EVENTS.failed,
    ]);
  });
});

describe('SupervisionService.reject y cancel', () => {
  it('rechazar: sólo un pleno que no la pidió, con su nota', async () => {
    const { service, eventos, execute } = banco();
    await expect(service.reject(SUPERVISADO, SOLICITUD, null)).rejects.toBeInstanceOf(
      FullSuperadminRequiredError,
    );
    await service.reject(PLENO, SOLICITUD, 'no ahora');
    expect(execute).not.toHaveBeenCalled();
    const [rechazo] = eventos();
    expect(eventos()).toHaveLength(1);
    expect(rechazo).toMatchObject({
      actor: PLENO,
      eventType: CHANGE_REQUEST_EVENTS.rejected,
      payload: { note: 'no ahora' },
    });
  });

  it('cancelar: sólo quien la pidió', async () => {
    const { service, eventos } = banco();
    await expect(service.cancel(PLENO, SOLICITUD)).rejects.toBeInstanceOf(NotRequesterError);
    await service.cancel(SUPERVISADO, SOLICITUD);
    expect(eventos().map((e) => e.eventType)).toEqual([CHANGE_REQUEST_EVENTS.cancelled]);
  });
});

describe('failureMessage', () => {
  it('el mensaje de la API, nunca el de un error interno', () => {
    expect(failureMessage(new BadRequestException('regla inválida'))).toBe('regla inválida');
    expect(failureMessage(new Error('connection refused 10.0.0.5'))).not.toContain('10.0.0.5');
  });
});
