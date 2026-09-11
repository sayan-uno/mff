
'use client';

import SmartImage from '@/components/smart-image';
import { isVideoUrl } from '@/lib/media-urls';

interface AdminSliderMediaProps {
  src: string;
  alt: string;
}

export default function AdminSliderMedia({ src, alt }: AdminSliderMediaProps) {
  if (isVideoUrl(src)) {
    return (
      <video
        src={src}
        autoPlay
        loop
        muted
        playsInline
        className="w-full h-full object-cover"
      />
    );
  }

  return (
    <SmartImage
      src={src}
      alt={alt}
      fill
      className="object-cover"
    />
  );
}
