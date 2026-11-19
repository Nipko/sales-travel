import { describe, expect, it } from 'vitest';
import { isStaleDeployError } from './stale-deploy';

describe('isStaleDeployError', () => {
  it('reconoce la server action que el deploy nuevo ya no tiene', () => {
    const error = new Error(
      'Server Action "60339b01fd6cb290ee0721a857f6dcc677a6a26537" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action',
    );
    expect(isStaleDeployError(error)).toBe(true);
  });

  it('reconoce el error tipado de Next y los chunks que ya no existen', () => {
    const unrecognized = Object.assign(new Error('x'), { name: 'UnrecognizedActionError' });
    const chunk = Object.assign(new Error('Loading chunk 812 failed.'), { name: 'ChunkLoadError' });
    expect(isStaleDeployError(unrecognized)).toBe(true);
    expect(isStaleDeployError(chunk)).toBe(true);
    expect(isStaleDeployError(new Error('Loading chunk app/hoteles failed.'))).toBe(true);
  });

  it('no confunde los errores de negocio con una versión vieja', () => {
    expect(isStaleDeployError(new Error('La tarifa ya no está disponible'))).toBe(false);
    expect(isStaleDeployError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isStaleDeployError(null)).toBe(false);
    expect(isStaleDeployError('Server Action')).toBe(false);
  });
});
