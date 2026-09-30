/**
 * Summarizing the context is work in its own right, not part of the turn's thinking: while Pi writes
 * the summary the turn's work clock stops, the summary stands between the two blocks of work as a
 * landmark, and the work after it carries on from the total the clock had reached.
 *
 * The live marks below are the renderer's copy of what Pi is doing right now; the persisted
 * landmarks arrive with the session projection instead, and carry the same two numbers estimated
 * from the entries written either side of them.
 */
import type { MessageKey } from '../../../shared/i18n'

export type CompactionReason = 'manual' | 'threshold' | 'overflow'

export interface LiveCompaction {
  id: string
  reason: CompactionReason
  startedAt: number
  /** Work time the turn had reached when the summary began: where the next block picks up. */
  workMsBefore: number
  endedAt: number | null
  status: 'running' | 'done' | 'failed'
  /** Present once the summary landed, so the landmark can be read without waiting for history. */
  summary?: string
  tokensBefore?: number
  errorMessage?: string
}

/**
 * A mark belongs to the run it happened in while that run has somewhere to put it. A summary written
 * between runs, or one that failed and therefore left no landmark behind, is reported beside the
 * composer instead: the transcript only keeps what Pi actually recorded.
 */
export function showsInTranscript(mark: LiveCompaction, runInTranscript: boolean): boolean {
  return runInTranscript && mark.status !== 'failed'
}

/** The three reasons read differently to a reader: manual, near the limit, or already overflowing. */
export function compactionReasonKey(reason: CompactionReason): MessageKey {
  if (reason === 'manual') return 'chat.compactingManual'
  if (reason === 'overflow') return 'chat.compactingOverflow'
  return 'chat.compactingThreshold'
}

/** Only the timing is needed to lay out blocks of work: live marks and persisted landmarks both fit. */
export interface WorkLandmark {
  workMsBefore: number
  durationMs: number
}

/**
 * Work time at the end of every block of work, in block order. Block `i` ends where landmark `i`
 * began, and the last block is the one still counting.
 */
export function workBlockMs(landmarks: WorkLandmark[], lastBlockMs: number): number[] {
  return [...landmarks.map((landmark) => Math.max(0, landmark.workMsBefore)), Math.max(0, lastBlockMs)]
}

/**
 * Live work time for the last block: a running summary has stopped the clock at the time the block
 * before it reached, and a finished one lets the clock run again from the same value.
 */
export function liveLastBlockMs(marks: LiveCompaction[], now: number, startedAt: number | null): number {
  const last = marks[marks.length - 1]
  if (!last) return startedAt == null ? 0 : Math.max(0, now - startedAt)
  if (last.endedAt == null) return Math.max(0, last.workMsBefore)
  return Math.max(0, last.workMsBefore + (now - last.endedAt))
}

/** The same total for a persisted turn: Pi's elapsed time less the summaries written inside it. */
export function settledLastBlockMs(totalMs: number, landmarks: WorkLandmark[]): number {
  const summarized = landmarks.reduce((sum, landmark) => sum + Math.max(0, landmark.durationMs), 0)
  return Math.max(0, totalMs - summarized)
}
