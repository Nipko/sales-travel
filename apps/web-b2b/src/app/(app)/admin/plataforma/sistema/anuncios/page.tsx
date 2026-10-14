import { SystemConsole } from '../_components/system-console';
import { AnnouncementsPanel } from './_components/announcements-panel';

/** Plataforma → Sistema › Anuncios (sólo superadmin; la guarda es el layout de `/admin/plataforma`). */
export default function PlatformAnnouncementsPage() {
  return (
    <SystemConsole current="anuncios">
      <AnnouncementsPanel />
    </SystemConsole>
  );
}
