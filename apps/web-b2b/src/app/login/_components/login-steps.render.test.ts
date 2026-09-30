import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  LOGIN_MESSAGES,
  parseSeatsFull,
  type CredentialsState,
  type MfaState,
  type SeatsState,
} from '../login-state';
import { CredentialsStep } from './credentials-step';
import { MfaStep, REMEMBER_DEVICE_LABEL } from './mfa-step';
import { RELEASE_BUTTON_LABEL, SeatsFullStep } from './seats-full-step';

// La página importa la server action, que importa `next/headers`: acá sólo interesa lo que pinta.
vi.mock('../actions', () => ({ loginAction: vi.fn() }));

/*
 * El primer pintado de cada paso del login: lo que viaja en cada formulario, lo que anuncia un
 * lector de pantalla y el orden de tabulación. La lógica de pasos está en `login-state.test.ts`.
 */

const noop = () => undefined;
const EMAIL = 'ana@andinos.co';

function inputs(html: string): string[] {
  return html.match(/<input[^>]*>/g) ?? [];
}

function hidden(html: string, name: string): string | undefined {
  const tag = inputs(html).find((i) => i.includes('type="hidden"') && i.includes(`name="${name}"`));
  return tag?.match(/value="([^"]*)"/)?.[1];
}

function attr(tag: string | undefined, name: string): string | undefined {
  return tag?.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
}

function credentials(state: Partial<CredentialsState> = {}, extra: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(CredentialsStep, {
      state: { step: 'credentials', attempt: 0, email: '', ...state },
      pending: false,
      formAction: noop,
      next: '/reservas/9',
      ...extra,
    }),
  );
}

