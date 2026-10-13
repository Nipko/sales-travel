import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Plataforma → Usuarios → Invitaciones, sin pantalla: qué se lee del API, a qué ruta va el pedido
 * (lo desconocido no pasa), cómo se dice cada dato, qué le pasa a la lista después de reenviar o
 * revocar, y las llamadas del navegador, que nunca lanzan. Todo en tú.
 */

const mocks = vi.hoisted(() => ({ apiWithStatus: vi.fn() }));

vi.mock('./api', () => ({ apiWithStatus: mocks.apiWithStatus }));

import {
  afterRemoval,
  afterResend,
  appendInvitations,
  DEFAULT_INVITATION_FILTERS,
  emptyInvitationsMessage,
  hasInvitationFilters,
  invitationExpiryLabel,
  invitationsCountLabel,
  invitationsLoadError,
  invitationsSearch,
  isInvitationExpired,
  loadPendingInvitationCount,
  loadPlatformInvitations,
  narrowsInvitations,
  parsePlatformInvitation,
  parsePlatformInvitationsPage,
  platformInvitationsListTarget,
  stateFilterCount,
  type InvitationsView,
  type PlatformInvitation,
} from './platform-invitations';
import { voseoIn } from './voseo';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const DAY = 24 * 60 * 60_000;
const NODE = '0b6f6a52-7a47-4c8e-9a3b-1a2b3c4d5e6f';
const OTHER = '1c7a7b63-8b58-4d9f-8b4c-2b3c4d5e6f70';

const RAW = {
  id: 'inv-1',
  email: 'ana@agencia.co',
  role: 'vendedor',
  tenantId: NODE.toUpperCase(),
  tenantName: 'Agencia Norte',
  invitedByEmail: 'root@plataforma.co',
  createdAt: '2026-10-11T12:00:00Z',
  expiresAt: '2026-10-18T12:00:00Z',
  expired: false,
};

function invitation(patch: Partial<PlatformInvitation> = {}): PlatformInvitation {
  const parsed = parsePlatformInvitation({ ...RAW, ...patch });
  if (parsed === undefined) throw new Error('fixture inválida');
  return parsed;
}

function view(
  invitations: PlatformInvitation[],
  counts: InvitationsView['counts'] = { pending: 4, expired: 2 },
): InvitationsView {
  return { invitations, nextCursor: 'cur', counts };
}

describe('lo que trae el API', () => {
  it('una invitación, con el nodo en minúsculas y sin quién la mandó si esa cuenta ya no existe', () => {
    expect(parsePlatformInvitation(RAW)).toEqual({ ...RAW, tenantId: NODE });
    expect(parsePlatformInvitation({ ...RAW, invitedByEmail: null, tenantName: 7 })).toMatchObject({
      invitedByEmail: null,
      tenantName: '',
    });
  });

  it('sin id, correo, rol, nodo o vencimiento no se puede mostrar ni actuar: se descarta', () => {
    for (const field of ['id', 'email', 'role', 'tenantId', 'expiresAt'] as const) {
      const { [field]: _omit, ...rest } = RAW;
      expect(parsePlatformInvitation(rest), field).toBeUndefined();
    }
    expect(parsePlatformInvitation(null)).toBeUndefined();
  });

  it('la página: filas válidas, cursor y contadores; sin contadores, null y no ceros inventados', () => {
    expect(
      parsePlatformInvitationsPage({
        invitations: [RAW, { id: 'rota' }],
        nextCursor: 'abc',
        counts: { pending: 3, expired: 1 },
      }),
    ).toEqual({
      invitations: [{ ...RAW, tenantId: NODE }],
      nextCursor: 'abc',
      counts: { pending: 3, expired: 1 },
    });
    expect(parsePlatformInvitationsPage({ invitations: [], nextCursor: '' })).toEqual({
      invitations: [],
      nextCursor: null,
      counts: null,
    });
    expect(
      parsePlatformInvitationsPage({ invitations: [], counts: { pending: -1, expired: 0 } })
        ?.counts,
    ).toBeNull();
  });

  it('una forma que no es la esperada es un error, no una lista vacía', () => {
    expect(parsePlatformInvitationsPage({ users: [] })).toBeUndefined();
    expect(parsePlatformInvitationsPage({ invitations: [], nextCursor: 5 })).toBeUndefined();
    expect(parsePlatformInvitationsPage('nada')).toBeUndefined();
  });
});

