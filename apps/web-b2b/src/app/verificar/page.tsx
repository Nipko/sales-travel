import { VerifyClient } from './verify-client';

export const dynamic = 'force-dynamic';

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return <VerifyClient token={token ?? ''} />;
}
