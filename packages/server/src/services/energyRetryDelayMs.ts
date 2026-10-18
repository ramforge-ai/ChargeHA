// Retry hints are durations, not adapter-specific HTTP details. Never retry
// before a server's bounded hint, and only add positive jitter.
export function energyRetryDelayMs(
  error: unknown,
  failures: number,
  random: () => number = Math.random,
): number {
  const steps = [30_000, 60_000, 120_000, 300_000];
  const base = steps[Math.min(Math.max(failures - 1, 0), steps.length - 1)];
  const hint = error instanceof Error && "retryAfterMs" in error
    ? error.retryAfterMs
    : 0;
  const boundedHint = typeof hint === "number" && Number.isFinite(hint)
    ? Math.min(Math.max(hint, 0), 3_600_000)
    : 0;
  return Math.max(boundedHint, Math.min(300_000, base + base * 0.1 * random()));
}
