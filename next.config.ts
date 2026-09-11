
import type {NextConfig} from 'next';
import { getImageRemotePatterns } from './src/lib/media-urls';
const withPWA = require('next-pwa')({
    dest: 'public',
    register: true,
    skipWaiting: true,
    disable: process.env.NODE_ENV === 'development'
})


const nextConfig: NextConfig = {

  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:9002', '*.app.github.dev'],
      bodySizeLimit: '12mb', // Allow up to an 8MB image (~11MB as a base64 data URI) per upload
    },
  },

  
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    // Hosts the server-side optimizer (/_next/image) may fetch from. The list
    // lives in src/lib/media-urls.ts (built-in CDNs + NEXT_PUBLIC_IMAGE_HOSTS
    // env var) and is shared with <SmartImage>, which renders images from any
    // other host `unoptimized` (loaded directly by the browser). Do not replace
    // this with a bare `**` wildcard: /_next/image is public, so that would let
    // anyone use the server as an open image proxy.
    remotePatterns: getImageRemotePatterns(),
    // Remote SVGs are never proxied/rasterised by the optimizer (XSS surface);
    // next/image serves them unoptimized instead.
    dangerouslyAllowSVG: false,
  },
};

export default withPWA(nextConfig);