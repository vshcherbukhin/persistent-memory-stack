'use client'

import { useMemo } from 'react'
import { MemoryToolsScope, useMemoryToolState } from '@/components/MemoryToolsState'
import { emptyMemoryImportResult, runMemoryImport } from '@/lib/memoryImportRunner'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { FileInput } from '@/components/ui/FileInput'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
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
  onImportFinished?: (result: MemoryImportResult) => void
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
  // Prototype d-tools: the three safe tools side by side, the destructive one on its own row.
  return (
    <MemoryToolsScope scope={`${props.surface}:${props.localTeamId ?? ''}`}>
    <div className="memory-tools-stack">
      {props.canManageAdminTools ? <>
        <section className="panel tool-card">
          <div className="card-head">
            <h2 className="card-title"><Icon name="download" size={16} /> Export memory</h2>
          </div>
          <ExportTab {...props} />
        </section>
        <section className="panel tool-card">
          <div className="card-head">
            <h2 className="card-title"><Icon name="upload" size={16} /> Import memory</h2>
          </div>
          <ImportTab {...props} />
        </section>
        <section className="panel tool-card">
          <div className="card-head">
            <h2 className="card-title"><Icon name="hub" size={16} /> Rebuild memory graph</h2>
          </div>
          <GraphRebuildTab {...props} />
        </section>
      </> : null}
      <section className="panel tool-card tool-card-danger">
        <div className="card-head">
          <div>
            <h2 className="card-title"><Icon name="delete" size={16} /> Bulk delete</h2>
            <div className="card-sub">Scoped, previewed, and irreversible. Always shows the graph cascade before confirming.</div>
          </div>
          <span className="badge bad up">destructive</span>
        </div>
        <DeleteTab {...props} />
      </section>
    </div>
    </MemoryToolsScope>
  )
}

// ── Graph rebuild ───────────────────────────────────────────────────────────────
function GraphRebuildTab({ surface, teams, users, projectScopes, localTeamId, isSuper, busy, onGraphRebuild }: DashboardToolsProps) {
  const [team, setTeam] = useMemoryToolState('graph.team', '')
  const [project, setProject] = useMemoryToolState('graph.project', '')
  const [createdById, setCreatedById] = useMemoryToolState('graph.author', '')
  const [running, setRunning] = useMemoryToolState('graph.running', false)
  const [status, setStatus] = useMemoryToolState<{ kind: 'ok' | 'error'; text: string } | null>('graph.status', null)
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
      {!isPersonalSurface && !localTeamId && isSuper ? (
        <label className="tool-field">
          <span>Team</span>
          <Select
            ariaLabel="Graph rebuild team"
            value={team}
            onChange={(v) => {
              setTeam(v)
              setProject('')
            }}
            options={[{ value: '', label: 'All teams' }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
          />
        </label>
      ) : null}
      <label className="tool-field">
        <span>Project</span>
        <Select ariaLabel="Graph rebuild project" value={project} onChange={setProject} options={projectOptions} />
      </label>
      <label className="tool-field">
        <span>Author</span>
        <Select
          ariaLabel="Graph rebuild author"
          value={createdById}
          onChange={setCreatedById}
          options={[{ value: '', label: 'All authors' }, ...users.map((u) => ({ value: u.id, label: u.label }))]}
        />
      </label>
      <button type="button" className="btn secondary block tool-card-action" disabled={busy || running} onClick={() => void doRebuild()}>
        <Icon name="refresh" size={15} /> {running ? 'Queueing…' : 'Rebuild graph'}
      </button>
      {status ? <div className={`notice${status.kind === 'error' ? ' danger' : ' ok'}`}>{status.text}</div> : null}
    </>
  )
}

// ── Export ───────────────────────────────────────────────────────────────────────
function ExportTab({ surface, teams, projectScopes, localTeamId, isSuper, busy, onExport }: DashboardToolsProps) {
  const [team, setTeam] = useMemoryToolState('export.team', '') // '' = all teams (super only)
  const [project, setProject] = useMemoryToolState('export.project', '')
  const [exportType, setExportType] = useMemoryToolState<'secure' | 'standard'>('export.type', 'secure')
  const [passphrase, setPassphrase] = useMemoryToolState('export.passphrase', '')
  const [status, setStatus] = useMemoryToolState<{ kind: 'ok' | 'error'; text: string } | null>('export.status', null)
  const [saving, setSaving] = useMemoryToolState('export.saving', false)
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
      {!isPersonalSurface && !localTeamId && isSuper ? (
        <label className="tool-field">
          <span>Team</span>
          <Select ariaLabel="Export team" value={team} onChange={onTeamChange} options={[{ value: '', label: 'All teams' }, ...teams.map((t) => ({ value: t.id, label: t.name }))]} />
        </label>
      ) : null}
      <label className="tool-field">
        <span>Project</span>
        <Select ariaLabel="Export project" value={project} onChange={setProject} options={projectOptions} />
      </label>
      <div className="tool-field">
        <span>Export type</span>
        <SegmentedControl
          ariaLabel="Export type"
          value={exportType}
          onChange={setExportType}
          options={[
            { value: 'secure', label: 'Secure .pm' },
            { value: 'standard', label: 'JSON' },
          ]}
        />
      </div>
      {exportType === 'secure' ? (
        <label className="tool-field">
          <span>Passphrase</span>
          <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="required for .pm" />
        </label>
      ) : null}
      <button type="button" className="btn primary block tool-card-action" disabled={busy || saving} onClick={() => void doExport()}>
        <Icon name="download" size={15} /> {saving ? 'Exporting…' : 'Export memories'}
      </button>
      {status ? <div className={`notice${status.kind === 'error' ? ' danger' : ' ok'}`}>{status.text}</div> : null}
    </>
  )
}

