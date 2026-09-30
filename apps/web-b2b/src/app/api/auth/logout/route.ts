import { logoutResponse } from '../../session/_lib/logout';

/**
 * El cierre de sesión de antes. El panel ahora usa `/api/session/logout`; éste queda igual a aquél
 * para las pestañas que siguen con el JavaScript anterior durante un deploy.
 */
export function POST(req: Request) {
  return logoutResponse(req);
}
