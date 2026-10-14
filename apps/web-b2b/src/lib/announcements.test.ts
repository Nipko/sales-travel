import { describe, expect, it } from 'vitest';
import {
  ANNOUNCEMENTS_SHOWN_MAX,
  DISMISSED_STORAGE_KEY,
  SEVERITY_BANNER_LABEL,
  SEVERITY_OPTIONS,
  STATUS_LABEL,
  TITLE_PLACEHOLDER,
  announcementErrorMessage,
  announcementWindowLabel,
  archiveAnnouncementTarget,
  audienceLabel,
  canDismiss,
  cleanBody,
  cleanTitle,
  createAnnouncementPlan,
  draftFromAnnouncement,
  draftToCreateBody,
  draftToPatchBody,
  emptyDraft,
  fromBogotaInput,
  isDraftDirty,
  parseActiveAnnouncements,
  parseAdminAnnouncements,
  previewOf,
  readDismissed,
  rememberDismissed,
  toBogotaInput,
  updateAnnouncementPlan,
  validateDraft,
  visibleAnnouncements,
  type ActiveAnnouncement,
  type AdminAnnouncement,
  type KeyValueStorage,
} from './announcements';
import { voseoIn } from './voseo';

const NOW = new Date('2026-10-13T17:00:00.000Z'); // 12:00 en Bogotá
const DAY = 86_400_000;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const NODO = '44444444-4444-4444-8444-444444444444';

function active(id: string, severity: ActiveAnnouncement['severity']): ActiveAnnouncement {
  return { id, severity, title: `Aviso ${id.slice(0, 1)}`, body: '' };
}

/** Un almacenamiento en memoria que sobrevive "recargas": se vuelve a leer con otra llamada. */
function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

/** El de una ventana privada o con los datos del sitio bloqueados: todo lanza. */
const brokenStorage: KeyValueStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('parseActiveAnnouncements', () => {
  it('lee la lista y descarta lo que no se puede leer, sin romper', () => {
    expect(
      parseActiveAnnouncements({
        announcements: [
          { id: A, severity: 'critical', title: 'Caída', body: 'Uno\nDos' },
          { id: 'x', severity: 'info', title: 'Sin id' },
          { id: B, severity: 'urgent', title: 'Gravedad rara' },
          { id: C, severity: 'info', title: '   ' },
          { id: A, severity: 'info', title: 'Repetido' },
          { id: NODO, severity: 'warning', title: 'Sin mensaje' },
        ],
      }),
    ).toEqual([
      { id: A, severity: 'critical', title: 'Caída', body: 'Uno\nDos' },
      { id: NODO, severity: 'warning', title: 'Sin mensaje', body: '' },
    ]);
    expect(parseActiveAnnouncements(null)).toEqual([]);
    expect(parseActiveAnnouncements({ announcements: 'no' })).toEqual([]);
    expect(parseActiveAnnouncements('<html>')).toEqual([]);
  });
});