// ── Import ───────────────────────────────────────────────────────────────────────
type ImportPhase = 'idle' | 'verifying' | 'ready' | 'importing' | 'done' | 'error' | 'interrupted'
type LocalImportDetail = { stage: string; message: string }
type ImportDraft = {
  fileName: string
  schema: string
  secure: boolean
  memories: unknown[]
  options: MemoryExportOptions | null
  exportedAt?: string
}

function ImportTab({ surface, teams, projectScopes, localTeamId, isSuper, busy, pending, canRunBackfill, onImport, onImportFinished, onBackfill }: DashboardToolsProps) {
  const [file, setFile] = useMemoryToolState<File | null>('import.file', null)
  const [team, setTeam] = useMemoryToolState('import.team', '') // '' = keep each row's team from the file
  const [project, setProject] = useMemoryToolState('import.project', '')
  const [passphrase, setPassphrase] = useMemoryToolState('import.passphrase', '')
  const [status, setStatus] = useMemoryToolState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>('import.status', null)
  const [phase, setPhase] = useMemoryToolState<ImportPhase>('import.phase', 'idle')
  const [draft, setDraft] = useMemoryToolState<ImportDraft | null>('import.draft', null)
  const [result, setResult] = useMemoryToolState<MemoryImportResult | null>('import.result', null)
  const [completed, setCompleted] = useMemoryToolState('import.completed', 0)
  const [localDetails, setLocalDetails] = useMemoryToolState<LocalImportDetail[]>('import.details', [])
  const [loading, setLoading] = useMemoryToolState('import.loading', false)
  const [importing, setImporting] = useMemoryToolState('import.running', false)
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
    setCompleted(0)
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
    setCompleted(0)
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
    if (!draft || importing) return
    setImporting(true)
    setStatus({ kind: 'ok', text: 'Importing memories and preparing embeddings…' })
    setLocalDetails([])
    setPhase('importing')
    try {
      const targetTeam = isPersonalSurface ? undefined : localTeamId ?? (team || (isSuper && draft.options?.teamId ? draft.options.teamId : undefined))
      const targetProject = project || draft.options?.project || inferSingleProject(draft.memories) || undefined
      const outcome = await runMemoryImport(draft.memories, (rows) => onImport(rows, targetTeam, targetProject), (progress) => {
        setCompleted(progress.completed)
        setResult(progress.result)
        setStatus({ kind: 'ok', text: `Processed ${progress.completed.toLocaleString()} of ${draft.memories.length.toLocaleString()} memories (${progress.result.imported.toLocaleString()} imported, ${progress.result.errors.toLocaleString()} errors).` })
      }, { completed, result: result ?? emptyMemoryImportResult() })
      setResult(outcome.result)
      if (outcome.interrupted) {
        setPhase(outcome.interrupted.rejected ? 'error' : 'interrupted')
        setStatus(outcome.interrupted.rejected
          ? { kind: 'error', text: `Import request rejected at row ${outcome.interrupted.index}. ${outcome.completed} of ${draft.memories.length} rows have confirmed results. Correct the request error and verify the file again.` }
          : { kind: 'warn', text: `Import interrupted at row ${outcome.interrupted.index}. ${outcome.completed} of ${draft.memories.length} rows have confirmed results. The current row may still be processing on the server.` })
        setLocalDetails([{ stage: `Row ${outcome.interrupted.index} · Import request`, message: outcome.interrupted.message }])
        return
      }
      const notice = memoryImportNotice(outcome.result)
      setStatus({ kind: notice.kind === 'success' ? 'ok' : notice.kind, text: notice.text })
      setPhase(notice.kind === 'error' ? 'error' : 'done')
      onImportFinished?.(outcome.result)
    } catch (err) {
      setPhase('interrupted')
      setStatus({ kind: 'warn', text: 'The import response was interrupted. Confirmed results are retained; the current row may still be processing on the server.' })
      setLocalDetails([{ stage: 'Import request', message: err instanceof Error ? err.message : String(err) }])
    } finally {
      setImporting(false)
    }
  }
  return (
    <>
      <p className="tool-desc">
        Import a previously-exported JSON or secure .pm file. Verify the package first; nothing is written until you confirm.{' '}
        {isPersonalSurface ? 'Memories are imported into personal memories.' : localTeamId ? 'Memories are imported into your team.' : isSuper ? 'Pick a target team, or keep each row’s team from the file.' : 'Memories are imported into your team.'}
      </p>
      <div className="tool-field">
        <span>File</span>
        <FileInput
          variant="dropzone"
          selectedFileName={file?.name ?? null}
          disabled={loading || importing}
          accept=".json,.pm,application/json,application/octet-stream"
          dropLabel={<>Drop a <code>.pm</code> or <code>.json</code> export here</>}
          onFile={(picked) => void onPickFile(picked)}
        />
      </div>
      {!isPersonalSurface && !localTeamId && isSuper ? (
        <label className="tool-field">
          <span>Target team</span>
          <Select
            ariaLabel="Import target team"
            disabled={loading || importing}
            value={team}
            onChange={(v) => {
              setTeam(v)
              setProject('')
              setResult(null)
              setCompleted(0)
              setPhase(draft ? 'ready' : 'idle')
              setLocalDetails([])
              setStatus(null)
            }}
            options={[{ value: '', label: 'team from file' }, ...teams.map((t) => ({ value: t.id, label: `→ ${t.name}` }))]}
          />
        </label>
      ) : null}
      <label className="tool-field">
        <span>Target project</span>
        <Select ariaLabel="Import target project" value={project} disabled={loading || importing} onChange={(v) => { setProject(v); setResult(null); setCompleted(0); setPhase(draft ? 'ready' : 'idle'); setLocalDetails([]); setStatus(null) }} options={projectOptions} />
      </label>
      {file?.name.toLowerCase().endsWith('.pm') ? (
        <label className="tool-field">
          <span>Passphrase</span>
          <Input type="password" value={passphrase} disabled={loading || importing} onChange={(e) => { setPassphrase(e.target.value); clearLoadedState(); setStatus(file ? { kind: 'ok', text: 'Passphrase changed. Load and verify the file again.' } : null) }} />
        </label>
      ) : null}
      <button type="button" className="btn secondary block tool-card-action" disabled={!file || busy || loading || importing} onClick={() => void doLoadAndVerify()}>
        {loading ? 'Verifying…' : 'Load & verify'}
      </button>
      {!draft && status ? <div className={noticeClass(status.kind)}>{status.text}</div> : null}
      {!draft ? <ImportErrorDetails localDetails={localDetails} resultDetails={result?.details ?? []} totalErrors={result?.errors ?? localDetails.length} /> : null}
      {!draft && pending && pending.memories + pending.chunks > 0 ? (
        <div className="tool-card-foot">
          <span className="note">
            {pending.memories.toLocaleString()} memor{pending.memories === 1 ? 'y' : 'ies'} · {pending.chunks.toLocaleString()} chunks awaiting embedding
          </span>
          {canRunBackfill ? (
            <Tooltip label={pending.embeddingMode !== 'server' ? 'Client-managed embeddings run on the client side' : 'Re-embed pending rows now'}>
              <button type="button" className="btn sm ghost" disabled={busy || pending.embeddingMode !== 'server'} onClick={onBackfill}>
                Run backfill now
              </button>
            </Tooltip>
          ) : null}
        </div>
      ) : null}

      {draft ? (
        // Prototype d-tools-import: the staged package is reviewed before anything is written.
        <div className="import-review" aria-live="polite">
          <div className="card-head">
            <div>
              <h3 className="card-title"><Icon name="upload" size={16} /> Review import</h3>
              <div className="card-sub">{phase === 'done' ? 'Import finished. Embeddings continue in the background.' : phase === 'importing' ? 'Import is running. You can switch dashboard pages while it continues.' : phase === 'interrupted' ? 'Confirmed results are retained. Check the current row before resuming.' : phase === 'error' ? 'Review the errors before retrying.' : 'Nothing is written until you confirm.'}</div>
            </div>
            <span className={`badge up ${phase === 'done' ? 'ok' : phase === 'error' ? 'bad' : phase === 'interrupted' ? 'warn' : 'accent'}`}>
              {phase === 'done' ? 'imported' : phase === 'importing' ? 'importing' : phase === 'error' ? 'failed' : phase === 'interrupted' ? 'interrupted' : 'staged'}
            </span>
          </div>
          <div className="import-review-grid">
            <ImportProgress phase={phase} draft={draft} result={result} />
            <div className="import-summary">
              <div><span>File</span><b>{draft.fileName}</b></div>
              <div><span>Memories</span><b>{draft.memories.length.toLocaleString()}</b></div>
              <div><span>Format</span><b>{draft.secure ? 'Secure .pm' : 'Standard JSON'}</b></div>
              {isPersonalSurface ? null : <div><span>Target team</span><b>{selectedTeamLabel}</b></div>}
              <div><span>Target project</span><b>{selectedProjectLabel}</b></div>
              {draft.exportedAt ? <div><span>Exported</span><b>{new Date(draft.exportedAt).toLocaleString()}</b></div> : null}
            </div>
          </div>
          {status ? <div className={noticeClass(status.kind)}>{status.text}</div> : null}
          <ImportErrorDetails localDetails={localDetails} resultDetails={result?.details ?? []} totalErrors={result?.errors ?? localDetails.length} />
          <div className={`notice with-icon${pending && pending.memories + pending.chunks > 0 ? ' warn' : ''}`}>
            <span className="n-ic"><Icon name={pending && pending.memories + pending.chunks > 0 ? 'warning' : 'info'} size={16} /></span>
            <span className="n-body">
              <span className="notice-title">Embedding status</span>
              Imported memories embed in the background.{' '}
              <b>{pending ? `${pending.memories} memories · ${pending.chunks} chunks` : '—'}</b>{' '}
              pending{pending && pending.embeddingMode !== 'server' ? ' (client-managed: the MCP client embeds these)' : ''}.
            </span>
          </div>
          <div className="btn-row">
            <button type="button" className="btn primary" disabled={busy || loading || importing || completed === draft.memories.length} onClick={() => void doImport()}>
              {importing ? 'Importing…' : phase === 'interrupted' ? 'Resume import' : 'Import & re-embed'}
            </button>
            {canRunBackfill ? (
              <Tooltip label={pending && pending.embeddingMode !== 'server' ? 'Client-managed embeddings run on the client side' : 'Re-embed pending rows now'}>
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy || (pending != null && pending.embeddingMode !== 'server')}
                  onClick={onBackfill}
                >
                  Run backfill now
                </button>
              </Tooltip>
            ) : null}
            <button
              type="button"
              className="btn ghost"
              disabled={importing}
              onClick={() => {
                clearLoadedState()
                setStatus(null)
              }}
            >
              {phase === 'done' ? 'Done' : 'Cancel'}
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}

function ImportProgress({ phase, draft, result }: { phase: ImportPhase; draft: ImportDraft | null; result: MemoryImportResult | null }) {
  const verifiedState = phase === 'verifying' ? 'active' : draft || phase === 'importing' || phase === 'done' ? 'done' : phase === 'error' && !draft ? 'error' : 'idle'
  const importState = phase === 'importing' ? 'active' : phase === 'interrupted' ? 'queued' : phase === 'error' && draft ? 'error' : result && result.imported > 0 ? 'done' : 'idle'
  const embedState = phase === 'importing' ? 'active' : phase === 'interrupted' ? 'queued' : result ? (result.pending > 0 ? 'queued' : 'done') : 'idle'
  return (
    <div className="import-steps steplist" aria-label="Import progress">
      <ImportStep state={phase === 'idle' && !draft ? 'current' : 'done'} title="Select file" detail={draft?.fileName ?? 'Choose a .json or .pm export'} />
      <ImportStep state={verifiedState} title="Load & verify" detail={draft ? `${draft.memories.length.toLocaleString()} memories verified` : 'Parse, decrypt, and validate rows'} />
      <ImportStep state={draft && importState === 'idle' ? 'current' : importState} title="Import rows" detail={result ? `${result.imported.toLocaleString()} imported, ${result.errors.toLocaleString()} errors` : 'Write memories by id'} />
      <ImportStep state={embedState} title="Re-embed" detail={result ? `${result.embedded.toLocaleString()} embedded, ${result.pending.toLocaleString()} pending` : 'Embed now or queue backfill'} />
    </div>
  )
}

/** Prototype `.steprow`: finished steps tick, the running one spins, a failure is named. */
function ImportStep({ state, title, detail }: { state: 'idle' | 'current' | 'active' | 'done' | 'queued' | 'error'; title: string; detail: string }) {
  const tone = { idle: '', current: ' current', active: ' running', done: ' done', queued: ' queued', error: ' failed' }[state]
  return (
    <div className={`steprow${tone}`}>
      <span className="st-ic" aria-hidden="true">{state === 'done' ? <Icon name="check" size={11} /> : state === 'error' ? '!' : null}</span>
      <span className="steprow-text">
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
  const [project, setProject] = useMemoryToolState('delete.project', '')
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
      <div className="tool-row tool-row-danger">
        {!isPersonalSurface ? <div><span>Team</span><b>{teamName ?? 'Your team'}</b></div> : null}
        <label className="tool-field tool-field-grow">
          <span>Project</span>
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
        </label>
        <button type="button" className="btn danger" disabled={!canReview || busy} onClick={() => onRequestBulkDelete(project || undefined)}>
          <Icon name="delete" size={15} /> Review bulk delete
        </button>
      </div>
      {!isPersonalSurface ? (
        <p className="field-hint tool-card-hint">
          Deletes memories {canManageAdminTools ? 'in your current team' : 'that you created in your current team'}, optionally limited to one project.
        </p>
      ) : null}
    </>
  )
}
