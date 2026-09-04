'use client'

import { useMemo, useState } from 'react'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { FileInput } from '@/components/ui/FileInput'
import { Icon } from '@/components/ui/Icon'
import { Tooltip } from '@/components/ui/Tooltip'
import { memoryImportNotice } from '@/lib/memoryImportResult'
import type { Team, MemoryExportEnvelope, MemoryExportOptions, MemoryGraphRebuildResult, MemoryImportErrorDetail, MemoryImportResult, PendingEmbeddings, MemorySurface } from '@/lib/types'

export interface DashboardToolsProps {
  surface: MemorySurface
  teams: Team[]
  /** Kept for page compatibility; author-scoped export remains available only through the legacy route. */
  users: { id: string; label: string }[]
  /** Projects + their team — backs the team-scoped bulk-delete project dropdown. */
  projectScopes: { name: string; teamId: string }[]
  /** When set (local mode, one team) the team/user selectors are hidden and this team is used. */
  localTeamId?: string
  /** Shared space displays the fixed current-team scope without exposing a selector. */
  teamName?: string | null
  /** Export/import/rebuild stay admin-only; every team member gets the scoped bulk-delete card. */
  canManageAdminTools: boolean
  isSuper: boolean
  canRunBackfill: boolean
  busy: boolean
  pending: PendingEmbeddings | null
  onExport: (teamId?: string, project?: string) => Promise<MemoryExportEnvelope>
  onImport: (memories: unknown[], teamId?: string, project?: string) => Promise<MemoryImportResult>
  onGraphRebuild: (input: { teamId?: string; project?: string; createdById?: string }) => Promise<MemoryGraphRebuildResult>
  onRequestBulkDelete: (project: string | undefined) => void
  onBackfill: () => void
}

/**
 * Memories dashboard tools, split into vertically stacked cards. Personal Memories
 * hide team selectors and operate on the local personal stack; Shared Memories
 * keeps the team-scoped controls. The embed-backfill lives under Import
 * (imported memories embed in the background; this forces a re-embed).
 */
export function DashboardTools(props: DashboardToolsProps) {
  return (
    <div className="memory-tools-stack">
      {props.canManageAdminTools ? <>
        <section className="panel panel-pad memory-tool-card">
          <h2 className="card-title">Export memory</h2>
          <ExportTab {...props} />
        </section>
        <section className="panel panel-pad memory-tool-card">
          <h2 className="card-title">Import memory</h2>
          <ImportTab {...props} />
        </section>
        <section className="panel panel-pad memory-tool-card">
          <h2 className="card-title">Rebuild memory graph</h2>
          <GraphRebuildTab {...props} />
        </section>
      </> : null}
      <section className="panel panel-pad memory-tool-card">
        <h2 className="card-title">Bulk delete</h2>
        <DeleteTab {...props} />
      </section>
    </div>
  )
}