describe('ocultar avisos', () => {
  it('lo oculto sobrevive a una recarga con almacenamiento', () => {
    const storage = memoryStorage();
    const after = rememberDismissed(storage, readDismissed(storage), A.toUpperCase());
    expect(after.has(A)).toBe(true);
    // "Recarga": se vuelve a leer de cero.
    expect([...readDismissed(storage)]).toEqual([A]);
    expect(storage.data.get(DISMISSED_STORAGE_KEY)).toBe(JSON.stringify([A]));
  });

  it('sin almacenamiento (o si lanza) no rompe: queda oculto hasta recargar', () => {
    expect(readDismissed(null).size).toBe(0);
    expect(readDismissed(brokenStorage).size).toBe(0);
    expect(rememberDismissed(brokenStorage, new Set(), A).has(A)).toBe(true);
    expect(rememberDismissed(null, new Set(), A).has(A)).toBe(true);
  });

  it('un valor guardado roto o ajeno se ignora', () => {
    const storage = memoryStorage();
    storage.setItem(DISMISSED_STORAGE_KEY, '{no es json');
    expect(readDismissed(storage).size).toBe(0);
    storage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([A, 'x', 3, null]));
    expect([...readDismissed(storage)]).toEqual([A]);
  });

  it('se recuerdan los últimos 50', () => {
    const storage = memoryStorage();
    let set = readDismissed(storage);
    for (let i = 0; i < 60; i++) {
      set = rememberDismissed(
        storage,
        set,
        `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
    }
    const kept = readDismissed(storage);
    expect(kept.size).toBe(50);
    expect(kept.has('00000000-0000-4000-8000-000000000059')).toBe(true);
    expect(kept.has('00000000-0000-4000-8000-000000000000')).toBe(false);
  });

  it('lo crítico no se oculta nunca; se muestran 3 como mucho', () => {
    expect(canDismiss('critical')).toBe(false);
    expect(canDismiss('warning')).toBe(true);
    expect(canDismiss('info')).toBe(true);
    const list = [active(A, 'critical'), active(B, 'warning'), active(C, 'info')];
    const dismissed = new Set([A, B]);
    expect(visibleAnnouncements(list, dismissed).map((a) => a.id)).toEqual([A, C]);
    const many = [...list, active(NODO, 'info')];
    expect(visibleAnnouncements(many, new Set())).toHaveLength(ANNOUNCEMENTS_SHOWN_MAX);
  });
});

describe('texto plano', () => {
  it('título en una línea, sin controles ni invisibles; el mensaje conserva sus saltos', () => {
    expect(cleanTitle('  Hola\u0007\nmun\u200Bdo\u202E ')).toBe('Hola mundo');
    expect(cleanBody('Uno\r\nDos\u0000\n\n\n\nTres\t!')).toBe('Uno\nDos\n\nTres !');
  });

  it('la vista previa es el anuncio como se verá, con un título de ejemplo si falta', () => {
    const draft = { ...emptyDraft(NOW), severity: 'critical' as const, body: ' Hola\n ' };
    expect(previewOf(draft)).toMatchObject({
      severity: 'critical',
      title: 'Título del anuncio',
      body: 'Hola',
    });
  });
});

describe('fechas en hora de Bogotá', () => {
  it('ida y vuelta del datetime-local, con UTC−5 todo el año', () => {
    expect(toBogotaInput(NOW)).toBe('2026-10-13T12:00');
    expect(fromBogotaInput('2026-10-13T12:00')).toBe(NOW.toISOString());
    expect(fromBogotaInput('2026-07-01T23:30')).toBe('2026-07-02T04:30:00.000Z');
    expect(fromBogotaInput('2026-02-30T10:00')).toBeUndefined();
    expect(fromBogotaInput('mañana')).toBeUndefined();
    expect(toBogotaInput('no es fecha')).toBe('');
  });

  it('la vigencia y el público como se leen en la lista', () => {
    expect(
      announcementWindowLabel({
        startsAt: '2026-10-17T07:00:00.000Z',
        endsAt: '2026-10-17T09:00:00.000Z',
      }),
    ).toBe('Del 17 oct, 02:00 al 17 oct, 04:00 (hora Bogotá)');
    expect(audienceLabel({ rootTenantId: null, rootTenantName: null, adminsOnly: false })).toBe(
      'Toda la red',
    );
    expect(audienceLabel({ rootTenantId: NODO, rootTenantName: 'Norte', adminsOnly: true })).toBe(
      'Norte y su red · Solo administradores',
    );
  });
});

describe('el formulario', () => {
  it('uno nuevo: información para toda la red, desde ahora y por un día', () => {
    expect(emptyDraft(NOW)).toEqual({
      severity: 'info',
      title: '',
      body: '',
      scope: 'network',
      rootTenantId: '',
      adminsOnly: false,
      startsLocal: '2026-10-13T12:00',
      endsLocal: '2026-10-14T12:00',
    });
  });

  it('revisa lo mismo que el API: título, mensaje, nodo y 31 días que no terminaron', () => {
    const ok = { ...emptyDraft(NOW), title: 'TBO en mantenimiento' };
    expect(validateDraft(ok, NOW)).toEqual({});
    expect(validateDraft({ ...ok, title: ' a\u0007 ' }, NOW).title).toBeDefined();
    expect(validateDraft({ ...ok, title: 'x'.repeat(121) }, NOW).title).toBeDefined();
    expect(validateDraft({ ...ok, body: 'x'.repeat(601) }, NOW).body).toBeDefined();
    expect(validateDraft({ ...ok, body: '🛫'.repeat(600) }, NOW).body).toBeUndefined();
    expect(validateDraft({ ...ok, scope: 'node' }, NOW).rootTenantId).toBe(
      'Elige el nodo que recibe el anuncio.',
    );
    expect(validateDraft({ ...ok, scope: 'node', rootTenantId: NODO }, NOW)).toEqual({});
    expect(validateDraft({ ...ok, endsLocal: '2026-11-13T12:00' }, NOW)).toEqual({});
    expect(validateDraft({ ...ok, endsLocal: '2026-11-13T12:01' }, NOW).endsLocal).toBe(
      'Un anuncio dura como mucho 31 días.',
    );
    expect(validateDraft({ ...ok, endsLocal: ok.startsLocal }, NOW).endsLocal).toBe(
      'Tiene que terminar después de empezar.',
    );
    expect(
      validateDraft({ ...ok, startsLocal: '2026-10-10T08:00', endsLocal: '2026-10-11T08:00' }, NOW)
        .endsLocal,
    ).toBe('Ese final ya pasó: elige uno en el futuro.');
    expect(validateDraft({ ...ok, startsLocal: '' }, NOW).startsLocal).toBeDefined();
  });

  it('publicar manda el texto limpio, el público y las fechas como instantes', () => {
    const draft = {
      ...emptyDraft(NOW),
      severity: 'warning' as const,
      title: '  TBO\n en mantenimiento ',
      body: 'Sábado\r\n02:00 a 04:00',
      scope: 'node' as const,
      rootTenantId: NODO.toUpperCase(),
      adminsOnly: true,
    };
    expect(draftToCreateBody(draft)).toEqual({
      severity: 'warning',
      title: 'TBO en mantenimiento',
      body: 'Sábado\n02:00 a 04:00',
      audience: { rootTenantId: NODO, adminsOnly: true },
      startsAt: NOW.toISOString(),
      endsAt: new Date(NOW.getTime() + DAY).toISOString(),
    });
  });

  it('corregir manda sólo lo que cambió; las fechas, sólo si cambió el minuto', () => {
    const announcement: AdminAnnouncement = {
      id: A,
      severity: 'info',
      title: 'Hola',
      body: '',
      startsAt: '2026-10-13T17:00:33.123Z',
      endsAt: '2026-10-14T17:00:00.000Z',
      audience: { rootTenantId: null, rootTenantName: null, adminsOnly: false },
      status: 'active',
      archivedAt: null,
    };
    const base = draftFromAnnouncement(announcement);
    expect(draftToPatchBody(base, base)).toEqual({});
    expect(isDraftDirty(base, base)).toBe(false);
    const next = { ...base, title: 'Hola de nuevo', endsLocal: '2026-10-15T12:00' };
    expect(draftToPatchBody(next, base)).toEqual({
      title: 'Hola de nuevo',
      endsAt: '2026-10-15T17:00:00.000Z',
    });
    expect(draftToPatchBody({ ...base, adminsOnly: true }, base)).toEqual({
      audience: { rootTenantId: null, adminsOnly: true },
    });
  });
});

describe('las rutas del panel rearman el cuerpo', () => {
  const body = {
    severity: 'info',
    title: 'Hola',
    body: 'Mensaje',
    audience: { rootTenantId: null, adminsOnly: false },
    endsAt: '2026-10-14T17:00:00.000Z',
  };

  it('publicar: sólo los campos del anuncio, con su forma', () => {
    expect(createAnnouncementPlan({ ...body, createdBy: 'otro', html: '<b>' })).toEqual({
      ok: true,
      path: '/admin/announcements',
      body,
    });
    expect(createAnnouncementPlan({ ...body, severity: 'urgent' }).ok).toBe(false);
    expect(createAnnouncementPlan({ ...body, endsAt: 'mañana' }).ok).toBe(false);
    expect(
      createAnnouncementPlan({ ...body, audience: { rootTenantId: '../x', adminsOnly: true } }).ok,
    ).toBe(false);
    const { endsAt: _endsAt, ...sinFinal } = body;
    expect(createAnnouncementPlan(sinFinal).ok).toBe(false);
    expect(createAnnouncementPlan(undefined).ok).toBe(false);
  });

  it('corregir y archivar: el id tiene que ser un UUID; corregir, con algo que cambiar', () => {
    expect(updateAnnouncementPlan(A.toUpperCase(), { title: 'Otro', extra: 1 })).toEqual({
      ok: true,
      path: `/admin/announcements/${A}`,
      body: { title: 'Otro' },
    });
    expect(updateAnnouncementPlan('../../tenants', { title: 'x' }).ok).toBe(false);
    expect(updateAnnouncementPlan(A, {}).ok).toBe(false);
    expect(archiveAnnouncementTarget(A)).toEqual({
      ok: true,
      path: `/admin/announcements/${A}/archive`,
    });
    expect(archiveAnnouncementTarget('x').ok).toBe(false);
  });

  it('los mensajes de error', () => {
    expect(announcementErrorMessage(400, 'Un anuncio dura como mucho 31 días.')).toBe(
      'Un anuncio dura como mucho 31 días.',
    );
    expect(announcementErrorMessage(403, undefined)).toBe(
      'Sólo el superadmin gestiona los anuncios.',
    );
    expect(announcementErrorMessage(502, '')).toContain('Inténtalo de nuevo');
  });
});

describe('parseAdminAnnouncements', () => {
  it('lee el estado, el público y las fechas; descarta lo ilegible', () => {
    const ok = {
      id: A,
      severity: 'warning',
      title: 'Hola',
      body: '',
      startsAt: '2026-10-13T17:00:00.000Z',
      endsAt: '2026-10-14T17:00:00.000Z',
      audience: { rootTenantId: NODO.toUpperCase(), rootTenantName: 'Norte', adminsOnly: true },
      status: 'scheduled',
      archivedAt: null,
      createdAt: '2026-10-13T16:00:00.000Z',
    };
    const parsed = parseAdminAnnouncements({
      announcements: [ok, { ...ok, id: B, status: 'raro' }, { ...ok, id: C, audience: null }],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]).toMatchObject({
      status: 'scheduled',
      audience: { rootTenantId: NODO, rootTenantName: 'Norte', adminsOnly: true },
      archivedAt: null,
    });
    expect(parseAdminAnnouncements({})).toBeUndefined();
  });
});

describe('copy', () => {
  it('las etiquetas que pide el panel, en tú', () => {
    expect(Object.values(SEVERITY_BANNER_LABEL)).toEqual(['Aviso', 'Importante', 'Crítico']);
    expect(SEVERITY_OPTIONS.map((o) => o.label)).toEqual(['Información', 'Advertencia', 'Crítico']);
    expect(Object.values(STATUS_LABEL)).toEqual(['Programado', 'Vigente', 'Vencido', 'Archivado']);
    expect(TITLE_PLACEHOLDER).toBe('TBO en mantenimiento el sábado de 02:00 a 04:00 (hora Bogotá)');
    const textos = [
      ...SEVERITY_OPTIONS.map((o) => o.detail),
      ...Object.values(validateDraft({ ...emptyDraft(NOW), scope: 'node', startsLocal: '' }, NOW)),
      announcementErrorMessage(404, undefined),
      announcementErrorMessage(409, undefined),
      announcementErrorMessage(500, undefined),
      announcementErrorMessage(400, undefined),
    ];
    expect(voseoIn(textos.join(' '))).toEqual([]);
  });
});
