import type { NearlinkAPI } from '../../shared/types'
declare global {
  interface Window {
    nearlink: NearlinkAPI
  }
}
export {}
