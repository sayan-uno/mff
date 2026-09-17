// --- Ad Analytics: admin page ---
// Server component: loads the default report (last 7 days), then the client
// dashboard lets the admin change the period. Protected by the admin middleware
// like every /admin route.

import AdAnalyticsDashboard from './_components/ad-analytics-dashboard';
import { getAdAnalytics } from './actions';
import { DEFAULT_PRESET, DEFAULT_TOP_LIMIT } from '@/lib/ad-analytics/types';

export const dynamic = 'force-dynamic';

export default async function AdAnalyticsPage() {
    const initial = await getAdAnalytics({ preset: DEFAULT_PRESET, top: DEFAULT_TOP_LIMIT });
    return <AdAnalyticsDashboard initial={initial} />;
}
