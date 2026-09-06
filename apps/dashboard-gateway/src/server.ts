import http from 'node:http'
import { readFile } from 'node:fs/promises'

const DEFAULT_COORDINATOR_STATE_PATH = '/run/persistent-memory/update-coordinator-state/dashboard-handoff.json'
const DEFAULT_LEGACY_STATE_PATH = '/run/persistent-memory/update-state/dashboard-handoff.json'
const HANDOFF_PROTOCOL_VERSION = 1
const PUBLIC_RELEASE_LINE = 'public-v1'
const DEFAULT_DASHBOARD_BASE_URL = 'http://persistent-memory-dashboard:3000'
const ACTIVE_SHELL_PHASES = new Set<HandoffPhase>(['updating', 'rebuilding-dashboard', 'verifying', 'failed'])
const PHASES = new Set<HandoffPhase>(['idle', 'updating', 'rebuilding-dashboard', 'verifying', 'complete', 'failed'])
const SOURCES = new Set(['update-script', 'update-runner', 'update-coordinator'])
const HOP_BY_HOP_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
])
const DECODED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
])

export type HandoffPhase = 'idle' | 'updating' | 'rebuilding-dashboard' | 'verifying' | 'complete' | 'failed'
export type HandoffSource = 'update-script' | 'update-runner' | 'update-coordinator'

export type HandoffStepStatus = 'pending' | 'running' | 'done' | 'failed'

export interface HandoffStep {
  name: string
  status: HandoffStepStatus
  message?: string
}

export type HandoffActivityPhase = 'setup' | 'build' | 'deploy' | 'verify'
export type HandoffActivityStatus = 'running' | 'done' | 'failed'

export interface HandoffActivity {
  phase: HandoffActivityPhase
  status: HandoffActivityStatus
  sequence: number
  service?: string
  detail?: string
  updatedAt: string
}

export interface HandoffProbe {
  message: string
  completed: number
  total: number
  remaining: number
  checkedAt: string
}

export interface IdleHandoffState {
  phase: 'idle'
  active: false
}

export interface ActiveHandoffState {
  active: true
  releaseLine: string
  id: string
  source: HandoffSource
  phase: Exclude<HandoffPhase, 'idle'>
  message: string
  startedAt: string
  updatedAt: string
  progress?: number
  targetVersion?: string
  releaseNotesVersion?: string
  finishedAt?: string
  error?: string
  steps?: HandoffStep[]
  activity?: HandoffActivity
  probe?: HandoffProbe
  compatibility?: true
}

export type HandoffState = IdleHandoffState | ActiveHandoffState

export interface GatewayRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body?: Buffer
}

export interface GatewayResponse {
  status: number
  headers: Record<string, string>
  body: string | Buffer
}

export interface ProxyRequest {
  method: string
  targetUrl: string
  headers: Record<string, string>
  body?: Buffer
}

export type ProxyFn = (req: ProxyRequest) => Promise<GatewayResponse>

export interface GatewayDeps {
  statePath: string
  legacyStatePath?: string
  dashboardBaseUrl: string
  proxy: ProxyFn
}

function idle(): IdleHandoffState {
  return { phase: 'idle', active: false }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function progressValue(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, Math.round(value)))
}

function sanitizeSteps(value: unknown): HandoffStep[] | undefined {
  if (!Array.isArray(value)) return undefined
  const steps = value.flatMap((raw): HandoffStep[] => {
    const input = raw as Partial<HandoffStep> | null
    if (!input || typeof input.name !== 'string' || !input.name.trim()) return []
    if (!['pending', 'running', 'done', 'failed'].includes(String(input.status))) return []
    const step: HandoffStep = { name: input.name, status: input.status as HandoffStepStatus }
    if (typeof input.message === 'string' && input.message.trim()) step.message = input.message
    return [step]
  })
  return steps.length ? steps : undefined
}

function boundedText(value: unknown, maxLength = 320): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized && normalized.length <= maxLength ? normalized : undefined
}