describe('CredentialsStep', () => {
  it('primer pintado: email enfocado, contraseña con toggle y destino en el formulario', () => {
    const html = credentials();
    const email = inputs(html).find((i) => i.includes('name="email"'));
    expect(email).toContain('type="email"');
    expect(email).toContain('autoComplete="username"');
    expect(email).toMatch(/autofocus=""/i);
    // 16 px en el teléfono: iOS no hace zoom al enfocar.
    expect(email).toMatch(/class="[^"]*\btext-base\b/);
    const password = inputs(html).find((i) => i.includes('name="password"'));
    expect(password).toContain('type="password"');
    expect(password).toContain('autoComplete="current-password"');
    expect(html).toContain('aria-label="Mostrar contraseña"');
    expect(hidden(html, 'intent')).toBe('credentials');
    expect(hidden(html, 'next')).toBe('/reservas/9');
    expect(html).toContain('href="/olvide-password"');
    expect(html).toMatch(/<h1[^>]*>Ingresá a tu cuenta<\/h1>/);
  });

  it('Tab desde el email va a la contraseña: el link de olvido queda después del botón', () => {
    const html = credentials();
    const email = html.indexOf('name="email"');
    const password = html.indexOf('name="password"');
    const submit = html.search(/<button[^>]*type="submit"/);
    const forgot = html.indexOf('href="/olvide-password"');
    expect(email).toBeLessThan(password);
    expect(password).toBeLessThan(submit);
    expect(submit).toBeLessThan(forgot);
  });

  it('después de un error conserva el email y asocia el error a los campos', () => {
    const html = credentials({
      attempt: 1,
      email: EMAIL,
      error: { kind: 'invalid', message: LOGIN_MESSAGES.invalid },
    });
    const email = inputs(html).find((i) => i.includes('name="email"'));
    expect(attr(email, 'value')).toBe(EMAIL);
    expect(email).not.toMatch(/autofocus/i);

    const alert = html.match(/<div id="([^"]+)" role="alert"/);
    expect(alert).not.toBeNull();
    const errorId = alert?.[1];
    expect(attr(email, 'aria-describedby')).toBe(errorId);
    expect(attr(email, 'aria-invalid')).toBe('true');
    const password = inputs(html).find((i) => i.includes('name="password"'));
    expect(attr(password, 'aria-invalid')).toBe('true');
    expect(attr(password, 'aria-describedby')).toContain(errorId);

    expect(html).toContain(LOGIN_MESSAGES.invalid);
    expect(html).toContain('bloqueamos la cuenta por 15 minutos');
  });

  it('un error del servidor no marca los campos como inválidos', () => {
    const html = credentials({
      attempt: 1,
      email: EMAIL,
      error: { kind: 'unavailable', message: LOGIN_MESSAGES.unavailable },
    });
    expect(html).not.toContain('aria-invalid');
    expect(html).not.toContain('bloqueamos la cuenta');
  });

  it('el aviso de por qué volvió a la contraseña es un status', () => {
    const html = credentials({ attempt: 2, email: EMAIL, notice: LOGIN_MESSAGES.mfaExpired });
    expect(html).toMatch(new RegExp(`role="status"[^>]*>.*${LOGIN_MESSAGES.mfaExpired}`));
    // Sin cuenta bloqueada no hay link de restablecer en el aviso (sólo el de siempre, abajo).
    expect(html.match(/href="\/olvide-password"/g)).toHaveLength(1);
  });

  // Un status que se monta ya con su texto no se anuncia en todos los lectores: el aviso se lee
  // como descripción del campo que recibe el foco al volver del código.
  it('el aviso describe el campo que recibe el foco', () => {
    const html = credentials({ attempt: 2, email: EMAIL, notice: LOGIN_MESSAGES.mfaExpired });
    const noticeId = html.match(/<div id="([^"]+)" role="status"/)?.[1];
    expect(noticeId).toBeDefined();
    const password = inputs(html).find((i) => i.includes('name="password"'));
    expect(attr(password, 'aria-describedby')).toBe(noticeId);
    const email = inputs(html).find((i) => i.includes('name="email"'));
    expect(attr(email, 'aria-describedby')).toBeUndefined();

    // Sin email cargado el foco va al email: ahí va el aviso.
    const noEmail = credentials({ notice: LOGIN_MESSAGES.mfaLost });
    const id = noEmail.match(/<div id="([^"]+)" role="status"/)?.[1];
    const emailInput = inputs(noEmail).find((i) => i.includes('name="email"'));
    expect(attr(emailInput, 'aria-describedby')).toBe(id);
  });

  it('cuenta bloqueada en el paso del código: el aviso lo dice y ofrece restablecer', () => {
    const html = credentials({
      attempt: 3,
      email: EMAIL,
      notice: LOGIN_MESSAGES.mfaLocked,
      offerPasswordReset: true,
    });
    const status = html.match(/<div id="[^"]+" role="status"[^>]*>(.*?)<\/div><\/div>/)?.[1];
    expect(status).toContain('bloqueamos la cuenta por 15 minutos');
    expect(status).toContain('href="/olvide-password"');
    expect(status).toContain('Restablecer contraseña');
  });

  it('muestra el motivo del cierre sólo en la primera pantalla', () => {
    const first = credentials({}, { motivo: 'otro-dispositivo' });
    expect(first).toContain('Tu sesión se abrió en otro dispositivo.');
    expect(first).toContain('Si no fuiste vos, cambiá tu contraseña');
    const retry = credentials(
      { attempt: 1, email: EMAIL, error: { kind: 'invalid', message: LOGIN_MESSAGES.invalid } },
      { motivo: 'otro-dispositivo' },
    );
    expect(retry).not.toContain('Tu sesión se abrió en otro dispositivo.');
  });

  it('inactividad con los minutos', () => {
    expect(credentials({}, { motivo: 'inactividad', idleMinutes: 30 })).toContain(
      'Cerramos tu sesión después de 30 minutos sin actividad.',
    );
  });

  it('enviando: botón ocupado y formulario con aria-busy', () => {
    const html = renderToStaticMarkup(
      createElement(CredentialsStep, {
        state: { step: 'credentials', attempt: 0, email: '' },
        pending: true,
        formAction: noop,
        next: '/',
      }),
    );
    expect(html).toMatch(/<form[^>]*aria-busy="true"/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>.*Ingresando…/);
    expect(html).toMatch(/<p class="sr-only" aria-live="polite">Verificando tus datos…<\/p>/);
  });
});

