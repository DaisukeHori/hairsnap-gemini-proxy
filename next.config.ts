import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // RunPod へのリクエストが大きい画像を含むため
  experimental: {
    serverActions: {
      bodySizeLimit: '20mb',
    },
  },
};

export default nextConfig;
