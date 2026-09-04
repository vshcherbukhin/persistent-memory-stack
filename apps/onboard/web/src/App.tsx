/**
 * persistent-memory onboarding wizard — personal-first.
 *
 * The legacy flow ids remain as migration aliases, but the visible install is one
 * local personal memory stack plus stream MCP, with an optional Shared Memories
 * connection after personal setup.
 *
 * Layout: a 60px header + a 2-column body (left step rail | scrollable content
 * card over a pinned footer). Back/Next live in ONE shared footer in App; each
 * gated step reports its blocked state up via `setNextDisabled`. The footer is
 * hidden on the flow picker, the install run, and the done screen.
 */
import { useEffect, useRef, useState } from 'react'
import { getJSON, postJSON, streamNDJSON } from './api'
import { ProgressBar, Field, StepList, Terminal, StatusRow, type StepState } from './components'
import { type Flow, type Phase, phasesFor, nextPhase, prevPhase, prereqsBlocked, modelPresence, extractionNextBlocked } from './flow'

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
  embedProvider: 'ollama'
  embedModel: string
  embedDim: number
  // Full-flow extraction LLM
  extractionProvider: 'anthropic' | 'openai'
  extractionModel: string
  anthropicApiKey: string
  openaiApiKey: string
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
  updateNotifications: boolean
  updateBitbucketUrl: string
  updateBitbucketToken: string
  updateBitbucketScope: 'project' | 'user'
  updateBitbucketProject: string
  updateBitbucketUser: string
  updateBitbucketRepo: string
  updateBitbucketBranch: string
  // Personal/shared memory surfaces
  personalMemoryEnabled: boolean
  memoryInstallMode: 'shared-only' | 'personal-only' | 'personal-and-shared'
  defaultMemorySurface: 'personal' | 'shared'
}

const DEFAULT_ANSWERS: Answers = {
  embeddingMode: 'server',
  embedProvider: 'ollama',
  embedModel: 'qwen3-embedding:4b',
  embedDim: 2560,
  extractionProvider: 'anthropic',
  extractionModel: 'claude-haiku-4-5-20251001',
  anthropicApiKey: '',
  openaiApiKey: '',
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
  updateNotifications: false,
  updateBitbucketUrl: '',
  updateBitbucketToken: '',
  updateBitbucketScope: 'project',
  updateBitbucketProject: '',
  updateBitbucketUser: '',
  updateBitbucketRepo: '',
  updateBitbucketBranch: 'master',
  personalMemoryEnabled: true,
  memoryInstallMode: 'personal-only',
  defaultMemorySurface: 'personal',
}

const EMBED_MODELS = [
  { model: 'qwen3-embedding:0.6b', dim: 1024, note: 'CPU-friendly', ram: '< 16 GB' },
  { model: 'qwen3-embedding:4b', dim: 2560, note: 'balanced', ram: '≥ 16 GB' },
  { model: 'qwen3-embedding:8b', dim: 4096, note: 'highest quality, needs RAM', ram: '≥ 64 GB' },
]

