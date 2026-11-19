import { redirect } from 'next/navigation';
import { PLATFORM_LANDING } from '../../../../lib/platform-status';

/** `/admin/plataforma` a secas es su Estado. */
export default function PlatformIndexPage(): never {
  redirect(PLATFORM_LANDING);
}
