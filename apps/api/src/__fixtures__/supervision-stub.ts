import type {
  PlatformStanding,
  SupervisionService,
} from '../platform-admins/supervision.service.js';

/**
 * La puerta de supervisión para los tests que arman un controlador a mano: quien pide es un
 * superadmin pleno (o lo que diga `standing`), así que nada queda como solicitud. Lo propio de la
 * supervisión se prueba en platform-admins/.
 */
export function supervisionStub(standing: PlatformStanding = 'full'): SupervisionService {
  return {
    register: () => undefined,
    gate: () => Promise.resolve(),
    standing: () => Promise.resolve(standing),
  } as unknown as SupervisionService;
}
