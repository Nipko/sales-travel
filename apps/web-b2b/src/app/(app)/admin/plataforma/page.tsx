import { redirect } from 'next/navigation';
import { PLATFORM_HOME } from '../../../../lib/platform-overview';

/** `/admin/plataforma` a secas es su Resumen. */
export default function PlatformIndexPage(): never {
  redirect(PLATFORM_HOME);
}
