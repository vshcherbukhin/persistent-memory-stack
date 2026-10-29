export function overviewMemorySummary({ memoryCount, recentAvailable, recentSummary, pendingAvailable, pendingCount }: {
  memoryCount: number; recentAvailable: boolean; recentSummary: string | null; pendingAvailable: boolean; pendingCount: number
}): string {
  return [
    recentAvailable ? recentSummary : 'Recent memory activity is temporarily unavailable',
    pendingAvailable ? pendingCount > 0 ? `${pendingCount} awaiting embedding` : null : 'Embedding queue is temporarily unavailable',
  ].filter(Boolean).join(' · ') || (memoryCount === 0 ? 'No memories yet — your agents write here' : 'No recent writes recorded')
}
