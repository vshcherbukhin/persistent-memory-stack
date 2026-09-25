'use client'

/**
 * The interactive Workers monitor. Lists managed scheduled jobs (schedule + status
 * + next-run), and lets a superuser start/stop jobs, edit cron schedules, and
 * inspect live last-run logs.
 * Auto-refreshes every 10s.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { LogOutput } from '@/components/LogOutput'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Select } from '@/components/ui/Select'
import { StatusToggle } from '@/components/ui/StatusToggle'
import { Tooltip } from '@/components/ui/Tooltip'
import type { WorkerStatus, WorkerLiveness, WorkerLog, WorkerAction } from '@/lib/types'
import {
  buildSchedulePreview,
  cronDescription,
  draftFromWorker,
  MONTHS,
  normalizeCronForCompare,
  SCHEDULE_MODES,
  WEEKDAYS,
  type CronDraft,
} from '@/lib/worker-schedule'
import { listWorkersAction, workerLogsAction, workerActionAction, editWorkerAction } from './actions'

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
const COMMON_MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'))

function fmtAgo(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - Date.parse(iso)
  if (ms < 0) return 'just now'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function fmtNext(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.parse(iso) - Date.now()
  if (ms <= 0) return 'due'
  const s = Math.round(ms / 1000)
  if (s < 60) return `in ${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `in ${h}h`
  return `in ${Math.round(h / 24)}d`
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Prototype "Last / next run": one mono line — "2m ago · in 8m", or the failure and its retry. */
function runLine(w: WorkerStatus): string {
  const failed = w.status === 'failed' || Boolean(w.lastError)
  const last = w.lastRunAt
    ? `${failed ? 'failed ' : ''}${fmtAgo(w.lastRunAt)}${w.lastDurationMs != null ? ` (${fmtDuration(w.lastDurationMs)})` : ''}`
    : 'never ran'
  const next = !w.enabled ? 'stopped' : !w.nextRunAt ? '—' : failed ? `retry ${fmtNext(w.nextRunAt)}` : fmtNext(w.nextRunAt)
  return `${last} · ${next}`
}

/** Keep a non-standard saved value selectable instead of silently snapping it to a preset. */
function withCurrent(values: string[], current: string): string[] {
  return values.includes(current) ? values : [...values, current].sort((a, b) => Number(a) - Number(b))
}

function workerLogText(l: WorkerLog): string {
  return [
    `INFO: job ${l.name}`,
    `INFO: status ${l.status}`,
    l.lastError ? `ERROR: ${l.lastError}` : (l.logTail ?? '(no output yet)'),
  ].join('\n')
}

function CronButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button type="button" className={`cron-choice${selected ? ' active' : ''}`} onClick={onClick}>
      {children}
    </button>
  )
}

