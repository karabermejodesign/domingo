import type { NextConfig } from 'next'

// The app is one file at public/cook/index.html. It is served at the root: "/" rewrites to it
// (URL stays "/"), and the old "/cook" path redirects to "/" so earlier links keep working.
const nextConfig: NextConfig = {
  async redirects() {
    return [{ source: '/cook', destination: '/', permanent: false }]
  },
  async rewrites() {
    return [{ source: '/', destination: '/cook/index.html' }]
  },
  async headers() {
    return [
      { source: '/', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }, { key: 'Cache-Control', value: 'no-cache' }] },
      { source: '/cook/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] },
    ]
  },
  outputFileTracingIncludes: { '/api/week': ['./src/data/seed-week.json'] },
}

export default nextConfig
