'use client';

import SmartImage from '@/components/smart-image';
import { isVideoUrl } from '@/lib/media-urls';

interface ProductMediaProps {
  src: string;
  alt: string;
  dataAiHint?: string;
}

export default function ProductMedia({ src, alt, dataAiHint }: ProductMediaProps) {
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
      data-ai-hint={dataAiHint}
    />
  );
}
