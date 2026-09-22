'use client';

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { APK_DOWNLOAD_URL } from '@/lib/app-download';

// Landing page for the app download. Its whole job is to be a page of THIS site
// that the browser loads before the APK: by the time it renders, the middleware
// has already turned any `?ref=` on the URL into the referral cookie. The page
// then starts the download by itself and keeps a manual button as a fallback.
export default function GetAppPage() {
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setStarted(true);
      window.location.href = APK_DOWNLOAD_URL;
    }, 1200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="container mx-auto px-6 py-16 flex flex-col items-center text-center gap-6">
      <Download className="h-12 w-12 text-primary" />
      <h1 className="text-2xl font-bold">{started ? 'Your download has started' : 'Your download is starting...'}</h1>
      <p className="text-muted-foreground max-w-sm">
        If nothing happens in a few seconds, tap the button below. After installing, open the app to continue.
      </p>
      <a href={APK_DOWNLOAD_URL} download>
        <Button size="lg">
          <Download className="mr-2" /> Download App
        </Button>
      </a>
    </div>
  );
}