// ── Graph rebuild ───────────────────────────────────────────────────────────────
function GraphRebuildTab({ surface, teams, users, projectScopes, localTeamId, isSuper, busy, onGraphRebuild }: DashboardToolsProps) {
  const [team, setTeam] = useState('')
  const [project, setProject] = useState('')
  const [createdById, setCreatedById] = useState('')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const isPersonalSurface = surface === 'personal'
  const effectiveTeam = isPersonalSurface ? undefined : localTeamId ?? (isSuper ? team || undefined : undefined)
  const projectOptions = useMemo(() => projectSelectOptions(projectScopes, effectiveTeam, project), [effectiveTeam, project, projectScopes])
  const doRebuild = async () => {
    setRunning(true)
    setStatus(null)
    try {
      const result = await onGraphRebuild({
        ...(effectiveTeam ? { teamId: effectiveTeam } : {}),
        ...(project ? { project } : {}),
        ...(createdById ? { createdById } : {}),
      })
      setStatus({
        kind: 'ok',
        text: `Queued graph rebuild for ${result.matched.toLocaleString()} matching memor${result.matched === 1 ? 'y' : 'ies'} (job ${result.jobId}).`,
      })
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setRunning(false)
    }
  }
  return (
    <>
      <p className="tool-desc">
        Queue a one-time worker job that replays existing memories through Graphiti. Normal memory writes keep syncing automatically; this repairs or populates graph data for the selected slice.
      </p>
      <div className="tool-row">
        {!isPersonalSurface && !localTeamId && isSuper ? (
          <label className="tool-field">
            <span>Team</span>
            <div style={{ minWidth: 200 }}>
              <Select
                ariaLabel="Graph rebuild team"
                value={team}
                onChange={(v) => {
                  setTeam(v)
                  setProject('')
                }}
                options={[{ value: '', label: 'All teams' }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
              />
            </div>
          </label>
        ) : null}
        <label className="tool-field">
          <span>Project</span>
          <div style={{ minWidth: 200 }}>
            <Select ariaLabel="Graph rebuild project" value={project} onChange={setProject} options={projectOptions} />
          </div>
        </label>
        <label className="tool-field">
          <span>Author</span>
          <div style={{ minWidth: 220 }}>
            <Select
              ariaLabel="Graph rebuild author"
              value={createdById}
              onChange={setCreatedById}
              options={[{ value: '', label: 'All authors' }, ...users.map((u) => ({ value: u.id, label: u.label }))]}
            />
          </div>
        </label>
        <button type="button" className="btn primary" disabled={busy || running} onClick={() => void doRebuild()}>
          {running ? 'Queueing…' : 'Run graph rebuild'}
        </button>
      </div>
      {status ? <div className={`notice${status.kind === 'error' ? ' danger' : ' ok'}`} style={{ marginTop: 14 }}>{status.text}</div> : null}
    </>
  )
}

// ── Export ───────────────────────────────────────────────────────────────────────
function ExportTab({ surface, teams, projectScopes, localTeamId, isSuper, busy, onExport }: DashboardToolsProps) {
  const [team, setTeam] = useState('') // '' = all teams (super only)
  const [project, setProject] = useState('')
  const [exportType, setExportType] = useState<'secure' | 'standard'>('secure')
  const [passphrase, setPassphrase] = useState('')
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const isPersonalSurface = surface === 'personal'
  const effectiveTeam = isPersonalSurface ? undefined : localTeamId ?? (team || undefined)
  const projectOptions = useMemo(() => projectSelectOptions(projectScopes, effectiveTeam, project), [effectiveTeam, project, projectScopes])
  const selectedTeamName = effectiveTeam ? (teams.find((t) => t.id === effectiveTeam)?.name ?? 'selected team') : null
  const scope = `${isPersonalSurface ? 'personal memories' : localTeamId ? 'your team' : isSuper ? (selectedTeamName ?? 'all teams') : 'your team'} / ${project || 'all projects'}`
  const onTeamChange = (v: string) => {
    setTeam(v)
    setProject('')
  }
  const doExport = async () => {
    setStatus(null)
    if (exportType === 'secure' && passphrase.trim().length < 8) {
      setStatus({ kind: 'error', text: 'Secure export needs a passphrase with at least 8 characters.' })
      return
    }
    setSaving(true)
    try {
      const teamId = isPersonalSurface ? undefined : localTeamId ?? (isSuper ? team || undefined : undefined)
      const selectedProject = project || undefined
      const envelope = await onExport(teamId, selectedProject)
      const exportOptions: MemoryExportOptions = isPersonalSurface
        ? {
            exportType,
            project: selectedProject ?? envelope.filters?.project ?? null,
            createdById: envelope.filters?.createdById ?? null,
          }
        : {
            exportType,
            teamId: teamId ?? envelope.filters?.teamId ?? null,
            teamName: teamId ? teams.find((t) => t.id === teamId)?.name ?? null : null,
            project: selectedProject ?? envelope.filters?.project ?? null,
            createdById: envelope.filters?.createdById ?? null,
          }
      const payload: MemoryExportEnvelope = {
        ...envelope,
        exportedAt: envelope.exportedAt ?? new Date().toISOString(),
        exportOptions,
      }
      const ext = exportType === 'secure' ? 'pm' : 'json'
      const fileName = exportFileName(exportOptions, ext, isPersonalSurface ? 'personal' : 'shared')
      if (exportType === 'secure') {
        const secure = await encryptExport(payload, passphrase.trim())
        await saveTextFile(fileName, 'application/vnd.persistent-memory.export+json', JSON.stringify(secure, null, 2), [
          { description: 'Persistent Memory secure export', accept: { 'application/vnd.persistent-memory.export+json': ['.pm'] } },
        ])
      } else {
        await saveTextFile(fileName, 'application/json', JSON.stringify(payload, null, 2), [
          { description: 'Persistent Memory JSON export', accept: { 'application/json': ['.json'] } },
        ])
      }
      setStatus({ kind: 'ok', text: `Exported ${payload.count.toLocaleString()} memories.` })
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <p className="tool-desc">
        Save a re-importable memory file for <b>{scope}</b>. Vectors are excluded — re-importing re-embeds them.
      </p>
      <div className="tool-row">
        {!isPersonalSurface && !localTeamId && isSuper ? (
          <label className="tool-field">
            <span>Team</span>
            <div style={{ minWidth: 200 }}>
              <Select ariaLabel="Export team" value={team} onChange={onTeamChange} options={[{ value: '', label: 'All teams' }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} />
            </div>
          </label>
        ) : null}
        <label className="tool-field">
          <span>Project</span>
          <div style={{ minWidth: 200 }}>
            <Select ariaLabel="Export project" value={project} onChange={setProject} options={projectOptions} />
          </div>
        </label>
        <label className="tool-field">
          <span>Export type</span>
          <div style={{ minWidth: 180 }}>
            <Select
              ariaLabel="Export type"
              value={exportType}
              onChange={(v) => setExportType(v === 'standard' ? 'standard' : 'secure')}
              options={[
                { value: 'secure', label: 'Secure (.pm)' },
                { value: 'standard', label: 'Standard JSON' },
              ]}
            />
          </div>
        </label>
        {exportType === 'secure' ? (
          <label className="tool-field">
            <span>Passphrase</span>
            <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} style={{ minWidth: 220 }} />
          </label>
        ) : null}
        <button type="button" className="btn primary" disabled={busy || saving} onClick={() => void doExport()}>
          Export
        </button>
      </div>
      {status ? <div className={`notice${status.kind === 'error' ? ' danger' : ''}`} style={{ marginTop: 14 }}>{status.text}</div> : null}
    </>
  )
}

// ── Import ───────────────────────────────────────────────────────────────────────
type ImportPhase = 'idle' | 'verifying' | 'ready' | 'importing' | 'done' | 'error'
type LocalImportDetail = { stage: string; message: string }
type ImportDraft = {
  fileName: string
  schema: string
  secure: boolean
  memories: unknown[]
  options: MemoryExportOptions | null
  exportedAt?: string
}

function ImportTab({ surface, teams, projectScopes, localTeamId, isSuper, busy, pending, canRunBackfill, onImport, onBackfill }: DashboardToolsProps) {
  const [file, setFile] = useState<File | null>(null)
  const [team, setTeam] = useState('') // '' = keep each row's team from the file
  const [project, setProject] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [status, setStatus] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null)
  const [phase, setPhase] = useState<ImportPhase>('idle')
  const [draft, setDraft] = useState<ImportDraft | null>(null)
  const [result, setResult] = useState<MemoryImportResult | null>(null)
  const [localDetails, setLocalDetails] = useState<LocalImportDetail[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const isPersonalSurface = surface === 'personal'
  const effectiveTeam = isPersonalSurface ? undefined : localTeamId ?? (team || undefined)
  const projectOptions = useMemo(() => projectSelectOptions(projectScopes, effectiveTeam, project, 'project from file'), [effectiveTeam, project, projectScopes])
  const selectedTeamLabel = isPersonalSurface
    ? null
    : localTeamId
    ? teams.find((t) => t.id === localTeamId)?.name ?? 'your team'
    : team
      ? teams.find((t) => t.id === team)?.name ?? 'selected team'
      : draft?.options?.teamName || 'team from file'
  const selectedProjectLabel = project || draft?.options?.project || inferSingleProject(draft?.memories) || 'project from file'
  const clearLoadedState = () => {
    setDraft(null)
    setResult(null)
    setLocalDetails([])
    setPhase('idle')
  }
  const applyScope = (options?: MemoryExportOptions | null, memories?: unknown[]) => {
    const optionTeam = options?.teamId ?? undefined
    if (!localTeamId && isSuper && optionTeam && teams.some((t) => t.id === optionTeam)) setTeam(optionTeam)
    if (options?.project) {
      setProject(options.project)
    } else {
      const inferred = inferSingleProject(memories)
      if (inferred) setProject(inferred)
    }
  }
  const onPickFile = async (picked: File | null) => {
    setFile(picked)
    setStatus(picked ? { kind: 'ok', text: 'File selected. Load and verify it before importing memories.' } : null)
    setProject('')
    clearLoadedState()
  }
  const doLoadAndVerify = async () => {
    if (!file) return
    setLoading(true)
    setStatus(null)
    setResult(null)
    setLocalDetails([])
    setDraft(null)
    setPhase('verifying')
    try {
      const parsed = JSON.parse(await file.text()) as unknown
      const secure = isSecureExport(parsed)
      if (secure && passphrase.trim().length === 0) {
        setPhase('error')
        setStatus({ kind: 'error', text: 'Secure export verification needs the passphrase.' })
        setLocalDetails([{ stage: 'Decrypt', message: 'Enter the passphrase used when this .pm file was exported.' }])
        return
      }
      const payload = secure ? await decryptExport(parsed, passphrase.trim()) : parsed
      const memories = readMemoriesFromPayload(payload)
      const details = validateImportMemories(memories, { requireTeam: !isPersonalSurface })
      if (details.length > 0) {
        setPhase('error')
        setStatus({ kind: 'error', text: `File verification failed: ${details.length.toLocaleString()} issue(s) found.` })
        setLocalDetails(details)
        return
      }
      const options = readExportOptions(payload) ?? (secure ? parsed.exportOptions ?? null : null)
      applyScope(options, memories)
      setDraft({
        fileName: file.name,
        schema: isRecord(payload) && typeof payload.schema === 'string' ? payload.schema : secure ? 'pm.secure-memory-export/1' : 'unknown',
        secure,
        memories,
        options,
        exportedAt: isRecord(payload) && typeof payload.exportedAt === 'string' ? payload.exportedAt : undefined,
      })
      setPhase('ready')
      setStatus({ kind: 'ok', text: `File verified: ${memories.length.toLocaleString()} memories are ready for import.` })
    } catch (err) {
      setPhase('error')
      setStatus({ kind: 'error', text: 'File verification failed.' })
      setLocalDetails([{ stage: 'Verify file', message: err instanceof Error ? err.message : String(err) }])
    } finally {
      setLoading(false)
    }
  }
  const doImport = async () => {
    if (!draft) return
    setImporting(true)
    setStatus({ kind: 'ok', text: 'Importing memories and preparing embeddings…' })
    setLocalDetails([])
    setResult(null)
    setPhase('importing')
    try {
      const targetTeam = isPersonalSurface ? undefined : localTeamId ?? (team || (isSuper && draft.options?.teamId ? draft.options.teamId : undefined))
      const targetProject = project || draft.options?.project || inferSingleProject(draft.memories) || undefined
      const nextResult = await onImport(draft.memories, targetTeam, targetProject)
      setResult(nextResult)
      const notice = memoryImportNotice(nextResult)
      setStatus({ kind: notice.kind === 'success' ? 'ok' : notice.kind, text: notice.text })
      setPhase(notice.kind === 'error' ? 'error' : 'done')
    } catch (err) {
      setPhase('error')
      setStatus({ kind: 'error', text: 'Import failed before the server returned a batch result.' })
      setLocalDetails([{ stage: 'Import request', message: err instanceof Error ? err.message : String(err) }])
    } finally {
      setImporting(false)
    }
  }
  return (
    <>
      <p className="tool-desc">
        Import a previously-exported JSON or secure .pm file. First verify the package, then import and re-embed.{' '}
        {isPersonalSurface ? 'Memories are imported into personal memories.' : localTeamId ? 'Memories are imported into your team.' : isSuper ? 'Pick a target team, or keep each row’s team from the file.' : 'Memories are imported into your team.'}
      </p>
      <ImportProgress phase={phase} draft={draft} result={result} />
      <div className="tool-row" style={{ marginBottom: 12 }}>
        <FileInput accept=".json,.pm,application/json,application/octet-stream" buttonLabel="Choose file…" onFile={(picked) => void onPickFile(picked)} />
      </div>
      <div className="tool-row">
        {!isPersonalSurface && !localTeamId && isSuper ? (
          <label className="tool-field">
            <span>Target team</span>
            <div style={{ minWidth: 190 }}>
              <Select
                ariaLabel="Import target team"
                value={team}
                onChange={(v) => {
                  setTeam(v)
                  setProject('')
                  setResult(null)
                }}
                options={[{ value: '', label: 'team from file' }, ...teams.map((t) => ({ value: t.id, label: `→ ${t.name}` }))]}
              />
            </div>
          </label>
        ) : null}
        <label className="tool-field">
          <span>Target project</span>
          <div style={{ minWidth: 200 }}>
            <Select ariaLabel="Import target project" value={project} onChange={(v) => { setProject(v); setResult(null) }} options={projectOptions} />
          </div>
        </label>
        {file?.name.toLowerCase().endsWith('.pm') ? (
          <label className="tool-field">
            <span>Passphrase</span>
            <Input type="password" value={passphrase} onChange={(e) => { setPassphrase(e.target.value); clearLoadedState(); setStatus(file ? { kind: 'ok', text: 'Passphrase changed. Load and verify the file again.' } : null) }} style={{ minWidth: 220 }} />
          </label>
        ) : null}
        <button type="button" className="btn secondary" disabled={!file || busy || loading || importing} onClick={() => void doLoadAndVerify()}>
          {loading ? 'Verifying…' : 'Load & verify'}
        </button>
        <button type="button" className="btn primary" disabled={!draft || busy || loading || importing} onClick={() => void doImport()}>
          {importing ? 'Importing…' : 'Import & re-embed'}
        </button>
      </div>
      {draft ? (
        <div className="import-summary" aria-live="polite">
          <div><span>File</span><b>{draft.fileName}</b></div>
          <div><span>Memories</span><b>{draft.memories.length.toLocaleString()}</b></div>
          <div><span>Format</span><b>{draft.secure ? 'Secure .pm' : 'Standard JSON'}</b></div>
          {isPersonalSurface ? null : <div><span>Target team</span><b>{selectedTeamLabel}</b></div>}
          <div><span>Target project</span><b>{selectedProjectLabel}</b></div>
          {draft.exportedAt ? <div><span>Exported</span><b>{new Date(draft.exportedAt).toLocaleString()}</b></div> : null}
        </div>
      ) : null}
      {status ? <div className={noticeClass(status.kind)} style={{ marginTop: 14 }}>{status.text}</div> : null}
      <ImportErrorDetails localDetails={localDetails} resultDetails={result?.details ?? []} totalErrors={result?.errors ?? localDetails.length} />

      <div className="notice" style={{ marginTop: 16 }}>
        <div className="notice-title">Embedding status</div>
        Imported memories embed in the background.{' '}
        <b style={{ color: pending && pending.memories + pending.chunks > 0 ? 'var(--marigold)' : 'var(--soft)' }}>
          {pending ? `${pending.memories} memories · ${pending.chunks} chunks` : '—'}
        </b>{' '}
        pending{pending && pending.embeddingMode !== 'server' ? ' (client-managed: the MCP client embeds these)' : ''}.
        {canRunBackfill ? (
          <div style={{ marginTop: 10 }}>
            <Tooltip label={pending && pending.embeddingMode !== 'server' ? 'Client-managed embeddings run on the client side' : 'Re-embed pending rows now'}>
              <button
                type="button"
                className="secondary"
                disabled={busy || (pending != null && pending.embeddingMode !== 'server')}
                onClick={onBackfill}
              >
                Run backfill now
              </button>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </>
  )
}

function ImportProgress({ phase, draft, result }: { phase: ImportPhase; draft: ImportDraft | null; result: MemoryImportResult | null }) {
  const verifiedState = phase === 'verifying' ? 'active' : draft || phase === 'importing' || phase === 'done' ? 'done' : phase === 'error' && !draft ? 'error' : 'idle'
  const importState = phase === 'importing' ? 'active' : result && result.imported > 0 ? 'done' : phase === 'error' && draft ? 'error' : 'idle'
  const embedState = phase === 'importing' ? 'active' : result ? (result.pending > 0 ? 'queued' : 'done') : 'idle'
  return (
    <div className="import-steps" aria-label="Import progress">
      <ImportStep number="1" state={phase === 'idle' && !draft ? 'active' : 'done'} title="Select file" detail={draft?.fileName ?? 'Choose a .json or .pm export'} />
      <ImportStep number="2" state={verifiedState} title="Load & verify" detail={draft ? `${draft.memories.length.toLocaleString()} memories verified` : 'Parse, decrypt, and validate rows'} />
      <ImportStep number="3" state={importState} title="Import rows" detail={result ? `${result.imported.toLocaleString()} imported, ${result.errors.toLocaleString()} errors` : 'Write memories by id'} />
      <ImportStep number="4" state={embedState} title="Re-embed" detail={result ? `${result.embedded.toLocaleString()} embedded, ${result.pending.toLocaleString()} pending` : 'Embed now or queue backfill'} />
    </div>
  )
}

function ImportStep({ number, state, title, detail }: { number: string; state: 'idle' | 'active' | 'done' | 'queued' | 'error'; title: string; detail: string }) {
  return (
    <div className={`import-step ${state}`}>
      <span className="import-step-index">{state === 'done' ? <Icon name="check" size={13} /> : number}</span>
      <span>
        <b>{title}</b>
        <small>{detail}</small>
      </span>
    </div>
  )
}

function ImportErrorDetails({ localDetails, resultDetails, totalErrors }: { localDetails: LocalImportDetail[]; resultDetails: MemoryImportErrorDetail[]; totalErrors: number }) {
  const hasDetails = localDetails.length > 0 || resultDetails.length > 0
  if (!hasDetails) return null
  const visible = localDetails.length + resultDetails.length
  return (
    <div className="import-error-list" aria-live="polite">
      <div className="notice-title">Error details{totalErrors > visible ? ` (showing first ${visible})` : ''}</div>
      {localDetails.map((d, i) => (
        <div className="import-error-row" key={`local-${i}`}>
          <span>{d.stage}</span>
          <p>{d.message}</p>
        </div>
      ))}
      {resultDetails.map((d) => (
        <div className="import-error-row" key={`${d.index}-${d.id ?? d.stage}`}>
          <span>Row {d.index} · {d.stage.replace(/_/g, ' ')}</span>
          <p>{d.message}{d.id ? ` (${d.id})` : ''}</p>
        </div>
      ))}
    </div>
  )
}

function noticeClass(kind: 'ok' | 'warn' | 'error') {
  if (kind === 'error') return 'notice danger'
  if (kind === 'warn') return 'notice warn'
  return 'notice ok'
}

function validateImportMemories(memories: unknown[], opts: { requireTeam: boolean }): LocalImportDetail[] {
  const requireTeam = opts.requireTeam
  const details: LocalImportDetail[] = []
  if (memories.length === 0) return [{ stage: 'Validate rows', message: 'The selected file does not contain any memories.' }]
  memories.forEach((row, index) => {
    if (details.length >= 25) return
    if (!isRecord(row)) {
      details.push({ stage: `Row ${index + 1}`, message: 'Row is not an object.' })
      return
    }
    const teamFields = requireTeam ? ['teamId'] : []
    const missing = ['id', ...teamFields, 'content', 'category', 'shape', 'entities'].filter((key) => !(key in row))
    if (missing.length > 0) {
      details.push({ stage: `Row ${index + 1}`, message: `Missing required field(s): ${missing.join(', ')}.` })
      return
    }
    if (typeof row.id !== 'string' || !isUuid(row.id)) details.push({ stage: `Row ${index + 1}`, message: 'Memory id is not a UUID.' })
    if (requireTeam && (typeof row.teamId !== 'string' || !isUuid(row.teamId))) details.push({ stage: `Row ${index + 1}`, message: 'Team id is not a UUID.' })
    if (typeof row.content !== 'string' || row.content.trim().length === 0) details.push({ stage: `Row ${index + 1}`, message: 'Content is empty.' })
    if (!Array.isArray(row.entities)) details.push({ stage: `Row ${index + 1}`, message: 'Entities must be an array.' })
  })
  if (details.length >= 25 && memories.length > 25) details.push({ stage: 'Validate rows', message: 'Additional row issues were hidden. Fix the first rows and verify again.' })
  return details
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

// ── File export/import helpers ──────────────────────────────────────────────────
type SavePickerType = { description?: string; accept: Record<string, string[]> }
type SavePickerHandle = { createWritable: () => Promise<{ write: (data: Blob) => Promise<void> | void; close: () => Promise<void> | void }> }
type SavePickerWindow = Window & {
  showSaveFilePicker?: (opts: { suggestedName?: string; types?: SavePickerType[] }) => Promise<SavePickerHandle>
}

type SecureExportFile = {
  schema: 'pm.secure-memory-export/1'
  exportOptions?: MemoryExportOptions
  crypto: {
    algorithm: 'AES-GCM'
    kdf: 'PBKDF2-SHA256'
    iterations: number
    salt: string
    iv: string
  }
  payload: string
}

const KDF_ITERATIONS = 210_000

function projectSelectOptions(projectScopes: { name: string; teamId: string }[], teamId?: string, selected = '', emptyLabel = 'All projects') {
  const projects = [
    ...new Set(
      projectScopes
        .filter((p) => !teamId || p.teamId === teamId)
        .map((p) => p.name)
        .sort((a, b) => a.localeCompare(b)),
    ),
  ]
  if (selected && !projects.includes(selected)) projects.push(selected)
  return [{ value: '', label: emptyLabel }, ...projects.map((p) => ({ value: p, label: p }))]
}

function exportFileName(options: MemoryExportOptions, ext: 'json' | 'pm', surface: MemorySurface) {
  const team = surface === 'personal' ? 'personal-memories' : slug(options.teamName || options.teamId || 'all-teams')
  const project = slug(options.project || 'all-projects')
  const date = new Date().toISOString().slice(0, 10)
  return `persistent-memory-${team}-${project}-${date}.${ext}`
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'all'
}

async function saveTextFile(fileName: string, mime: string, text: string, types: SavePickerType[]) {
  const blob = new Blob([text], { type: mime })
  const picker = window as SavePickerWindow
  if (picker.showSaveFilePicker) {
    try {
      const handle = await picker.showSaveFilePicker({ suggestedName: fileName, types })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      throw err
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function encryptExport(payload: MemoryExportEnvelope, passphrase: string): Promise<SecureExportFile> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveAesKey(passphrase, toArrayBuffer(salt))
  const encoded = new TextEncoder().encode(JSON.stringify(payload))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, encoded))
  return {
    schema: 'pm.secure-memory-export/1',
    exportOptions: payload.exportOptions,
    crypto: {
      algorithm: 'AES-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: KDF_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
    },
    payload: bytesToBase64(cipher),
  }
}

async function decryptExport(file: SecureExportFile, passphrase: string): Promise<MemoryExportEnvelope> {
  const salt = base64ToBytes(file.crypto.salt)
  const iv = base64ToBytes(file.crypto.iv)
  const key = await deriveAesKey(passphrase, toArrayBuffer(salt), file.crypto.iterations)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(base64ToBytes(file.payload)))
  return JSON.parse(new TextDecoder().decode(plain)) as MemoryExportEnvelope
}

async function deriveAesKey(passphrase: string, salt: BufferSource, iterations = KDF_ITERATIONS): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function bytesToBase64(bytes: Uint8Array) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.slice(i, i + 0x8000))
  return btoa(out)
}

function base64ToBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSecureExport(value: unknown): value is SecureExportFile {
  return isRecord(value) && value.schema === 'pm.secure-memory-export/1' && typeof value.payload === 'string' && isRecord(value.crypto)
}

function readMemoriesFromPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (isRecord(value) && Array.isArray(value.memories)) return value.memories
  return []
}

function readExportOptions(value: unknown): MemoryExportOptions | null {
  if (!isRecord(value)) return null
  if (isRecord(value.exportOptions)) return value.exportOptions as MemoryExportOptions
  if (isRecord(value.filters)) {
    return {
      teamId: typeof value.filters.teamId === 'string' ? value.filters.teamId : null,
      project: typeof value.filters.project === 'string' ? value.filters.project : null,
      createdById: typeof value.filters.createdById === 'string' ? value.filters.createdById : null,
    }
  }
  return null
}

function inferSingleProject(memories: unknown[] | undefined): string | null {
  if (!memories || memories.length === 0) return null
  const projects = new Set<string>()
  for (const row of memories) {
    if (isRecord(row) && typeof row.project === 'string' && row.project.trim()) projects.add(row.project)
    if (projects.size > 1) return null
  }
  return [...projects][0] ?? null
}

// ── Bulk delete ────────────────────────────────────────────────────────────────────
function DeleteTab({ surface, projectScopes, localTeamId, teamName, canManageAdminTools, busy, onRequestBulkDelete }: DashboardToolsProps) {
  const [project, setProject] = useState('')
  const isPersonalSurface = surface === 'personal'
  const effectiveTeam = localTeamId
  // Personal Memories are self-owned: no team selector or hidden team gate.
  // Shared projects stay pinned to the caller's one current team.
  const canReview = isPersonalSurface || Boolean(effectiveTeam)
  const teamProjects = isPersonalSurface
    ? [...new Set(projectScopes.map((p) => p.name))]
    : effectiveTeam
      ? [...new Set(projectScopes.filter((p) => p.teamId === effectiveTeam).map((p) => p.name))]
      : []
  return (
    <>
      <p className="tool-desc" style={{ color: 'var(--coral-soft)' }}>
        Permanently delete memories{isPersonalSurface ? ' in Personal Memories' : canManageAdminTools ? ' in your current team' : ' that you created in your current team'}, optionally scoped to a single project. A live graph-impact review is required before anything is removed.
      </p>
      <div className="tool-row">
        {!isPersonalSurface ? <div><span>Team</span><b>{teamName ?? 'Your team'}</b></div> : null}
        <label className="tool-field">
          <span>Project</span>
          <div style={{ minWidth: 180 }}>
            <Select
              ariaLabel="Project to bulk-delete"
              value={project}
              onChange={setProject}
              disabled={!canReview}
              options={
                canReview
                  ? [{ value: '', label: 'All projects' }, ...teamProjects.map((p) => ({ value: p, label: p }))]
                  : [{ value: '', label: 'No team available' }]
              }
            />
          </div>
        </label>
        <button type="button" className="btn danger" disabled={!canReview || busy} onClick={() => onRequestBulkDelete(project || undefined)}>Review bulk delete</button>
      </div>
    </>
  )
}