describe('platformInvitationsListTarget: la consulta que llega al API', () => {
  function target(search: string) {
    return platformInvitationsListTarget(new URLSearchParams(search));
  }

  it('sin filtros va a /admin/invitations tal cual', () => {
    expect(target('')).toEqual({ ok: true, path: '/admin/invitations' });
  });

  it('reconstruye cada parámetro: búsqueda recortada, nodo en minúsculas, límite normalizado', () => {
    expect(
      target(`state=expired&q=%20%20ana%20&tenantId=${NODE.toUpperCase()}&cursor=abc_-1&limit=007`),
    ).toEqual({
      ok: true,
      path: `/admin/invitations?state=expired&q=ana&tenantId=${NODE}&cursor=abc_-1&limit=7`,
    });
    expect(target('q=%20%20')).toEqual({ ok: true, path: '/admin/invitations' });
  });

  it.each([
    ['un parámetro desconocido', 'q=ana&role=admin'],
    ['un parámetro repetido', 'state=pending&state=all'],
    ['un estado que no existe', 'state=accepted'],
    ['un cursor con caracteres de más', 'cursor=a%2Fb'],
    ['un límite fuera de rango', 'limit=0'],
    ['un límite de más de 100', 'limit=101'],
    ['un límite que no es número', 'limit=diez'],
  ])('rechaza %s sin llegar al API', (_label, search) => {
    expect(target(search)).toEqual({
      ok: false,
      error: 'Los filtros de las invitaciones no son válidos. Recarga la página.',
    });
  });

  it('un nodo inválido y una búsqueda larga dicen qué está mal', () => {
    expect(target('tenantId=norte')).toEqual({ ok: false, error: 'Nodo inválido.' });
    expect(target(`q=${'x'.repeat(101)}`)).toEqual({
      ok: false,
      error: 'La búsqueda puede tener hasta 100 caracteres.',
    });
  });
});

describe('los filtros de la pantalla', () => {
  it('las pendientes son el defecto y no se nombran; el resto va a la consulta', () => {
    expect(invitationsSearch(DEFAULT_INVITATION_FILTERS)).toBe('');
    expect(invitationsSearch({ state: 'all', q: '  ana ', tenantId: NODE }, 'cur')).toBe(
      `state=all&q=ana&tenantId=${NODE}&cursor=cur`,
    );
  });

  it('"Limpiar filtros" aparece con cualquier cambio; "con esos filtros", sólo con búsqueda o nodo', () => {
    expect(hasInvitationFilters(DEFAULT_INVITATION_FILTERS)).toBe(false);
    expect(hasInvitationFilters({ state: 'expired', q: '' })).toBe(true);
    expect(hasInvitationFilters({ state: 'pending', q: ' a ' })).toBe(true);
    expect(narrowsInvitations({ state: 'expired', q: '  ' })).toBe(false);
    expect(narrowsInvitations({ state: 'pending', q: '', tenantId: NODE })).toBe(true);
  });

  it('el número de cada estado; "Todas" suma las dos; sin contadores, sin número', () => {
    const counts = { pending: 4, expired: 2 };
    expect(stateFilterCount(counts, 'pending')).toBe(4);
    expect(stateFilterCount(counts, 'expired')).toBe(2);
    expect(stateFilterCount(counts, 'all')).toBe(6);
    expect(stateFilterCount(null, 'all')).toBeUndefined();
  });

  it('la lista vacía dice qué no hay', () => {
    expect(emptyInvitationsMessage(DEFAULT_INVITATION_FILTERS)).toBe(
      'No hay invitaciones pendientes.',
    );
    expect(emptyInvitationsMessage({ state: 'expired', q: '' })).toBe(
      'No hay invitaciones vencidas.',
    );
    expect(emptyInvitationsMessage({ state: 'all', q: '' })).toBe(
      'No hay invitaciones sin aceptar.',
    );
    expect(emptyInvitationsMessage({ state: 'expired', q: 'ana' })).toBe(
      'No encontramos invitaciones con esos filtros.',
    );
  });

  it('el conteo de la lista', () => {
    expect(invitationsCountLabel(1, false)).toBe('1 invitación');
    expect(invitationsCountLabel(50, true)).toBe('50 invitaciones (hay más)');
  });
});

describe('el vencimiento', () => {
  it('vence en unos días, hoy o mañana; venció hace un tiempo', () => {
    const at = (ms: number) => invitation({ expiresAt: new Date(NOW + ms).toISOString() });
    expect(invitationExpiryLabel(at(5 * DAY + 60_000), NOW)).toBe('Vence en 5 días');
    expect(invitationExpiryLabel(at(DAY + 60_000), NOW)).toBe('Vence mañana');
    expect(invitationExpiryLabel(at(60 * 60_000), NOW)).toBe('Vence hoy');
    expect(invitationExpiryLabel(at(-3 * DAY), NOW)).toBe('Venció hace 3 días');
    expect(invitationExpiryLabel(at(0), NOW)).toBe('Venció hace un momento');
  });

  it('con el reloj de quien mira; si la fecha no se lee, lo que dijo el API', () => {
    expect(isInvitationExpired(invitation({ expiresAt: '2026-10-13T11:59:59Z' }), NOW)).toBe(true);
    expect(isInvitationExpired(invitation({ expiresAt: 'mañana', expired: true }), NOW)).toBe(true);
    const unreadable = invitation({ expiresAt: 'mañana', expired: false });
    expect(isInvitationExpired(unreadable, NOW)).toBe(false);
    expect(invitationExpiryLabel(unreadable, NOW)).toBe('Vigente');
    expect(invitationExpiryLabel(invitation({ expiresAt: 'ayer', expired: true }), NOW)).toBe(
      'Venció',
    );
  });
});

