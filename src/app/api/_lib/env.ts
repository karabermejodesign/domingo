export function siteUrl() {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? '').trim().replace(/\/$/, '')
}
