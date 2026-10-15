/// <reference types="vite/client" />

import type { OsintApi } from '../../shared/ipc'

declare global {
  interface Window {
    /** The only bridge to the main process. See src/preload/index.ts. */
    osint: OsintApi
  }
}

export {}
