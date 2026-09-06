import { ProgressBar } from './components'
import { downloadPercent, formatDownloadBytes, type PrereqProgressState } from './prereq-progress'

export function PrereqProgress({ progress, component }: { progress: PrereqProgressState; component: string }) {
  const percent = downloadPercent(progress)
  const counts = progress.downloadedBytes === undefined ? undefined
    : `${formatDownloadBytes(progress.downloadedBytes)}${progress.totalBytes === undefined ? ' downloaded' : ` of ${formatDownloadBytes(progress.totalBytes)}`}`
  return (
    <div className="prereq-progress">
      <div className="prereq-progress-heading">
        <span className="prereq-progress-label" role="status">{progress.label}</span>
        {percent !== undefined ? <strong className="prereq-progress-percent" aria-hidden="true">{percent}%</strong> : null}
      </div>
      <div
        role="progressbar"
        aria-label={`${component}: ${progress.label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={percent === undefined ? counts ?? progress.label : `${percent}%${counts ? `; ${counts}` : ''}`}
      >
        <ProgressBar value={percent === undefined ? undefined : percent / 100} indeterminate={percent === undefined} />
      </div>
      {counts ? <p className="prereq-progress-bytes">{counts}</p> : null}
    </div>
  )
}