function sanitizeActivity(value: unknown): HandoffActivity | undefined {
  const input = value as Partial<HandoffActivity> | null
  if (!input) return undefined
  if (!['setup', 'build', 'deploy', 'verify'].includes(String(input.phase))) return undefined
  if (!['running', 'done', 'failed'].includes(String(input.status))) return undefined
  const sequence = input.sequence
  if (!Number.isInteger(sequence) || (sequence ?? -1) < 0) return undefined
  const updatedAt = boundedText(input.updatedAt, 64)
  if (!updatedAt) return undefined
  const activity: HandoffActivity = {
    phase: input.phase as HandoffActivityPhase,
    status: input.status as HandoffActivityStatus,
    sequence: sequence as number,
    updatedAt,
  }
  const service = boundedText(input.service)
  const detail = boundedText(input.detail)
  if (service) activity.service = service
  if (detail) activity.detail = detail
  return activity
}

function sanitizeProbe(value: unknown): HandoffProbe | undefined {
  const input = value as Partial<HandoffProbe> | null
  if (!input) return undefined
  const completed = input.completed
  const total = input.total
  const remaining = input.remaining
  const message = boundedText(input.message)
  const checkedAt = boundedText(input.checkedAt, 64)
  if (
    !Number.isInteger(completed) || (completed ?? -1) < 0
    || !Number.isInteger(total) || (total ?? -1) < 0
    || !Number.isInteger(remaining) || (remaining ?? -1) < 0
    || remaining !== Math.max(0, (total ?? 0) - (completed ?? 0))
    || !message || !checkedAt
  ) return undefined
  return { message, completed: completed as number, total: total as number, remaining: remaining as number, checkedAt }
}

function compatibilityState(input: Record<string, unknown>): ActiveHandoffState {
  return {
    active: true,
    releaseLine: PUBLIC_RELEASE_LINE,
    id: stringValue(input.id) ?? 'unsupported-handoff',
    source: 'update-coordinator',
    phase: 'updating',
    message: 'Live update view is unavailable for this dashboard version. Follow the terminal; completion will be available when you reopen the dashboard.',
    startedAt: stringValue(input.startedAt) ?? 'unknown',
    updatedAt: stringValue(input.updatedAt) ?? 'unknown',
    compatibility: true,
  }
}

function parseHandoffState(value: unknown): HandoffState {
  const input = value as Record<string, unknown> | null
  if (!input || typeof input !== 'object' || input.releaseLine !== PUBLIC_RELEASE_LINE) return idle()
  if ('protocolVersion' in input && input.protocolVersion !== HANDOFF_PROTOCOL_VERSION) {
    return compatibilityState(input)
  }
  const phase = input.phase
  const source = input.source
  const id = stringValue(input.id)
  const message = stringValue(input.message)
  const startedAt = stringValue(input.startedAt)
  const updatedAt = stringValue(input.updatedAt)
  if (
    !id
    || !message
    || !startedAt
    || !updatedAt
    || typeof phase !== 'string'
    || phase === 'idle'
    || !PHASES.has(phase as HandoffPhase)
    || typeof source !== 'string'
    || !SOURCES.has(source)
  ) {
    return idle()
  }

  const state: ActiveHandoffState = {
    active: true,
    releaseLine: PUBLIC_RELEASE_LINE,
    id,
    source: source as HandoffSource,
    phase: phase as ActiveHandoffState['phase'],
    message,
    startedAt,
    updatedAt,
  }
  const targetVersion = stringValue(input.targetVersion)
  const releaseNotesVersion = stringValue(input.releaseNotesVersion)
  const finishedAt = stringValue(input.finishedAt)
  const error = stringValue(input.error)
  const progress = progressValue(input.progress)
  const steps = sanitizeSteps(input.steps)
  const activity = sanitizeActivity(input.activity)
  const probe = sanitizeProbe(input.probe)
  if (progress !== undefined) state.progress = progress
  if (targetVersion) state.targetVersion = targetVersion
  if (releaseNotesVersion) state.releaseNotesVersion = releaseNotesVersion
  if (finishedAt) state.finishedAt = finishedAt
  if (error) state.error = error
  if (steps) state.steps = steps
  if (activity) state.activity = activity
  if (probe) state.probe = probe
  return state
}

