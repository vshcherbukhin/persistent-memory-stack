export interface PrereqProgressState {
  label: string
  downloadedBytes?: number
  totalBytes?: number
}

const STAGE_LABELS: Record<string, string> = {
  download: 'Downloading Ollama',
  verify: 'Verifying installer',
  install: 'Installing Ollama',
  start: 'Starting Ollama',
  ready: 'Checking readiness',
}

function bytes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Native Windows events carry bytes; other hosts retain their actual step names. */
export function prereqProgressEvent(event: Record<string, unknown>): PrereqProgressState | null {
  if (event.type === 'step-start' && typeof event.name === 'string' && event.name.trim()) {
    return { label: event.name.trim() }
  }
  if (event.type !== 'progress' || typeof event.stage !== 'string' || !Object.hasOwn(STAGE_LABELS, event.stage)) return null
  const label = STAGE_LABELS[event.stage]!
  if (event.stage !== 'download') return { label }
  const downloadedBytes = bytes(event.downloadedBytes)
  const totalBytes = bytes(event.totalBytes)
  return { label, downloadedBytes, totalBytes: totalBytes && totalBytes > 0 ? totalBytes : undefined }
}

export function downloadPercent(progress: PrereqProgressState): number | undefined {
  const downloaded = bytes(progress.downloadedBytes)
  const total = bytes(progress.totalBytes)
  if (downloaded === undefined || !total) return undefined
  return Math.floor(Math.min(1, downloaded / total) * 100)
}

export function formatDownloadBytes(value: number): string {
  if (value < 1024) return `${Math.floor(value)} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  return `${(value / 1024 ** 3).toFixed(1)} GiB`
}
