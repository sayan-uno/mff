import { unstable_noStore as noStore } from 'next/cache';
import { redirect } from 'next/navigation';
import { isAdminAuthenticated } from '@/app/actions';
import { describeR2Error, getObjectManagerConfig, listLevel } from '@/lib/object-manager/r2';
import ObjectManager from './_components/object-manager';
import SetupNotice from './_components/setup-notice';

// Admin auth is enforced by the middleware and the (protected) layout, and every
// server action and the upload route check it again on their own. This page reads
// the bucket listing directly, so it checks the session itself as well and never
// depends on those outer layers alone.
export default async function ObjectManagerPage() {
  noStore();
  if (!(await isAdminAuthenticated())) redirect('/admin/login');
  const cfg = getObjectManagerConfig();
  if (!cfg.configured) {
    return <SetupNotice missing={cfg.missing} />;
  }
  try {
    const initial = await listLevel(cfg, '');
    return <ObjectManager initial={initial} bucket={cfg.bucket} publicBaseUrl={cfg.publicBaseUrl} imageTransform={cfg.imageTransform} />;
  } catch (error) {
    console.error('[object-manager] initial listing failed:', error);
    return <SetupNotice missing={[]} error={describeR2Error(error)} />;
  }
}
