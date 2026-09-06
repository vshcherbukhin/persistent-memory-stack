/**
 * Wizard flow graph — pure (no React) so it's unit-testable in a node env.
 * V1 keeps legacy flow ids as migration aliases, but every path is personal-first:
 * configure the local stack, optionally connect Shared Memories, then install.
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
  full: ['flow', 'prereqs', 'account', 'embedding', 'extraction', 'ecosystem', 'registration', 'rule', 'review', 'shared', 'install', 'done'],
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

export interface PrereqGateState {
  node: { ok: boolean }
  docker: { ok: boolean }
  compose: { ok: boolean }
  ollama: { ok: boolean }
}

export function prereqsBlocked(flow: Flow, p: PrereqGateState | null, options: FlowOptions = {}): boolean {
  if (!p) return true
  return !p.node.ok || !p.docker.ok || !p.compose.ok || !p.ollama.ok
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
