export const metadata = { title: 'Sunday Prep', robots: { index: false } }
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body>{children}</body></html>)
}