function mfa(state: Partial<MfaState> = {}, pending = false): string {
  return renderToStaticMarkup(
    createElement(MfaStep, {
      state: {
        step: 'mfa',
        attempt: 1,
        email: EMAIL,
        mfaToken: 'mfa-jwt',
        rememberDevice: true,
        mode: 'totp',
        ...state,
      },
      pending,
      formAction: noop,
      next: '/reservas/9',
      onBack: noop,
    }),
  );
}

describe('MfaStep', () => {
  it('"Recordar este equipo" marcado por defecto y ANTES del código en el orden de tabulación', () => {
    const html = mfa();
    const tags = inputs(html);
    const rememberAt = tags.findIndex((i) => i.includes('name="rememberDevice"'));
    const firstDigitAt = tags.findIndex((i) => i.includes('aria-label="Dígito 1 de 6"'));
    expect(rememberAt).toBeGreaterThanOrEqual(0);
    expect(firstDigitAt).toBeGreaterThan(rememberAt);
    expect(tags[rememberAt]).toContain('type="checkbox"');
    expect(tags[rememberAt]).toContain('value="1"');
    expect(tags[rememberAt]).toContain('checked=""');
    expect(html).toContain(REMEMBER_DEVICE_LABEL);
    // Enfoca el código: se puede escribir de una, y volver atrás a la casilla con Mayús+Tab.
    expect(tags[firstDigitAt]).toMatch(/autofocus=""/i);
  });

  it('respeta la elección del intento anterior', () => {
    const remember = inputs(mfa({ rememberDevice: false })).find((i) =>
      i.includes('name="rememberDevice"'),
    );
    expect(remember).not.toContain('checked');
  });

  it('seis casillas y lo necesario para canjear el desafío', () => {
    const html = mfa();
    expect(inputs(html).filter((i) => i.includes('aria-label="Dígito'))).toHaveLength(6);
    expect(hidden(html, 'intent')).toBe('mfa');
    expect(hidden(html, 'mfaToken')).toBe('mfa-jwt');
    expect(hidden(html, 'email')).toBe(EMAIL);
    expect(hidden(html, 'mode')).toBe('totp');
    expect(hidden(html, 'next')).toBe('/reservas/9');
    expect(hidden(html, 'code')).toBe('');
    expect(html).toContain(EMAIL);
  });

  it('botón de respaldo, código de recuperación y volver', () => {
    const html = mfa();
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Verificar<\/button>/);
    expect(html).toContain('Usar un código de recuperación');
    expect(html).toMatch(/<button type="button"[^>]*>.*Volver<\/button>/);
  });

  it('código incorrecto: error asociado al grupo, con los intentos que quedan', () => {
    const html = mfa({ attempt: 2, error: 'El código no es correcto. Te quedan 3 intentos.' });
    const errorId = html.match(/<div id="([^"]+)" role="alert"/)?.[1];
    expect(errorId).toBeDefined();
    expect(html).toContain('Te quedan 3 intentos.');
    const group = html.match(/<div role="group"[^>]*>/)?.[0];
    expect(attr(group, 'aria-describedby')).toContain(errorId);
    expect(inputs(html).find((i) => i.includes('Dígito 1 de 6'))).toContain('aria-invalid="true"');
  });

  it('enviando: casillas deshabilitadas, el valor sigue viajando y se anuncia', () => {
    const html = mfa({}, true);
    for (const box of inputs(html).filter((i) => i.includes('aria-label="Dígito'))) {
      expect(box).toContain('disabled=""');
    }
    expect(inputs(html).find((i) => i.includes('name="code"'))).not.toContain('disabled');
    expect(html).toMatch(/<form[^>]*aria-busy="true"/);
    expect(html).toContain('Verificando…');
    expect(html).toContain('Verificando el código…');
  });

  it('modo recuperación: un campo de texto, sin envío automático', () => {
    const html = mfa({ mode: 'recovery' });
    expect(inputs(html).some((i) => i.includes('aria-label="Dígito'))).toBe(false);
    const code = inputs(html).find((i) => i.includes('name="code"'));
    expect(code).not.toContain('type="hidden"');
    expect(code).toContain('autoComplete="off"');
    expect(code).toContain('placeholder="A1B2C-3D4E5"');
    expect(hidden(html, 'mode')).toBe('recovery');
    expect(html).toContain('Usar el código de la app');
  });
});