const PHASE_LABEL: Record<Phase, string> = {
  flow: 'Get started', prereqs: 'Environment pre-check', account: 'Account', remote: 'Connect server', embedding: 'Embeddings',
  pullModel: 'Pull model', extraction: 'Extraction LLM', updates: 'Updates', ecosystem: 'Ecosystem',
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

// ── Brand hexagon "B" mark ─────────────────────────────────────────────────────
function HexLogo({ size = 26 }: { size?: number }) {
  return (
    <svg className="wiz-logo" width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      <polygon points="50,5 91,28 91,72 50,95 9,72 9,28" fill="rgba(22,167,219,.12)" stroke="#16A7DB" strokeWidth="6" strokeLinejoin="round" />
      <text x="50" y="67" textAnchor="middle" fontSize="46" fontWeight="700" fill="#16A7DB" fontFamily="'Source Sans Pro',sans-serif">B</text>
    </svg>
  )
}

// ── Left step rail (per-flow phase list; jump to a visited step) ────────────────
function Rail({ flow, phase, personalMemoryEnabled, goto }: { flow: Flow; phase: Phase; personalMemoryEnabled: boolean; goto: (p: Phase) => void }) {
  const seq = phasesFor(flow, { personalMemoryEnabled })
  const cur = seq.indexOf(phase)
  return (
    <aside className="wiz-rail">
      <div className="wiz-rail-flow">{RAIL_HEADING}</div>
      <div className="wiz-rail-list">
        {seq.map((p, idx) => {
          const state = idx < cur ? 'done' : idx === cur ? 'current' : 'todo'
          const visited = idx <= cur
          return (
            <button
              key={p}
              type="button"
              className={`wiz-rail-item ${state}`}
              disabled={!visited}
              onClick={() => { if (visited) goto(p) }}
            >
              <span className="wiz-rail-num">{state === 'done' ? '✓' : String(idx + 1)}</span>
              <span className="wiz-rail-label">{PHASE_LABEL[p]}</span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('flow')
  const [flow, setFlow] = useState<Flow>('full')
  const [answers, setAnswers] = useState<Answers>(DEFAULT_ANSWERS)
  const [apps, setApps] = useState<Apps>({ claudeCli: false, claudeDesktop: false, codexCli: false, codexDesktop: false })
  const [serverPin, setServerPin] = useState<ServerPin | null>(null)
  const [remoteIdentity, setRemoteIdentity] = useState<RemoteIdentity | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [nextDisabled, setNextDisabled] = useState(false)
  // Whether the Ecosystem step has applied its detected defaults — so navigating
  // back/forward doesn't clobber the user's manual app selection.
  const appsInited = useRef(false)
  const set: Setter = (k, v) => setAnswers((a) => ({ ...a, [k]: v }))
  const personalFlow = answers.personalMemoryEnabled

  const setPhaseAndResetGate = (p: Phase | null) => {
    if (!p) return
    setNextDisabled(false)
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
    onBack: () => go('back'), onNext: () => go('next'), setNextDisabled,
  }

  // Footer is hidden on the flow picker, the install run, and the done screen.
  const showFooter = phase !== 'flow' && phase !== 'install' && phase !== 'done'

  return (
    <div className="shell">
      <header className="wiz-header">
        <HexLogo />
        <div className="wiz-brand">
          <span className="wiz-title">persistent-memory</span>
          <span className="wiz-sub">Guided install · host-only · 127.0.0.1:4319</span>
        </div>
      </header>

      <div className="wiz-stage">
        <div className="wiz-card">
          <Rail flow={flow} phase={phase} personalMemoryEnabled={personalFlow} goto={setPhaseAndResetGate} />

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
              {phase === 'remote' && <RemoteConnect {...shared} />}
              {phase === 'embedding' && <EmbeddingPicker {...shared} />}
              {phase === 'pullModel' && <PullModel {...shared} />}
              {phase === 'extraction' && <Extraction {...shared} />}
              {phase === 'updates' && <UpdateNotifications {...shared} />}
              {phase === 'ecosystem' && <Ecosystem {...shared} />}
              {phase === 'registration' && <Registration {...shared} />}
              {phase === 'rule' && <RuleStep {...shared} />}
              {phase === 'review' && <Review flow={flow} answers={answers} serverPin={serverPin} setNextDisabled={setNextDisabled} />}
              {phase === 'shared' && <SharedConnect {...shared} />}
              {phase === 'install' && (
                <Install
                  flow={flow}
                  body={installBody(flow, answers, apps, serverPin)}
                  onToken={setToken}
                  onDone={() => setPhaseAndResetGate('done')}
                />
              )}
              {phase === 'done' && <Done flow={flow} token={token} remoteToken={answers.remoteToken} apps={apps} passwordConfigured={Boolean(answers.userPassword)} />}
            </div>

            {showFooter && (
              <footer className="wiz-footer">
                <button type="button" className="ghost" onClick={() => go('back')}>← Back</button>
                <button type="button" className="primary" disabled={nextDisabled} onClick={() => go('next')}>
                  {phase === 'review' ? 'Generate & Install' : 'Next →'}
                </button>
              </footer>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

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
}

function installBody(flow: Flow, a: Answers, apps: Apps, pin: ServerPin | null): InstallBody {
  const base: InstallBody = {
    flow,
    mcpRuntime: 'stream',
    apps,
    regLevel: a.regLevel,
    projectPaths: a.projectPaths,
    ruleBody: a.ruleText,
    memoryBlock: a.memoryBlock,
    personalMemoryEnabled: a.personalMemoryEnabled,
    memoryInstallMode: a.memoryInstallMode,
    defaultMemorySurface: a.defaultMemorySurface,
    personalApiUrl: 'http://localhost:8090',
    teamName: a.teamName,
    userEmail: a.userEmail,
    userName: a.userName,
    userPassword: a.userPassword,
  }
  return {
    ...base,
    remoteApiUrl: a.remoteApiUrl,
    remoteOllamaUrl: a.remoteOllamaUrl,
    remoteToken: a.remoteToken,
    pullModel: a.memoryInstallMode === 'personal-and-shared' ? pin?.model : undefined,
    sharedApiUrl: a.memoryInstallMode === 'personal-and-shared' ? a.remoteApiUrl : undefined,
    sharedUserToken: a.memoryInstallMode === 'personal-and-shared' ? a.remoteToken : undefined,
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
}

// ── Step 0: flow router ─────────────────────────────────────────────────────────
function FlowRouter({ onPick }: { onPick: (f: Flow, personalMemoryEnabled: boolean) => void }) {
  return (
    <section className="welcome-step">
      <h2>Welcome to Persistent Memory</h2>
      <p>Persistent Memory gives Claude and Codex a durable local memory system for project context, decisions, fixes, and long-running work.</p>
      <p className="welcome-copy">The installer starts with Personal Memories on this computer, then supports sharing memories by connecting this local dashboard to a Shared Memories server later or during setup.</p>
      <div className="row welcome-actions">
        <button type="button" className="primary" onClick={() => onPick('full', true)}>Get started</button>
      </div>
    </section>
  )
}

// ── Prereqs (flow-aware) ──────────────────────────────────────────────────────────
interface PrereqResult {
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
  { key: 'node', label: 'Node 20+' },
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
  const icon = status === 'ok' ? '✓' : status === 'warn' ? '!' : ''
  return (
    <div className={`precheck-card ${status}`}>
      <span className={`precheck-icon ${status}`} aria-hidden>{icon}</span>
      <span className="precheck-label">{label}</span>
      <span className="precheck-detail">{detail}</span>
      {status === 'warn' && action && onInstall ? (
        <button type="button" className="precheck-action" onClick={onInstall}>{action}</button>
      ) : null}
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
  const brewMissing = !!(p.homebrew && !p.homebrew.ok)
  if (key === 'node') return p.node.ok || brewMissing ? undefined : 'Install'
  if (key === 'docker') return p.docker.ok ? undefined : p.docker.installed ? 'Start' : brewMissing ? undefined : 'Install'
  if (key === 'compose') return p.compose.ok || brewMissing ? undefined : 'Install / Repair'
  if (key === 'ollama') return p.ollama.ok ? undefined : p.ollama.installed ? 'Start' : brewMissing ? undefined : 'Install'
  return undefined
}

function Prereqs({ flow, answers, setNextDisabled }: StepProps) {
  const [p, setP] = useState<PrereqResult | null>(null)
  const [completedChecks, setCompletedChecks] = useState(0)
  const [installing, setInstalling] = useState<PrereqKey | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const check = async () => {
    setP(null)
    setCompletedChecks(0)
    setError(null)
    try {
      setP(await getJSON<PrereqResult>('/api/prereqs'))
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
  const blocked = prereqsBlocked(flow, p, { personalMemoryEnabled: answers.personalMemoryEnabled })
  const brewMissing = !!(p?.homebrew && !p.homebrew.ok)
  useEffect(() => { setNextDisabled(!p || completedChecks < PREREQ_ITEMS.length || blocked) }, [p, completedChecks, blocked])
  const install = async (component: PrereqKey) => {
    setInstalling(component); setLog([]); setError(null)
    let failed: string | null = null
    try {
      await streamNDJSON('/api/prereqs/install', { component }, (e) => {
        if (e.type === 'stdout') setLog((l) => [...l.slice(-300), String(e.chunk)])
        if (e.type === 'error' && e.message) failed = String(e.message)
      })
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e)
    } finally {
      setInstalling(null)
    }
    if (failed) {
      setError(failed)
      return
    }
    await check()
  }
  return (
    <section>
      <h2>Environment pre-check</h2>
      <p>Auto-checked for the local personal memory install.</p>
      <div className="precheck-list">
        {PREREQ_ITEMS.map((item, idx) => {
          const isInstalling = installing === item.key
          if (isInstalling) {
            return <PrereqCard key={item.key} status="installing" label={item.label} detail="installing..." />
          }
          if (!p) {
            return <PrereqCard key={item.key} status={idx === 0 ? 'verifying' : 'pending'} label={item.label} detail={idx === 0 ? 'verifying...' : 'pending...'} />
          }
          if (completedChecks <= idx) {
            return <PrereqCard key={item.key} status={completedChecks === idx ? 'verifying' : 'pending'} label={item.label} detail={completedChecks === idx ? 'verifying...' : 'pending...'} />
          }
          const probe = prereqProbe(p, item.key)
          const detail = brewMissing && !probe.ok && item.key !== 'node'
            ? `${probe.detail} Install Homebrew first.`
            : probe.detail
          return (
            <PrereqCard
              key={item.key}
              status={probe.ok ? 'ok' : 'warn'}
              label={item.label}
              detail={detail}
              action={prereqAction(p, item.key)}
              onInstall={() => void install(item.key)}
            />
          )
        })}
      </div>
      {brewMissing && p?.homebrew?.manualInstall ? (
        <p className="notice warn">Homebrew is required for automatic installs on macOS. Install Homebrew in Terminal, then return to this step.</p>
      ) : null}
      {(blocked && p) || error ? (
        <p className="notice bad prereq-error">{error ?? 'A required check failed. Fix it or use the install action in the matching card before continuing.'}</p>
      ) : null}
      {log.length > 0 && <div className="prereq-log"><Terminal lines={log} /></div>}
    </section>
  )
}

// ── Account — full flow collects identity; client personal flow uses the server token identity.
function Account({ answers, set, setNextDisabled, flow, remoteIdentity, serverPin }: StepProps) {
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
  return (
    <section>
      <h2>Your account</h2>
      {clientPersonal ? (
        <p>Server accepted the token. Your email is copied from the server account; choose your local dashboard alias and optional password.</p>
      ) : (
        <p>Create the local dashboard identity shown in Personal Memories. You can change profile details later.</p>
      )}
      {!remoteIdentity && clientPersonal ? <p className="notice bad">Connect to the server first. This step uses the token identity from <code>/whoami</code>.</p> : null}
      {clientPersonal ? (
        <>
          <Field label="Your email" hint="Read-only: provided by the server token.">
            <input readOnly type="email" value={remoteIdentity?.userEmail ?? ''} placeholder="Server user has no email" />
          </Field>
        </>
      ) : (
        <Field label="Your email" hint="Identifies you in the dashboard.">
          <input type="email" value={answers.userEmail} onChange={(e) => set('userEmail', e.target.value)} placeholder="you@company.com" />
        </Field>
      )}
      {email.length > 0 && !emailValid ? <p className="field-hint" style={{ color: 'var(--danger)' }}>Enter a valid email address.</p> : null}
      <Field label={clientPersonal ? 'Display name / alias' : 'Display name (optional)'} hint={derived ? `Blank → derived from your email: “${derived}”.` : 'Blank → derived from your email.'}>
        <input value={answers.userName} onChange={(e) => set('userName', e.target.value)} placeholder={derived || 'Your name'} />
      </Field>
      <div className="seg-group">
        <span className="seg-label">{serverUsesSso ? 'Dashboard password' : passwordRequired ? 'Dashboard password' : 'Dashboard password (optional)'} <span className="seg-hint">{serverUsesSso ? '· SSO' : passwordRequired ? '· required' : ''}</span></span>
        {serverUsesSso ? (
          <p className="notice ok">
            This server uses SSO for dashboard login. The wizard will keep using your token for MCP registration;
            use your work email to sign in to the dashboard.
          </p>
        ) : (
          <>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" onClick={createPassword}>Generate password</button>
            </div>
            <Field label={passwordRequired ? 'Password' : 'Password (optional)'} hint={passwordRequired
              ? 'Required for dashboard login. This protects the dashboard session; the token remains for MCP/API recovery.'
              : 'Set one to require login when opening the dashboard; leave blank and it opens directly. You can add or remove it later in your profile.'}>
              <input
                type="password"
                value={answers.userPassword}
                onChange={(e) => { set('userPassword', e.target.value); setGenerated(null) }}
                placeholder={passwordRequired ? 'required for dashboard login' : 'leave blank for no login'}
              />
            </Field>
            {strength ? (
              <>
                <div className={`password-meter ${strength.level}`} aria-hidden="true"><span /></div>
                <p className="field-hint">{strength.accepted ? 'Strong password.' : strength.messages[0]}</p>
              </>
            ) : null}
            {passwordRequired || pw.length > 0 ? (
              <Field label="Confirm password">
                <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </Field>
            ) : null}
            {generated ? (
              <p className="notice warn">Generated password shown once: <code>{generated}</code></p>
            ) : null}
            {pwMissing ? <p className="field-hint" style={{ color: 'var(--danger)' }}>Enter a dashboard password for password-mode servers.</p> : null}
            {weakPassword ? <p className="field-hint" style={{ color: 'var(--danger)' }}>Use a stronger password before continuing.</p> : null}
            {pwMismatch ? <p className="field-hint" style={{ color: 'var(--danger)' }}>Passwords do not match.</p> : null}
          </>
        )}
      </div>
    </section>
  )
}

// ── Optional Shared Memories connection ─────────────────────────────────────────
function SharedConnect(props: StepProps) {
  const { answers, set, remoteIdentity, setRemoteIdentity, setServerPin, setNextDisabled } = props
  const [sharedConnectEnabled, setSharedConnectEnabled] = useState(answers.memoryInstallMode === 'personal-and-shared')
  useEffect(() => {
    set('memoryInstallMode', sharedConnectEnabled ? 'personal-and-shared' : 'personal-only')
    set('defaultMemorySurface', 'personal')
    if (!sharedConnectEnabled) {
      setRemoteIdentity(null)
      setServerPin(null)
    }
  }, [sharedConnectEnabled])
  useEffect(() => {
    setNextDisabled(sharedConnectEnabled && !remoteIdentity)
  }, [sharedConnectEnabled, remoteIdentity])

  return (
    <section>
      <h2>Connect Shared Memories</h2>
      <label className={`checkrow flow-isolation-option${sharedConnectEnabled ? ' checked' : ''}`}>
        <input type="checkbox" checked={sharedConnectEnabled} onChange={(e) => setSharedConnectEnabled(e.target.checked)} />
        <span className="checkbox" aria-hidden>{sharedConnectEnabled ? '✓' : ''}</span>
        <span className="checkrow-label">Connect this local dashboard to Shared Memories</span>
        <span className="checkrow-tag">can be added later</span>
      </label>
      {sharedConnectEnabled ? (
        <div className="shared-connect-body">
          <RemoteConnect {...props} />
        </div>
      ) : (
        <p className="notice">Shared Memories can be connected later from the local dashboard.</p>
      )}
    </section>
  )
}

// ── Shared server connector token test ─────────────────────────────────────────
function RemoteConnect({ answers, set, serverPin, setServerPin, remoteIdentity, setRemoteIdentity, setNextDisabled }: StepProps) {
  const [testing, setTesting] = useState(false)
  const [whoami, setWhoami] = useState<RemoteIdentity | null>(remoteIdentity)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setWhoami(remoteIdentity) }, [remoteIdentity])
  useEffect(() => { setNextDisabled(!whoami) }, [whoami])
  const clearConnection = () => {
    setWhoami(null)
    setRemoteIdentity(null)
    setServerPin(null)
    setError(null)
  }
  const setRemoteApiUrl = (value: string) => {
    clearConnection()
    set('remoteApiUrl', value)
  }
  const setRemoteToken = (value: string) => {
    clearConnection()
    set('remoteToken', value)
  }
  const missingLocalPort = (urlText: string) => {
    try {
      const url = new URL(urlText)
      return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && !url.port
    } catch {
      return false
    }
  }
  const test = async () => {
    setTesting(true); setError(null); setWhoami(null); setServerPin(null); setRemoteIdentity(null)
    const r = await postJSON<{ config: RemoteServerConfig | null; whoami: RemoteIdentity | null; error?: string }>(
      '/api/remote/test', { apiUrl: answers.remoteApiUrl, token: answers.remoteToken },
    ).catch(() => ({ config: null, whoami: null, error: 'unreachable' }))
    setTesting(false)
    const pin = serverPinFromConfig(r.config)
    if (r.error === 'unreachable' || !pin) {
      const portHint = missingLocalPort(answers.remoteApiUrl)
        ? ' Local server installs need the API port, for example http://127.0.0.1:12090 for a client-managed embeddings validation server.'
        : ''
      setError(`Couldn’t reach ${answers.remoteApiUrl.replace(/\/+$/, '')}/config.${portHint}`)
      return
    }
    if (r.error === 'bad_token' || !r.whoami) { setError('Server reachable, but the token was rejected.'); setServerPin(pin); return }
    const identity = r.whoami
    const alias = identity.userDisplayName?.trim() || (identity.userEmail?.includes('@') ? identity.userEmail.split('@')[0] : '')
    setServerPin(pin); setWhoami(identity); setRemoteIdentity(identity)
    set('teamName', identity.teamName ?? '')
    set('userEmail', identity.userEmail ?? '')
    set('userName', alias)
  }
  return (
    <section>
      <h2>Shared Memories server</h2>
      <p>The connector token is saved in the local dashboard as a masked secret.</p>
      <Field label="Shared API URL" hint="The persistent-memory API URL printed by the shared server installer.">
        <input value={answers.remoteApiUrl} onChange={(e) => setRemoteApiUrl(e.target.value)} placeholder="http://127.0.0.1:12090" />
      </Field>
      <Field label="Connector token" hint="Server-issued token for this local dashboard (tokenId.secret).">
        <input type="password" value={answers.remoteToken} onChange={(e) => setRemoteToken(e.target.value)} placeholder="tokenId.secret" />
      </Field>
      <div className="row"><button onClick={() => void test()} disabled={testing || !answers.remoteApiUrl || !answers.remoteToken}>{testing ? 'Testing…' : 'Test connection'}</button></div>
      {error ? <p className="notice bad">{error} Check it was copied whole (<code>tokenId.secret</code>) and not expired.</p> : null}
      {whoami ? <p className="notice ok">✓ Connected — <b>{whoami.userEmail ?? 'server user'}</b>{whoami.teamName ? <> on team <b>{whoami.teamName}</b></> : null}; role <b>{whoami.adminLevel}</b>. Server pins <code>{serverPin?.model} @ {serverPin?.dim}</code>.</p> : null}
    </section>
  )
}

// ── Embedding picker (full flow — defines the server pin) ─────────────────────────
function EmbeddingPicker({ answers, set, flow }: StepProps) {
  const [rec, setRec] = useState<{ model: string; dim: number } | null>(null)
  const [models, setModels] = useState<string[]>([])
  useEffect(() => { void getJSON<{ recommended: { model: string; dim: number } }>('/api/specs').then((s) => setRec(s.recommended)).catch(() => setRec(null)) }, [])
  useEffect(() => { void getJSON<{ models: string[] }>('/api/prereqs').then((r) => setModels(r.models)).catch(() => setModels([])) }, [])
  const pick = (model: string) => { const m = EMBED_MODELS.find((x) => x.model === model)!; set('embedModel', m.model); set('embedDim', m.dim) }
  return (
    <section>
      <h2>Embeddings</h2>
      <p>Defines the <b>{flow === 'full' ? 'local server pin' : 'personal memory pin'}</b> — the one model + dim the local corpus commits to. This host
        embeds personal/local memories on the laptop.</p>
      <div className="seg-group">
        <span className="seg-label">Local embedding model {rec ? <span className="seg-hint">· recommended for this host: {rec.model} @ {rec.dim}</span> : null}</span>
        <div className="modellist">
          {EMBED_MODELS.map((m) => {
            const on = answers.embedModel === m.model
            return (
              <button type="button" key={m.model} className={`modelrow${on ? ' active' : ''}`} onClick={() => pick(m.model)}>
                <span className="modelradio" aria-hidden />
                <span className="modelrow-main">
                  <span className="modelrow-name">{m.model}</span> <span className="modelrow-dim">@ {m.dim}</span> <span className="modelrow-note">· {m.note}</span>
                </span>
                <span className="modelrow-ram">{m.ram}</span>
                <span className={`modelrow-rec ${modelPresence(models, m.model) === 'installed' ? 'ok' : 'warn'}`}>{modelPresence(models, m.model) === 'installed' ? 'installed' : 'will be installed'}</span>
                {rec && rec.model === m.model ? <span className="modelrow-rec">recommended</span> : null}
              </button>
            )
          })}
        </div>
      </div>
      <p className="notice warn">Switching the model/dim later forces a full <b>re-embed migration</b> of the whole corpus — pick deliberately. Matryoshka lets you truncate down (2560 → 1024 → 768…) within qwen3.</p>
    </section>
  )
}

// ── Pull model (engine flow — pull the server's exact pin) ────────────────────────
function PullModel({ serverPin, setNextDisabled }: StepProps) {
  const model = serverPin?.model ?? ''
  const [pulled, setPulled] = useState<boolean | null>(null)
  const [pulling, setPulling] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const check = () => getJSON<{ models: string[] }>('/api/prereqs').then((r) => setPulled(r.models.some((m) => m === model || m.startsWith(model)))).catch(() => setPulled(null))
  useEffect(() => { void check() }, [])
  useEffect(() => { setNextDisabled(!pulled) }, [pulled])
  const pull = async () => {
    setPulling(true)
    await streamNDJSON('/api/ollama/pull', { model }, (e) => { if (e.type === 'stdout') setLog((l) => [...l.slice(-200), String(e.chunk)]) })
    setPulling(false); void check()
  }
  return (
    <section>
      <h2>Local embedding model</h2>
      <p>The shared server requires <code>{model}</code> for client-managed embeddings. This local dashboard must run the <em>exact same</em> model before connecting.</p>
      <StatusRow ok={pulled} label={model} detail={pulled ? 'pulled' : pulling ? 'pulling…' : 'not pulled'} />
      {!pulled && <div className="row"><button disabled={pulling} onClick={() => void pull()}>{pulling ? 'Pulling…' : `Pull ${model}`}</button></div>}
      {log.length > 0 && <Terminal lines={log} />}
    </section>
  )
}

// ── Extraction LLM (full flow) ────────────────────────────────────────────────────
function Extraction({ answers, set, setNextDisabled }: StepProps) {
  // Detect API keys already in the user's .env so they don't re-paste them (the auto-generated
  // secrets — TOKEN_PEPPER/DOCKER_CONTROL_TOKEN/USAGE_INGEST_TOKEN — are always regenerated instead).
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
      <p>Powers the Shape gate + graph entity/edge extraction.</p>
      <div className="seg-group">
        <span className="seg-label">Provider</span>
        <div className="seg-row">
          <button type="button" className={`seg${answers.extractionProvider === 'anthropic' ? ' active' : ''}`} onClick={() => { set('extractionProvider', 'anthropic'); set('extractionModel', 'claude-haiku-4-5-20251001') }}>
            Anthropic <span className="seg-note" style={{ display: 'inline' }}>· recommended</span>
          </button>
          <button type="button" className={`seg${answers.extractionProvider === 'openai' ? ' active' : ''}`} onClick={() => { set('extractionProvider', 'openai'); set('extractionModel', 'gpt-4o') }}>
            OpenAI
          </button>
        </div>
      </div>
      <div className="seg-group">
        <span className="seg-label">Model <span className="seg-hint">· Haiku is the default (cheaper + faster); Sonnet 4.6 for higher quality if you have a key</span></span>
        <div className="modellist">
          {models.map((m) => {
            const on = answers.extractionModel === m.id
            return (
              <button type="button" key={m.id} className={`modelrow${on ? ' active' : ''}`} onClick={() => set('extractionModel', m.id)}>
                <span className="modelradio" aria-hidden />
                <span className="modelrow-main">
                  <span className="modelrow-name">{m.id}</span> <span className="modelrow-note">· {m.note}</span>
                </span>
                {m.rec ? <span className="modelrow-rec">recommended</span> : null}
              </button>
            )
          })}
        </div>
      </div>
      {isAnthropic ? (
        <Field label="ANTHROPIC_API_KEY (mandatory)" hint="Stored only in the local .env.persistent-memory; masked in the review."><input type="password" value={answers.anthropicApiKey} onChange={(e) => set('anthropicApiKey', e.target.value)} placeholder={keyOnFile ? '•••• existing key — leave blank to keep' : 'sk-…'} /></Field>
      ) : (
        <Field label="OPENAI_API_KEY (mandatory)" hint="Stored only in the local .env.persistent-memory; masked in the review."><input type="password" value={answers.openaiApiKey} onChange={(e) => set('openaiApiKey', e.target.value)} placeholder={keyOnFile ? '•••• existing key — leave blank to keep' : 'sk-…'} /></Field>
      )}
      {keyOnFile && <p className="notice ok">✓ An existing <code>{isAnthropic ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}</code> was found in your <code>.env.persistent-memory</code> — leave the field blank to keep it, or enter a new one to replace it.</p>}
      {needsKey ? <p className="notice warn">API key is required to continue.</p> : null}
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" onClick={() => void testFactExtraction()} disabled={needsKey || testState === 'testing'}>
          {testState === 'testing' ? 'Testing...' : 'Test fact extraction'}
        </button>
      </div>
      {testState === 'ok' ? <p className="notice ok">{testResult?.message ?? 'Fact extraction test passed.'}</p> : null}
      {testState === 'error' ? <p className="notice bad">{testResult?.message ?? 'Fact extraction test failed.'}{testResult?.details ? <> {testResult.details}</> : null}</p> : null}
      <p className="notice">You don’t enter these. <b>Regenerated</b> each install: <code>TOKEN_PEPPER</code>, <code>DOCKER_CONTROL_TOKEN</code>, <code>USAGE_INGEST_TOKEN</code>. The DB / MinIO passwords are <b>kept in sync with your data volumes</b> — preserved if a <code>.env.persistent-memory</code> already exists, generated fresh otherwise.</p>
    </section>
  )
}

// ── Dashboard update notifications (full flow, optional) ───────────────────────
function UpdateNotifications({ answers, set, setNextDisabled }: StepProps) {
  const [tokenOnFile, setTokenOnFile] = useState(false)
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [testMessage, setTestMessage] = useState<string | null>(null)
  useEffect(() => {
    void getJSON<{
      updateProvider?: string
      updateBitbucketUrl?: string
      updateBitbucketTokenPresent?: boolean
      updateBitbucketScope?: 'project' | 'user'
      updateBitbucketProject?: string
      updateBitbucketUser?: string
      updateBitbucketRepo?: string
      updateBitbucketBranch?: string
    }>('/api/env/existing').then((r) => {
      setTokenOnFile(Boolean(r.updateBitbucketTokenPresent))
      if (!answers.updateNotifications && r.updateProvider === 'bitbucket') set('updateNotifications', true)
      if (!answers.updateBitbucketUrl && r.updateBitbucketUrl) set('updateBitbucketUrl', r.updateBitbucketUrl)
      if (r.updateBitbucketScope === 'project' || r.updateBitbucketScope === 'user') set('updateBitbucketScope', r.updateBitbucketScope)
      if (!answers.updateBitbucketProject && r.updateBitbucketProject) set('updateBitbucketProject', r.updateBitbucketProject)
      if (!answers.updateBitbucketUser && r.updateBitbucketUser) set('updateBitbucketUser', r.updateBitbucketUser)
      if (!answers.updateBitbucketRepo && r.updateBitbucketRepo) set('updateBitbucketRepo', r.updateBitbucketRepo)
      if ((!answers.updateBitbucketBranch || answers.updateBitbucketBranch === 'master') && r.updateBitbucketBranch) {
        set('updateBitbucketBranch', r.updateBitbucketBranch)
      }
    }).catch(() => {})
  }, [])
  const setUpdateValue = <K extends keyof Answers>(key: K, value: Answers[K]) => {
    set(key, value)
    setTestState('idle')
    setTestMessage(null)
  }
  const enabled = answers.updateNotifications
  const missingToken = enabled && !answers.updateBitbucketToken.trim() && !tokenOnFile
  const missingOwner = answers.updateBitbucketScope === 'user'
    ? !answers.updateBitbucketUser.trim()
    : !answers.updateBitbucketProject.trim()
  const missingFields = enabled && (
    !answers.updateBitbucketUrl.trim() ||
    missingToken ||
    missingOwner ||
    !answers.updateBitbucketRepo.trim() ||
    !answers.updateBitbucketBranch.trim()
  )
  const blocked = enabled && (missingFields || testState !== 'ok')
  useEffect(() => { setNextDisabled(blocked) }, [blocked])
  useEffect(() => {
    if (!enabled) {
      setTestState('idle')
      setTestMessage(null)
    }
  }, [enabled])
  const testConnection = async () => {
    setTestState('testing')
    setTestMessage(null)
    const r = await postJSON<{ ok: boolean; message?: string }>('/api/update/test', {
      url: answers.updateBitbucketUrl,
      token: answers.updateBitbucketToken,
      scope: answers.updateBitbucketScope,
      project: answers.updateBitbucketProject,
      user: answers.updateBitbucketUser,
      repo: answers.updateBitbucketRepo,
      branch: answers.updateBitbucketBranch,
    }).catch((e) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }))
    setTestState(r.ok ? 'ok' : 'error')
    setTestMessage(r.message ?? (r.ok ? 'Connection verified.' : 'Connection failed.'))
  }
  return (
    <section>
      <h2>Dashboard updates</h2>
      <p>Enable dashboard notifications about the available release update (require personal Bitbucket API token).</p>
      <label className={`checkrow${enabled ? ' checked' : ''}`}>
        <input type="checkbox" checked={enabled} onChange={(e) => setUpdateValue('updateNotifications', e.target.checked)} />
        <span className="checkbox" aria-hidden>{enabled ? '✓' : ''}</span>
        <span className="checkrow-label">Show update notifications from Bitbucket</span>
      </label>
      {enabled ? (
        <div className="update-fields">
          <Field label="Bitbucket/Stash URL" hint="Base URL only, for example https://stash.company.com">
            <input value={answers.updateBitbucketUrl} onChange={(e) => setUpdateValue('updateBitbucketUrl', e.target.value)} placeholder="https://stash.company.com" />
          </Field>
          <Field label="Bitbucket token" hint="Stored only in .env.persistent-memory and used by update-runner for read-only release checks.">
            <input type="password" value={answers.updateBitbucketToken} onChange={(e) => setUpdateValue('updateBitbucketToken', e.target.value)} placeholder={tokenOnFile ? '•••• existing token — leave blank to keep' : 'token'} />
          </Field>
          {tokenOnFile ? <p className="notice ok">✓ Existing Bitbucket token found — leave blank to keep it.</p> : null}
          <div className="seg-group">
            <span className="seg-label">Repository owner</span>
            <div className="seg-row">
              <button type="button" className={`seg${answers.updateBitbucketScope === 'project' ? ' active' : ''}`} onClick={() => setUpdateValue('updateBitbucketScope', 'project')}>Project repo</button>
              <button type="button" className={`seg${answers.updateBitbucketScope === 'user' ? ' active' : ''}`} onClick={() => setUpdateValue('updateBitbucketScope', 'user')}>Personal repo</button>
            </div>
          </div>
          {answers.updateBitbucketScope === 'project' ? (
            <Field label="Project key" hint="For URLs like /projects/ENG/repos/example-service/browse">
              <input value={answers.updateBitbucketProject} onChange={(e) => setUpdateValue('updateBitbucketProject', e.target.value)} placeholder="ENG" />
            </Field>
          ) : (
            <Field label="User slug" hint="For URLs like /users/example.user/repos/example-service/browse">
              <input value={answers.updateBitbucketUser} onChange={(e) => setUpdateValue('updateBitbucketUser', e.target.value)} placeholder="example.user" />
            </Field>
          )}
          <Field label="Repository slug">
            <input value={answers.updateBitbucketRepo} onChange={(e) => setUpdateValue('updateBitbucketRepo', e.target.value)} placeholder="example-service" />
          </Field>
          <Field label="Branch">
            <input value={answers.updateBitbucketBranch} onChange={(e) => setUpdateValue('updateBitbucketBranch', e.target.value)} placeholder="master" />
          </Field>
          {missingFields ? <p className="notice warn">Fill every Bitbucket field, or turn update notifications off.</p> : null}
          <div className="row">
            <button type="button" onClick={() => void testConnection()} disabled={missingFields || testState === 'testing'}>{testState === 'testing' ? 'Testing...' : 'Test Bitbucket connection'}</button>
          </div>
          {testState === 'ok' ? <p className="notice ok">{testMessage ?? 'Connection verified.'}</p> : null}
          {testState === 'error' ? <p className="notice bad">{testMessage ?? 'Connection failed.'} Tip: check VPN connection is UP.</p> : null}
        </div>
      ) : (
        <p className="notice">Enable dashboard notifications about the available release update (require personal Bitbucket API token).</p>
      )}
    </section>
  )
}

// ── Ecosystem (detected agent apps) ───────────────────────────────────────────────
interface AppDetect { claudeCli: boolean; claudeDesktop: boolean; codexCli: boolean; codexDesktop: boolean }
function Ecosystem({ apps, setApps, setNextDisabled, appsInited }: StepProps) {
  const [det, setDet] = useState<AppDetect | null>(null)
  useEffect(() => {
    void getJSON<AppDetect>('/api/apps').then((d) => {
      setDet(d)
      // Apply the detected defaults only ONCE — preserve the user's selection if they
      // navigate back to this step and forward again.
      if (!appsInited?.current) {
        setApps({ claudeCli: d.claudeCli, claudeDesktop: d.claudeDesktop, codexCli: d.codexCli, codexDesktop: d.codexDesktop })
        if (appsInited) appsInited.current = true
      }
    }).catch(() => setDet(null))
  }, [])
  const rows: { key: keyof Apps; label: string; present: boolean }[] = det ? [
    { key: 'claudeCli', label: 'Claude CLI', present: det.claudeCli },
    { key: 'claudeDesktop', label: 'Claude Desktop', present: det.claudeDesktop },
    { key: 'codexCli', label: 'Codex CLI', present: det.codexCli },
    { key: 'codexDesktop', label: 'Codex Desktop', present: det.codexDesktop },
  ] : []
  const any = Object.values(apps).some(Boolean)
  useEffect(() => { setNextDisabled(!any) }, [any])
  return (
    <section>
      <h2>Register the MCP with…</h2>
      <p>Detected agent apps on this machine. Undetected ones are disabled.</p>
      {!det ? <p>Detecting installed apps…</p> : (
        <div className="checklist">
          {rows.map((r) => {
            const checked = apps[r.key]
            const tag = !r.present ? 'not detected' : ''
            return (
              <label key={r.key} className={`checkrow${checked ? ' checked' : ''}${!r.present ? ' disabled' : ''}`}>
                <input type="checkbox" checked={checked} disabled={!r.present} onChange={(e) => setApps({ ...apps, [r.key]: e.target.checked })} />
                <span className="checkbox" aria-hidden>{checked ? '✓' : ''}</span>
                <span className="checkrow-label">{r.label}</span>
                {tag ? <span className="checkrow-tag">{tag}</span> : null}
              </label>
            )
          })}
        </div>
      )}
    </section>
  )
}

// ── Registration: runtime architecture + scope, driven by the apps picked in Ecosystem ──────
function Registration({ answers, set, apps, setNextDisabled, flow }: StepProps) {
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
      else if (r.unsupported) setPickNote('The system folder picker runs on macOS/Linux only — type or paste the absolute path here.')
    } catch { setPickNote('Could not open the folder picker — type or paste the absolute path here.') }
  }
  // Project scope needs ≥1 folder (Claude + Codex both write per-folder configs).
  const blocked = isProject && nonEmptyPaths.length === 0
  useEffect(() => { setNextDisabled(blocked) }, [blocked])

  return (
    <section>
      <h2>Registration</h2>
      <p>persistent-memory is added to the MCP config of the apps you picked. Your other MCP servers are left
        untouched, and re-running the installer just updates this one entry. Config files are saved private to
        your user (owner read/write only).</p>
      <div className="seg-group">
        <span className="seg-label">MCP runtime</span>
        <div className="seg-row">
          <button type="button" className="seg active" disabled={!streamAvailable} onClick={() => set('mcpRuntime', 'stream')}>Stream MCP service</button>
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
        <div className="folders">
          <span className="field-label">Project folders <span className="seg-hint">· pick via the system dialog, or type/paste an absolute path</span></span>
          {answers.projectPaths.map((p, i) => (
            <div key={i} className="row">
              <input value={p} placeholder="/abs/path/to/project" onChange={(e) => setPath(i, e.target.value)} />
              <button type="button" className="folders-choose" onClick={() => void pickFolder(i)}>📁 Choose…</button>
              <button type="button" className="folders-del" onClick={() => delPath(i)}>✕</button>
            </div>
          ))}
          <button type="button" className="folders-add" onClick={addPath}>+ Add folder</button>
          {pickNote && <p className="field-hint">{pickNote}</p>}
        </div>
      )}
      <div className="notice">
        <b>What gets registered</b>
        {(apps.claudeCli || apps.claudeDesktop) && (
          <div>{isProject
            ? <>Claude (Code + Desktop folder sessions) → <code>~/.claude.json</code> per folder (<code>projects.&lt;path&gt;</code>).</>
            : <>Claude (Code + Desktop folder sessions) → <code>~/.claude.json</code>. Standalone Desktop chat uses a Claude Custom Connector for the HTTP endpoint.</>}</div>
        )}
        {codex && (
          <div>{isProject
            ? <>{codexLabel} → <code>&lt;folder&gt;/.codex/config.toml</code> per folder — you must <b>trust the folder</b> in Codex for it to load.</>
            : <>{codexLabel} → <code>~/.codex/config.toml</code>.</>}</div>
        )}
      </div>
      <p className="notice">Stream MCP entries carry only the HTTP endpoint. Connector tokens are managed by the local dashboard.</p>
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
        <p className="notice">Select at least one Claude or Codex target to write the memory guidance.</p>
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
      <p>Written to {ruleSpecs.map((s, i) => (
        <span key={i}>{i > 0 ? ' + ' : ''}<code>{isProject ? projPath(s.tail) : s.global}</code></span>
      ))}. Edit freely.{isProject && folders.length > 0 ? <span className="field-hint"> Hover <b>&lt;project_path&gt;</b> for the exact file per folder.</span> : null}</p>
      <Field label={`Top memory block — inserted as the first section under ${memLabel}`} hint={`Any persistent-memory rule reference in this block is rewritten per target (${ruleRefLabel}).`}>
        <textarea value={answers.memoryBlock} rows={8} onChange={(e) => set('memoryBlock', e.target.value)} />
      </Field>
      <Field label="Detailed memory rule prompt — written to persistent-memory.md">
        <textarea value={answers.ruleText} rows={14} onChange={(e) => set('ruleText', e.target.value)} />
      </Field>
    </section>
  )
}

// ── Review .env (full flow) ───────────────────────────────────────────────────────
function Review({ flow, answers, serverPin, setNextDisabled }: { flow: Flow; answers: Answers; serverPin: ServerPin | null; setNextDisabled: (b: boolean) => void }) {
  const [preview, setPreview] = useState<string | null>(null)
  const [issues, setIssues] = useState<{ key: string; message: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void (async () => {
      setNextDisabled(true)
      const personalAndShared = answers.memoryInstallMode === 'personal-and-shared'
      const embedModel = answers.embedModel
      const embedDim = answers.embedDim
      const envAnswers = {
        embeddingMode: answers.embeddingMode, embedProvider: answers.embedProvider, embedModel, embedDim,
        extractionProvider: answers.extractionProvider, extractionModel: answers.extractionModel,
        anthropicApiKey: answers.anthropicApiKey, openaiApiKey: answers.openaiApiKey,
        graphBackend: answers.graphBackend, semaphoreLimit: answers.semaphoreLimit,
        // Review runs when a local stack will exist: full-local, or client flows
        // with isolated personal memory. The local stack is always no-auth/local.
        deploymentMode: 'local' as const,
        // P1 account step — seed the named local team + user (+ optional dashboard password).
        teamName: answers.teamName, userEmail: answers.userEmail, userName: answers.userName,
        userPassword: answers.userPassword,
        mcpRuntime: 'stream' as const,
        personalMemoryEnabled: answers.personalMemoryEnabled,
        memoryInstallMode: answers.memoryInstallMode,
        defaultMemorySurface: answers.defaultMemorySurface,
        personalApiUrl: 'http://localhost:8090',
        sharedApiUrl: personalAndShared ? answers.remoteApiUrl : '',
        sharedUserToken: personalAndShared ? answers.remoteToken : '',
        updateCheckProvider: answers.updateNotifications ? 'bitbucket' as const : 'none' as const,
        updateBitbucketUrl: answers.updateNotifications ? answers.updateBitbucketUrl : '',
        updateBitbucketToken: answers.updateNotifications ? answers.updateBitbucketToken : '',
        updateBitbucketScope: answers.updateBitbucketScope,
        updateBitbucketProject: answers.updateNotifications ? answers.updateBitbucketProject : '',
        updateBitbucketUser: answers.updateNotifications ? answers.updateBitbucketUser : '',
        updateBitbucketRepo: answers.updateNotifications ? answers.updateBitbucketRepo : '',
        updateBitbucketBranch: answers.updateNotifications ? answers.updateBitbucketBranch : 'master',
      }
      try {
        const r = await postJSON<{ preview: string; issues: { key: string; message: string }[] }>('/api/env', { answers: envAnswers })
        setPreview(r.preview); setIssues(r.issues ?? []); setNextDisabled((r.issues ?? []).length > 0)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        setNextDisabled(true)
      }
    })()
  }, [answers, flow, serverPin, setNextDisabled])
  return (
    <section>
      <h2>Review .env.persistent-memory</h2>
      <p>Secrets are masked. Written to <code>.env.persistent-memory</code> (gitignored).</p>
      {error ? <p className="notice bad">{error}</p> : null}
      {issues.length > 0 ? (
        <div className="notice bad">
          Missing required value(s): {issues.map((i) => <code key={i.key}>{i.key}</code>)}
        </div>
      ) : null}
      <div className="review-env-terminal">
        {preview ? <Terminal lines={[preview]} /> : <p>Generating…</p>}
      </div>
    </section>
  )
}

// ── Install (flow-aware body) ─────────────────────────────────────────────────────
function Install({ flow, body, onToken, onDone }: { flow: Flow; body: InstallBody; onToken: (t: string) => void; onDone: () => void }) {
  const [steps, setSteps] = useState<{ id: string; name: string; state: StepState }[]>([])
  const [log, setLog] = useState<string[]>([])
  const [doneCount, setDoneCount] = useState(0)
  const [failed, setFailed] = useState(false)
  const [running, setRunning] = useState(true)
  useEffect(() => {
    void streamNDJSON('/api/install', body, (e) => {
      switch (e.type) {
        case 'run-start': setSteps((e.steps as { id: string; name: string }[]).map((s) => ({ ...s, state: 'pending' }))); break
        case 'step-start': setSteps((ss) => ss.map((s) => (s.id === e.id ? { ...s, state: 'running' } : s))); break
        case 'stdout': setLog((l) => [...l.slice(-400), String(e.chunk)]); break
        case 'step-done': setSteps((ss) => ss.map((s) => (s.id === e.id ? { ...s, state: e.ok ? 'done' : 'failed' } : s))); if (e.ok) setDoneCount((c) => c + 1); break
        case 'token': if (e.token) onToken(String(e.token)); break
        case 'error': setFailed(true); setRunning(false); break
        case 'done':
          setRunning(false)
          if (e.ok) onDone()
          break
      }
    })
  }, [])
  const total = steps.length || 1
  const title = failed ? 'Install failed' : running ? 'Installing' : 'Install complete'
  const sub = body.memoryInstallMode === 'personal-and-shared'
    ? 'Bringing up the local personal stack, connecting Shared Memories, then registering the stream MCP. ~5–10 min.'
    : 'Bringing up the local personal stack, then registering the stream MCP and writing the rule. ~5–10 min.'
  return (
    <section>
      <h2>{title}</h2>
      <p>{sub}</p>
      <ProgressBar value={doneCount / total} tone={failed ? 'danger' : 'accent'} />
      <StepList steps={steps} />
      <Terminal lines={log} caret={running} />
      {failed && <p className="notice bad">A step failed — see the output above. Fix the issue and re-run <code>npm run install-persistent-memory</code>.</p>}
    </section>
  )
}

// ── Done (flow-aware) ───────────────────────────────────────────────────────────
function Done({ flow, token, apps, passwordConfigured }: { flow: Flow; token: string | null; remoteToken: string; apps: Apps; passwordConfigured: boolean }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { if (token) { try { void navigator.clipboard.writeText(token) } catch { /* ignore */ } setCopied(true); setTimeout(() => setCopied(false), 1600) } }
  const go = async () => {
    const fin = await getJSON<{ dashboardUrl: string }>('/api/finish').catch(() => ({ dashboardUrl: LOCAL_DASHBOARD_URL }))
    void fetch('/api/shutdown', { method: 'POST' }).catch(() => {})
    window.location.assign(fin.dashboardUrl)
  }
  return (
    <section>
      <div className="done-head">
        <div className="done-check" aria-hidden>✓</div>
        <h2>Installed</h2>
      </div>
      {token ? (
        <div className="notice token">
          <strong>Bootstrap super-admin token · shown once</strong>
          <div className="token-line">
            <code className="tokenval">{token}</code>
            <button type="button" className="copy-btn" onClick={copy}>{copied ? 'copied ✓' : 'copy'}</button>
          </div>
          <p>Use it to log into the dashboard — it won’t be shown again.</p>
        </div>
      ) : flow === 'full' ? (
        <p className="notice ok">
          {passwordConfigured
            ? <>Local mode is protected. <b>Go to dashboard opens the local login screen first.</b></>
            : <>Local mode opens directly to Personal Overview with <b>no login</b>, so there’s no token to copy.</>}
        </p>
      ) : (
        <p className="notice">Your MCP config was written with the token you provided.</p>
      )}
      {(() => {
        const restart = [
          apps.claudeCli && 'Claude CLI',
          apps.claudeDesktop && 'Claude Desktop',
          apps.codexCli && 'Codex CLI',
          apps.codexDesktop && 'Codex Desktop',
        ].filter(Boolean).join(', ')
        return restart ? <p className="notice">Restart {restart} to load the new MCP + memory rule.</p> : null
      })()}
      {flow === 'full' ? (
        <div className="row"><button className="primary" onClick={() => void go()}>Go to dashboard →</button></div>
      ) : (
        <div className="row"><button className="primary" onClick={() => void fetch('/api/shutdown', { method: 'POST' }).catch(() => {})}>Done</button></div>
      )}
    </section>
  )
}
