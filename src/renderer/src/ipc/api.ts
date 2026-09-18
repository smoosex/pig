import type { SessionApi } from '../../../shared/api'

export type * from '../../../shared/api'
export { DEFAULT_REVIEW_WIDTH, MAX_REVIEW_WIDTH, MIN_REVIEW_WIDTH } from '../../../shared/api'

export const api: SessionApi = window.api
