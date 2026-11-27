import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import {
  CHANGE_REQUEST_PENDING_PREFIX,
  announcedPending,
  isChangeRequestPending,
  toastFailure,
} from './change-request-notice';

const PENDIENTE =
  'Tu cambio quedó como solicitud: un superadmin pleno tiene que aprobarlo en Plataforma → Superadmins.';

describe('el 409 de la solicitud pendiente es un aviso, no un error (QA-H-24)', () => {
  it('la API escribe el mensaje con el mismo comienzo que reconoce el panel', () => {
    const api = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        'api',
        'src',
        'platform-admins',
        'platform-admins.errors.ts',
      ),
      'utf8',
    );
    expect(api).toContain(`'${CHANGE_REQUEST_PENDING_PREFIX}`);
  });

  it('toastFailure: la pendiente va como info; lo demás, como error', () => {
    toastFailure(PENDIENTE);
    toastFailure('No se pudo guardar.');
    expect(toast.info).toHaveBeenCalledWith(PENDIENTE);
    expect(toast.error).toHaveBeenCalledWith('No se pudo guardar.');
  });

  it('announcedPending sólo dice que sí con la pendiente', () => {
    expect(announcedPending({ ok: false, message: PENDIENTE })).toBe(true);
    expect(announcedPending({ ok: false, message: 'otro' })).toBe(false);
    expect(announcedPending({ ok: true })).toBe(false);
    expect(isChangeRequestPending(undefined)).toBe(false);
  });
});
