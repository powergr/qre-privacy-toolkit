import type { BatchResult } from "../types";

/**
 * A job that the user stopped reports "Cancelled." for the file it was working on, and one line
 * ("3 more files", "Cancelled. Not started.") for the files it never reached. None of those is a
 * failure, so the screens keep them apart from real problems.
 */
export function isCancelledResult(result: BatchResult): boolean {
  return !result.success && result.message.startsWith("Cancelled");
}

export interface CancelSummary {
  /** True if the user stopped the job. */
  cancelled: boolean;
  /** How many files were finished before the stop. */
  finished: number;
  /** Real problems, without the cancelled lines. */
  problems: BatchResult[];
}

export function summarizeCancel(results: BatchResult[]): CancelSummary {
  return {
    cancelled: results.some(isCancelledResult),
    finished: results.filter((r) => r.success).length,
    problems: results.filter((r) => !r.success && !isCancelledResult(r)),
  };
}

/** The notice shown after a stop. `done` is a past participle: "locked", "unlocked", "upgraded". */
export function cancelNotice(finished: number, done: string): string {
  if (finished <= 0) return "Cancelled. Nothing was changed.";
  const files = finished === 1 ? "1 file was" : `${finished} files were`;
  return `Cancelled. ${files} ${done} before you stopped. The rest were left as they were.`;
}
