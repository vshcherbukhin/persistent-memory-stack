/**
 * persistent-memory onboarding wizard — personal-first.
 *
 * The visible install creates one local personal memory stack plus stream MCP.
 * Legacy flow ids retain their existing optional server connector separately.
 *
 * Layout: a 60px header + a 2-column body (left step rail | scrollable content
 * card over a pinned footer). Back/Next live in ONE shared footer in App; each
 * gated step reports its blocked state up via `setNextDisabled`. The footer is
 * hidden on the flow picker, the install run, and the done screen.
 */
import { useEffect, useRef, useState } from 'react'
import { getJSON, postJSON, streamNDJSON } from './api'
import { startWizardHeartbeat } from './heartbeat'
import { ProgressBar, Field, StepList, Terminal, StatusRow, formatStepDuration, type StepState } from './components'
import { Icon, Lattice, Notice, ProductMark } from './ui'
import { PrereqProgress } from './PrereqProgress'
import { prereqProgressEvent, type PrereqProgressState } from './prereq-progress'
import { applyTheme, dashboardThemeUrl, readTheme, type ThemePreference } from './theme'
import { EmbeddingSetup, embeddingTestSignature } from './EmbeddingSetup'
import { ResourceSummary } from './ResourceSummary'
import { RESOURCE_MODELS, evaluateResources, recommendResources, type ResourceSnapshot } from '../../shared/resource-policy'
import { type Flow, type Phase, phasesFor, nextPhase, prevPhase, prereqsBlocked, modelPresence, extractionNextBlocked, memorySettingsForFlow } from './flow'

const LOCAL_DASHBOARD_URL = 'http://localhost:3200'

interface Apps { claudeCli: boolean; claudeDesktop: boolean; codexCli: boolean; codexDesktop: boolean }
interface ServerPin { model: string; dim: number; embeddingTopology?: string; embeddingMode?: string; dashboardLoginMode?: 'password' | 'sso' }
interface RemoteServerConfig {
  model?: string
  dim?: number
  activeModel?: string
  activeDim?: number
  embeddingTopology?: string
  embeddingMode?: string
  dashboardLoginMode?: 'password' | 'sso'
}
interface RemoteIdentity {
  userId: string
  teamId: string | null
  teamName?: string | null
  userDisplayName?: string | null
  userEmail?: string | null
  adminLevel: string
}
interface ExtractionTestResult {
  ok: boolean
  message: string
  details?: string
}

interface Answers {
  // Full-flow embedding (defines the SERVER pin)
  embeddingMode: 'server' | 'client-bridge'
  embedProvider: 'ollama' | 'openai' | 'voyage'
  embedModel: string
  embedDim: number
  // Full-flow extraction LLM
  extractionProvider: 'anthropic' | 'openai'
  extractionModel: string
  anthropicApiKey: string
  openaiApiKey: string
  voyageApiKey: string
  resourceAcknowledged: boolean
  graphBackend: 'falkordb' | 'neo4j'
  semaphoreLimit: number
  // Optional Shared Memories connector
  remoteApiUrl: string
  remoteToken: string
  remoteOllamaUrl: string
  // Registration. Node is a legacy alias; stream is the only runtime.
  mcpRuntime: 'stream' | 'node'
  regLevel: 'global' | 'project'
  projectPaths: string[]
  // Memory rule
  ruleText: string
  memoryBlock: string
  // Full-local account (P1) — names the single local team + user; password optional
  teamName: string
  userEmail: string
  userName: string
  userPassword: string
  // Full-local optional dashboard update notifications
  // Personal/shared memory surfaces
  personalMemoryEnabled: boolean
  memoryInstallMode: 'shared-only' | 'personal-only' | 'personal-and-shared'
  defaultMemorySurface: 'personal' | 'shared'
}

const DEFAULT_ANSWERS: Answers = {
  embeddingMode: 'server',
  embedProvider: 'openai',
  embedModel: 'text-embedding-3-small',
  embedDim: 1536,
  extractionProvider: 'anthropic',
  extractionModel: 'claude-haiku-4-5-20251001',
  anthropicApiKey: '',
  openaiApiKey: '',
  voyageApiKey: '',
  resourceAcknowledged: false,
  graphBackend: 'falkordb',
  semaphoreLimit: 10,
  remoteApiUrl: 'http://localhost:8090',
  remoteToken: '',
  remoteOllamaUrl: 'http://localhost:11434',
  mcpRuntime: 'stream',
  regLevel: 'global',
  projectPaths: [],
  ruleText: '',
  memoryBlock: '',
  teamName: '',
  userEmail: '',
  userName: '',
  userPassword: '',
  personalMemoryEnabled: true,
  memoryInstallMode: 'personal-only',
  defaultMemorySurface: 'personal',
}

const PHASE_LABEL: Record<Phase, string> = {
  flow: 'Get started', prereqs: 'Environment pre-check', account: 'Account', remote: 'Connect server', embedding: 'Embeddings',
  pullModel: 'Pull model', extraction: 'Extraction LLM', ecosystem: 'Ecosystem',
  registration: 'Registration', rule: 'Memory rule', review: 'Review env', shared: 'Shared Memories', install: 'Install',
  done: 'Done',
}
const RAIL_HEADING = 'INSTALLATION STEPS'

type Setter = <K extends keyof Answers>(k: K, v: Answers[K]) => void

function serverPinFromConfig(config: RemoteServerConfig | null): ServerPin | null {
  if (!config) return null
  const model = config.model ?? config.activeModel
  const dim = config.dim ?? config.activeDim
  if (!model || !dim) return null
  return { model, dim: Number(dim), embeddingTopology: config.embeddingTopology, embeddingMode: config.embeddingMode, dashboardLoginMode: config.dashboardLoginMode }
}

type PasswordStrengthLevel = 'red' | 'yellow' | 'green'
interface PasswordStrength { level: PasswordStrengthLevel; accepted: boolean; messages: string[] }
const PASSWORD_SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?'

function assessPasswordStrength(password: string): PasswordStrength {
  const messages: string[] = []
  let score = 0
  if (password.length >= 12) score += 2
  else messages.push('Use at least 12 characters.')
  if (/[a-z]/.test(password)) score += 1
  else messages.push('Add a lowercase letter.')
  if (/[A-Z]/.test(password)) score += 1
  else messages.push('Add an uppercase letter.')
  if (/\d/.test(password)) score += 1
  else messages.push('Add a number.')
  if (new RegExp(`[${PASSWORD_SYMBOLS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`).test(password)) score += 1
  else messages.push('Add a symbol.')
  if (!/(.)\1{2,}/.test(password)) score += 1
  else messages.push('Avoid repeated characters.')
  const accepted = password.length >= 12 && score >= 5
  return { level: accepted ? 'green' : score >= 4 ? 'yellow' : 'red', accepted, messages }
}

function pickPasswordChar(chars: string): string {
  const bytes = new Uint32Array(1)
  globalThis.crypto.getRandomValues(bytes)
  return chars[bytes[0] % chars.length]
}

function generateStrongPassword(): string {
  const lower = 'abcdefghijkmnopqrstuvwxyz'
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const digits = '23456789'
  const all = `${lower}${upper}${digits}${PASSWORD_SYMBOLS}`
  const chars = [
    pickPasswordChar(lower),
    pickPasswordChar(lower),
    pickPasswordChar(upper),
    pickPasswordChar(upper),
    pickPasswordChar(digits),
    pickPasswordChar(digits),
    pickPasswordChar(PASSWORD_SYMBOLS),
    pickPasswordChar(PASSWORD_SYMBOLS),
    ...Array.from({ length: 12 }, () => pickPasswordChar(all)),
  ]
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const bytes = new Uint32Array(1)
    globalThis.crypto.getRandomValues(bytes)
    const j = bytes[0] % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

// ── Appearance toggle (header) ─────────────────────────────────────────────────
// The completion link explicitly hands this choice to the dashboard.
function ThemeToggle() {
  const [theme, setTheme] = useState<ThemePreference>(() => readTheme())
  const choose = (next: ThemePreference) => { setTheme(next); applyTheme(next) }
  return (
    <div className="wiz-theme" role="radiogroup" aria-label="Appearance">
      {(['obsidian', 'porcelain'] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={theme === option}
          tabIndex={theme === option ? 0 : -1}
          className={theme === option ? 'active' : ''}
          onClick={() => choose(option)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 'obsidian' : event.key === 'End' ? 'porcelain' : option === 'obsidian' ? 'porcelain' : 'obsidian'
            choose(next)
            const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
            buttons?.[next === 'obsidian' ? 0 : 1]?.focus()
          }}
        >
          {option === 'obsidian' ? 'Obsidian' : 'Porcelain'}
        </button>
      ))}
    </div>
  )
}

