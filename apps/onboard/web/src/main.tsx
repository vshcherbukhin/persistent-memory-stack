import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Vendored type — the installer must work on a machine with no internet access,
// so fonts are bundled rather than fetched from a CDN.
import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/manrope'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './styles.css'
import { applyTheme, readTheme } from './theme'

// Stamp the theme before the first render so setup never flashes the wrong ground.
applyTheme(readTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
