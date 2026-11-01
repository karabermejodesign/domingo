import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  async redirects() {
    return [{ source: '/', destination: '/cook', permanent: false }]
  },
  async headers() {
    return [
      { source: '/cook', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }, { key: 'Cache-Control', value: 'no-cache' }] },
      { source: '/cook/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] },
    ]
  },
  outputFileTracingIncludes: { '/api/week': ['./src/data/seed-week.json'] },
}

export default nextConfig
