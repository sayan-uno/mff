'use client';

import Image, { type ImageProps } from 'next/image';
import { ImageOff } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { isOptimizableImageSrc } from '@/lib/media-urls';

/**
 * Drop-in replacement for `next/image` for images whose URL comes from the
 * database (product / slider / event / notification images), i.e. anything an
 * admin can paste from any hosting platform.
 *
 * - Hosts on the allow-list in `src/lib/media-urls.ts` go through the Next.js
 *   image optimizer as usual (resized, converted to WebP, cached).
 * - Every other host is rendered `unoptimized`: the browser downloads the file
 *   straight from its source, so no `next.config.ts` change is needed and the
 *   server never fetches untrusted URLs.
 * - If the optimizer fails for an allow-listed image (upstream error, SVG,
 *   timeout, …) it retries once by loading the original URL directly.
 * - If the image cannot be loaded at all, a neutral placeholder tile is shown
 *   instead of a broken-image icon (override with the `fallback` prop).
 */
export type SmartImageProps = Omit<ImageProps, 'src' | 'loader'> & {
  src: string;
  /** Rendered when the image cannot be loaded at all. */
  fallback?: ReactNode;
};

type LoadStage = 'optimized' | 'direct' | 'failed';

export default function SmartImage(props: SmartImageProps) {
  // Keyed on `src` so the retry state resets whenever the URL changes.
  return <SmartImageInner key={props.src} {...props} />;
}

function SmartImageInner({
  src,
  alt,
  unoptimized,
  onError,
  fallback,
  className,
  fill,
  width,
  height,
  style,
  ...rest
}: SmartImageProps) {
  const [stage, setStage] = useState<LoadStage>(() =>
    !unoptimized && isOptimizableImageSrc(src) ? 'optimized' : 'direct'
  );

  if (typeof src !== 'string' || src.length === 0 || stage === 'failed') {
    if (fallback !== undefined) return <>{fallback}</>;
    return (
      <div
        role="img"
        aria-label={alt}
        className={cn(
          'flex items-center justify-center bg-muted text-muted-foreground',
          fill && 'absolute inset-0',
          className
        )}
        style={fill ? style : { width, height, ...style }}
      >
        <ImageOff className="h-6 w-6 opacity-60" aria-hidden="true" />
      </div>
    );
  }

  return (
    <Image
      {...rest}
      src={src}
      alt={alt}
      fill={fill}
      width={width}
      height={height}
      style={style}
      className={className}
      unoptimized={stage === 'direct'}
      onError={(event) => {
        onError?.(event);
        // Optimizer failed → try the original URL directly. Direct failed → give up.
        setStage((current) => (current === 'optimized' ? 'direct' : 'failed'));
      }}
    />
  );
}
