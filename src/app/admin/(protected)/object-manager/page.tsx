import { unstable_noStore as noStore } from 'next/cache';
import { describeR2Error, getObjectManagerConfig, listLevel } from '@/lib/object-manager/r2';
import ObjectManager from './_components/object-manager';
import SetupNotice from './_components/setup-notice';

// Admin auth is enforced by the (protected) layout; every server action and the
// upload route check it again on their own.
export default async function ObjectManagerPage() {
  noStore();
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
