
'use client';

import SmartImage from '@/components/smart-image';
import { isVideoUrl } from '@/lib/media-urls';

interface SliderMediaProps {
  src: string;
  alt: string;
  priority?: boolean;
}

export default function SliderMedia({ src, alt, priority = false }: SliderMediaProps) {
  if (isVideoUrl(src)) {
    return (
      <video
        src={src}
        autoPlay
        loop
        muted
        playsInline
        className="w-full h-full object-cover"
      >
        Your browser does not support the video tag.
      </video>
    );
  }

  return (
    <SmartImage
      src={src}
      alt={alt}
      fill
      className="object-cover"
      priority={priority}
    />
  );
}