const LISTED_AT = Date.now();

const SEATS = parseSeatsFull({
  tenantName: 'Viajes Andinos',
  limit: 2,
  inUse: 2,
  release: {
    token: 'release-jwt',
    sessions: [
      {
        sessionId: 's-1',
        name: 'Ana Pérez',
        email: 'ana@andinos.co',
        tenantName: 'Viajes Andinos',
        lastSeenAt: new Date(LISTED_AT - 3 * 60_000).toISOString(),
        device:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        ip: '190.0.0.1',
      },
      {
        sessionId: 's-2',
        name: null,
        email: 'caja@andinos.co',
        tenantName: 'Sucursal Norte',
        lastSeenAt: null,
        device: null,
        ip: null,
      },
    ],
  },
});

function seats(state: Partial<SeatsState> = {}): string {
  return renderToStaticMarkup(
    createElement(SeatsFullStep, {
      state: {
        step: 'seats',
        attempt: 1,
        email: EMAIL,
        seats: SEATS,
        listedAt: LISTED_AT,
        ...state,
      },
      pending: false,
      formAction: noop,
      next: '/',
      onBack: noop,
    }),
  );
}

describe('SeatsFullStep', () => {
  it('quien administra el cupo ve quién está conectado y puede desconectar a alguien', () => {
    const html = seats();
    expect(html).toMatch(/<h1[^>]*tabindex="-1"[^>]*>No hay puestos libres<\/h1>/i);
    expect(html).toContain('Los 2 puestos de Viajes Andinos están en uso.');
    expect(hidden(html, 'intent')).toBe('release');
    expect(hidden(html, 'releaseToken')).toBe('release-jwt');
    expect(hidden(html, 'email')).toBe(EMAIL);

    expect(html).toContain('Ana Pérez');
    expect(html).toContain('Chrome en Windows · 190.0.0.1');
    expect(html).toContain('Activo hace 3 min');
    // Sin nombre, se identifica por el email; el nodo aparece si no es el del cupo.
    expect(html).toContain('caja@andinos.co');
    expect(html).toContain('Sucursal Norte');
    expect(html).toContain('Dispositivo desconocido');

    const buttons = html.match(/<button[^>]*type="submit"[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(attr(buttons[0], 'name')).toBe('sessionId');
    expect(attr(buttons[0], 'value')).toBe('s-1');
    expect(attr(buttons[1], 'value')).toBe('s-2');
    // El botón dice lo mismo en cada fila: la descripción dice a quién desconecta.
    const describedBy = attr(buttons[0], 'aria-describedby');
    expect(html).toContain(`id="${describedBy}" class="truncate text-sm font-medium`);
    expect(html.split(RELEASE_BUTTON_LABEL).length - 1).toBe(2);
  });

  it('quien no administra el cupo ve a quién pedírselo, sin lista', () => {
    const html = seats({ seats: { ...SEATS, release: null } });
    expect(html).toContain('Pedile a un administrador de Viajes Andinos que libere uno');
    expect(html).toContain('Volver a intentar');
    expect(html).not.toContain(RELEASE_BUTTON_LABEL);
    expect(html).not.toContain('Ana Pérez');
    expect(hidden(html, 'releaseToken')).toBeUndefined();
  });

  it('errores y avisos a la vista', () => {
    expect(seats({ error: LOGIN_MESSAGES.releaseForbidden })).toMatch(/role="alert"/);
    expect(seats({ notice: LOGIN_MESSAGES.seatsTakenAgain })).toContain(
      LOGIN_MESSAGES.seatsTakenAgain,
    );
  });

  // Tras una respuesta el foco vuelve al título (el botón usado se deshabilitó o desapareció): el
  // lector lo lee junto con el error o aviso nuevo.
  it('el título se describe con el error o aviso de la respuesta', () => {
    const html = seats({ attempt: 2, error: LOGIN_MESSAGES.rateLimited });
    const alertId = html.match(/<div id="([^"]+)" role="alert"/)?.[1];
    expect(alertId).toBeDefined();
    const title = html.match(/<h1[^>]*>/)?.[0];
    expect(attr(title, 'aria-describedby')).toBe(alertId);

    const both = seats({ attempt: 3, notice: LOGIN_MESSAGES.seatsTakenAgain, error: 'x' });
    const ids = [
      both.match(/<div id="([^"]+)" role="status"/)?.[1],
      both.match(/<div id="([^"]+)" role="alert"/)?.[1],
    ];
    expect(attr(both.match(/<h1[^>]*>/)?.[0], 'aria-describedby')).toBe(ids.join(' '));

    expect(seats().match(/<h1[^>]*>/)?.[0]).not.toContain('aria-describedby');
  });

  it('"Activo hace" se mide contra cuándo llegó la lista, no contra el montaje', () => {
    // Una lista que llegó 4 minutos "después" (otra respuesta en el mismo paso): la sesión vista
    // 1 minuto antes de que llegara no es "Activo ahora".
    const later = LISTED_AT + 4 * 60_000;
    const fresh = parseSeatsFull({
      tenantName: 'Viajes Andinos',
      limit: 1,
      inUse: 1,
      release: {
        token: 'release-jwt',
        sessions: [
          { sessionId: 's-9', name: 'Beto', lastSeenAt: new Date(later - 60_000).toISOString() },
        ],
      },
    });
    const html = seats({ seats: fresh, listedAt: later, notice: LOGIN_MESSAGES.seatsTakenAgain });
    expect(html).toContain('Activo hace 1 min');
    expect(html).not.toContain('Activo ahora');
  });
});

