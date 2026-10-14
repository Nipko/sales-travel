import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  parseLegacyAccountsList,
  type LegacyAccount,
  type LegacyAccountsList,
} from '../../../../../../lib/legacy-passwords';
import { voseoIn } from '../../../../../../lib/voseo';
import {
  LegacyAccountsSelection,
  LegacyPasswordsCallout,
  LegacyPasswordsDialog,
  LegacyResetResults,
  legacyOriginLine,
} from './legacy-passwords-dialog';

/*
 * El primer pintado de las cuentas heredadas (USR-14): el aviso con "Revisarlas", la lista con una
 * casilla por cuenta (todas elegidas al abrir), dónde nació cada una y quién eligió la contraseña, y
 * el resultado por cuenta. Todo en tú.
 */

const NORTE = '11111111-1111-4111-8111-111111111111';
const ANA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BETO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = Date.parse('2026-10-13T15:00:00.000Z');

const LIST: LegacyAccountsList = parseLegacyAccountsList({
  users: [
    {
      id: ANA,
      email: 'ana@agencia.co',
      name: 'Ana Pérez',
      createdAt: '2026-06-01T12:00:00.000Z',
      lastLoginAt: '2026-10-12T15:00:00.000Z',
      activeNodes: 2,
      origin: { tenantId: NORTE, tenantName: 'Agencia Norte', createdByEmail: 'admin@norte.co' },
    },
    {
      id: BETO,
      email: 'beto@agencia.co',
      name: null,
      createdAt: '2026-05-10T12:00:00.000Z',
      lastLoginAt: null,
      activeNodes: 0,
      origin: { tenantId: NORTE, tenantName: 'Agencia Norte', createdByEmail: null },
    },
  ],
  truncated: false,
})!;

const [ana, beto] = LIST.users as [LegacyAccount, LegacyAccount];

function selection(selected: string[], disabled = false): string {
  return renderToStaticMarkup(
    createElement(LegacyAccountsSelection, {
      accounts: LIST.users,
      selected: new Set(selected),
      now: NOW,
      disabled,
      onToggle: () => undefined,
      onToggleAll: () => undefined,
    }),
  );
}

describe('LegacyPasswordsCallout', () => {
  it('el aviso con su botón', () => {
    const html = renderToStaticMarkup(
      createElement(LegacyPasswordsCallout, {
        text: 'Hay 2 cuentas con una contraseña que eligió un admin antes del alta por invitación.',
        onReview: () => undefined,
      }),
    );
    expect(html).toContain('Hay 2 cuentas con una contraseña que eligió un admin');
    expect(html).toContain('Revisarlas');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
  });
});

describe('LegacyAccountsSelection', () => {
  it('una casilla por cuenta, con su nombre, su correo, dónde nació y quién eligió la contraseña', () => {
    const html = selection([ANA, BETO]);
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html).toContain('Seleccionar todas');
    expect(html).toContain('2 de 2 elegidas');
    expect(html).toContain('Ana Pérez');
    expect(html).toContain('ana@agencia.co');
    expect(html).toContain('Creada por admin@norte.co en Agencia Norte');
    // Sin nombre, el correo una sola vez; sin creador, sólo el nodo.
    expect(html.match(/beto@agencia\.co/g)).toHaveLength(1);
    expect(html).toContain('Creada en Agencia Norte');
    expect(html).toContain('Nunca ingresó');
    expect(html).toContain('Último ingreso:');
    expect(html).toContain('2 nodos activos');
    expect(html).toContain('Sin accesos activos');
    // "Seleccionar todas" controla la lista.
    const listId = /<ul id="([^"]+)"/.exec(html)?.[1];
    expect(listId).toBeDefined();
    expect(html).toContain(`aria-controls="${listId}"`);
  });

  it('cada casilla va dentro de su etiqueta: se elige tocando la fila', () => {
    const html = selection([ANA]);
    expect(html).toMatch(/<label[^>]*><input type="checkbox"[^>]*checked=""/);
    expect(html).toContain('1 de 2 elegidas');
  });

  it('mientras corre, nada se puede cambiar', () => {
    const html = selection([ANA, BETO], true);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
});

describe('legacyOriginLine', () => {
  it('con o sin quien la creó', () => {
    expect(legacyOriginLine(ana)).toMatch(/^Creada por admin@norte\.co en Agencia Norte · /);
    expect(legacyOriginLine(beto)).toMatch(/^Creada en Agencia Norte · /);
  });
});

describe('LegacyResetResults', () => {
  it('el resumen arriba y el resultado de cada cuenta, con qué hacer', () => {
    const html = renderToStaticMarkup(
      createElement(LegacyResetResults, {
        accounts: LIST.users,
        run: {
          results: [
            { userId: ANA, status: 'sent', revokedSessions: 1 },
            { userId: BETO, status: 'email_failed', revokedSessions: 0 },
          ],
          error: null,
        },
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('Listo: 2 cuentas tienen que elegir una contraseña nueva.');
    expect(html).toContain('Enlace enviado');
    expect(html).toContain('Cambio forzado, pero el correo no salió');
    expect(html).toContain('Al intentar ingresar le llega otro enlace.');
    expect(html).not.toContain('role="alert"');
  });

  it('si la corrida se detuvo, lo dice como alerta', () => {
    const html = renderToStaticMarkup(
      createElement(LegacyResetResults, {
        accounts: LIST.users,
        run: {
          results: [
            { userId: ANA, status: 'unknown' },
            { userId: BETO, status: 'not_processed' },
          ],
          error: 'El servidor no respondió a tiempo.',
        },
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('El servidor no respondió a tiempo.');
    expect(html).toContain('Sin confirmar');
    expect(html).toContain('Sin procesar');
  });
});

describe('LegacyPasswordsDialog', () => {
  const dialog = (list: LegacyAccountsList) =>
    renderToStaticMarkup(
      createElement(LegacyPasswordsDialog, {
        list,
        onClose: () => undefined,
        onFinished: () => undefined,
      }),
    );

  it('abre con todas elegidas, la explicación y el botón que dice a cuántas', () => {
    const html = dialog(LIST);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Contraseñas elegidas por un admin');
    expect(html).toContain('antes del alta por invitación (30 de septiembre de 2026)');
    expect(html).toContain('2 de 2 elegidas');
    expect(html).toContain('Forzar el cambio a 2 cuentas');
    expect(html).toContain('Cancelar');
  });

  it('con la lista cortada lo dice; sin cuentas, que no quedan', () => {
    expect(dialog({ ...LIST, truncated: true })).toContain('Mostramos las 500 más recientes.');
    const empty = dialog({ users: [], truncated: false });
    expect(empty).toContain('No quedan cuentas con una contraseña elegida por un admin.');
    expect(empty).toContain('Elige al menos una cuenta');
  });

  it('el primer pintado va en tú', () => {
    expect(voseoIn(dialog(LIST))).toEqual([]);
  });
});