describe('la lista después de una acción', () => {
  const pending = invitation({ id: 'p', expiresAt: new Date(NOW + 2 * DAY).toISOString() });
  const expired = invitation({
    id: 'v',
    expiresAt: new Date(NOW - DAY).toISOString(),
    expired: true,
    invitedByEmail: null,
  });
  const issued = { expiresAt: new Date(NOW + 7 * DAY).toISOString(), invitedByEmail: 'yo@x.co' };

  it('reenviar una pendiente: vence más tarde y la respalda quien reenvió; los contadores no cambian', () => {
    const next = afterResend(view([pending, expired]), 'p', issued, 'pending', NOW);
    expect(next.invitations[0]).toMatchObject({
      id: 'p',
      expiresAt: issued.expiresAt,
      expired: false,
      invitedByEmail: 'yo@x.co',
    });
    expect(next.counts).toEqual({ pending: 4, expired: 2 });
    expect(next.nextCursor).toBe('cur');
  });

  it('reenviar una vencida en "Todas": queda pendiente y pasa de un contador al otro', () => {
    const next = afterResend(view([pending, expired]), 'v', issued, 'all', NOW);
    expect(next.invitations.map((i) => [i.id, i.expired])).toEqual([
      ['p', false],
      ['v', false],
    ]);
    expect(next.counts).toEqual({ pending: 5, expired: 1 });
  });

  it('reenviar una vencida en "Vencidas": sale de la lista', () => {
    const next = afterResend(view([pending, expired]), 'v', issued, 'expired', NOW);
    expect(next.invitations.map((i) => i.id)).toEqual(['p']);
    expect(next.counts).toEqual({ pending: 5, expired: 1 });
  });

  it('sin el correo de quien reenvió, queda el anterior; una fila que ya no está no cambia nada', () => {
    const next = afterResend(
      view([pending]),
      'p',
      { ...issued, invitedByEmail: null },
      'pending',
      NOW,
    );
    expect(next.invitations[0]?.invitedByEmail).toBe('root@plataforma.co');
    const same = view([pending]);
    expect(afterResend(same, 'otra', issued, 'pending', NOW)).toBe(same);
    expect(afterRemoval(same, 'otra', NOW)).toBe(same);
  });

  it('revocar (o saber que ya no estaba pendiente): sale de la lista y de su contador, nunca bajo cero', () => {
    expect(afterRemoval(view([pending, expired]), 'p', NOW)).toEqual({
      invitations: [expired],
      nextCursor: 'cur',
      counts: { pending: 3, expired: 2 },
    });
    expect(afterRemoval(view([pending, expired]), 'v', NOW).counts).toEqual({
      pending: 4,
      expired: 1,
    });
    expect(afterRemoval(view([expired], { pending: 0, expired: 0 }), 'v', NOW).counts).toEqual({
      pending: 0,
      expired: 0,
    });
    expect(afterRemoval(view([pending], null), 'p', NOW).counts).toBeNull();
  });

  it('"Cargar más" suma sin repetir y se queda con el cursor y los contadores nuevos', () => {
    const next = appendInvitations(view([pending]), {
      invitations: [pending, expired],
      nextCursor: null,
      counts: { pending: 1, expired: 1 },
    });
    expect(next).toEqual({
      invitations: [pending, expired],
      nextCursor: null,
      counts: { pending: 1, expired: 1 },
    });
    expect(
      appendInvitations(view([pending]), { invitations: [], nextCursor: null, counts: null })
        .counts,
    ).toEqual({ pending: 4, expired: 2 });
  });
});