describe('LoginPage', () => {
  async function page(params: Record<string, string>): Promise<string> {
    const { default: LoginPage } = await import('../page');
    const element = await LoginPage({ searchParams: Promise.resolve(params) });
    return renderToStaticMarkup(element);
  }

  it('lleva el destino validado y el motivo al formulario', async () => {
    const html = await page({ next: '/reservas/9', motivo: 'inactividad', minutos: '30' });
    expect(hidden(html, 'next')).toBe('/reservas/9');
    expect(html).toContain('Cerramos tu sesión después de 30 minutos sin actividad.');
  });

  it('un next externo o un motivo inventado no pasan', async () => {
    const html = await page({ next: '//evil.example', motivo: '<script>' });
    expect(hidden(html, 'next')).toBe('/');
    expect(html).not.toContain('role="status"');
  });

  it('voseo en toda la pantalla y sin links falsos', async () => {
    const html = await page({});
    for (const ustedeo of [
      'Ingrese',
      'Use su',
      'Contacte',
      'Gestione',
      'Conéctese',
      'su agencia',
    ]) {
      expect(html).not.toContain(ustedeo);
    }
    expect(html).not.toContain('cursor-pointer');
    expect(html).toContain('¿No podés ingresar? Pedile ayuda al administrador de tu agencia.');
    // Un solo h1 por pantalla: el del paso.
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });
});