async function readHandoffStateFile(path: string): Promise<HandoffState | undefined> {
  try {
    return parseHandoffState(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch {
    return undefined
  }
}

export async function readHandoffState(path: string, legacyPath?: string): Promise<HandoffState> {
  const primary = await readHandoffStateFile(path)
  const legacy = legacyPath ? await readHandoffStateFile(legacyPath) : undefined
  // A fresh launcher must remain visible while the previous coordinator event
  // is still complete. Once the coordinator publishes the same run, its
  // lifecycle state is canonical; a later launcher write must not regress its
  // displayed progress. Different runs are selected by their start time.
  if (primary?.active && legacy?.active) {
    if (primary.id === legacy.id) return primary
    const primaryStartedAt = Date.parse(primary.startedAt)
    const legacyStartedAt = Date.parse(legacy.startedAt)
    if (Number.isFinite(primaryStartedAt) && Number.isFinite(legacyStartedAt)) {
      if (legacyStartedAt > primaryStartedAt) return legacy
      if (primaryStartedAt > legacyStartedAt) return primary
    }
    const primaryUpdatedAt = Date.parse(primary.updatedAt)
    const legacyUpdatedAt = Date.parse(legacy.updatedAt)
    if (Number.isFinite(primaryUpdatedAt) && Number.isFinite(legacyUpdatedAt) && legacyUpdatedAt > primaryUpdatedAt) return legacy
    return primary
  }
  if (primary && shouldServeUpdateShell(primary)) return primary
  if (legacy?.active && shouldServeUpdateShell(legacy)) return legacy
  if (primary && primary.phase !== 'idle') return primary
  if (legacy && legacy.phase !== 'idle') return legacy
  return idle()
}

export function shouldServeUpdateShell(state: HandoffState): boolean {
  return state.active && state.releaseLine === PUBLIC_RELEASE_LINE && ACTIVE_SHELL_PHASES.has(state.phase)
}

function textHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : value ?? ''
}

function isBrowserNavigation(req: GatewayRequest): boolean {
  if (req.method !== 'GET') return false
  const url = new URL(req.url, 'http://dashboard-gateway')
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_next/')) return false
  const accept = textHeader(req.headers.accept).toLowerCase()
  return accept.includes('text/html')
}

function jsonResponse(body: unknown, status = 200): GatewayResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: `${JSON.stringify(body)}\n`,
  }
}

function htmlEscape(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!)
}

