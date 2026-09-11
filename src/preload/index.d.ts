import type { SessionApi } from '../shared/api'

declare global {
  interface Window {
    api: SessionApi
  }
}
