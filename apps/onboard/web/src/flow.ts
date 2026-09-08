/**
 * Wizard flow graph — pure (no React) so it's unit-testable in a node env.
 * The public full flow installs Personal Memories only. Legacy flow ids retain
 * their existing optional server-connection step for operator compatibility.
 */
export type Flow = 'full' | 'engine' | 'mcp'

export type Phase =
  | 'flow'
  | 'prereqs'
  | 'account'
  | 'remote'
  | 'embedding'
  | 'pullModel'
  | 'extraction'
  | 'ecosystem'
  | 'registration'
  | 'rule'
  | 'review'
  | 'shared'
  | 'install'
  | 'done'

export const FLOW_PHASES: Record<Flow, Phase[]> = {
  full: ['flow', 'prereqs', 'account', 'embedding', 'extraction', 'ecosystem', 'registration', 'rule', 'review', 'install', 'done'],
  engine: ['flow', 'prereqs', 'account', 'embedding', 'extraction', 'ecosystem', 'registration', 'rule', 'review', 'shared', 'install', 'done'],
  mcp: ['flow', 'prereqs', 'account', 'embedding', 'extraction', 'ecosystem', 'registration', 'rule', 'review', 'shared', 'install', 'done'],
}

export interface FlowOptions {
  personalMemoryEnabled?: boolean
}

export function phasesFor(flow: Flow, options: FlowOptions = {}): Phase[] {
  return FLOW_PHASES[flow]
}

export function nextPhase(cur: Phase, flow: Flow, options: FlowOptions = {}): Phase | null {
  const seq = phasesFor(flow, options)
  const i = seq.indexOf(cur)
  return i === -1 || i === seq.length - 1 ? null : seq[i + 1]!
}

export function prevPhase(cur: Phase, flow: Flow, options: FlowOptions = {}): Phase | null {
  const seq = phasesFor(flow, options)
  const i = seq.indexOf(cur)
  return i <= 0 ? null : seq[i - 1]!
}

interface MemorySettings {
  personalMemoryEnabled: boolean
  memoryInstallMode: 'shared-only' | 'personal-only' | 'personal-and-shared'
  defaultMemorySurface: 'personal' | 'shared'
  remoteApiUrl: string
  remoteOllamaUrl: string
  remoteToken: string
}

/** Normalize both env review and install submissions, so stale connector state
 * cannot activate a server connection in the public personal-only wizard. */
export function memorySettingsForFlow(flow: Flow, answers: MemorySettings, serverModel?: string) {
  const personalOnly = flow === 'full'
  const shared = !personalOnly && answers.memoryInstallMode === 'personal-and-shared'
  return {
    personalMemoryEnabled: personalOnly ? true : answers.personalMemoryEnabled,
    memoryInstallMode: personalOnly ? 'personal-only' as const : answers.memoryInstallMode,
    defaultMemorySurface: personalOnly ? 'personal' as const : answers.defaultMemorySurface,
    remoteApiUrl: personalOnly ? '' : answers.remoteApiUrl,
    remoteOllamaUrl: personalOnly ? '' : answers.remoteOllamaUrl,
    remoteToken: personalOnly ? '' : answers.remoteToken,
    sharedApiUrl: shared ? answers.remoteApiUrl : undefined,
    sharedUserToken: shared ? answers.remoteToken : undefined,
    pullModel: shared ? serverModel : undefined,
  }
}

export interface PrereqGateState {
  node: { ok: boolean }
  docker: { ok: boolean }
  compose: { ok: boolean }
  ollama: { ok: boolean }
}

export function prereqsBlocked(flow: Flow, p: PrereqGateState | null, options: FlowOptions = {}): boolean {
  if (!p) return true
  // Ollama is optional: a machine that can run the stack with remote APIs must
  // reach the embedding-provider selection even without a local model runtime.
  return !p.node.ok || !p.docker.ok || !p.compose.ok
}

export type ModelPresence = 'installed' | 'will-be-installed'

export function modelPresence(models: string[], selected: string): ModelPresence {
  const norm = (n: string) => (n.includes(':') ? n : `${n}:latest`)
  const wanted = norm(selected)
  return models.some((m) => norm(m) === wanted || m === selected) ? 'installed' : 'will-be-installed'
}

export interface ExtractionGateState {
  apiKeyAvailable: boolean
  testPassed: boolean
}

export function extractionNextBlocked(state: ExtractionGateState): boolean {
  return !state.apiKeyAvailable || !state.testPassed
}
