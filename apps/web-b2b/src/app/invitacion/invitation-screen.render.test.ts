import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { voseoIn } from '../../lib/voseo';
import { InvitationScreen, JoinStep, NewAccountStep } from './_components/invitation-screen';
import {
  INVITATION_MESSAGES,
  invitationLoginHref,
  type InvitationDetails,
  type InvitationView,
} from './invitation-view';

// Las server actions importan `next/headers`: acá sólo interesa lo que se pinta.
vi.mock('./actions', () => ({
  acceptInvitationAction: vi.fn(),
  joinInvitationAction: vi.fn(),
  switchAccountAction: vi.fn(),
}));

/*
 * El primer pintado de cada estado de /invitacion (USR-17): qué ve quien abre el enlace según la
 * vista previa, qué viaja en cada formulario y que nadie con cuenta ve un campo de contraseña.
 */

const TOKEN = 'Qm9vbS1lc3RlLWVzLXVuLXRva2VuLWRlLXBydWViYQ';
const DETAILS: InvitationDetails = {
  tenantName: 'Viajes Norte',
  roleLabel: 'Vendedor',
  summary: 'Te invitó Laura Gómez. La invitación vence en 6 días.',
};
const noop = () => undefined;

function screen(view: InvitationView): string {
  return renderToStaticMarkup(createElement(InvitationScreen, { view, token: TOKEN }));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function inputs(html: string): string[] {
  return html.match(/<input[^>]*>/g) ?? [];
}

function hidden(html: string, name: string): string | undefined {
  const tag = inputs(html).find((i) => i.includes('type="hidden"') && i.includes(`name="${name}"`));
  return tag?.match(/value="([^"]*)"/)?.[1];
}

const hasPassword = (html: string) => inputs(html).some((i) => i.includes('type="password"'));

describe('InvitationScreen', () => {
  it('sin cuenta: a qué nodo y rol, quién, y el formulario de siempre con el token', () => {
    const html = screen({ kind: 'create', details: DETAILS, signedInElsewhere: false });

    expect(text(html)).toContain('Te invitaron a Viajes Norte como Vendedor');
    expect(text(html)).toContain('Te invitó Laura Gómez. La invitación vence en 6 días.');
    expect(hidden(html, 'token')).toBe(TOKEN);
    for (const name of ['name', 'password', 'confirm']) {
      expect(inputs(html).some((i) => i.includes(`name="${name}"`))).toBe(true);
    }
    expect(text(html)).toContain('Crear cuenta y aceptar');
    expect(text(html)).not.toContain('Tienes abierta la sesión de otra cuenta');
    expect(voseoIn(text(html))).toEqual([]);
  });

  it('sin cuenta, con la sesión de otra abierta: lo avisa', () => {
    const html = screen({ kind: 'create', details: DETAILS, signedInElsewhere: true });
    expect(text(html)).toContain('Tienes abierta la sesión de otra cuenta');
  });

  it('con cuenta y sin sesión: ingresar y volver, sin campo de contraseña', () => {
    const html = screen({
      kind: 'sign-in',
      details: DETAILS,
      loginHref: invitationLoginHref(TOKEN),
    });

    expect(text(html)).toContain('Te invitaron a Viajes Norte como Vendedor');
    expect(text(html)).toContain(INVITATION_MESSAGES.signInRequired);
    expect(text(html)).toContain('Volver al inicio de sesión');
    expect(hasPassword(html)).toBe(false);
    expect(html).toContain(`href="${invitationLoginHref(TOKEN).replace(/&/g, '&amp;')}"`);
    expect(text(html)).toContain('Ingresar para aceptar');
    expect(voseoIn(text(html))).toEqual([]);
  });

  it('con la sesión de la cuenta invitada: un solo botón, con el token y sin contraseña', () => {
    const html = screen({ kind: 'join', details: DETAILS });

    expect(text(html)).toContain('Acepta para sumar Viajes Norte a tus agencias.');
    expect(hasPassword(html)).toBe(false);
    expect(hidden(html, 'token')).toBe(TOKEN);
    expect(html.match(/<button[^>]*type="submit"/g)).toHaveLength(1);
    expect(text(html)).toContain('Aceptar invitación');
    // Con sesión, el pie lleva al panel y no a un login que devolvería a él.
    expect(text(html)).toContain('Volver al panel');
    expect(text(html)).not.toContain('Volver al inicio de sesión');
  });

  it('con la sesión de otra cuenta: salir de ella, con el token para volver', () => {
    const html = screen({ kind: 'wrong-account', details: DETAILS });

    expect(text(html)).toContain(INVITATION_MESSAGES.wrongAccount);
    expect(hasPassword(html)).toBe(false);
    expect(hidden(html, 'token')).toBe(TOKEN);
    expect(text(html)).toContain('Salir e ingresar con la cuenta invitada');
  });

  it('inválida o sin token: que pida otra, sin formulario ni datos de nadie', () => {
    const invalid = screen({ kind: 'invalid' });
    expect(text(invalid)).toContain(INVITATION_MESSAGES.invalid);
    expect(inputs(invalid)).toEqual([]);
    expect(invalid).not.toContain(TOKEN);

    const missing = screen({ kind: 'missing-token' });
    expect(text(missing)).toContain(INVITATION_MESSAGES.missingToken);
    expect(inputs(missing)).toEqual([]);
  });

  it('sin servidor: reintentar la misma invitación', () => {
    const html = screen({ kind: 'unavailable', message: INVITATION_MESSAGES.unavailable });
    expect(text(html)).toContain(INVITATION_MESSAGES.unavailable);
    expect(html).toContain(`href="/invitacion?token=${TOKEN}"`);
  });
});