export function WorkersClient({
  initial,
  initialLiveness,
  initialError,
  canControl,
}: {
  initial: WorkerStatus[]
  initialLiveness: WorkerLiveness | null
  initialError?: string
  canControl: boolean
}) {
  const [workers, setWorkers] = useState<WorkerStatus[]>(initial)
  // Liveness was already fetched and passed in, but never rendered: a dead worker
  // process looked identical to an idle one.
  const [liveness, setLiveness] = useState<WorkerLiveness | null>(initialLiveness)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [busy, setBusy] = useState<string | null>(null)
  const busyRef = useRef<string | null>(null)
  const [scheduleFor, setScheduleFor] = useState<string | null>(null)
  const [scheduleDraft, setScheduleDraft] = useState<CronDraft | null>(null)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [logs, setLogs] = useState<string>('')
  // Prototype d-workers: one job is selected and its last run reads in the terminal card below.
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const inFlight = useRef(false)
  const runAllRef = useRef<() => void>(() => {})

  const setBusyState = (key: string | null) => {
    busyRef.current = key
    setBusy(key)
  }

  const refresh = useCallback(async (force = false) => {
    if (!force && busyRef.current) return
    if (inFlight.current) return
    inFlight.current = true
    try {
      const r = await listWorkersAction()
      setWorkers(r.workers)
      setLiveness(r.liveness)
      setError(r.error ?? null)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => void refresh(), 10_000)
    return () => window.clearInterval(id)
  }, [refresh])

  const loadLogs = useCallback(async (name: string) => {
    const r = await workerLogsAction(name)
    if (r.error || !r.log) {
      setLogs(`Error: ${r.error ?? 'no data'}`)
      return
    }
    setLogs(workerLogText(r.log))
  }, [])

  useEffect(() => {
    if (!logsFor) return
    const id = window.setInterval(() => void loadLogs(logsFor), 4_000)
    return () => window.clearInterval(id)
  }, [logsFor, loadLogs])

  const act = async (name: string, action: WorkerAction) => {
    const busyKey = `${name}:${action}`
    setBusyState(busyKey)
    setError(null)
    const r = await workerActionAction(name, action)
    if (r.error) {
      setError(r.error)
      setBusyState(null)
      return
    }
    await new Promise((resolve) => window.setTimeout(resolve, action === 'run-now' ? 1200 : 400))
    await refresh(true)
    setBusyState(null)
  }

  const openSchedule = (w: WorkerStatus) => {
    setScheduleFor(w.name)
    setScheduleDraft(draftFromWorker(w))
    setScheduleError(null)
  }

  const updateDraft = (patch: Partial<CronDraft>) => {
    setScheduleDraft((current) => (current ? { ...current, ...patch } : current))
    setScheduleError(null)
  }

  const toggleMinute = (minute: string) => {
    setScheduleDraft((current) => {
      if (!current) return current
      const next = current.minutes.includes(minute)
        ? current.minutes.filter((m) => m !== minute)
        : [...current.minutes, minute].sort((a, b) => Number(a) - Number(b))
      return { ...current, minutes: next.length ? next : [minute], minute: next[0] ?? minute }
    })
  }

  const toggleWeekday = (day: string) => {
    setScheduleDraft((current) => {
      if (!current) return current
      const next = current.weekdays.includes(day)
        ? current.weekdays.filter((d) => d !== day)
        : [...current.weekdays, day].sort((a, b) => Number(a) - Number(b))
      return { ...current, weekdays: next.length ? next : [day] }
    })
  }

  const showLogs = async (name: string) => {
    setLogsFor(name)
    setLogs('Loading…')
    await loadLogs(name)
  }

  // The top bar owns the prototype's "Run all now"; it signals this page.
  useEffect(() => {
    const onRunAll = () => runAllRef.current()
    window.addEventListener('pm:workers-run-all', onRunAll)
    return () => window.removeEventListener('pm:workers-run-all', onRunAll)
  }, [])

  const scheduleWorker = scheduleFor ? workers.find((w) => w.name === scheduleFor) ?? null : null
  const schedulePreview = scheduleWorker && scheduleDraft ? buildSchedulePreview(scheduleDraft, scheduleWorker.cron) : null
  const scheduleChanged = Boolean(
    scheduleWorker &&
      schedulePreview &&
      (schedulePreview.enabled !== scheduleWorker.enabled ||
        normalizeCronForCompare(schedulePreview.cron) !== normalizeCronForCompare(scheduleWorker.cron)),
  )

  const saveSchedule = async () => {
    if (!scheduleWorker || !schedulePreview || !schedulePreview.valid || !scheduleChanged) return
    setBusyState(`${scheduleWorker.name}:edit`)
    setScheduleError(null)
    const r = await editWorkerAction(scheduleWorker.name, {
      cron: schedulePreview.cron,
      enabled: schedulePreview.enabled,
    })
    setBusyState(null)
    if (r.error) {
      setScheduleError(r.error)
      return
    }
    setScheduleFor(null)
    setScheduleDraft(null)
    void refresh()
  }

  // Prototype d-workers: Job · Schedule · Status · Last / next run · Logs.
  const cols = 'minmax(0, 1fr) minmax(210px, .8fr) 130px 210px 150px'
  const workerProcessDown = liveness !== null && !liveness.alive
  const failingWorkers = workers.filter((w) => w.status === 'failed' || w.lastError)
  const selectedWorker = workers.find((w) => w.name === selectedName) ?? failingWorkers[0] ?? workers[0] ?? null
  const selectedFailed = Boolean(selectedWorker && (selectedWorker.status === 'failed' || selectedWorker.lastError))
  runAllRef.current = () => {
    if (!canControl || workerProcessDown || busyRef.current) return
    void (async () => {
      for (const job of workers.filter((w) => w.enabled)) await act(job.name, 'run-now')
    })()
  }
  const saveDisabled =
    !scheduleWorker || !schedulePreview || !schedulePreview.valid || !scheduleChanged || busy !== null || !canControl

  return (
    <div className="page-fill workers-page">
      {error ? (
        <div className="notice with-icon danger" role="alert">
          <span className="n-ic"><Icon name="error_outline" size={16} /></span>
          <span className="n-body">{error}</span>
        </div>
      ) : null}

      {/* A failing schedule needs to say what stops working, not just colour a row. */}
      {workerProcessDown ? (
        <div className="notice with-icon fault worker-incident" role="status">
          <span className="n-ic"><Icon name="error_outline" size={16} /></span>
          <span className="n-body">
            <span className="notice-title">The worker process is not reporting</span>
            No scheduled job can run — embedding backfill and graph consolidation are both stalled.
            Stored memories are unaffected, but new records stay unembedded until the process is back.
          </span>
        </div>
      ) : failingWorkers.length > 0 ? (
        <div className="notice with-icon fault worker-incident" role="status">
          <span className="n-ic"><Icon name="error_outline" size={16} /></span>
          <span className="n-body">
            <span className="notice-title">
              {failingWorkers.length === 1
                ? failingWorkers[0]!.errorCount > 1
                  ? `${failingWorkers[0]!.name} has failed ${failingWorkers[0]!.errorCount} runs in a row`
                  : `${failingWorkers[0]!.name} has failed its last run`
                : `${failingWorkers.length} jobs have failed their last run`}
            </span>
            {failingWorkers.map((w) => (
              <span key={w.name} className="worker-incident-item">
                <b>{w.name}</b> — {w.lastError ?? 'failed without an error message'}
                {w.enabled && w.nextRunAt ? `; retries ${fmtNext(w.nextRunAt)}` : '; paused, no retry scheduled'}
              </span>
            ))}
          </span>
        </div>
      ) : null}

      <div className="gt table-scroll">
        <div className="gt-head" style={{ gridTemplateColumns: cols }}>
          <div>Job</div>
          <div>Schedule</div>
          <div>Status</div>
          <div>Last / next run</div>
          <div>Logs</div>
        </div>
        <div className="gt-scroll-body">
          {workers.map((w) => {
            const toggleAction: WorkerAction = w.enabled ? 'pause' : 'resume'
            const toggleBusy = busy === `${w.name}:pause` || busy === `${w.name}:resume`
            const statusKind = w.status === 'failed' || w.lastError ? 'error' : w.enabled ? 'running' : 'stopped'
            const runBusy = busy === `${w.name}:run-now`
            const selected = selectedWorker?.name === w.name
            return (
              <div
                className={`gt-row worker-row${statusKind === 'error' ? ' worker-row-failed' : ''}${selected ? ' selected' : ''}`}
                key={w.name}
                style={{ gridTemplateColumns: cols }}
                onClick={() => setSelectedName(w.name)}
              >
                <div className="worker-job-cell">
                  {statusKind === 'error' ? <i className="dot bad" aria-hidden="true" /> : null}
                  <div className="service-cell-text">
                    <button
                      type="button"
                      className="worker-job-select"
                      aria-pressed={selected}
                      aria-label={`Show the last run of ${w.name}`}
                      onClick={() => setSelectedName(w.name)}
                    >
                      {w.name}
                    </button>
                    <span className="note worker-job-desc">{w.description}</span>
                  </div>
                </div>
                <div>
                  <div className="worker-schedule-cell">
                    <div className="worker-schedule-copy">
                      <code className="code-inline mono" style={{ fontSize: 12 }}>{w.cron}</code>
                      <div className="worker-schedule-desc">{cronDescription(w.cron, w.enabled)}</div>
                    </div>
                    {canControl ? (
                      <Tooltip label={`Edit schedule for ${w.name}`}>
                        <button
                          type="button"
                          className="worker-icon-button"
                          aria-label={`Edit schedule for ${w.name}`}
                          disabled={busy !== null}
                          onClick={(event) => {
                            event.stopPropagation()
                            openSchedule(w)
                          }}
                        >
                          <Icon name="settings" size={15} />
                        </button>
                      </Tooltip>
                    ) : null}
                  </div>
                </div>
                <div>
                  <div className="worker-status-cell">
                    {toggleBusy ? (
                      <span
                        className="worker-status-progress"
                        aria-label={`${toggleAction === 'pause' ? 'Stopping' : 'Starting'} ${w.name}`}
                      >
                        <span />
                      </span>
                    ) : (
                      <span className={`worker-status-badge ${statusKind}`}>
                        {statusKind === 'running' ? 'enabled' : statusKind === 'error' ? (w.errorCount > 1 ? `${w.errorCount} failures` : 'failed') : 'stopped'}
                      </span>
                    )}
                  </div>
                </div>
                <div className={`worker-run-cell cell-mono${statusKind === 'error' ? ' failed' : ''}`}>{runLine(w)}</div>
                <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                  {canControl ? (
                    <>
                      <Tooltip label={`${w.enabled ? 'Stop' : 'Start'} ${w.name}`}>
                        <StatusToggle
                          checked={w.enabled}
                          ariaLabel={`${w.enabled ? 'Stop' : 'Start'} ${w.name}`}
                          disabled={busy !== null}
                          onClick={() => void act(w.name, toggleAction)}
                        />
                      </Tooltip>
                      {/* run-now was already a supported WorkerAction; the UI simply never offered it,
                          so a failed job could only be retried by waiting for its next scheduled tick. */}
                      <Tooltip label={`Run ${w.name} now`}>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Run ${w.name} now`}
                          disabled={busy !== null || workerProcessDown}
                          onClick={() => void act(w.name, 'run-now')}
                        >
                          <Icon name={runBusy ? 'hourglass_top' : 'play_arrow'} size={15} />
                        </button>
                      </Tooltip>
                    </>
                  ) : null}
                  <Tooltip label={`Open live logs for ${w.name}`}>
                    <button
                      type="button"
                      className="icon-btn worker-log-cell"
                      aria-label={`Open live logs for ${w.name}`}
                      onClick={() => void showLogs(w.name)}
                    >
                      <Icon name="terminal" size={15} />
                    </button>
                  </Tooltip>
                </div>
              </div>
            )
          })}
          {workers.length === 0 && !error ? (
            <div className="gt-empty">No scheduled jobs registered (is the worker running?).</div>
          ) : null}
        </div>
      </div>

      {selectedWorker ? (
        <section className={`card flush worker-terminal-card${selectedFailed ? ' failed' : ''}`} aria-label={`Last run of ${selectedWorker.name}`}>
          <div className="terminal-head">
            <Icon name={selectedFailed ? 'error_outline' : 'terminal'} size={13} />
            worker · {selectedWorker.name} · {selectedFailed ? 'last failure' : 'last run'}
          </div>
          <LogOutput
            text={selectedWorker.logTail ?? (selectedWorker.lastError ? `ERROR: ${selectedWorker.lastError}` : null)}
            fallback={selectedWorker.lastRunAt ? '(no output recorded for the last run)' : 'This job has not run yet.'}
            fallbackTimestamp={selectedWorker.lastFinishAt ?? selectedWorker.lastRunAt}
            variant="terminal"
            className="worker-terminal"
          />
        </section>
      ) : null}

      {selectedWorker && selectedFailed && canControl ? (
        <div className="btn-row">
          <button
            type="button"
            className="btn primary"
            disabled={busy !== null || workerProcessDown}
            onClick={() => void act(selectedWorker.name, 'run-now')}
          >
            <Icon name="play_arrow" size={15} /> Run now
          </button>
          <button type="button" className="btn secondary" disabled={busy !== null} onClick={() => openSchedule(selectedWorker)}>
            <Icon name="schedule" size={15} /> Edit schedule
          </button>
        </div>
      ) : null}

      {!canControl ? <p className="note">Start, stop, run-now and schedule edits are superuser-only.</p> : null}

      {scheduleWorker && scheduleDraft && schedulePreview ? (
        <Modal
          icon={<Icon name="schedule" size={18} />}
          title={`Schedule · ${scheduleWorker.name}`}
          onClose={() => {
            setScheduleFor(null)
            setScheduleDraft(null)
          }}
          width={600}
          className="worker-schedule-modal"
          footer={
            <>
              <button
                type="button"
                className="btn secondary"
                onClick={() => {
                  setScheduleFor(null)
                  setScheduleDraft(null)
                }}
              >
                Cancel
              </button>
              <button type="button" className="btn primary" disabled={saveDisabled} onClick={() => void saveSchedule()}>
                {busy === `${scheduleWorker.name}:edit` ? 'Saving…' : 'Save schedule'}
              </button>
            </>
          }
        >
          <div className="cron-builder">
            <SegmentedControl
              ariaLabel="Schedule frequency"
              className="cron-modes"
              value={scheduleDraft.mode}
              onChange={(mode) => updateDraft({ mode })}
              options={SCHEDULE_MODES.map((mode) => ({ value: mode.id, label: mode.label }))}
            />

            {scheduleDraft.mode === 'never' ? (
              <div className="cron-empty">This job will stay stopped. The cron value remains saved so you can start it again later.</div>
            ) : null}

            {scheduleDraft.mode === 'hourly' ? (
              <div className="cron-section">
                <div className="cron-section-title">Cadence</div>
                <div className="cron-hourly-mode" role="group" aria-label="Hourly cadence">
                  <CronButton selected={scheduleDraft.hourlyCadence === 'interval'} onClick={() => updateDraft({ hourlyCadence: 'interval' })}>
                    Every interval
                  </CronButton>
                  <CronButton selected={scheduleDraft.hourlyCadence === 'minutes'} onClick={() => updateDraft({ hourlyCadence: 'minutes' })}>
                    Specific minutes
                  </CronButton>
                </div>
                {scheduleDraft.hourlyCadence === 'interval' ? (
                  <label className="field cron-interval-field">
                    <span>Every how many minutes?</span>
                    <Input
                      type="number"
                      min={1}
                      max={59}
                      value={scheduleDraft.interval}
                      onChange={(e) => updateDraft({ interval: e.target.value })}
                    />
                  </label>
                ) : (
                  <>
                    <div className="cron-section-title cron-minutes-title">Minutes</div>
                    <div className="cron-grid cron-grid-minutes">
                      {COMMON_MINUTES.map((m) => (
                        <CronButton key={m} selected={scheduleDraft.minutes.includes(m)} onClick={() => toggleMinute(m)}>
                          {m}
                        </CronButton>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : null}

            {['daily', 'weekly', 'monthly', 'yearly'].includes(scheduleDraft.mode) ? (
              <div className="cron-section">
                <div className="section-label">Cadence</div>
                <div className="cron-field-row">
                  <label className="tool-field">
                    <span>Hour</span>
                    <Select
                      ariaLabel="Hour"
                      value={scheduleDraft.hour}
                      onChange={(hour) => updateDraft({ hour })}
                      options={withCurrent(HOURS, scheduleDraft.hour).map((h) => ({ value: h, label: h }))}
                    />
                  </label>
                  <label className="tool-field">
                    <span>Minute</span>
                    <Select
                      ariaLabel="Minute"
                      value={scheduleDraft.minute}
                      onChange={(minute) => updateDraft({ minute })}
                      options={withCurrent(COMMON_MINUTES, scheduleDraft.minute).map((m) => ({ value: m, label: m }))}
                    />
                  </label>
                </div>
              </div>
            ) : null}

            {scheduleDraft.mode === 'weekly' ? (
              <div className="cron-section">
                <div className="cron-section-title">Days of week</div>
                <div className="cron-grid cron-grid-days">
                  {WEEKDAYS.map((d) => (
                    <CronButton key={d.value} selected={scheduleDraft.weekdays.includes(d.value)} onClick={() => toggleWeekday(d.value)}>
                      {d.label}
                    </CronButton>
                  ))}
                </div>
              </div>
            ) : null}

            {scheduleDraft.mode === 'monthly' || scheduleDraft.mode === 'yearly' ? (
              <div className="cron-field-row">
                {scheduleDraft.mode === 'yearly' ? (
                  <div className="cron-section">
                    <div className="cron-section-title">Month</div>
                    <div className="cron-grid cron-grid-months">
                      {MONTHS.map((m) => (
                        <CronButton key={m.value} selected={scheduleDraft.month === m.value} onClick={() => updateDraft({ month: m.value })}>
                          {m.label}
                        </CronButton>
                      ))}
                    </div>
                  </div>
                ) : null}
                <label className="field cron-day-field">
                  <span>Day of month</span>
                  <Input
                    type="number"
                    min={1}
                    max={31}
                    value={scheduleDraft.dayOfMonth}
                    onChange={(e) => updateDraft({ dayOfMonth: e.target.value })}
                  />
                </label>
              </div>
            ) : null}

            <label className="tool-field cron-pattern-field">
              <span>Cron pattern</span>
              {scheduleDraft.mode === 'custom' ? (
                <Input
                  value={scheduleDraft.customCron}
                  onChange={(e) => updateDraft({ customCron: e.target.value })}
                  placeholder="0 3 * * *"
                  className="mono"
                />
              ) : (
                <Input value={schedulePreview.cron} readOnly aria-readonly="true" className="mono" />
              )}
              <span className={`field-hint${schedulePreview.valid ? '' : ' danger'}`}>
                <b>{schedulePreview.text}</b>
              </span>
            </label>
            {schedulePreview.error ? <div className="field-hint danger">{schedulePreview.error}</div> : null}
            {scheduleError ? (
              <div className="notice with-icon danger">
                <span className="n-ic"><Icon name="error_outline" size={16} /></span>
                <span className="n-body">{scheduleError}</span>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {logsFor ? (
        <Modal
          title={`Logs — ${logsFor}`}
          onClose={() => setLogsFor(null)}
          width={780}
          className="worker-log-modal"
          bodyClassName="worker-log-modal-body"
        >
          <div className="worker-log-live-row">
            <span className="badge ok-badge">live</span>
            <span>{workers.find((w) => w.name === logsFor)?.enabled ? 'schedule running' : 'schedule stopped'}</span>
          </div>
          <LogOutput
            text={logs}
            fallbackTimestamp={workers.find((w) => w.name === logsFor)?.lastFinishAt ?? workers.find((w) => w.name === logsFor)?.lastRunAt}
            variant="terminal"
            showTimeToggle
          />
        </Modal>
      ) : null}
    </div>
  )
}
