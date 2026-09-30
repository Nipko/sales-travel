import { logoutResponse } from '../_lib/logout';

/** `POST /api/session/logout` `{ reason?: 'idle' }`. Ver {@link logoutResponse}. */
export function POST(req: Request) {
  return logoutResponse(req);
}