describe('las llamadas del navegador', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function respond(status: number, body: unknown) {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('la lista pide la ruta del panel con los filtros y lee la página', async () => {
    const fetchMock = respond(200, {
      invitations: [RAW],
      nextCursor: null,
      counts: { pending: 1, expired: 0 },
    });
    const res = await loadPlatformInvitations({ state: 'all', q: 'ana', tenantId: OTHER }, 'cur');
    expect(res).toMatchObject({ ok: true, data: { invitations: [{ id: 'inv-1' }] } });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/invitations?state=all&q=ana&tenantId=${OTHER}&cursor=cur`,
      { cache: 'no-store' },
    );
  });

  it('sin filtros, la ruta sola; un 403 llega como el mensaje de permiso', async () => {
    const fetchMock = respond(403, { error: 'Esta acción es sólo para el superadmin.' });
    await expect(loadPlatformInvitations(DEFAULT_INVITATION_FILTERS)).resolves.toEqual({
      ok: false,
      message: 'Esta pantalla es sólo para el superadmin.',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/invitations', { cache: 'no-store' });
  });

  it('sin conexión o con una respuesta que no se entiende, un mensaje y no una excepción', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await expect(loadPlatformInvitations(DEFAULT_INVITATION_FILTERS)).resolves.toEqual({
      ok: false,
      message: 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
    });
    respond(200, { nada: true });
    await expect(loadPlatformInvitations(DEFAULT_INVITATION_FILTERS)).resolves.toEqual({
      ok: false,
      message: 'El servidor respondió algo que no pudimos leer. Recarga la página.',
    });
  });

  it('el contador de la pestaña pide una sola fila y lee las pendientes de toda la red', async () => {
    const fetchMock = respond(200, {
      invitations: [RAW],
      nextCursor: 'x',
      counts: { pending: 12, expired: 3 },
    });
    await expect(loadPendingInvitationCount()).resolves.toEqual({ ok: true, data: 12 });
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/invitations?limit=1', {
      cache: 'no-store',
    });

    respond(200, { invitations: [], nextCursor: null });
    await expect(loadPendingInvitationCount()).resolves.toMatchObject({ ok: false });
  });

  it('por qué no cargó, según el estado', () => {
    expect(invitationsLoadError(401, 'x')).toBe('Tu sesión venció. Vuelve a iniciar sesión.');
    expect(invitationsLoadError(503, undefined)).toBe(
      'No pudimos cargar las invitaciones: el servidor no respondió. Inténtalo de nuevo en unos minutos.',
    );
    expect(invitationsLoadError(400, ' Revisa los datos ingresados — q: muy larga ')).toBe(
      'Revisa los datos ingresados — q: muy larga',
    );
    expect(invitationsLoadError(400, '  ')).toBe(
      'No pudimos cargar las invitaciones. Inténtalo de nuevo.',
    );
  });
});

describe('la ruta del panel', () => {
  beforeEach(() => {
    mocks.apiWithStatus.mockReset();
    mocks.apiWithStatus.mockResolvedValue({
      kind: 'json',
      status: 200,
      body: { invitations: [], nextCursor: null, counts: { pending: 0, expired: 0 } },
    });
  });

  it('GET /api/admin/invitations reenvía la consulta reconstruida; lo inválido no llega al API', async () => {
    const { GET } = await import('../app/api/admin/invitations/route');
    const bad = await GET(new Request('https://app.test/api/admin/invitations?role=admin'));
    expect(bad.status).toBe(400);
    expect(mocks.apiWithStatus).not.toHaveBeenCalled();

    const ok = await GET(
      new Request('https://app.test/api/admin/invitations?state=expired&q=%20ana%20'),
    );
    expect(ok.status).toBe(200);
    expect(mocks.apiWithStatus).toHaveBeenCalledWith('/admin/invitations?state=expired&q=ana');
    expect(await ok.json()).toEqual({
      invitations: [],
      nextCursor: null,
      counts: { pending: 0, expired: 0 },
    });
  });

  it('deja pasar el estado y el motivo del API, no el cuerpo crudo', async () => {
    mocks.apiWithStatus.mockResolvedValueOnce({
      kind: 'json',
      status: 403,
      body: {
        message: 'Esta acción es sólo para el superadmin.',
        reason: 'SUPERADMIN_ONLY',
        stack: 'no',
      },
    });
    const { GET } = await import('../app/api/admin/invitations/route');
    const res = await GET(new Request('https://app.test/api/admin/invitations'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Esta acción es sólo para el superadmin.',
      reason: 'SUPERADMIN_ONLY',
    });
  });
});

describe('los textos van en tú', () => {
  it('ninguno vosea', () => {
    const texts = [
      emptyInvitationsMessage(DEFAULT_INVITATION_FILTERS),
      emptyInvitationsMessage({ state: 'all', q: 'x' }),
      invitationsLoadError(401, undefined),
      invitationsLoadError(403, undefined),
      invitationsLoadError(500, undefined),
      invitationsLoadError(400, undefined),
      platformInvitationsListTarget(new URLSearchParams('x=1')),
    ].map((t) => (typeof t === 'string' ? t : JSON.stringify(t)));
    for (const text of texts) expect(voseoIn(text), text).toEqual([]);
  });
});
