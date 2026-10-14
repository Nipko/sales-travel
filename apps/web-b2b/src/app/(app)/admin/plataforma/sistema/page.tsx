import { SystemConsole } from './_components/system-console';
import { SystemJobs } from './_components/system-jobs';

/** Plataforma → Sistema › Procesos (sólo superadmin; la guarda es el layout de `/admin/plataforma`). */
export default function PlatformSystemPage() {
  return (
    <SystemConsole current="procesos">
      <SystemJobs />
    </SystemConsole>
  );
}
