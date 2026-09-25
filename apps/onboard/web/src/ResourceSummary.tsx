import { GiB, type ResourceAssessment, type ResourceSnapshot } from '../../shared/resource-policy'
import { Icon, Notice } from './ui'

const capacity = (bytes: number | null | undefined) => bytes == null ? 'Not verified' : `${(bytes / GiB).toFixed(1)} GiB`

export function ResourceSummary({ snapshot, assessment, acknowledged, onAcknowledge }: {
  snapshot: ResourceSnapshot
  assessment: ResourceAssessment
  acknowledged?: boolean
  onAcknowledge?: (value: boolean) => void
}) {
  const budget = assessment.budget
  if (!budget) return <Notice tone="fault">Choose a supported embedding model.</Notice>
  const { minimum: min, recommended: rec } = budget
  const estimatedAvailable = snapshot.host.availableMemorySource === 'macos-vm-stat'
  const sharedModelDisk = assessment.model?.location === 'local' && snapshot.installDisk.filesystemId === snapshot.ollamaDisk.filesystemId
  // Prototype resource table: the measured value carries the verdict colour against the budget.
  type Row = [label: string, bytes: number | null | undefined, minimum: number, recommended: number]
  const tone = (bytes: number | null | undefined, minimum: number, recommended: number) =>
    bytes == null ? 'warn' : bytes / GiB < minimum ? 'bad' : bytes / GiB < recommended ? 'warn' : 'ok'
  const rows: Row[] = [
    ['Total computer RAM', snapshot.host.totalMemoryBytes, min.hostMemoryGiB, rec.hostMemoryGiB],
    [estimatedAvailable ? 'Estimated available RAM' : 'Currently free RAM', snapshot.host.availableMemorySource ? snapshot.host.availableMemoryBytes : snapshot.host.freeMemoryBytes, min.freeHostMemoryGiB, rec.freeHostMemoryGiB],
    ['RAM allocated to Docker', snapshot.docker.totalMemoryBytes, min.dockerMemoryGiB, rec.dockerMemoryGiB],
    [sharedModelDisk ? 'Free installation + model disk' : 'Free installation disk', snapshot.installDisk.freeBytes, min.installDiskGiB + (sharedModelDisk ? min.modelDiskGiB : 0), rec.installDiskGiB + (sharedModelDisk ? rec.modelDiskGiB : 0)],
    ['Free storage inside Docker', snapshot.docker.storageFreeBytes, min.dockerDiskGiB, rec.dockerDiskGiB],
    ...(snapshot.dockerHostDisk ? [['Free Docker data disk', snapshot.dockerHostDisk.freeBytes, min.dockerDiskGiB, rec.dockerDiskGiB] as Row] : []),
    ...(assessment.model?.location === 'local' && !sharedModelDisk ? [['Free Ollama model disk', snapshot.ollamaDisk.freeBytes, min.modelDiskGiB, rec.modelDiskGiB] as Row] : []),
  ]
  return <div className="resource-summary">
    <h3>Machine resources</h3>
    <p>{snapshot.host.platform === 'darwin' ? 'macOS' : snapshot.host.platform === 'win32' ? 'Windows' : snapshot.host.platform} · {snapshot.host.arch} · {snapshot.host.cpuCount ?? '?'} logical CPUs. Requirements below apply to <b>{assessment.model?.label}</b>.</p>
    <div className="resource-table-scroll"><table className="resource-table">
      <thead><tr><th scope="col">Resource</th><th scope="col">Available</th><th scope="col">Minimum</th><th scope="col">Recommended</th></tr></thead>
      <tbody>{rows.map(([label, bytes, minimum, recommended]) => <tr key={label}><th scope="row">{label}</th><td className={`res-${tone(bytes, minimum, recommended)}`}>{capacity(bytes)}</td><td>{minimum} GiB</td><td>{recommended} GiB</td></tr>)}</tbody>
    </table></div>
    <p className="field-hint">Conservative whole-stack planning budgets, including the operating system, Docker and build headroom. Model file size alone does not predict memory use. Actual needs grow with your data and workload.</p>
    {estimatedAvailable ? <p className="field-hint">macOS available RAM is estimated from free, speculative and inactive pages. It includes memory the system may reclaim, so it can be higher than free RAM. Reclaiming inactive memory may require compression or disk writeback; this is not a guarantee that it is immediately free.</p> : null}
    <details><summary>Measured locations</summary><p>Installation: <code>{snapshot.installDisk.path}</code></p><p>Docker data: <code>{snapshot.dockerHostDisk?.path ?? 'Location not verified'}</code></p>{assessment.model?.location === 'local' ? <p>Ollama models: <code>{snapshot.ollamaDisk.path}</code></p> : null}</details>
    {assessment.blockers.length ? (
      <Notice tone="fault" title="Minimum requirements are not met" role="alert">
        <ul>{assessment.blockers.map(issue => <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>)}</ul>
        <p className="note">Free disk space, close other applications or adjust Docker resources, then check again. If you leave setup to clean up, re-run the installation afterward. Next remains unavailable until the minimum checks pass.</p>
      </Notice>
    ) : null}
    {assessment.warnings.length ? (
      <Notice tone="warn" title="Resource warnings">
        <ul>{assessment.warnings.map(issue => <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>)}</ul>
        {assessment.model?.location === 'local' && !assessment.meetsRecommended ? <p className="note"><b>This local model is strongly not recommended with the current headroom.</b> Heavy memory pressure may freeze the computer. A forced shutdown or exhausted disk can interrupt writes and damage stored data; this is not a claim that low RAM directly corrupts memory.</p> : null}
      </Notice>
    ) : null}
    {assessment.allowed && assessment.warnings.length && onAcknowledge ? (
      <label className={`checkrow resource-ack${acknowledged ? ' checked' : ''}`}>
        <input type="checkbox" checked={acknowledged ?? false} onChange={event => onAcknowledge(event.target.checked)} />
        <span className="checkbox" aria-hidden>{acknowledged ? <Icon name="check" size={11} /> : ''}</span>
        <span className="checkrow-label">I have reviewed these warnings and checked any storage that could not be measured.</span>
      </label>
    ) : null}
  </div>
}
