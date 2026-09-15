// --- Online visitors: admin page ---
// Server component: loads the first snapshot, then the client dashboard keeps
// itself fresh. Protected by the admin middleware like every /admin route.

import OnlineDashboard from './_components/online-dashboard';
import { getOnlineSnapshotForAdmin } from './actions';

export const dynamic = 'force-dynamic';

export default async function OnlinePage() {
    const initial = await getOnlineSnapshotForAdmin(6);
    return <OnlineDashboard initial={initial} />;
}
