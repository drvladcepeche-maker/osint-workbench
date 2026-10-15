import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/index.css'

/*
 * Under Electron the preload script has already installed `window.osint`, and this
 * branch is skipped. In a plain browser during development it has not, and the app would
 * throw on its first IPC call — so the fixture bridge stands in, which is what makes it
 * possible to drive every view with Playwright, force `prefers-reduced-motion`, and
 * screenshot the live-run states.
 *
 * `import.meta.env.DEV` is replaced with `false` at build time, so the dynamic import
 * below is eliminated from the production bundle entirely.
 */
if (import.meta.env.DEV && !window.osint) {
  const { installFixtureBridge } = await import('./lib/fixtures')
  installFixtureBridge()
}

const el = document.getElementById('root')
if (!el) throw new Error('#root is missing from index.html')

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>
)
