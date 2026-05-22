import { api } from '../../../lib/api';
import { ReportesClient } from './ReportesClient';

export default async function ReportesPage() {
  const [salesRes, commissionsRes] = await Promise.all([
    api<any>('/reports/sales-metrics'),
    api<any>('/reports/commissions'),
  ]);

  const salesMetrics = salesRes.ok ? salesRes.data : {
    byVertical: [],
    monthlyTrend: [],
    topPerformers: [],
  };

  const commissions = commissionsRes.ok ? commissionsRes.data : {
    byVertical: [],
    summary: {
      totalSalesMinor: 0,
      totalCommissionsMinor: 0,
      totalMarkupsMinor: 0,
      netEarningsMinor: 0,
    },
  };

  return <ReportesClient salesMetrics={salesMetrics} commissions={commissions} />;
}
