import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/*
 * Primer pintado de la pantalla de Seguridad y de la de enrolamiento obligatorio: lo que se ofrece
 * en cada estado y lo que anuncia un lector de pantalla. La lógica de qué vista gana está en
 * `security-model.test.ts`; las acciones, en `actions.test.ts`.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('./actions', () => {
  const noop = vi.fn(() => Promise.resolve({}));
  return {
    changePasswordAction: noop,
    confirmMfaAction: noop,
    disableMfaAction: noop,
    enrollMfaAction: noop,
    regenerateRecoveryCodesAction: noop,
    revokeAllSessionsAction: noop,
    revokeAllTrustedDevicesAction: noop,
    revokeSessionAction: noop,
    revokeTrustedDeviceAction: noop,
    startPhoneChangeAction: noop,
  };
});

import { DisableMfaForm, SecurityClient, type SecurityClientProps } from './SecurityClient';
import { MfaEnrollmentGate, GATE_TITLE } from './_components/mfa-enrollment-gate';
import { MfaSetupStep, QR_LABEL, SCAN_TITLE } from './_components/mfa-enrollment';
import { RecoveryCodeField } from './_components/recovery-code-field';
import { RecoveryCodes } from './_components/recovery-codes';
import { SessionsList } from './_components/sessions-list';
import { TrustedDevices } from './_components/trusted-devices';
import type { SessionRow, TrustedDeviceRow } from './security-model';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const CODES = Array.from({ length: 10 }, (_, i) => `ABCDE-${String(i).padStart(5, '0')}`);

function buttons(html: string): string[] {
  return (html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).map((b) =>
    b.replace(/<[^>]+>/g, '').trim(),
  );
}

function buttonTag(html: string, text: string): string | undefined {
  return (html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).find((b) =>
    b
      .replace(/<[^>]+>/g, '')
      .trim()
      .startsWith(text),
  );
}

const session = (over: Partial<SessionRow>): SessionRow => ({
  id: 's',
  issuedAt: '2026-09-29T08:00:00Z',
  lastSeenAt: '2026-09-29T11:58:00Z',
  expiresAt: '2026-09-29T20:00:00Z',
  ip: '203.0.113.7',
  userAgent: CHROME_WIN,
  current: false,
  ...over,
});

const device = (over: Partial<TrustedDeviceRow>): TrustedDeviceRow => ({
  id: 'd',
  createdAt: '2026-09-20T12:00:00Z',
  lastUsedAt: '2026-09-28T12:00:00Z',
  expiresAt: '2026-10-20T12:00:00Z',
  ip: '203.0.113.7',
  userAgent: CHROME_WIN,
  current: false,
  ...over,
});

function page(over: Partial<SecurityClientProps> = {}): string {
  const props: SecurityClientProps = {
    mfa: { enabled: false, recoveryCodesRemaining: 0, required: false, pendingEnrollment: false },
    sessions: [session({ id: 'me', current: true })],
    trustedDevices: [],
    now: NOW,
    enrollmentRequired: false,
    ...over,
  };
  return renderToStaticMarkup(createElement(SecurityClient, props));
}

describe('RecoveryCodes', () => {
  const html = renderToStaticMarkup(
    createElement(RecoveryCodes, {
      codes: CODES,
      reason: 'enabled',
      email: 'ana@agencia.co',
      onDone: () => {},
    }),
  );

  it('muestra los 10 códigos en una lista con nombre', () => {
    expect(html).toContain('aria-label="Códigos de recuperación"');
    for (const code of CODES) expect(html).toContain(code);
  });

  it('copiar, descargar e imprimir', () => {
    const labels = buttons(html);
    expect(labels).toEqual(expect.arrayContaining(['Copiar todos', 'Descargar .txt', 'Imprimir']));
  });

  it('"Listo" arranca deshabilitado hasta marcar "Los guardé en un lugar seguro"', () => {
    expect(html).toContain('Los guardé en un lugar seguro');
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(buttonTag(html, 'Listo')).toContain('disabled=""');
    expect(html).toContain('Marcá la casilla cuando los tengas guardados.');
  });

  it('avisa que no se vuelven a mostrar; al regenerar, que los anteriores dejaron de servir', () => {
    expect(html).toContain('No los');
    expect(html).not.toContain('Los códigos anteriores dejaron de servir');
    const regenerated = renderToStaticMarkup(
      createElement(RecoveryCodes, { codes: CODES, reason: 'regenerated', onDone: () => {} }),
    );
    expect(regenerated).toContain('Los códigos anteriores dejaron de servir');
    expect(regenerated).toContain('Generamos códigos de recuperación nuevos');
  });
});

describe('MfaSetupStep', () => {
  const html = renderToStaticMarkup(
    createElement(MfaSetupStep, {
      enrollment: {
        secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
        otpauthUri:
          'otpauth://totp/Planetour:ana%40agencia.co?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      },
      onConfirmed: () => {},
    }),
  );

  it('QR como imagen con nombre accesible, bajo el título del paso', () => {
    expect(html).toContain(SCAN_TITLE);
    expect(html).toContain(`<svg role="img" aria-label="${QR_LABEL}"`);
  });

  it('pasos 1-2-3 en una lista ordenada', () => {
    expect(html).toMatch(/<ol[^>]*>[\s\S]*<li[\s\S]*<li[\s\S]*<li/);
    expect(html).toContain('Abrí tu app de autenticación');
    expect(html).toContain('Ingresá el código de 6 dígitos que muestra la app');
  });

  it('clave manual colapsable, en bloques de 4, con Copiar', () => {
    expect(html).toMatch(/<details[^>]*>[\s\S]*¿No podés escanear\? Ingresá la clave a mano/);
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html).toContain('<span>JBSW</span><span>Y3DP</span>');
    expect(buttons(html)).toContain('Copiar');
  });

  it('en el teléfono, un enlace que abre la app con la cuenta', () => {
    expect(html).toMatch(/<a href="otpauth:\/\/totp\/[^"]+"[^>]*sm:hidden/);
  });

  it('el código viaja en un input oculto "code" y se confirma con "Activar"', () => {
    expect(html).toMatch(/<input type="hidden" name="code"/);
    expect(html).toContain('Dígito 1 de 6');
    expect(buttons(html)).toContain('Activar');
  });
});

describe('SessionsList', () => {
  const html = renderToStaticMarkup(
    createElement(SessionsList, {
      sessions: [
        session({ id: 'me', current: true }),
        session({ id: 'other', userAgent: SAFARI_IPHONE, lastSeenAt: '2026-09-29T09:00:00Z' }),
      ],
      now: NOW,
    }),
  );

  it('"Cerrar" sólo en las sesiones que no son ésta', () => {
    const closeButtons = buttons(html).filter((b) => b === 'Cerrar');
    expect(closeButtons).toHaveLength(1);
    expect(html).toContain('aria-label="Cerrar la sesión de Safari en iPhone"');
    expect(html).not.toContain('aria-label="Cerrar la sesión de Chrome en Windows"');
  });

  it('marca la sesión actual y mantiene "todos los dispositivos"', () => {
    expect(html).toContain('Esta sesión');
    expect(buttons(html)).toContain('Cerrar sesión en todos los dispositivos');
  });

  it('tiempos relativos contra la hora del servidor', () => {
    expect(html).toContain('última actividad hace 3 h');
  });

  it('si la lista no cargó, lo dice y "todos los dispositivos" sigue disponible', () => {
    const failed = renderToStaticMarkup(
      createElement(SessionsList, {
        sessions: [],
        now: NOW,
        loadError: 'No pudimos cargar tus sesiones abiertas. Recargá la página.',
      }),
    );
    expect(failed).toMatch(/role="alert"[\s\S]*No pudimos cargar tus sesiones abiertas/);
    expect(failed).not.toContain('No hay sesiones para mostrar');
    // /auth/logout-all no depende de la lista: es la salida de quien sospecha de un acceso ajeno.
    expect(buttonTag(failed, 'Cerrar sesión en todos los dispositivos')).not.toContain(
      'disabled=""',
    );
  });
});

describe('TrustedDevices', () => {
  it('lista con "Este equipo", "Quitar" por fila y "Quitar todos"', () => {
    const html = renderToStaticMarkup(
      createElement(TrustedDevices, {
        devices: [
          device({ id: 'me', current: true }),
          device({ id: 'x', userAgent: SAFARI_IPHONE }),
        ],
        now: NOW,
      }),
    );
    expect(html).toContain('Este equipo');
    expect(buttons(html).filter((b) => b === 'Quitar')).toHaveLength(2);
    expect(buttons(html)).toContain('Quitar todos');
    expect(html).toContain('vence en 21 días');
  });

  it('vacío: explica cómo se agrega uno', () => {
    const html = renderToStaticMarkup(createElement(TrustedDevices, { devices: [], now: NOW }));
    expect(html).toContain('Recordar este equipo');
    expect(buttons(html)).not.toContain('Quitar todos');
  });
});

describe('DisableMfaForm', () => {
  const html = renderToStaticMarkup(createElement(DisableMfaForm, { onCancel: () => {} }));

  it('arranca con el código de la app y ofrece usar uno de recuperación', () => {
    expect(html).toMatch(/<input type="hidden" name="mode" value="totp"/);
    expect(html).toContain('Dígito 1 de 6');
    expect(buttons(html)).toEqual(
      expect.arrayContaining(['Usar un código de recuperación', 'Desactivar', 'Cancelar']),
    );
  });

  it('el cambio de tipo no envía el formulario', () => {
    expect(buttonTag(html, 'Usar un código de recuperación')).toContain('type="button"');
  });
});

describe('RecoveryCodeField', () => {
  it('va en el mismo campo "code", sin autocompletar ni corrector, con su error anunciado', () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryCodeField, {
        id: 'rc',
        label: 'Código de recuperación',
        error: 'La contraseña o el código no son correctos.',
        pending: false,
      }),
    );
    expect(html).toMatch(/<label for="rc"[^>]*>Código de recuperación<\/label>/);
    expect(html).toMatch(/<input[^>]*name="code"/);
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('spellCheck="false"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="rc-error"');
    expect(html).toMatch(/id="rc-error" role="alert"/);
  });
});

describe('SecurityClient', () => {
  it('sin 2FA: el botón para activarla, y el aviso si el rol la exige', () => {
    const html = page({
      mfa: { enabled: false, recoveryCodesRemaining: 0, required: true, pendingEnrollment: false },
      enrollmentRequired: true,
    });
    expect(buttons(html)).toContain('Activar verificación en dos pasos');
    expect(html).toContain('Tu rol requiere la verificación en dos pasos');
    expect(html).toContain('Obligatoria para tu rol');
  });

  it('2FA activo y exigido por el rol: sin "Desactivar", con la explicación', () => {
    const html = page({
      mfa: { enabled: true, recoveryCodesRemaining: 8, required: true, pendingEnrollment: false },
    });
    expect(buttons(html)).not.toContain('Desactivar');
    expect(html).toContain(
      'Tu rol exige la verificación en dos pasos, así que no se puede desactivar',
    );
    expect(buttons(html)).toEqual(expect.arrayContaining(['Cambiar de teléfono', 'Regenerar']));
  });

  it('2FA activo y opcional: se puede desactivar', () => {
    const html = page({
      mfa: { enabled: true, recoveryCodesRemaining: 8, required: false, pendingEnrollment: false },
    });
    expect(buttons(html)).toContain('Desactivar');
  });

  it('con 3 códigos o menos, aviso con acceso directo a generar nuevos', () => {
    const html = page({
      mfa: { enabled: true, recoveryCodesRemaining: 2, required: false, pendingEnrollment: false },
    });
    expect(html).toContain('Te quedan 2 códigos de recuperación');
    expect(buttons(html)).toContain('Generar códigos nuevos');
    const plenty = page({
      mfa: { enabled: true, recoveryCodesRemaining: 9, required: false, pendingEnrollment: false },
    });
    expect(plenty).not.toContain('Te quedan 9 códigos');
  });

  it('equipos de confianza sólo con 2FA activo', () => {
    const on = page({
      mfa: { enabled: true, recoveryCodesRemaining: 9, required: false, pendingEnrollment: false },
      trustedDevices: [device({ current: true })],
    });
    expect(on).toContain('Equipos de confianza');
    expect(page()).not.toContain('Equipos de confianza');
  });

  it('la tarjeta de contraseña promete lo que cumple: esta sesión se mantiene', () => {
    const html = page();
    expect(html).toContain('Esta sesión se mantiene');
    expect(html.match(/autoComplete="new-password"/g)).toHaveLength(2);
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('aria-label="Mostrar contraseña"');
  });

  it('si no se pudo leer el estado del 2FA, no lo pinta como "Desactivada" ni ofrece activarla', () => {
    const html = page({ mfa: null, trustedDevices: [] });
    expect(html).toContain('No pudimos cargar el estado de la verificación en dos pasos');
    expect(buttons(html)).toContain('Reintentar');
    expect(html).not.toContain('Desactivada');
    expect(buttons(html)).not.toContain('Activar verificación en dos pasos');
    expect(buttons(html)).not.toContain('Desactivar');
    // Esconder los equipos de confianza daría por hecho que el 2FA está apagado.
    expect(html).toContain('Equipos de confianza');
  });

  it('si no se pudo leer la lista de sesiones, no dice "0 sesiones activas"', () => {
    const html = page({ sessions: [], sessionsError: 'No pudimos cargar tus sesiones abiertas.' });
    expect(html).not.toContain('0 sesiones activas');
    expect(html).toContain('No pudimos cargar tus sesiones abiertas.');
  });

  it('un solo h1 y las secciones como h2', () => {
    const html = page({
      mfa: { enabled: true, recoveryCodesRemaining: 9, required: false, pendingEnrollment: false },
    });
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html.match(/<h2/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('MfaEnrollmentGate', () => {
  it('se monta sin props, con "Empezar" y la única salida "Cerrar sesión"', () => {
    const html = renderToStaticMarkup(createElement(MfaEnrollmentGate));
    expect(html).toContain(GATE_TITLE);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(buttons(html)).toEqual(['Cerrar sesión', 'Empezar']);
  });

  it('muestra la cuenta si la conoce', () => {
    const html = renderToStaticMarkup(
      createElement(MfaEnrollmentGate, { email: 'ana@agencia.co', tenantName: 'Viajes Ana' }),
    );
    expect(html).toContain('ana@agencia.co');
    expect(html).toContain('Viajes Ana');
  });
});