export function createUpdateHtml(initialState: HandoffState): string {
  const safeState = JSON.stringify(initialState).replace(/</g, '\\u003c')
  const title = updateTitle(initialState)
  const message = initialState.active ? initialState.message : 'Preparing update status.'
  const progress = initialState.active ? (initialState.progress ?? phaseProgress(initialState.phase)) : 5
  const progressMinWidth = progress && progress > 0 ? '4px' : '0'
  const progressHidden = initialState.active && initialState.phase === 'failed' ? ' hidden' : ''
  const initialErrorHidden = initialState.active && initialState.error ? '' : ' hidden'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(title)}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #030608; color: #f5f7fb; }
    body { margin: 0; min-height: 100vh; box-sizing: border-box; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at 18% 0%, rgba(32, 174, 229, .18), transparent 38%), rgba(3, 6, 8, .96); }
    .update-handoff-panel { width: min(680px, 100%); box-sizing: border-box; border: 1px solid #263039; border-radius: 8px; background: #12171b; box-shadow: 0 24px 80px rgba(0,0,0,.42); padding: 28px; }
    .update-handoff-kicker { color: #20aee5; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .update-handoff-title-row { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
    .update-handoff-title { margin: 0; color: #f5f7fb; font-size: 18px; line-height: 1.25; letter-spacing: 0; font-weight: 800; }
    .update-handoff-spinner { width: 26px; height: 26px; flex: 0 0 auto; border-radius: 999px; border: 3px solid #263039; border-top-color: #20aee5; animation: update-handoff-spin .9s linear infinite; }
    .update-handoff-panel.failed .update-handoff-spinner { animation: none; border-top-color: #ff7676; }
    @keyframes update-handoff-spin { to { transform: rotate(360deg); } }
    .update-handoff-message { margin-top: 8px; color: #aab4bd; line-height: 1.55; font-size: 14px; }
    .update-handoff-probe { margin: 12px 0 0; color: #8df0ad; font-size: 13px; line-height: 1.45; }
    .update-handoff-progress { margin-top: 22px; }
    .update-handoff-progress-meta { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; color: #737f89; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; font-weight: 800; }
    .update-handoff-progress-meta strong { color: #f5f7fb; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    .update-handoff-progress-track { height: 10px; box-sizing: border-box; padding: 1px; border: 1px solid #263039; border-radius: 999px; background: #080d10; overflow: hidden; }
    .update-handoff-progress-fill { width: 0%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #37B360 0%, #50E68A 100%); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .18); transition: width .35s ease; }
    .update-handoff-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 22px; }
    .update-handoff-grid > div { min-width: 0; border: 1px solid #263039; border-radius: 8px; background: #080d10; padding: 12px; }
    .update-handoff-grid span { display: block; color: #737f89; font-size: 11px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    .update-handoff-grid strong { display: block; margin-top: 6px; color: #f5f7fb; font-size: 13px; line-height: 1.35; word-break: break-word; }
    .update-handoff-grid #phase { color: #20aee5; }
    .update-handoff-panel.complete .update-handoff-grid #phase { color: #8df0ad; }
    .update-handoff-panel.failed { border-color: #ff7676; }
    .update-handoff-panel.failed .update-handoff-grid #phase { color: #ff7676; }
    .update-handoff-error { margin-top: 16px; border: 1px solid #ff7676; border-radius: 8px; background: rgba(255, 94, 94, .11); color: #ff9b9b; padding: 12px; font-size: 13px; line-height: 1.45; }
    .steps { margin-top: 18px; display: grid; gap: 8px; }
    .step { display: flex; align-items: center; justify-content: space-between; gap: 14px; border: 1px solid #253039; border-radius: 8px; padding: 10px 12px; background: #0c1115; }
    .step span:first-child { font-weight: 700; }
    .step span:last-child { color: #8df0ad; font-size: 13px; font-weight: 800; }
    .step.pending span:last-child { color: #737f89; }
    .step.running span:last-child { color: #20aee5; }
    .step.failed span:last-child { color: #ffcc66; }
    .update-handoff-hint { margin-top: 16px; color: #7e8992; font-size: 13px; line-height: 1.45; }
    @media (max-width: 640px) {
      .update-handoff-panel { padding: 22px; }
      .update-handoff-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main id="shell" class="update-handoff-panel ${initialState.phase}">
    <div class="update-handoff-kicker">Persistent Memory</div>
    <div class="update-handoff-title-row"><div class="update-handoff-spinner" aria-hidden="true"></div><h1 class="update-handoff-title">${htmlEscape(title)}</h1></div>
    <p class="update-handoff-message" id="message">${htmlEscape(message)}</p>
    <p class="update-handoff-probe" id="probe"${initialState.active && initialState.probe ? '' : ' hidden'}>${initialState.active ? htmlEscape(initialState.probe?.message ?? '') : ''}</p>
    <section class="update-handoff-progress" id="progress-section" aria-label="Update progress"${progressHidden}>
      <div class="update-handoff-progress-meta"><span>Progress</span><strong id="progress-text">${progress}%</strong></div>
      <div class="update-handoff-progress-track" id="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
        <div class="update-handoff-progress-fill" id="progress-fill" style="width: ${progress}%; min-width: ${progressMinWidth}"></div>
      </div>
    </section>
    <section class="update-handoff-grid" aria-live="polite">
      <div><span>Phase</span><strong id="phase">${initialState.phase}</strong></div>
      <div><span>Version</span><strong id="version">${initialState.active ? htmlEscape(initialState.targetVersion ?? initialState.releaseNotesVersion ?? 'detecting') : 'detecting'}</strong></div>
      <div><span>Updated</span><strong id="updated">${initialState.active ? htmlEscape(initialState.updatedAt) : 'waiting'}</strong></div>
    </section>
    <div class="update-handoff-error" id="error-row"${initialErrorHidden}><span id="error">${initialState.active ? htmlEscape(initialState.error ?? '') : ''}</span></div>
    <div class="steps" id="steps"></div>
    <p class="update-handoff-hint" id="hint" hidden></p>
  </main>
  <script>
    const initialState = ${safeState};
    const releaseKey = 'pm:public-v1:post-update-release-notes-version';
    const handoffSeenKey = 'pm:public-v1:update-handoff-seen-id';
    const shell = document.getElementById('shell');
    const message = document.getElementById('message');
    const probe = document.getElementById('probe');
    const phase = document.getElementById('phase');
    const version = document.getElementById('version');
    const updated = document.getElementById('updated');
    const errorRow = document.getElementById('error-row');
    const error = document.getElementById('error');
    const steps = document.getElementById('steps');
    const hint = document.getElementById('hint');
    const progressSection = document.getElementById('progress-section');
    const progressText = document.getElementById('progress-text');
    const progressBar = document.getElementById('progress-bar');
    const progressFill = document.getElementById('progress-fill');
    const title = document.querySelector('.update-handoff-title');
    let reloadScheduled = false;
    let readinessPolling = false;
    const progressStorageKey = 'pm:public-v1:update-handoff-progress';
    let displayedRunId = initialState && initialState.active ? initialState.id : null;
    let displayedProgress = initialState && initialState.active ? (Number.isFinite(initialState.progress) ? initialState.progress : phaseProgress(initialState.phase)) : 5;
    try {
      const stored = JSON.parse(sessionStorage.getItem(progressStorageKey) || 'null');
      if (stored && stored.id === displayedRunId && Number.isFinite(stored.progress)) displayedProgress = Math.max(displayedProgress, stored.progress);
    } catch (err) {}

    function phaseProgress(phaseName) {
      return {
        updating: 25,
        'rebuilding-dashboard': 50,
        verifying: 82,
        complete: 96,
        failed: 100,
      }[phaseName] || 5;
    }

    function renderProgress(state) {
      progressSection.hidden = state.phase === 'failed';
      const candidate = Math.max(0, Math.min(100, Math.round(Number.isFinite(state.progress) ? state.progress : phaseProgress(state.phase))));
      if (state.id && state.id === displayedRunId) displayedProgress = Math.max(displayedProgress, candidate);
      else {
        displayedRunId = state.id || null;
        displayedProgress = candidate;
      }
      if (displayedRunId) {
        try { sessionStorage.setItem(progressStorageKey, JSON.stringify({ id: displayedRunId, progress: displayedProgress })); } catch (err) {}
      }
      const value = displayedProgress;
      progressText.textContent = value + '%';
      progressBar.className = 'update-handoff-progress-track';
      progressBar.setAttribute('aria-valuenow', String(value));
      progressFill.style.width = value + '%';
      progressFill.style.minWidth = value > 0 ? '4px' : '0';
    }

    function updateTitle(state) {
      if (state && state.active && state.compatibility) return 'Live update view unavailable';
      if (state && state.active && state.phase === 'failed') return 'Persistent Memory update needs attention';
      const version = state && state.active ? (state.targetVersion || state.releaseNotesVersion) : null;
      return version
        ? 'Updating Persistent Memory to the latest release ' + version
        : 'Updating Persistent Memory to the latest release';
    }

    function render(state) {
      shell.className = 'update-handoff-panel ' + (state.phase || 'idle');
      document.title = updateTitle(state);
      title.textContent = updateTitle(state);
      message.textContent = state.message || 'Waiting for update status.';
      probe.hidden = !state.probe;
      probe.textContent = state.probe ? state.probe.message : '';
      phase.textContent = state.phase || 'idle';
      version.textContent = state.targetVersion || state.releaseNotesVersion || 'detecting';
      updated.textContent = state.updatedAt || 'waiting';
      errorRow.hidden = !state.error;
      error.textContent = state.error || '';
      renderProgress(state);
      steps.replaceChildren(...(state.steps || []).map((item) => {
        const row = document.createElement('div');
        row.className = 'step ' + item.status;
        const name = document.createElement('span');
        name.textContent = item.name;
        const status = document.createElement('span');
        status.textContent = item.message || item.status;
        row.append(name, status);
        return row;
      }));
      if (state.phase === 'failed') {
        hint.hidden = false;
        hint.textContent = 'The update stopped before completion. Review the terminal output, fix the issue, and rerun npm run update-persistent-memory.';
      }
      if (state.phase === 'complete' && !reloadScheduled) {
        waitForDashboardReady(state);
      }
    }

    async function waitForDashboardReady(state) {
      if (readinessPolling || reloadScheduled) return;
      readinessPolling = true;
      message.textContent = 'Waiting for the refreshed dashboard to accept traffic.';
      hint.hidden = false;
      hint.textContent = 'Final checks are complete. The dashboard will reopen as soon as the refreshed app is ready.';
      while (!reloadScheduled) {
        try {
          const res = await fetch('/api/update/dashboard-ready', { cache: 'no-store' });
          const body = await res.json().catch(() => ({}));
          if (res.ok && body.ready) {
            reloadScheduled = true;
            if (state.id) localStorage.setItem(handoffSeenKey, state.id);
            if (state.releaseNotesVersion) localStorage.setItem(releaseKey, state.releaseNotesVersion);
            progressText.textContent = '100%';
            progressBar.setAttribute('aria-valuenow', '100');
            progressFill.style.width = '100%';
            progressFill.style.minWidth = '4px';
            hint.textContent = 'Dashboard is ready. Reloading now...';
            window.setTimeout(() => window.location.reload(), 900);
            return;
          }
        } catch (err) {
          updated.textContent = new Date().toISOString();
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
    }

    async function poll() {
      try {
        const res = await fetch('/api/update/handoff', { cache: 'no-store' });
        if (!res.ok) throw new Error('handoff returned ' + res.status);
        render(await res.json());
      } catch (err) {
        message.textContent = 'Dashboard services are restarting. This page will reconnect automatically.';
        updated.textContent = new Date().toISOString();
      }
    }

    render(initialState);
    window.setInterval(poll, 1000);
    void poll();
  </script>
</body>
</html>`
}

function phaseProgress(phase: ActiveHandoffState['phase']): number {
  switch (phase) {
    case 'updating': return 25
    case 'rebuilding-dashboard': return 50
    case 'verifying': return 82
    case 'complete': return 96
    case 'failed': return 100
  }
}

function updateTitle(state: HandoffState): string {
  if (state.active && state.compatibility) return 'Live update view unavailable'
  if (state.active && state.phase === 'failed') return 'Persistent Memory update needs attention'
  const version = state.active ? state.targetVersion ?? state.releaseNotesVersion : undefined
  return version
    ? `Updating Persistent Memory to the latest release ${version}`
    : 'Updating Persistent Memory to the latest release'
}

async function isDashboardReady(deps: GatewayDeps): Promise<boolean> {
  try {
    const result = await deps.proxy({
      method: 'GET',
      targetUrl: new URL('/api/health', deps.dashboardBaseUrl).toString(),
      headers: { accept: 'application/json' },
    })
    return result.status >= 200 && result.status < 300
  } catch {
    return false
  }
}

export async function route(req: GatewayRequest, deps: GatewayDeps): Promise<GatewayResponse> {
  const url = new URL(req.url, 'http://dashboard-gateway')
  if (url.pathname === '/health' && req.method === 'GET') return jsonResponse({ ok: true })
  const state = await readHandoffState(deps.statePath, deps.legacyStatePath)
  if (url.pathname === '/api/update/handoff') {
    if (req.method !== 'GET') return jsonResponse({ error: 'method_not_allowed' }, 405)
    return jsonResponse(state)
  }
  if (url.pathname === '/api/update/dashboard-ready') {
    if (req.method !== 'GET') return jsonResponse({ error: 'method_not_allowed' }, 405)
    const ready = await isDashboardReady(deps)
    return jsonResponse({ ready }, ready ? 200 : 503)
  }
  if (state.active && state.phase === 'complete' && isBrowserNavigation(req) && !(await isDashboardReady(deps))) {
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
      body: createUpdateHtml({
        ...state,
        message: 'Waiting for the refreshed dashboard to accept traffic.',
        progress: state.progress ?? 96,
      }),
    }
  }
  if (shouldServeUpdateShell(state) && isBrowserNavigation(req)) {
    return {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
      body: createUpdateHtml(state),
    }
  }
  return deps.proxy(toProxyRequest(req, deps.dashboardBaseUrl))
}

function toProxyRequest(req: GatewayRequest, dashboardBaseUrl: string): ProxyRequest {
  const target = new URL(req.url, dashboardBaseUrl)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(key) || value == null) continue
    headers[name] = Array.isArray(value) ? value.join(',') : value
  }
  headers['x-forwarded-host'] = textHeader(req.headers.host)
  headers['x-forwarded-proto'] = 'http'
  return {
    method: req.method,
    targetUrl: target.toString(),
    headers,
    body: req.body,
  }
}

export async function proxyToDashboard(req: ProxyRequest): Promise<GatewayResponse> {
  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers: req.headers,
    redirect: 'manual',
  }
  if (req.body && req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = new Uint8Array(req.body)
    init.duplex = 'half'
  }
  const upstream = await fetch(req.targetUrl, init)
  const headers = sanitizeProxyResponseHeaders(upstream.headers)
  return {
    status: upstream.status,
    headers,
    body: Buffer.from(await upstream.arrayBuffer()),
  }
}

export function sanitizeProxyResponseHeaders(source: Headers): Record<string, string> {
  const headers: Record<string, string> = {}
  source.forEach((value, key) => {
    const lowerKey = key.toLowerCase()
    if (!HOP_BY_HOP_HEADERS.has(lowerKey) && !DECODED_RESPONSE_HEADERS.has(lowerKey)) headers[key] = value
  })
  return headers
}

async function collectBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return chunks.length ? Buffer.concat(chunks) : undefined
}

export interface ServerDeps {
  statePath: string
  legacyStatePath?: string
  dashboardBaseUrl: string
  proxy?: ProxyFn
}

export function createServer(deps: ServerDeps): http.Server {
  const proxy = deps.proxy ?? proxyToDashboard
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const result = await route({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          body: await collectBody(req),
        }, {
          statePath: deps.statePath,
          legacyStatePath: deps.legacyStatePath,
          dashboardBaseUrl: deps.dashboardBaseUrl,
          proxy,
        })
        res.writeHead(result.status, result.headers)
        res.end(result.body)
      } catch (err) {
        const requestPath = (req.url ?? '/').split('?')[0] || '/'
        console.error(`ERROR: [dashboard-gateway] request failed ${req.method ?? 'GET'} ${requestPath}: ${err instanceof Error ? err.message : String(err)}`)
        res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: 'gateway_error', message: err instanceof Error ? err.message : String(err) }))
      }
    })()
  })
}

export function start(): http.Server {
  const port = Number.parseInt(process.env.PORT ?? '3200', 10)
  const statePath = process.env.HANDOFF_STATE_PATH ?? DEFAULT_COORDINATOR_STATE_PATH
  const legacyStatePath = process.env.LEGACY_HANDOFF_STATE_PATH ?? DEFAULT_LEGACY_STATE_PATH
  const dashboardBaseUrl = process.env.DASHBOARD_BASE_URL ?? process.env.ADMIN_BASE_URL ?? DEFAULT_DASHBOARD_BASE_URL
  const server = createServer({ statePath, legacyStatePath, dashboardBaseUrl })
  server.listen(port, '0.0.0.0', () => {
    console.info(`INFO: [dashboard-gateway] listening on :${port} (dashboard ${dashboardBaseUrl}, handoff ${statePath}, legacy ${legacyStatePath})`)
  })
  return server
}
