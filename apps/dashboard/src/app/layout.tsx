import type { Metadata } from 'next'
import 'material-icons/iconfont/outlined.css'
import './globals.css'

export const metadata: Metadata = {
  title: 'persistent-memory · Dashboard',
  description: 'Control plane for the persistent-memory stack — teams, users, tokens, grants, settings.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
