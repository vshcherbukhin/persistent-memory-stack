import { GiB, type ResourceAssessment, type ResourceSnapshot } from '../../shared/resource-policy'

const capacity = (bytes: number | null | undefined) => bytes == null ? 'Not verified' : `${(bytes / GiB).toFixed(1)} GiB`

export function ResourceSummary({ snapshot, assessment, acknowledged, onAcknowledge }: {
  snapshot: ResourceSnapshot
  assessment: ResourceAssessment
  acknowledged?: boolean
  onAcknowledge?: (value: boolean) => void
}) {
  const budget = assessment.budget
  if (!budget) return <p className="notice bad">Choose a supported embedding model.</p>
  const { minimum: min, recommended: rec } = budget
  const sharedModelDisk = assessment.model?.location === 'local' && snapshot.installDisk.filesystemId === snapshot.ollamaDisk.filesystemId
  const rows = [
    ['Total computer RAM', capacity(snapshot.host.totalMemoryBytes), min.hostMemoryGiB, rec.hostMemoryGiB],
    ['Currently free RAM', capacity(snapshot.host.freeMemoryBytes), min.freeHostMemoryGiB, rec.freeHostMemoryGiB],
    ['RAM allocated to Docker', capacity(snapshot.docker.totalMemoryBytes), min.dockerMemoryGiB, rec.dockerMemoryGiB],
    [sharedModelDisk ? 'Free installation + model disk' : 'Free installation disk', capacity(snapshot.installDisk.freeBytes), min.installDiskGiB + (sharedModelDisk ? min.modelDiskGiB : 0), rec.installDiskGiB + (sharedModelDisk ? rec.modelDiskGiB : 0)],
    ['Free storage inside Docker', capacity(snapshot.docker.storageFreeBytes), min.dockerDiskGiB, rec.dockerDiskGiB],
    ...(snapshot.dockerHostDisk ? [['Free Docker data disk', capacity(snapshot.dockerHostDisk.freeBytes), min.dockerDiskGiB, rec.dockerDiskGiB]] : []),
    ...(assessment.model?.location === 'local' && !sharedModelDisk ? [['Free Ollama model disk', capacity(snapshot.ollamaDisk.freeBytes), min.modelDiskGiB, rec.modelDiskGiB]] : []),
  ]
  return <div className="resource-summary">
    <h3>Machine resources</h3>
    <p>{snapshot.host.platform === 'darwin' ? 'macOS' : snapshot.host.platform === 'win32' ? 'Windows' : snapshot.host.platform} · {snapshot.host.arch} · {snapshot.host.cpuCount ?? '?'} logical CPUs. Requirements below apply to <b>{assessment.model?.label}</b>.</p>
    <div className="resource-table-scroll"><table className="resource-table">
      <thead><tr><th scope="col">Resource</th><th scope="col">Available</th><th scope="col">Minimum</th><th scope="col">Recommended</th></tr></thead>
      <tbody>{rows.map(([label, actual, minimum, recommended]) => <tr key={String(label)}><th scope="row">{label}</th><td>{actual}</td><td>{minimum} GiB</td><td>{recommended} GiB</td></tr>)}</tbody>
    </table></div>
    <p className="field-hint">Conservative whole-stack planning budgets, including the operating system, Docker and build headroom. Model file size alone does not predict memory use. Actual needs grow with your data and workload.</p>
    <details><summary>Measured locations</summary><p>Installation: <code>{snapshot.installDisk.path}</code></p><p>Docker data: <code>{snapshot.dockerHostDisk?.path ?? 'Location not verified'}</code></p>{assessment.model?.location === 'local' ? <p>Ollama models: <code>{snapshot.ollamaDisk.path}</code></p> : null}</details>
    {assessment.blockers.length ? <div className="notice bad" role="alert"><b>Minimum requirements are not met.</b><ul>{assessment.blockers.map(issue => <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>)}</ul><p>Free disk space, close other applications or adjust Docker resources, then check again. If you leave setup to clean up, re-run the installation afterward. Next remains unavailable until the minimum checks pass.</p></div> : null}
    {assessment.warnings.length ? <div className="notice warn"><b>Resource warnings</b><ul>{assessment.warnings.map(issue => <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>)}</ul>{assessment.model?.location === 'local' && !assessment.meetsRecommended ? <p><b>This local model is strongly not recommended with the current headroom.</b> Heavy memory pressure may freeze the computer. A forced shutdown or exhausted disk can interrupt writes and damage stored data; this is not a claim that low RAM directly corrupts memory.</p> : null}</div> : null}
    {assessment.allowed && assessment.warnings.length && onAcknowledge ? <label className="resource-ack"><input type="checkbox" checked={acknowledged ?? false} onChange={event => onAcknowledge(event.target.checked)} /><span>I have reviewed these warnings and checked any storage that could not be measured.</span></label> : null}
  </div>
}
