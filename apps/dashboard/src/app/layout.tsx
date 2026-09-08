import type { Metadata } from 'next'
import 'material-icons/iconfont/outlined.css'
// Vendored type — the stack runs offline in Docker, so fonts are never fetched
// from a CDN. Variable faces keep the payload to one file per family.
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/manrope'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './globals.css'
import { THEME_BOOT_SCRIPT } from '@/lib/theme'
import { ThemeBoot } from '@/components/ui/ThemeBoot'

export const metadata: Metadata = {
  title: 'persistent-memory · Dashboard',
  description: 'Control plane for the persistent-memory stack — teams, users, tokens, grants, settings.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme is deliberately NOT rendered here: React reconciles attributes it
    // owns on <html>, which would drop the stamp the boot script writes. The script
    // stamps before paint (no flash) and ThemeBoot re-asserts it after hydration.
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <ThemeBoot />
        {children}
      </body>
    </html>
  )
}
