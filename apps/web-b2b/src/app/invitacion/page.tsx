import type { Metadata } from 'next';
import { api } from '../../lib/api';
import { getSession } from '../../lib/session';
import { InvitationScreen } from './_components/invitation-screen';
import { invitationTokenFrom, invitationViewFor } from './invitation-view';

export const metadata: Metadata = {
  title: 'Invitación · Sales-Travel',
};

export const dynamic = 'force-dynamic';

/**
 * /invitacion?token=… (USR-17): primero lee la invitación (`POST /invitations/preview`, que no la
 * gasta) y después muestra lo que corresponde: crear la cuenta, ingresar con la que ya existe,
 * aceptar con la sesión abierta, salir de la sesión de otra cuenta, o que pida una nueva. Si hay
 * sesión, `api()` la manda y el API dice si es la de la cuenta invitada.
 */
export default async function InvitationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const token = invitationTokenFrom((await searchParams)['token']);
  if (token === null) return <InvitationScreen view={{ kind: 'missing-token' }} token="" />;

  const res = await api<unknown>('/invitations/preview', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
  const view = invitationViewFor(res, token, new Date(), {
    sessionCookie: (await getSession()) !== null,
  });
  return <InvitationScreen view={view} token={token} />;
}