// ── Left step rail (per-flow phase list; jump to a visited step) ────────────────
function Rail({ flow, phase, personalMemoryEnabled, fault, goto }: { flow: Flow; phase: Phase; personalMemoryEnabled: boolean; fault: boolean; goto: (p: Phase) => void }) {
  const seq = phasesFor(flow, { personalMemoryEnabled })
  const cur = seq.indexOf(phase)
  return (
    <aside className="wiz-rail">
      <div className="wiz-rail-flow">{RAIL_HEADING}</div>
      {/* --conduit fills the rail's plasma trace up to the current step. */}
      <div
        className="wiz-rail-list"
        style={{ ['--conduit' as string]: `${seq.length > 1 ? (Math.max(cur, 0) / (seq.length - 1)) * 100 : 0}%` }}
      >
        {seq.map((p, idx) => {
          // A step reporting a blocking fault marks its own rail node, as in the prototype's negative artboards.
          const state = idx < cur ? 'done' : idx === cur ? (fault ? 'current fault' : 'current') : 'todo'
          const visited = idx <= cur
          return (
            <button
              key={p}
              type="button"
              className={`wiz-rail-item ${state}`}
              disabled={!visited}
              onClick={() => { if (visited) goto(p) }}
            >
              <span className="wiz-rail-num">{state === 'done' ? <Icon name="check" size={12} /> : String(idx + 1)}</span>
              <span className="wiz-rail-label">{PHASE_LABEL[p]}</span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

export default function App() {
  useEffect(() => startWizardHeartbeat(), [])
  const [phase, setPhase] = useState<Phase>('flow')
  const [flow, setFlow] = useState<Flow>('full')
  const [answers, setAnswers] = useState<Answers>(DEFAULT_ANSWERS)
  const [apps, setApps] = useState<Apps>({ claudeCli: false, claudeDesktop: false, codexCli: false, codexDesktop: false })
  const [serverPin, setServerPin] = useState<ServerPin | null>(null)
  const [remoteIdentity, setRemoteIdentity] = useState<RemoteIdentity | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [nextDisabled, setNextDisabled] = useState(false)
  const [fault, setFault] = useState(false)
  const [installSummary, setInstallSummary] = useState<InstallSummary | null>(null)
  const [resources, setResources] = useState<ResourceSnapshot | null>(null)
  const [resourceError, setResourceError] = useState<string | null>(null)
  const [embeddingTested, setEmbeddingTested] = useState('')
  const embeddingInited = useRef(false)
  const refreshResources = async () => {
    setResourceError(null)
    setAnswers(current => ({ ...current, resourceAcknowledged: false }))
    try {
      const snapshot = await getJSON<ResourceSnapshot>('/api/resources')
      setResources(snapshot)
      if (!embeddingInited.current) {
        const existing = await getJSON<{ embedding?: { provider: string; model: string; dim: number } | null }>('/api/env/existing')
        const saved = existing.embedding
        const recommended = recommendResources(snapshot)
        const choice = saved && RESOURCE_MODELS.some(model => model.provider === saved.provider && model.model === saved.model)
          ? saved : recommended
        setAnswers(current => ({ ...current, embedProvider: choice.provider as Answers['embedProvider'], embedModel: choice.model, embedDim: choice.dim }))
        embeddingInited.current = true
      }
    } catch (error) {
      setResources(null)
      setResourceError(error instanceof Error ? error.message : String(error))
    }
  }
  // Whether the Ecosystem step has applied its detected defaults — so navigating
  // back/forward doesn't clobber the user's manual app selection.
  const appsInited = useRef(false)
  const set: Setter = (k, v) => setAnswers((a) => ({ ...a, [k]: v }))
  const personalFlow = answers.personalMemoryEnabled

  const setPhaseAndResetGate = (p: Phase | null) => {
    if (!p) return
    setNextDisabled(false)
    setFault(false)
    setPhase(p)
  }

  const go = (dir: 'next' | 'back') => {
    const p = dir === 'next'
      ? nextPhase(phase, flow, { personalMemoryEnabled: personalFlow })
      : prevPhase(phase, flow, { personalMemoryEnabled: personalFlow })
    setPhaseAndResetGate(p)
  }

  const shared = {
    answers, set, apps, setApps, appsInited, serverPin, setServerPin, remoteIdentity, setRemoteIdentity, flow,
    resources, resourceError, refreshResources,
    onBack: () => go('back'), onNext: () => go('next'), setNextDisabled, setFault,
  }

  // Footer is hidden on the flow picker, the install run, and the done screen.
  const showFooter = phase !== 'flow' && phase !== 'install' && phase !== 'done'

  return (
    <div className="shell">
      <header className="wiz-header">
        {/* Prototype wizard shell: product mark and brand, the appearance switch, then the host-only pill. */}
        <div className="wiz-brand-block">
          <span className="wiz-mark"><ProductMark /></span>
          <div className="wiz-brand">
            <span className="wiz-title">Persistent Memory</span>
            <span className="wiz-sub">Guided install</span>
          </div>
        </div>
        <ThemeToggle />
        <span className="wiz-host"><Icon name="lock" size={13} /> host-only · 127.0.0.1:4319</span>
      </header>

      <div className="wiz-stage">
        <div className="wiz-card">
          <Rail flow={flow} phase={phase} personalMemoryEnabled={personalFlow} fault={fault} goto={setPhaseAndResetGate} />

          <div className="wiz-col">
            <div id="wiz-content">
              {phase === 'flow' && <FlowRouter onPick={(f, personal) => {
                setFlow(f)
                setServerPin(null)
                setRemoteIdentity(null)
                setAnswers((a) => ({
                  ...a,
                  personalMemoryEnabled: true,
                  memoryInstallMode: 'personal-only',
                  defaultMemorySurface: 'personal',
                  mcpRuntime: 'stream',
                }))
                setPhaseAndResetGate('prereqs')
              }} />}
              {phase === 'prereqs' && <Prereqs {...shared} />}
              {phase === 'account' && <Account {...shared} />}
              {phase === 'embedding' && <EmbeddingSetup {...shared} tested={embeddingTested} setTested={setEmbeddingTested} set={(key, value) => setAnswers(current => ({ ...current, [key]: value }))} />}
              {phase === 'pullModel' && <PullModel {...shared} />}
              {phase === 'extraction' && <Extraction {...shared} />}
              {phase === 'ecosystem' && <Ecosystem {...shared} />}
              {phase === 'registration' && <Registration {...shared} />}
              {phase === 'rule' && <RuleStep {...shared} />}
              {phase === 'review' && <Review flow={flow} answers={answers} serverPin={serverPin} setNextDisabled={setNextDisabled} setFault={setFault} embeddingTested={embeddingTested} onEmbedding={() => setPhaseAndResetGate('embedding')} onGoto={setPhaseAndResetGate} />}
              {phase === 'install' && (
                <Install
                  flow={flow}
                  body={installBody(flow, answers, apps, serverPin)}
                  onToken={setToken}
                  onDone={(summary) => { setInstallSummary(summary); setPhaseAndResetGate('done') }}
                  onBack={() => setPhaseAndResetGate('prereqs')}
                  setFault={setFault}
                />
              )}
              {phase === 'done' && <Done flow={flow} token={token} remoteToken={answers.remoteToken} apps={apps} passwordConfigured={Boolean(answers.userPassword)} embedding={`${answers.embedModel} @ ${answers.embedDim}`} summary={installSummary} />}
            </div>

            {showFooter && (
              <footer className="wiz-footer">
                <button type="button" className="btn ghost" onClick={() => go('back')}><Icon name="arrow_left" size={15} /> Back</button>
                <span className="wiz-step-count">
                  {(() => {
                    const seq = phasesFor(flow, { personalMemoryEnabled: personalFlow })
                    const at = seq.indexOf(phase)
                    return at < 0 ? '' : `STEP ${String(at + 1).padStart(2, '0')} / ${seq.length}`
                  })()}
                </span>
                <button type="button" className="btn primary" disabled={nextDisabled} onClick={() => go('next')}>
                  {phase === 'review' ? 'Generate & Install' : 'Next'} <Icon name="arrow_right" size={15} />
                </button>
              </footer>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface InstallSummary { done: number; total: number; ms: number }

interface InstallBody {
  flow: Flow
  mcpRuntime: 'stream' | 'node'
  apps: Apps
  regLevel: 'global' | 'project'
  projectPaths: string[]
  ruleBody: string
  memoryBlock: string
  remoteApiUrl?: string
  remoteOllamaUrl?: string
  remoteToken?: string
  pullModel?: string
  personalMemoryEnabled?: boolean
  memoryInstallMode?: 'shared-only' | 'personal-only' | 'personal-and-shared'
  defaultMemorySurface?: 'personal' | 'shared'
  personalApiUrl?: string
  sharedApiUrl?: string
  sharedUserToken?: string
  teamName?: string
  userEmail?: string
  userName?: string
  userPassword?: string
  resourceAcknowledged?: boolean
}

function installBody(flow: Flow, a: Answers, apps: Apps, pin: ServerPin | null): InstallBody {
  return {
    flow,
    mcpRuntime: 'stream',
    apps,
    regLevel: a.regLevel,
    projectPaths: a.projectPaths,
    ruleBody: a.ruleText,
    memoryBlock: a.memoryBlock,
    ...memorySettingsForFlow(flow, a, pin?.model),
    personalApiUrl: 'http://localhost:8090',
    teamName: a.teamName,
    userEmail: a.userEmail,
    userName: a.userName,
    userPassword: a.userPassword,
    resourceAcknowledged: a.resourceAcknowledged,
  }
}

interface StepProps {
  answers: Answers
  set: Setter
  apps: Apps
  setApps: (a: Apps) => void
  appsInited?: { current: boolean }
  serverPin: ServerPin | null
  setServerPin: (p: ServerPin | null) => void
  remoteIdentity: RemoteIdentity | null
  setRemoteIdentity: (i: RemoteIdentity | null) => void
  flow: Flow
  onBack: () => void
  onNext: () => void
  setNextDisabled: (b: boolean) => void
  setFault: (b: boolean) => void
  resources: ResourceSnapshot | null
  resourceError: string | null
  refreshResources: () => Promise<void>
}

// ── Step 0: flow router ─────────────────────────────────────────────────────────
const WELCOME_FEATURES: { icon: 'database' | 'cpu' | 'hub'; title: string; detail: string }[] = [
  { icon: 'database', title: 'Local stack', detail: 'Postgres · FalkorDB' },
  { icon: 'cpu', title: 'Embeddings', detail: 'Local model or API' },
  { icon: 'hub', title: 'Stream MCP', detail: 'One agent endpoint' },
]

function FlowRouter({ onPick }: { onPick: (f: Flow, personalMemoryEnabled: boolean) => void }) {
  // Prototype w-welcome: one committed action, the stack named in three cards, the lattice behind.
  return (
    <section className="welcome-step">
      <div className="welcome-hero">
        <span className="eyebrow accent">Welcome to Persistent Memory</span>
        <h2>Memory that outlives the session.</h2>
        <p className="lede">Persistent Memory gives Claude and Codex a durable local memory system for project context, decisions, fixes, and long-running work.</p>
        <p className="lede welcome-copy">Install your private memory stack, dashboard, and Claude/Codex integration on this computer.</p>
        <div className="welcome-features">
          {WELCOME_FEATURES.map((feature) => (
            <div key={feature.title} className="welcome-feature">
              <Icon name={feature.icon} size={18} />
              <b>{feature.title}</b>
              <span>{feature.detail}</span>
            </div>
          ))}
        </div>
        <div className="btn-row welcome-actions">
          <button type="button" className="btn primary lg" onClick={() => onPick('full', true)}>Get started <Icon name="arrow_right" size={16} /></button>
          <span className="note">About 5–10 minutes · runs on this computer</span>
        </div>
      </div>
      <div className="welcome-art"><Lattice width={360} height={220} /></div>
    </section>
  )
}

// ── Prereqs (flow-aware) ──────────────────────────────────────────────────────────
interface PrereqResult {
  platform?: string
  automaticInstallSupported?: boolean
  automaticInstallComponents?: Partial<Record<PrereqKey, boolean>>
  manualHints?: Partial<Record<PrereqKey, string>> | null
  homebrew?: {
    ok: boolean
    detail: string
    installed?: boolean
    path?: string | null
    manualInstall?: {
      installCommand: string
      pathCommand: string
      activateCommand: string
      brewPath: string
    } | null
  }
  docker: { ok: boolean; detail: string; installed?: boolean; running?: boolean }
  compose: { ok: boolean; detail: string }
  node: { ok: boolean; detail: string }
  ollama: { ok: boolean; detail: string; installed?: boolean; running?: boolean }
  models: string[]
  recommendedModelPresent: boolean
}

type PrereqKey = 'node' | 'docker' | 'compose' | 'ollama'
type PrecheckStatus = 'pending' | 'verifying' | 'installing' | 'ok' | 'warn'

const PREREQ_ITEMS: { key: PrereqKey; label: string }[] = [
  { key: 'node', label: 'Node 24 LTS / 22.12+ (22.x)' },
  { key: 'docker', label: 'Docker daemon' },
  { key: 'compose', label: 'Docker Compose v2' },
  { key: 'ollama', label: 'Ollama (host)' },
]

function PrereqCard({
  status,
  label,
  detail,
  action,
  onInstall,
}: {
  status: PrecheckStatus
  label: string
  detail?: string
  action?: string
  onInstall?: () => void
}) {
  const icon = status === 'ok' ? <Icon name="check" size={12} /> : status === 'warn' ? '!' : ''
  return (
    <div className={`precheck-card ${status}`}>
      <span className={`precheck-icon ${status}`} aria-hidden>{icon}</span>
      <span className="precheck-label">{label}</span>
      <span className="precheck-detail">{detail}</span>
      {status === 'warn' && action && onInstall ? (
        <button type="button" className="btn sm accent-quiet precheck-action" onClick={onInstall}>{action}</button>
      ) : <span />}
    </div>
  )
}

function CommandBlock({ command }: { command: string }) {
  return (
    <pre className="manual-command"><code>{command}</code></pre>
  )
}

function HomebrewManualCard({ detail, manual }: { detail: string; manual?: NonNullable<PrereqResult['homebrew']>['manualInstall'] }) {
  return (
    <div className="prereq-card homebrew-manual">
      <StatusRow ok={false} label="Homebrew" detail={detail} />
      {manual ? (
        <div className="manual-body">
          <p>Homebrew needs macOS Administrator approval. Run these in Terminal, then return to this step.</p>
          <CommandBlock command={manual.installCommand} />
          <CommandBlock command={manual.pathCommand} />
          <CommandBlock command={manual.activateCommand} />
        </div>
      ) : null}
    </div>
  )
}

function prereqProbe(p: PrereqResult, key: PrereqKey): { ok: boolean; detail: string; installed?: boolean } {
  if (key === 'node') return p.node
  if (key === 'docker') return p.docker
  if (key === 'compose') return p.compose
  return p.ollama
}

function prereqAction(p: PrereqResult, key: PrereqKey): string | undefined {
  if (p.automaticInstallComponents ? !p.automaticInstallComponents[key] : p.automaticInstallSupported === false) return undefined
  const brewMissing = !!(p.homebrew && !p.homebrew.ok)
  if (key === 'node') return p.node.ok || brewMissing ? undefined : 'Install'
  if (key === 'docker') return p.docker.ok ? undefined : p.docker.installed ? 'Start' : brewMissing ? undefined : 'Install'
  if (key === 'compose') return p.compose.ok || brewMissing ? undefined : 'Install / Repair'
  if (key === 'ollama') return p.ollama.ok ? undefined : p.ollama.installed ? 'Start' : brewMissing ? undefined : 'Install'
  return undefined
}

function Prereqs({ flow, answers, setNextDisabled, setFault, resources, resourceError, refreshResources }: StepProps) {
  const [p, setP] = useState<PrereqResult | null>(null)
  const [completedChecks, setCompletedChecks] = useState(0)
  const [installing, setInstalling] = useState<PrereqKey | null>(null)
  const [progress, setProgress] = useState<PrereqProgressState | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [restartRequired, setRestartRequired] = useState(false)
  const check = async () => {
    setP(null)
    setCompletedChecks(0)
    setError(null)
    try {
      const [result] = await Promise.all([getJSON<PrereqResult>('/api/prereqs'), refreshResources()])
      setP(result)
      if (result.node.ok) setRestartRequired(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  useEffect(() => { void check() }, [])
  useEffect(() => {
    if (!p) return
    setCompletedChecks(0)
    const timers = PREREQ_ITEMS.map((_, idx) => window.setTimeout(() => setCompletedChecks(idx + 1), 160 + (idx * 180)))
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [p])
  const baseline = resources ? evaluateResources(resources, { provider: 'openai', model: 'text-embedding-3-small' }) : null
  const localEnabled = resources ? recommendResources(resources).localEnabled : false
  const blocked = prereqsBlocked(flow, p, { personalMemoryEnabled: answers.personalMemoryEnabled }) || !baseline?.allowed
  const brewMissing = !!(p?.homebrew && !p.homebrew.ok)
  useEffect(() => { setNextDisabled(!p || completedChecks < PREREQ_ITEMS.length || blocked) }, [p, completedChecks, blocked])
  const scanned = !!p && completedChecks >= PREREQ_ITEMS.length
  const failedRequired = p ? PREREQ_ITEMS.filter(item => item.key !== 'ollama' && !prereqProbe(p, item.key).ok).length : 0
  const showFault = !installing && ((!restartRequired && blocked && scanned) || !!error)
  useEffect(() => { setFault(showFault) }, [showFault])
  const install = async (component: PrereqKey) => {
    setInstalling(component); setLog([]); setError(null)
    setProgress({ label: p && prereqAction(p, component) === 'Start' ? 'Starting' : 'Preparing installation' })
    let failed: string | null = null
    let needsRestart = false
    try {
      await streamNDJSON('/api/prereqs/install', { component }, (e) => {
        const update = prereqProgressEvent(e)
        if (update) setProgress(update)
        if (e.type === 'stdout') setLog((l) => [...l.slice(-300), String(e.chunk)])
        if (e.type === 'error' && e.message) failed = String(e.message)
        if (component === 'node' && e.type === 'done' && e.ok === true && e.restartRequired === true) needsRestart = true
      })
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e)
    } finally {
      setInstalling(null)
      setProgress(null)
    }
    if (failed) {
      setError(failed)
      return
    }
    if (needsRestart) {
      setRestartRequired(true)
      return
    }
    await check()
  }
  return (
    <section>
      <h2>Environment pre-check</h2>
      {installing ? (
        <p className="lede">Installing <b>{PREREQ_ITEMS.find(item => item.key === installing)!.label}</b> — this can take a few minutes.</p>
      ) : (
        <p className="lede">Reading this machine for the local personal memory install.</p>
      )}
      {/* Prototype w-prereq-unreachable: when the probe itself fails, that failure leads the page. */}
      {error && !p && !installing ? (
        <Notice tone="fault" className="prereq-error" title="Could not read this machine" role="alert">
          <code>GET /api/prereqs</code> failed: {error} Re-run <code>npm run install-persistent-memory</code> if the installer stopped responding.
        </Notice>
      ) : null}
      <div className="precheck-list">
        {PREREQ_ITEMS.map((item, idx) => {
          const isInstalling = installing === item.key
          if (isInstalling) {
            return <PrereqCard key={item.key} status="installing" label={item.label} detail={progress?.label ?? 'Working…'} />
          }
          if (!p) {
            if (error) return <PrereqCard key={item.key} status="pending" label={item.label} detail="Not checked." />
            return <PrereqCard key={item.key} status={idx === 0 ? 'verifying' : 'pending'} label={item.label} detail={idx === 0 ? 'verifying...' : 'pending...'} />
          }
          if (completedChecks <= idx) {
            return <PrereqCard key={item.key} status={completedChecks === idx ? 'verifying' : 'pending'} label={item.label} detail={completedChecks === idx ? 'verifying...' : 'pending...'} />
          }
          const probe = prereqProbe(p, item.key)
          if (item.key === 'ollama' && (answers.embedProvider !== 'ollama' || !localEnabled)) {
            return <PrereqCard key={item.key} status="ok" label="Ollama (optional)" detail={localEnabled ? 'Not needed for API embeddings. Choose a provider in the Embeddings step.' : 'Local embeddings unavailable with these resources. Use API embeddings.'} />
          }
          const detail = !probe.ok && p.manualHints?.[item.key]
            ? `${probe.detail} ${p.manualHints[item.key]}`
            : brewMissing && !probe.ok && item.key !== 'node'
            ? `${probe.detail} Install Homebrew first.`
            : probe.detail
          if (item.key === 'ollama') return <PrereqCard key={item.key} status={probe.ok ? 'ok' : 'warn'} label={item.label} detail={probe.ok ? detail : `${detail} Install or start it in the Embeddings step after reviewing the model’s resource requirements.`} />
          return (
            <PrereqCard
              key={item.key}
              status={probe.ok ? 'ok' : 'warn'}
              label={item.label}
              detail={detail}
              action={item.key === 'node' && restartRequired ? undefined : prereqAction(p, item.key)}
              onInstall={installing ? undefined : () => void install(item.key)}
            />
          )
        })}
      </div>
      {/* Prototype w-prereq-scan: probes resolve one at a time so the machine is visibly being read. */}
      {!installing && !error && (!p || completedChecks < PREREQ_ITEMS.length) ? (
        <div className="precheck-scan">
          <ProgressBar indeterminate />
          <p className="note precheck-scan-note">
            Probing {Math.min(completedChecks + 1, PREREQ_ITEMS.length)} of {PREREQ_ITEMS.length} · nothing is installed or changed during a pre-check.
          </p>
        </div>
      ) : null}
      {resources && baseline ? <ResourceSummary snapshot={resources} assessment={baseline} /> : <Notice tone="warn">{resourceError ?? 'Measuring RAM and disk space…'}</Notice>}
      <p className="field-hint">The baseline assumes API keys for both embeddings and fact extraction. Ollama adds model-specific requirements in the Embeddings step.</p>
      {installing && progress ? (
        <PrereqProgress progress={progress} component={PREREQ_ITEMS.find(item => item.key === installing)!.label} />
      ) : null}
      {brewMissing && p?.homebrew?.manualInstall ? (
        <HomebrewManualCard detail={p.homebrew.detail} manual={p.homebrew.manualInstall} />
      ) : null}
      {restartRequired && !installing ? (
        <Notice tone="warn" title="Restart the installer">
          Node 24 is installed. This wizard is still using the previous Node process. Stop it with Ctrl+C in its terminal, open a terminal where <code>node -v</code> reports v24.x, then run <code>npm run install-persistent-memory</code> again.
        </Notice>
      ) : null}
      {/* A resource-only blocker is already explained by the resource summary above. */}
      {!installing && ((!restartRequired && blocked && scanned && failedRequired > 0) || (error && p)) ? (
        <Notice
          tone="fault"
          className="prereq-error"
          title={error ? 'A repair did not finish' : `${failedRequired} required check${failedRequired === 1 ? '' : 's'} failed`}
          role="alert"
        >
          {error ?? 'Use the matching install or start action next to each row, or follow its instructions, then check again. Nothing is installed until you press one of those buttons.'}
          {!error && p && !p.ollama.ok ? <p className="note">Ollama is optional: without it you can still install using an API embedding provider.</p> : null}
        </Notice>
      ) : null}
      {scanned && !blocked && !error && !installing && !restartRequired ? (
        <Notice tone="ok" title="Ready to configure">
          Node, Docker and Compose are satisfied{p && p.ollama.ok ? ', and Ollama is present, so a local embedding model stays available' : ''}. Choose embeddings and extraction in the next steps.
        </Notice>
      ) : null}
      {(p || error) && !installing ? (
        <div className="btn-row">
          <button type="button" className="btn secondary" onClick={() => void check()}><Icon name="refresh" size={15} /> Check again</button>
        </div>
      ) : null}
      {log.length > 0 && <div className="prereq-log"><div className="terminal-head"><Icon name="terminal" size={13} /> installer output</div><Terminal lines={log} /></div>}
    </section>
  )
}

// ── Account — full flow collects identity; client personal flow uses the server token identity.
function Account({ answers, set, setNextDisabled, setFault, flow, remoteIdentity, serverPin }: StepProps) {
  const [confirm, setConfirm] = useState('')
  const [generated, setGenerated] = useState<string | null>(null)
  const clientPersonal = flow !== 'full'
  const serverUsesSso = clientPersonal && serverPin?.dashboardLoginMode === 'sso'
  const remoteEmail = remoteIdentity?.userEmail?.trim() ?? ''
  const remoteTeam = remoteIdentity?.teamName?.trim() ?? ''
  const email = clientPersonal ? remoteEmail : answers.userEmail.trim()
  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
  const pw = answers.userPassword
  const strength = pw ? assessPasswordStrength(pw) : null
  const passwordRequired = flow !== 'full' && !serverUsesSso
  const pwMissing = passwordRequired && pw.length === 0
  const pwMismatch = passwordRequired ? pw !== confirm : pw.length > 0 && pw !== confirm
  const weakPassword = pw.length > 0 && strength ? !strength.accepted : false
  const derived = email.includes('@') ? email.split('@')[0] : ''
  // Prototype w-account-errors: each error sits under its own field and a summary counts them.
  const emailInvalid = email.length > 0 && !emailValid
  const showMismatch = pwMismatch && pw.length > 0 && confirm.length > 0
  const invalidCount = [emailInvalid, pwMissing, weakPassword, showMismatch].filter(Boolean).length
  const createPassword = () => {
    const next = generateStrongPassword()
    set('userPassword', next)
    setConfirm(next)
    setGenerated(next)
  }
  useEffect(() => {
    if (!serverUsesSso) return
    set('userPassword', '')
    setConfirm('')
    setGenerated(null)
  }, [serverUsesSso])
  useEffect(() => {
    if (!clientPersonal || !remoteIdentity) return
    const nextName = remoteIdentity.userDisplayName?.trim() || derived
    set('teamName', remoteTeam)
    set('userEmail', remoteEmail)
    set('userName', nextName)
  }, [clientPersonal, remoteIdentity?.teamName, remoteIdentity?.userEmail, remoteIdentity?.userDisplayName])
  // The local seed still carries an internal default team, but the wizard only asks
  // for the user's account details. Only email + a matching password gate Next.
  const blocked = clientPersonal
    ? !remoteIdentity || !emailValid || pwMissing || pwMismatch || weakPassword
    : !emailValid || pwMismatch || weakPassword
  useEffect(() => { setNextDisabled(blocked) }, [blocked])
  useEffect(() => { setFault(invalidCount > 0 || (clientPersonal && !remoteIdentity)) }, [invalidCount, clientPersonal, remoteIdentity])
  return (
    <section>
      <h2>Your account</h2>
      {clientPersonal ? (
        <p className="lede">Server accepted the token. Your email is copied from the server account; choose your local dashboard alias and optional password.</p>
      ) : (
        <p className="lede">Create the local dashboard identity shown in Personal Memories. You can change profile details later.</p>
      )}
      {!remoteIdentity && clientPersonal ? <Notice tone="fault">Connect to the server first. This step uses the token identity from <code>/whoami</code>.</Notice> : null}
      {clientPersonal ? (
        <Field label="Your email" hint="Read-only: provided by the server token." error={emailInvalid ? 'Enter a valid email address.' : null}>
          <input readOnly type="email" className={emailInvalid ? 'invalid' : undefined} value={remoteIdentity?.userEmail ?? ''} placeholder="Server user has no email" />
        </Field>
      ) : (
        <Field label="Your email" hint="Identifies you in the dashboard." error={emailInvalid ? 'Enter a valid email address.' : null}>
          <input type="email" className={emailInvalid ? 'invalid' : undefined} value={answers.userEmail} onChange={(e) => set('userEmail', e.target.value)} placeholder="you@company.com" />
        </Field>
      )}
      <Field
        label={clientPersonal ? 'Display name / alias' : <>Display name <span className="note">(optional)</span></>}
        hint={derived ? `Blank → derived from your email: “${derived}”.` : 'Blank → derived from your email.'}
      >
        <input value={answers.userName} onChange={(e) => set('userName', e.target.value)} placeholder={derived || 'Your name'} />
      </Field>
      <div className="seg-group">
        <span className="seg-label">{serverUsesSso ? 'Dashboard password' : passwordRequired ? 'Dashboard password' : 'Dashboard password (optional)'} <span className="seg-hint">{serverUsesSso ? '· SSO' : passwordRequired ? '· required' : ''}</span></span>
        {serverUsesSso ? (
          <Notice tone="ok">
            This server uses SSO for dashboard login. The wizard will keep using your token for MCP registration;
            use your work email to sign in to the dashboard.
          </Notice>
        ) : (
          <>
            <Field
              label="Password"
              error={pwMissing ? 'Enter a dashboard password for password-mode servers.' : weakPassword ? (strength?.messages[0] ?? 'Use a stronger password before continuing.') : null}
              hint={strength?.accepted ? 'Strong password.' : undefined}
              hintTone={strength?.accepted ? 'ok' : undefined}
            >
              <div className="input-affix">
                <input
                  type="password"
                  className={pwMissing || weakPassword ? 'invalid' : undefined}
                  value={answers.userPassword}
                  onChange={(e) => { set('userPassword', e.target.value); setGenerated(null) }}
                  placeholder={passwordRequired ? 'required for dashboard login' : 'leave blank for no login'}
                />
                {generated ? <span className="affix">GENERATED</span> : null}
              </div>
              {strength ? <div className={`meter ${strength.level}`} aria-hidden="true"><i /><i /><i /></div> : null}
            </Field>
            {passwordRequired || pw.length > 0 ? (
              <Field label="Confirm password" error={showMismatch ? 'Passwords do not match.' : null}>
                <input type="password" className={showMismatch ? 'invalid' : undefined} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </Field>
            ) : null}
            {generated ? <Notice tone="warn">Generated password shown once: <code>{generated}</code></Notice> : null}
            <div className="btn-row">
              <button type="button" className="btn sm secondary" onClick={createPassword}><Icon name="key" size={13} /> Generate password</button>
            </div>
            <span className="field-hint">{passwordRequired
              ? 'Required for dashboard login. This protects the dashboard session; the token remains for MCP/API recovery.'
              : 'Set one to require login when opening the dashboard; leave blank and it opens directly. You can add or remove it later in your profile.'}</span>
          </>
        )}
      </div>
      {invalidCount > 0 ? (
        <Notice tone="bad">
          Fix the {invalidCount} highlighted field{invalidCount === 1 ? '' : 's'} to continue. Nothing has been written to <code>.env.persistent-memory</code> yet.
        </Notice>
      ) : null}
    </section>
  )
}

function PullModel({ serverPin, setNextDisabled }: StepProps) {
  const model = serverPin?.model ?? ''
  const [pulled, setPulled] = useState<boolean | null>(null)
  const [pulling, setPulling] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const check = () => getJSON<{ models: string[] }>('/api/prereqs').then((r) => setPulled(r.models.some((m) => m === model || m.startsWith(model)))).catch(() => setPulled(null))
  useEffect(() => { void check() }, [])
  useEffect(() => { setNextDisabled(!pulled) }, [pulled])
  const pull = async () => {
    setPulling(true)
    setError(null)
    try {
      await streamNDJSON('/api/ollama/pull', { model }, (e) => { if (e.type === 'stdout') setLog((l) => [...l.slice(-200), String(e.chunk)]) })
      await check()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPulling(false)
    }
  }
  return (
    <section>
      <h2>Local embedding model</h2>
      <p>The shared server requires <code>{model}</code> for client-managed embeddings. This local dashboard must run the <em>exact same</em> model before connecting.</p>
      <StatusRow ok={pulled} label={model} detail={pulled ? 'pulled' : pulling ? 'pulling…' : 'not pulled'} />
      {!pulled && <div className="btn-row"><button type="button" className="btn secondary" disabled={pulling} onClick={() => void pull()}>{pulling ? 'Pulling…' : `Pull ${model}`}</button></div>}
      {error && <Notice tone="fault" role="alert">{error}</Notice>}
      {log.length > 0 && <Terminal lines={log} />}
    </section>
  )
}

// ── Extraction LLM (full flow) ────────────────────────────────────────────────────
function Extraction({ answers, set, setNextDisabled, setFault }: StepProps) {
  // Detect saved provider keys so the user can keep them without re-pasting.
  // Generated service secrets are preserved by the server when configuration is saved.
  const [onFile, setOnFile] = useState<{ anthropic: boolean; openai: boolean }>({ anthropic: false, openai: false })
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [testResult, setTestResult] = useState<ExtractionTestResult | null>(null)
  const [testedSignature, setTestedSignature] = useState<string | null>(null)
  useEffect(() => {
    void getJSON<{ anthropicKeyPresent: boolean; openaiKeyPresent: boolean }>('/api/env/existing')
      .then((r) => setOnFile({ anthropic: r.anthropicKeyPresent, openai: r.openaiKeyPresent }))
      .catch(() => {})
  }, [])
  const isAnthropic = answers.extractionProvider === 'anthropic'
  const typedKey = isAnthropic ? answers.anthropicApiKey : answers.openaiApiKey
  const keyOnFile = isAnthropic ? onFile.anthropic : onFile.openai
  // Satisfied if the user typed a key OR one is already in the .env (kept on install).
  const needsKey = !typedKey?.trim() && !keyOnFile
  const testSignature = `${answers.extractionProvider}\n${answers.extractionModel}\n${typedKey?.trim() || (keyOnFile ? '__existing_key__' : '')}`
  const extractionTestPassed = testState === 'ok' && testedSignature === testSignature
  useEffect(() => {
    setNextDisabled(extractionNextBlocked({ apiKeyAvailable: !needsKey, testPassed: extractionTestPassed }))
  }, [needsKey, extractionTestPassed])
  useEffect(() => { setFault(testState === 'error') }, [testState])
  useEffect(() => {
    if (testedSignature && testedSignature !== testSignature) {
      setTestState('idle')
      setTestResult(null)
      setTestedSignature(null)
    }
  }, [testSignature, testedSignature])
  const testFactExtraction = async () => {
    setTestState('testing')
    setTestResult(null)
    setTestedSignature(null)
    try {
      const result = await postJSON<ExtractionTestResult>('/api/extraction/test', {
        provider: answers.extractionProvider,
        model: answers.extractionModel,
        apiKey: typedKey?.trim() || '',
      })
      setTestResult(result)
      setTestState(result.ok ? 'ok' : 'error')
      if (result.ok) setTestedSignature(testSignature)
    } catch (e) {
      setTestResult({ ok: false, message: 'Fact extraction test failed.', details: e instanceof Error ? e.message : String(e) })
      setTestState('error')
    }
  }
  const models = answers.extractionProvider === 'anthropic'
    ? [{ id: 'claude-haiku-4-5-20251001', note: 'cheaper + faster', rec: true }, { id: 'claude-sonnet-4-6', note: 'higher quality — needs a key', rec: false }]
    : [{ id: 'gpt-4o', note: 'recommended', rec: true }, { id: 'gpt-5.4', note: 'higher quality', rec: false }]
  return (
    <section>
      <h2>Extraction LLM</h2>
      <p className="lede">Powers the Shape gate and the graph entity/edge extraction that turns raw memories into a connected graph.</p>
      <div className="seg-group">
        <span className="seg-label">Provider</span>
        <div className="seg-row">
          <button type="button" className={`seg${answers.extractionProvider === 'anthropic' ? ' active' : ''}`} onClick={() => { set('extractionProvider', 'anthropic'); set('extractionModel', 'claude-haiku-4-5-20251001') }}>
            Anthropic <span className="seg-note">· recommended</span>
          </button>
          <button type="button" className={`seg${answers.extractionProvider === 'openai' ? ' active' : ''}`} onClick={() => { set('extractionProvider', 'openai'); set('extractionModel', 'gpt-4o') }}>
            OpenAI
          </button>
        </div>
      </div>
      <div className="seg-group">
        <span className="seg-label">Model <span className="seg-hint">{isAnthropic ? '· Haiku is the default (cheaper + faster)' : '· GPT-4o is the default'}</span></span>
        <div className="modellist">
          {models.map((m) => {
            const on = answers.extractionModel === m.id
            return (
              <button type="button" key={m.id} className={`modelrow${on ? ' active' : ''}`} onClick={() => set('extractionModel', m.id)}>
                <span className="modelradio" aria-hidden />
                <span className="modelrow-main">
                  <span className="modelrow-name">{m.id}</span> <span className="modelrow-note inline">· {m.note}</span>
                </span>
                {m.rec ? <span className="modelrow-rec">recommended</span> : null}
              </button>
            )
          })}
        </div>
      </div>
      {isAnthropic ? (
        <Field label="ANTHROPIC_API_KEY (mandatory)" hint={<>Stored only in the local <code>.env.persistent-memory</code>; masked in the review step.</>}>
          <input type="password" className={testState === 'error' ? 'invalid' : keyOnFile && !typedKey?.trim() ? 'readonly' : undefined} value={answers.anthropicApiKey} onChange={(e) => set('anthropicApiKey', e.target.value)} placeholder={keyOnFile ? '•••• existing key — leave blank to keep' : 'sk-…'} />
        </Field>
      ) : (
        <Field label="OPENAI_API_KEY (mandatory)" hint={<>Stored only in the local <code>.env.persistent-memory</code>; masked in the review step.</>}>
          <input type="password" className={testState === 'error' ? 'invalid' : keyOnFile && !typedKey?.trim() ? 'readonly' : undefined} value={answers.openaiApiKey} onChange={(e) => set('openaiApiKey', e.target.value)} placeholder={keyOnFile ? '•••• existing key — leave blank to keep' : 'sk-…'} />
        </Field>
      )}
      {keyOnFile && testState !== 'error' ? <Notice tone="ok">An existing <code>{isAnthropic ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}</code> was found in your <code>.env.persistent-memory</code> — leave the field blank to keep it, or enter a new one to replace it.</Notice> : null}
      {needsKey ? <Notice tone="warn">An API key is required to continue.</Notice> : null}
      <div className="btn-row">
        <button type="button" className={`btn${needsKey ? '' : ' secondary'}`} onClick={() => void testFactExtraction()} disabled={needsKey || testState === 'testing'}>
          <Icon name={testState === 'error' ? 'refresh' : 'bolt'} size={15} /> {testState === 'testing' ? 'Testing…' : testState === 'error' ? 'Test again' : 'Test fact extraction'}
        </button>
        {testState === 'idle' ? <span className="note">Runs one small extraction against your key.</span> : null}
      </div>
      {testState === 'ok' ? <Notice tone="ok" title="Fact extraction test passed">{testResult?.message}</Notice> : null}
      {testState === 'error' ? (
        <Notice tone="fault" title="Fact extraction test failed" role="alert">
          {testResult?.message ?? 'The provider did not return a result.'}
          {testResult?.details ? <p className="note">{testResult.details}</p> : null}
          <p className="note">The key was not saved. Check it was copied whole, has not been revoked, and that the selected model is enabled for your organisation.</p>
        </Notice>
      ) : null}
      {testState === 'idle' || testState === 'testing' ? (
        <Notice>Service secrets and database passwords are generated for you. Existing values in <code>.env.persistent-memory</code> are <b>preserved</b> so saved passwords, tokens, and data connections keep working. Only missing secrets are generated.</Notice>
      ) : null}
    </section>
  )
}

// ── Ecosystem (detected agent apps) ───────────────────────────────────────────────
interface AppDetect { claudeCli: boolean; claudeDesktop: boolean; codexCli: boolean; codexDesktop: boolean }
function Ecosystem({ apps, setApps, setNextDisabled, setFault, appsInited }: StepProps) {
  const [det, setDet] = useState<AppDetect | null>(null)
  const noneDetected: AppDetect = { claudeCli: false, claudeDesktop: false, codexCli: false, codexDesktop: false }
  useEffect(() => {
    void getJSON<AppDetect>('/api/apps').then((d) => {
      setDet(d)
      // Apply the detected defaults only ONCE — preserve the user's selection if they
      // navigate back to this step and forward again.
      if (!appsInited?.current) {
        setApps({ claudeCli: d.claudeCli, claudeDesktop: d.claudeDesktop, codexCli: d.codexCli, codexDesktop: d.codexDesktop })
        if (appsInited) appsInited.current = true
      }
    }).catch(() => setDet(noneDetected))
  }, [])
  const any = Object.values(apps).some(Boolean)
  // Prototype w-ecosystem-none: after installing an agent app, detection can run again.
  const detectAgain = () => {
    setDet(null)
    void getJSON<AppDetect>('/api/apps').then((d) => {
      setDet(d)
      if (!any) setApps({ claudeCli: d.claudeCli, claudeDesktop: d.claudeDesktop, codexCli: d.codexCli, codexDesktop: d.codexDesktop })
    }).catch(() => setDet(noneDetected))
  }
  const rows: { key: keyof Apps; label: string; present: boolean }[] = det ? [
    { key: 'claudeCli', label: 'Claude CLI', present: det.claudeCli },
    { key: 'claudeDesktop', label: 'Claude Desktop', present: det.claudeDesktop },
    { key: 'codexCli', label: 'Codex CLI', present: det.codexCli },
    { key: 'codexDesktop', label: 'Codex Desktop', present: det.codexDesktop },
  ] : []
  useEffect(() => { setNextDisabled(!any) }, [any])
  useEffect(() => { setFault(!!det && !any) }, [det, any])
  return (
    <section>
      <h2>Register the MCP with…</h2>
      <p className="lede">Select the agent apps you use. Detected apps are selected by default; you can also select an app installed in a custom location.</p>
      {!det ? <p className="note">Detecting installed apps…</p> : (
        <div className="checklist">
          {rows.map((r) => {
            const checked = apps[r.key]
            const tag = !r.present ? 'not detected' : ''
            return (
              <label key={r.key} className={`checkrow${checked ? ' checked' : ''}`}>
                <input type="checkbox" checked={checked} onChange={(e) => setApps({ ...apps, [r.key]: e.target.checked })} />
                <span className="checkbox" aria-hidden>{checked ? <Icon name="check" size={11} /> : ''}</span>
                <span className="checkrow-label">{r.label}</span>
                {tag ? <span className="checkrow-tag">{tag}</span> : null}
              </label>
            )
          })}
        </div>
      )}
      {det && !any ? (
        <>
          <Notice tone="fault" title="No agent app selected">
            {det && !Object.values(det).some(Boolean) ? 'No Claude or Codex installation was found in the default locations. ' : ''}
            Select at least one target, or install an agent app and detect again. Next stays unavailable until one is selected.
          </Notice>
          <div className="btn-row">
            <button type="button" className="btn secondary" onClick={detectAgain}><Icon name="refresh" size={15} /> Detect again</button>
          </div>
        </>
      ) : det ? (
        <Notice tone="accent">Your other MCP servers are left untouched. Re-running the installer only updates this one entry.</Notice>
      ) : null}
    </section>
  )
}

// ── Registration: runtime architecture + scope, driven by the apps picked in Ecosystem ──────
function Registration({ answers, set, apps, setNextDisabled, setFault, flow }: StepProps) {
  const streamAvailable = true
  useEffect(() => { if (answers.mcpRuntime !== 'stream') set('mcpRuntime', 'stream') }, [answers.mcpRuntime])
  const codex = apps.codexCli || apps.codexDesktop
  const codexLabel = codexSelectionLabel(apps)
  const isProject = answers.regLevel === 'project'
  const nonEmptyPaths = answers.projectPaths.filter((p) => p.trim())
  const addPath = () => set('projectPaths', [...answers.projectPaths, ''])
  const setPath = (i: number, v: string) => set('projectPaths', answers.projectPaths.map((p, j) => (j === i ? v : p)))
  const delPath = (i: number) => set('projectPaths', answers.projectPaths.filter((_, j) => j !== i))
  // Picking Project Level seeds one empty folder row so the picker is obviously present.
  const chooseProject = () => { set('regLevel', 'project'); if (answers.projectPaths.length === 0) set('projectPaths', ['']) }
  // Native folder picker (host-only): open the OS dialog and drop the chosen path into row i.
  const [pickNote, setPickNote] = useState<string | null>(null)
  const pickFolder = async (i: number) => {
    setPickNote(null)
    try {
      const r = await postJSON<{ path?: string; canceled?: boolean; unsupported?: boolean }>('/api/choose-folder', {})
      if (r.path) setPath(i, r.path)
      else if (r.unsupported) setPickNote('The system folder picker is unavailable — type or paste the absolute path here.')
    } catch { setPickNote('Could not open the folder picker — type or paste the absolute path here.') }
  }
  // Project scope needs ≥1 folder (Claude + Codex both write per-folder configs).
  const blocked = isProject && nonEmptyPaths.length === 0
  useEffect(() => { setNextDisabled(blocked) }, [blocked])
  useEffect(() => { setFault(!!pickNote || blocked) }, [pickNote, blocked])

  return (
    <section>
      <h2>Registration</h2>
      <p className="lede">persistent-memory is added to the MCP config of the apps you picked. Your other MCP servers are left
        untouched, and re-running the installer just updates this one entry. Windows files inherit their
        folder permissions; macOS files are created with owner read/write permissions.</p>
      <div className="seg-group">
        <span className="seg-label">MCP runtime</span>
        <div className="seg-row">
          <button type="button" className="seg active" disabled={!streamAvailable} onClick={() => set('mcpRuntime', 'stream')}><Icon name="hub" size={15} /> Stream MCP service</button>
        </div>
        <span className="field-hint"><b>Stream MCP service</b> registers Claude/Codex against one local Docker-managed Streamable HTTP MCP service.</span>
      </div>
      <div className="seg-group">
        <span className="seg-label">Scope</span>
        <div className="seg-row">
          <button type="button" className={`seg${answers.regLevel === 'global' ? ' active' : ''}`} onClick={() => set('regLevel', 'global')}>Global Level <span className="seg-badge">recommended</span></button>
          <button type="button" className={`seg${isProject ? ' active' : ''}`} onClick={chooseProject}>Project Level</button>
        </div>
        <span className="field-hint"><b>Global Level</b> registers it once for your user (available everywhere).
          <b> Project Level</b> scopes it to specific folders — visible only when you work in those folders. The
          installer writes the right config for each app you picked automatically (below).</span>
      </div>
      {isProject && (
        <div className="seg-group folders">
          <span className="seg-label">Project folders <span className="seg-hint">· pick via the system dialog, or paste an absolute path</span></span>
          {answers.projectPaths.map((p, i) => (
            <div key={i} className="folder-row">
              <input className={`mono${!p.trim() ? ' invalid' : ''}`} value={p} aria-label={`Project folder ${i + 1}`} placeholder="C:\Projects\My Project or /path/to/project" onChange={(e) => setPath(i, e.target.value)} />
              <button type="button" className="btn sm secondary" onClick={() => void pickFolder(i)}><Icon name="folder" size={14} /> Choose…</button>
              <button type="button" className="icon-btn danger" aria-label="Remove folder" onClick={() => delPath(i)}><Icon name="close" size={15} /></button>
            </div>
          ))}
          <button type="button" className="btn ghost sm" onClick={addPath}><Icon name="plus" size={14} /> Add folder</button>
          {pickNote && <Notice tone="bad">{pickNote} Empty rows are ignored, and Project Level needs at least one real folder.</Notice>}
        </div>
      )}
      {isProject && codex ? (
        <Notice tone="warn">Codex writes <code>&lt;folder&gt;/.codex/config.toml</code> per folder — you must <b>trust the folder</b> in Codex for it to load.</Notice>
      ) : null}
      {/* Prototype w-registration: the files that change are named, not described. */}
      <div className="wiz-card-box">
        <span className="section-label">What gets registered</span>
        <div className="kv">
          {(apps.claudeCli || apps.claudeDesktop) && (
            <div className="kv-row">
              <span>Claude</span>
              <span>{isProject
                ? <><code>~/.claude.json</code> per folder (<code>projects.&lt;path&gt;</code>) · Code and Desktop folder sessions</>
                : <><code>~/.claude.json</code> · Code and Desktop folder sessions. Standalone Desktop chat uses a Claude Custom Connector for the HTTP endpoint.</>}</span>
            </div>
          )}
          {codex && (
            <div className="kv-row">
              <span>{codexLabel}</span>
              <span>{isProject
                ? <><code>&lt;folder&gt;/.codex/config.toml</code> per folder</>
                : <code>~/.codex/config.toml</code>}</span>
            </div>
          )}
          <div className="kv-row"><span>Endpoint</span><code>http://127.0.0.1:8091/mcp</code></div>
        </div>
        <p className="note">These are the default locations. On Windows, <code>~</code> means your user profile folder.
          Configured <code>CODEX_HOME</code> and <code>CLAUDE_CONFIG_DIR</code> locations take precedence for global files.</p>
      </div>
      <Notice>Stream MCP entries carry only the HTTP endpoint. Connector tokens are managed by the local dashboard.</Notice>
    </section>
  )
}

function codexSelectionLabel(apps: Apps): string {
  if (apps.codexCli && apps.codexDesktop) return 'Codex CLI + Desktop'
  if (apps.codexDesktop) return 'Codex Desktop'
  return 'Codex CLI'
}

// ── Memory rule review/edit ─────────────────────────────────────────────────────
function RuleStep({ answers, set, apps, setNextDisabled }: StepProps) {
  const claude = apps.claudeCli || apps.claudeDesktop
  const codex = apps.codexCli || apps.codexDesktop
  const hasTarget = claude || codex
  useEffect(() => {
    if (answers.ruleText && answers.memoryBlock) return
    void getJSON<{ ruleText: string; memoryBlock: string }>('/api/rule/default').then((r) => {
      if (!answers.ruleText) set('ruleText', r.ruleText)
      if (!answers.memoryBlock) set('memoryBlock', r.memoryBlock)
    }).catch(() => {})
  }, [])
  useEffect(() => { setNextDisabled(hasTarget && (!answers.ruleText.trim() || !answers.memoryBlock.trim())) }, [answers.ruleText, answers.memoryBlock, hasTarget])
  if (!hasTarget) {
    return (
      <section>
        <h2>Memory-usage rule</h2>
        <Notice>Select at least one Claude or Codex target to write the memory guidance.</Notice>
      </section>
    )
  }
  // Where the detailed rule + top memory block land — SCOPE-AWARE. Global → ~/.claude|.codex. Project →
  // <project_path>/.claude|.codex (one line; once folders are picked, <project_path> becomes a
  // highlighted link whose hover-tooltip lists the real per-folder paths).
  const isProject = answers.regLevel === 'project'
  const folders = answers.projectPaths.map((p) => p.trim()).filter(Boolean)
  const ruleSpecs = [
    claude && { global: '~/.claude/rules/persistent-memory.md', tail: '/.claude/rules/persistent-memory.md' },
    codex && { global: '~/.codex/rules/persistent-memory.md', tail: '/.codex/rules/persistent-memory.md' },
  ].filter(Boolean) as { global: string; tail: string }[]
  const memSpecs = [
    claude && { global: '~/.claude/CLAUDE.md', tail: '/CLAUDE.md' },
    codex && { global: '~/.codex/AGENTS.md', tail: '/AGENTS.md' },
  ].filter(Boolean) as { global: string; tail: string }[]
  const memLabel = memSpecs.map((m) => (isProject ? `<project_path>${m.tail}` : m.global)).join(' / ')
  const ruleRefLabel = isProject
    ? 'its matching @.claude/rules or @.codex/rules path'
    : '@rules/persistent-memory.md'
  const projPath = (tail: string) =>
    folders.length === 0
      ? <>{'<project_path>'}{tail}</>
      : (
        <>
          <span className="proj-link" tabIndex={0}>{'<project_path>'}
            <span className="proj-pop" role="tooltip">
              <span className="proj-pop-title">rule file per folder</span>
              {folders.map((p) => <span key={p} className="proj-pop-row">{p.replace(/\/+$/, '') + tail}</span>)}
            </span>
          </span>{tail}
        </>
      )
  return (
    <section>
      <h2>Memory-usage rule</h2>
      <p className="lede">{isProject ? 'Written to ' : 'Default locations: '}{ruleSpecs.map((s, i) => (
        <span key={i}>{i > 0 ? ' + ' : ''}<code>{isProject ? projPath(s.tail) : s.global}</code></span>
      ))}. Edit freely.{isProject && folders.length > 0 ? <span className="field-hint"> Hover <b>&lt;project_path&gt;</b> for the exact file per folder.</span> : null}</p>
      {!isProject && <p className="field-hint">On Windows, <code>~</code> means your user profile folder. Configured <code>CODEX_HOME</code> and <code>CLAUDE_CONFIG_DIR</code> locations also apply to these rule files.</p>}
      <Field label={<>Top memory block <span className="note">— inserted as the first section under {memLabel}</span></>} hint={`Any persistent-memory rule reference in this block is rewritten per target (${ruleRefLabel}).`}>
        <textarea value={answers.memoryBlock} rows={8} onChange={(e) => set('memoryBlock', e.target.value)} />
      </Field>
      <Field label={<>Detailed memory rule prompt <span className="note">— written to persistent-memory.md</span></>}>
        <textarea value={answers.ruleText} rows={14} onChange={(e) => set('ruleText', e.target.value)} />
      </Field>
    </section>
  )
}

// ── Review .env (full flow) ───────────────────────────────────────────────────────
/** The step that supplies a required env key, for the review's "Back to …" actions. */
function issuePhase(key: string, answers: Answers): Phase | null {
  if (/ANTHROPIC|EXTRACTION/.test(key)) return 'extraction'
  if (key === 'OPENAI_API_KEY') return answers.extractionProvider === 'openai' && answers.embedProvider !== 'openai' ? 'extraction' : 'embedding'
  if (/EMBED|VOYAGE|OLLAMA/.test(key)) return 'embedding'
  if (/USER|EMAIL|PASSWORD|TEAM/.test(key)) return 'account'
  return null
}

/** Prototype env preview: keys in accent, values in ink, masked secrets dimmed, missing keys flagged. */
function EnvPreview({ text, issues }: { text: string; issues: Map<string, string> }) {
  const lines = text.replace(/\r/g, '').split('\n')
  return (
    <pre className="terminal">
      {lines.map((line, index) => {
        const eq = line.indexOf('=')
        const key = eq > 0 ? line.slice(0, eq).trim() : ''
        const value = eq > 0 ? line.slice(eq + 1) : ''
        const body = !line.trim() || line.trimStart().startsWith('#')
          ? <span className="t-dim">{line}</span>
          : !key
            ? line
            : issues.has(key)
              ? <span className="t-bad">{key}={value}    ← {issues.get(key)}</span>
              : <><span className="t-key">{key}</span>=<span className={/[•…]/.test(value) ? 't-dim' : 't-val'}>{value}</span></>
        return <span key={index}>{body}{index < lines.length - 1 ? '\n' : ''}</span>
      })}
    </pre>
  )
}

function Review({ flow, answers, serverPin, setNextDisabled, setFault, embeddingTested, onEmbedding, onGoto }: { flow: Flow; answers: Answers; serverPin: ServerPin | null; setNextDisabled: (b: boolean) => void; setFault: (b: boolean) => void; embeddingTested: string; onEmbedding: () => void; onGoto: (p: Phase) => void }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [issues, setIssues] = useState<{ key: string; message: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const needsEmbeddingTest = answers.embedProvider !== 'ollama' && embeddingTested !== embeddingTestSignature(answers)
  useEffect(() => {
    if (needsEmbeddingTest) { setNextDisabled(true); return }
    void (async () => {
      setNextDisabled(true)
      const memorySettings = memorySettingsForFlow(flow, answers, serverPin?.model)
      const embedModel = answers.embedModel
      const embedDim = answers.embedDim
      const envAnswers = {
        embeddingMode: answers.embeddingMode, embedProvider: answers.embedProvider, embedModel, embedDim,
        extractionProvider: answers.extractionProvider, extractionModel: answers.extractionModel,
        anthropicApiKey: answers.anthropicApiKey, openaiApiKey: answers.openaiApiKey, voyageApiKey: answers.voyageApiKey,
        graphBackend: answers.graphBackend, semaphoreLimit: answers.semaphoreLimit,
        // Review runs when a local stack will exist: full-local, or client flows
        // with isolated personal memory. The local stack is always no-auth/local.
        deploymentMode: 'local' as const,
        // P1 account step — seed the named local team + user (+ optional dashboard password).
        teamName: answers.teamName, userEmail: answers.userEmail, userName: answers.userName,
        userPassword: answers.userPassword,
        mcpRuntime: 'stream' as const,
        personalMemoryEnabled: memorySettings.personalMemoryEnabled,
        memoryInstallMode: memorySettings.memoryInstallMode,
        defaultMemorySurface: memorySettings.defaultMemorySurface,
        personalApiUrl: 'http://localhost:8090',
        sharedApiUrl: memorySettings.sharedApiUrl ?? '',
        sharedUserToken: memorySettings.sharedUserToken ?? '',
      }
      try {
        const r = await postJSON<{ preview: string; issues: { key: string; message: string }[] }>('/api/env', { answers: envAnswers })
        setPreview(r.preview); setIssues(r.issues ?? []); setNextDisabled((r.issues ?? []).length > 0)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setNextDisabled(true)
      }
    })()
  }, [answers, flow, serverPin, setNextDisabled, needsEmbeddingTest])
  useEffect(() => { setFault(issues.length > 0 || !!error) }, [issues.length, error])
  // Prototype w-review-missing: each missing key names the step that supplies it.
  const issueMessages = new Map(issues.map((issue) => [issue.key, issue.message] as const))
  const returnPhases = [...new Set(issues.map((issue) => issuePhase(issue.key, answers)))].filter((p): p is Phase => p !== null)
  const keyCount = preview ? preview.split('\n').filter((line) => /^[A-Z0-9_]+=/.test(line.trim())).length : 0
  return (
    <section>
      <h2>Review <code className="review-file">.env.persistent-memory</code></h2>
      <p className="lede">Secrets are masked. Written to <code>.env.persistent-memory</code> (gitignored) when you continue.</p>
      {needsEmbeddingTest ? (
        <Notice tone="warn" title="The embedding test is out of date">
          The embedding model or API key changed after its connection test. Test the final selection before installing.
          <div className="btn-row">
            <button type="button" className="btn secondary" onClick={onEmbedding}><Icon name="arrow_left" size={15} /> Return to embedding connection test</button>
          </div>
        </Notice>
      ) : null}
      {error ? <Notice tone="fault" title="Could not build the preview" role="alert">{error}</Notice> : null}
      {issues.length > 0 ? (
        <Notice tone="fault" title={`${issues.length} required value${issues.length === 1 ? ' is' : 's are'} missing`} role="alert">
          {issues.map((i) => <code key={i.key}>{i.key}</code>)}
          <p className="note">Go back to the matching step to supply {issues.length === 1 ? 'it' : 'them'}{returnPhases.length ? ` — ${returnPhases.map((p) => PHASE_LABEL[p]).join(' and ')}` : ''}. Nothing is written while required values are missing.</p>
        </Notice>
      ) : null}
      {preview ? (
        <div className="terminal-head">
          <Icon name="terminal" size={13} /> preview · {issues.length > 0 ? `${issues.length} problem${issues.length === 1 ? '' : 's'}` : `${keyCount} keys`}
        </div>
      ) : null}
      <div className="review-env-terminal">
        {preview ? <EnvPreview text={preview} issues={issueMessages} /> : needsEmbeddingTest ? null : <p className="note">Generating…</p>}
      </div>
      {preview && issues.length === 0 && !error ? <Notice tone="ok">All required values are present. Secrets stay masked in this preview.</Notice> : null}
      {returnPhases.length > 0 ? (
        <div className="btn-row">
          {returnPhases.map((p) => (
            <button key={p} type="button" className="btn secondary" onClick={() => onGoto(p)}><Icon name="arrow_left" size={15} /> Back to {PHASE_LABEL[p]}</button>
          ))}
        </div>
      ) : null}
    </section>
  )
}

// ── Install (flow-aware body) ─────────────────────────────────────────────────────
function Install({ flow, body, onToken, onDone, onBack, setFault }: { flow: Flow; body: InstallBody; onToken: (t: string) => void; onDone: (summary: InstallSummary) => void; onBack: () => void; setFault: (b: boolean) => void }) {
  const [steps, setSteps] = useState<{ id: string; name: string; state: StepState; ms?: number }[]>([])
  const [log, setLog] = useState<string[]>([])
  const [doneCount, setDoneCount] = useState(0)
  const [failed, setFailed] = useState(false)
  const [running, setRunning] = useState(true)
  // Step timings feed the prototype's per-step durations and the Done summary.
  const startedAt = useRef(new Map<string, number>())
  const runStartedAt = useRef(Date.now())
  const tally = useRef({ done: 0, total: 0 })
  const reportedError = useRef<string | null>(null)
  useEffect(() => {
    void streamNDJSON('/api/install', body, (e) => {
      switch (e.type) {
        case 'run-start':
          tally.current.total = (e.steps as { id: string; name: string }[]).length
          setSteps((e.steps as { id: string; name: string }[]).map((s) => ({ ...s, state: 'pending' })))
          break
        case 'step-start':
          startedAt.current.set(String(e.id), Date.now())
          setSteps((ss) => ss.map((s) => (s.id === e.id ? { ...s, state: 'running' } : s)))
          break
        case 'stdout': setLog((l) => [...l.slice(-400), String(e.chunk)]); break
        case 'step-done': {
          const began = startedAt.current.get(String(e.id))
          const ms = began ? Date.now() - began : undefined
          setSteps((ss) => ss.map((s) => (s.id === e.id ? { ...s, state: e.ok ? 'done' : 'failed', ms } : s)))
          if (e.ok) { tally.current.done += 1; setDoneCount((c) => c + 1) }
          break
        }
        case 'token': if (e.token) onToken(String(e.token)); break
        case 'error':
          setFailed(true); setRunning(false)
          if (e.message) { reportedError.current = String(e.message); setLog(lines => [...lines.slice(-400), `${String(e.message)}\n`]) }
          break
        case 'done':
          setRunning(false)
          if (e.ok) onDone({ done: tally.current.done, total: tally.current.total, ms: Date.now() - runStartedAt.current })
          break
      }
    }).catch((error: unknown) => {
      setFailed(true)
      setRunning(false)
      // The stream rethrows the failure it already delivered as an event; log each cause once.
      const message = error instanceof Error ? error.message : String(error)
      if (message !== reportedError.current) setLog((lines) => [...lines.slice(-400), `${message}\n`])
    })
  }, [])
  useEffect(() => { setFault(failed) }, [failed])
  const total = steps.length || 1
  const failedIndex = steps.findIndex((step) => step.state === 'failed')
  const title = failed ? 'Install failed' : running ? 'Installing' : 'Install complete'
  const sub = 'Bringing up the local personal stack, then registering the stream MCP and writing the rule. ~5–10 min.'
  const [copied, setCopied] = useState(false)
  const copyLog = () => {
    try { void navigator.clipboard.writeText(log.join('')) } catch { /* clipboard unavailable */ }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }
  // Prototype w-install / w-install-failed: named steps carry the narrative, the log stays secondary.
  return (
    <section className="install-step">
      <div className="install-head">
        <h2 className={failed ? 'bad' : undefined}>{title}</h2>
        {steps.length > 0 ? (
          failed
            ? <span className="badge bad up">{failedIndex >= 0 ? `step ${failedIndex + 1} of ${steps.length}` : 'failed'}</span>
            : <span className="badge accent up">{doneCount} of {steps.length} complete</span>
        ) : null}
      </div>
      <p className="lede">{failed
        ? <>The install stopped at <b>{failedIndex >= 0 ? steps[failedIndex].name : 'a step'}</b>. The failure output shows the cause.</>
        : <>{sub}{running ? ' You can leave this window open.' : ''}</>}</p>
      <ProgressBar value={doneCount / total} tone={failed ? 'danger' : 'accent'} />
      <div className="install-grid">
        <StepList steps={steps} />
        <div>
          <div className={`terminal-head${failed ? ' bad' : ''}`}>
            <Icon name={failed ? 'error_outline' : 'terminal'} size={13} /> {failed ? 'failure output' : 'live output'}
          </div>
          <Terminal lines={log} caret={running} />
        </div>
      </div>
      {failed ? (
        <>
          <Notice tone="fault" title={failedIndex >= 0 ? `${steps[failedIndex].name} failed` : 'A step failed'} role="alert">
            Fix the cause shown in the failure output, then re-run <code>npm run install-persistent-memory</code>.
          </Notice>
          <div className="btn-row">
            <button type="button" className="btn primary" onClick={onBack}><Icon name="arrow_left" size={15} /> Return to environment checks</button>
            <button type="button" className="btn secondary" onClick={copyLog}><Icon name="copy" size={15} /> {copied ? 'Copied' : 'Copy full log'}</button>
          </div>
        </>
      ) : null}
    </section>
  )
}

// ── Done (flow-aware) ───────────────────────────────────────────────────────────
function Done({ flow, token, apps, passwordConfigured, embedding, summary }: { flow: Flow; token: string | null; remoteToken: string; apps: Apps; passwordConfigured: boolean; embedding: string; summary: InstallSummary | null }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { if (token) { try { void navigator.clipboard.writeText(token) } catch { /* ignore */ } setCopied(true); setTimeout(() => setCopied(false), 1600) } }
  const go = async () => {
    const fin = await getJSON<{ dashboardUrl: string }>('/api/finish').catch(() => ({ dashboardUrl: LOCAL_DASHBOARD_URL }))
    void fetch('/api/shutdown', { method: 'POST' }).catch(() => {})
    window.location.assign(dashboardThemeUrl(fin.dashboardUrl, readTheme()))
  }
  const restart = [
    apps.claudeCli && 'Claude CLI',
    apps.claudeDesktop && 'Claude Desktop',
    apps.codexCli && 'Codex CLI',
    apps.codexDesktop && 'Codex Desktop',
  ].filter(Boolean).join(', ')
  // Prototype w-done / w-done-token: what now runs, any shown-once secret, and one next action.
  return (
    <section>
      <div className="done-head">
        <div className="done-check" aria-hidden><Icon name="check" size={24} /></div>
        <div>
          <h2>Installed</h2>
          <p className="note">{summary && summary.total > 0
            ? `${summary.done} of ${summary.total} steps completed in ${formatStepDuration(summary.ms)}`
            : 'The local personal memory stack is running.'}</p>
        </div>
      </div>
      {token ? (
        <div className="wiz-card-box accent">
          <div className="done-token-head">
            <Icon name="key" size={17} />
            <span>Bootstrap super-admin token</span>
            <span className="badge accent up">shown once</span>
          </div>
          <p className="note">Use it to log into the dashboard. It will not be shown again.</p>
          <div className="token-well">
            <code className="tokenval">{token}</code>
            <button type="button" className="btn sm accent-quiet" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? 'Copied' : 'Copy'}</button>
          </div>
        </div>
      ) : null}
      <div className="wiz-card-box">
        <span className="section-label">What is now running</span>
        <div className="kv">
          <div className="kv-row"><span>Local dashboard</span><code>{LOCAL_DASHBOARD_URL}</code></div>
          <div className="kv-row"><span>Stream MCP</span><code>http://127.0.0.1:8091/mcp</code></div>
          <div className="kv-row"><span>Embeddings</span><code>{embedding}</code></div>
          {restart ? <div className="kv-row"><span>Registered with</span><span>{restart}</span></div> : null}
        </div>
      </div>
      {!token && flow === 'full' ? (
        <Notice tone="ok">
          {passwordConfigured
            ? <>Local mode is protected. <b>Go to dashboard opens the local login screen first.</b></>
            : <>Local mode opens directly to Personal Overview with <b>no login</b>, so there’s no token to copy.</>}
        </Notice>
      ) : !token ? (
        <Notice>Your MCP config was written with the token you provided.</Notice>
      ) : null}
      {restart ? <Notice tone="warn">Restart <b>{restart}</b> to load the new MCP and memory rule.</Notice> : null}
      {flow === 'full' ? (
        <div className="btn-row">
          <button type="button" className="btn primary lg" onClick={() => void go()}>Go to dashboard <Icon name="arrow_right" size={16} /></button>
          {token ? <span className="note">Store the token in your password manager first.</span> : null}
        </div>
      ) : (
        <div className="btn-row"><button type="button" className="btn primary" onClick={() => void fetch('/api/shutdown', { method: 'POST' }).catch(() => {})}>Done</button></div>
      )}
    </section>
  )
}
