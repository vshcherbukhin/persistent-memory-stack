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
  initialError,
  canControl,
}: {
  initial: WorkerStatus[]
  initialLiveness: WorkerLiveness | null
  initialError?: string
  canControl: boolean
}) {
  const [workers, setWorkers] = useState<WorkerStatus[]>(initial)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [busy, setBusy] = useState<string | null>(null)
  const busyRef = useRef<string | null>(null)
  const [scheduleFor, setScheduleFor] = useState<string | null>(null)
  const [scheduleDraft, setScheduleDraft] = useState<CronDraft | null>(null)
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const [logsFor, setLogsFor] = useState<string | null>(null)
  const [logs, setLogs] = useState<string>('')
  const inFlight = useRef(false)

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

  const cols = 'minmax(220px, .9fr) minmax(300px, 1fr) 176px 170px minmax(360px, 2fr)'
  const saveDisabled =
    !scheduleWorker || !schedulePreview || !schedulePreview.valid || !scheduleChanged || busy !== null || !canControl

  return (
    <div className="page-fill workers-page">
      {error ? <div className="notice danger">{error}</div> : null}

      <div className="gt table-scroll">
        <div className="gt-head" style={{ gridTemplateColumns: cols }}>
          <div>Job</div>
          <div>Schedule</div>
          <div>Status</div>
          <div>Last / Next run</div>
          <div>Logs</div>
        </div>
        <div className="gt-scroll-body">
          {workers.map((w) => {
            const toggleAction: WorkerAction = w.enabled ? 'pause' : 'resume'
            const toggleBusy = busy === `${w.name}:pause` || busy === `${w.name}:resume`
            const statusKind = w.status === 'failed' || w.lastError ? 'error' : w.enabled ? 'running' : 'stopped'
            return (
              <div className="gt-row worker-row" key={w.name} style={{ gridTemplateColumns: cols }}>
                <div>
                  <div style={{ color: 'var(--body)' }}>{w.name}</div>
                  <div style={{ color: 'var(--dim)', fontSize: 11 }}>{w.description}</div>
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
                          onClick={() => openSchedule(w)}
                        >
                          <Icon name="settings" size={17} />
                        </button>
                      </Tooltip>
                    ) : null}
                  </div>
                </div>
                <div>
                  <div className="worker-status-cell">
                    <div>
                      {toggleBusy ? (
                        <span
                          className="worker-status-progress"
                          aria-label={`${toggleAction === 'pause' ? 'Stopping' : 'Starting'} ${w.name}`}
                        >
                          <span />
                        </span>
                      ) : (
                        <span className={`worker-status-badge ${statusKind}`}>
                          {statusKind}
                        </span>
                      )}
                    </div>
                    {canControl ? (
                      <>
                        <span className="status-toggle-dot" aria-hidden="true" />
                        <Tooltip label={`${w.enabled ? 'Stop' : 'Start'} ${w.name}`}>
                          <StatusToggle
                            checked={w.enabled}
                            ariaLabel={`${w.enabled ? 'Stop' : 'Start'} ${w.name}`}
                            disabled={busy !== null}
                            onClick={() => void act(w.name, toggleAction)}
                          />
                        </Tooltip>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="worker-run-cell">
                  <div className="muted">ran {fmtAgo(w.lastRunAt)}{w.lastDurationMs != null ? ` (${fmtDuration(w.lastDurationMs)})` : ''}</div>
                  <div style={{ color: 'var(--dim)' }}>{w.enabled ? `next ${fmtNext(w.nextRunAt)}` : 'stopped'}</div>
                </div>
                <div>
                  <button type="button" className="worker-log-cell" onClick={() => void showLogs(w.name)}>
                    <LogOutput
                      text={w.logTail ?? (w.lastError ? `ERROR: ${w.lastError}` : null)}
                      fallbackTimestamp={w.lastFinishAt ?? w.lastRunAt}
                      variant="preview"
                      maxLines={4}
                    />
                  </button>
                </div>
              </div>
            )
          })}
          {workers.length === 0 && !error ? (
            <div className="gt-empty">No scheduled jobs registered (is the worker running?).</div>
          ) : null}
        </div>
      </div>

      <div className="status-legend">
        <span><Icon name="play_circle" size={15} className="legend-icon running" /> running schedule</span>
        <span><Icon name="pause_circle" size={15} className="legend-icon stopped" /> stopped schedule</span>
        <span><Icon name="error" size={15} className="legend-icon error" /> failed last run</span>
        {!canControl ? <span className="legend-muted"><Icon name="lock" size={14} /> start/stop/schedule edits are superuser-only</span> : null}
      </div>

      {scheduleWorker && scheduleDraft && schedulePreview ? (
        <Modal
          title={`Schedule — ${scheduleWorker.name}`}
          onClose={() => {
            setScheduleFor(null)
            setScheduleDraft(null)
          }}
          width={760}
          className="worker-schedule-modal"
          footer={
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setScheduleFor(null)
                  setScheduleDraft(null)
                }}
              >
                Cancel
              </button>
              <button type="button" disabled={saveDisabled} onClick={() => void saveSchedule()}>
                {busy === `${scheduleWorker.name}:edit` ? 'Saving…' : 'Save'}
              </button>
            </>
          }
        >
          <div className="cron-builder">
            <div className="cron-tabs" role="tablist" aria-label="Schedule frequency">
              {SCHEDULE_MODES.map((mode) => (
                <button
                  type="button"
                  key={mode.id}
                  role="tab"
                  aria-selected={scheduleDraft.mode === mode.id}
                  className={`cron-tab${scheduleDraft.mode === mode.id ? ' active' : ''}`}
                  onClick={() => updateDraft({ mode: mode.id })}
                >
                  {mode.label}
                </button>
              ))}
            </div>

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
              <div className="cron-two-col">
                <div className="cron-section">
                  <div className="cron-section-title">Hour</div>
                  <div className="cron-grid cron-grid-hours">
                    {HOURS.map((h) => (
                      <CronButton key={h} selected={scheduleDraft.hour === h} onClick={() => updateDraft({ hour: h })}>
                        {h}
                      </CronButton>
                    ))}
                  </div>
                </div>
                <div className="cron-section">
                  <div className="cron-section-title">Minute</div>
                  <div className="cron-grid cron-grid-minutes">
                    {COMMON_MINUTES.map((m) => (
                      <CronButton key={m} selected={scheduleDraft.minute === m} onClick={() => updateDraft({ minute: m })}>
                        {m}
                      </CronButton>
                    ))}
                  </div>
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

            {scheduleDraft.mode === 'custom' ? (
              <label className="field">
                <span>Cron pattern</span>
                <Input
                  value={scheduleDraft.customCron}
                  onChange={(e) => updateDraft({ customCron: e.target.value })}
                  placeholder="0 3 * * *"
                  className="mono"
                />
              </label>
            ) : null}

            <div className={`cron-summary${schedulePreview.valid ? '' : ' error'}`}>
              <span>{schedulePreview.text}</span>
              <code>{schedulePreview.cron}</code>
            </div>
            {schedulePreview.error ? <div className="field-hint danger">{schedulePreview.error}</div> : null}
            {scheduleError ? <div className="notice danger">{scheduleError}</div> : null}
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