describe('NewAccountStep', () => {
  const step = (state: Parameters<typeof NewAccountStep>[0]['state'], signedInElsewhere = false) =>
    renderToStaticMarkup(
      createElement(NewAccountStep, {
        details: DETAILS,
        token: TOKEN,
        signedInElsewhere,
        state,
        formAction: noop,
      }),
    );

  it('la cuenta ya existía (la crearon en el medio): ingresar con ella en vez de reintentar', () => {
    const html = step({
      error: INVITATION_MESSAGES.signInRequired,
      signInHref: invitationLoginHref(TOKEN),
    });
    expect(text(html)).toContain(INVITATION_MESSAGES.signInRequired);
    expect(text(html)).toContain('Ingresar con mi cuenta');
    expect(text(html)).not.toContain('Crear cuenta y aceptar');
  });

  it('creada: al login; con otra sesión abierta, primero salir de ella', () => {
    const html = step({ done: true });
    expect(text(html)).toContain('Listo: ya formas parte de Viajes Norte.');
    expect(html).toMatch(/<a [^>]*href="\/login"[^>]*>Iniciar sesión<\/a>/);
    expect(inputs(html)).toEqual([]);

    // Con la sesión de otra cuenta, el login devolvería a su panel: primero se sale de ella.
    const elsewhere = step({ done: true }, true);
    expect(text(elsewhere)).not.toContain('Iniciar sesión');
    expect(text(elsewhere)).toContain('Salir e ingresar con tu cuenta nueva');
    expect(hidden(elsewhere, 'token')).toBeUndefined();
  });
});

describe('JoinStep', () => {
  const step = (state: Parameters<typeof JoinStep>[0]['state']) =>
    renderToStaticMarkup(
      createElement(JoinStep, { details: DETAILS, token: TOKEN, state, formAction: noop }),
    );

  it('aceptada: ya está en sus agencias y va al panel', () => {
    const html = step({ joined: true });
    expect(text(html)).toContain('Ya formas parte de Viajes Norte');
    expect(text(html)).toContain('Te sumaste como Vendedor.');
    expect(html.match(/href="\/"/g)).toHaveLength(1);
    expect(text(html)).not.toContain('Volver al');
    expect(inputs(html)).toEqual([]);
    expect(voseoIn(text(html))).toEqual([]);
  });

  it('rechazada: el motivo y lo que sigue (otra cuenta, sesión vencida o reintentar)', () => {
    const mismatch = step({ message: INVITATION_MESSAGES.wrongAccount, switchAccount: true });
    expect(text(mismatch)).toContain(INVITATION_MESSAGES.wrongAccount);
    expect(text(mismatch)).toContain('Salir e ingresar con la cuenta invitada');
    expect(text(mismatch)).not.toContain('Aceptar invitación');

    const ended = step({
      message: INVITATION_MESSAGES.sessionEnded,
      signInHref: '/api/session/end?motivo=cerrada',
    });
    expect(text(ended)).toContain('Ingresar de nuevo');
    expect(ended).toContain('href="/api/session/end?motivo=cerrada"');

    const member = step({ message: INVITATION_MESSAGES.alreadyMember });
    expect(text(member)).toContain(INVITATION_MESSAGES.alreadyMember);
    expect(text(member)).toContain('Aceptar invitación');
  });
});
