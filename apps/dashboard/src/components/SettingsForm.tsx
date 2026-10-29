'use client'

import { useActionState, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { Checkbox } from '@/components/ui/Checkbox'
import { Icon } from '@/components/ui/Icon'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import {
  saveFactExtractionAction,
  saveSettingsAction,
  testEmbeddingAction,
  testFactExtractionAction,
  type SettingsState,
} from '@/app/(dashboard)/settings/actions'
import type { FactExtractionProvider, ModelDependencyHealth, Settings, SettingsTestResult } from '@/lib/types'
import { capabilityHealthPresentation } from '@/lib/capabilityHealth'

const initial: SettingsState = {}

/** Known embedding models (mirrors @pm/shared MODEL_REGISTRY) + their canonical dim.
 * The server re-validates the (model, dim) pair; picking a model seeds its dim but the
 * dim stays editable (Matryoshka truncation within qwen3). */
const MODEL_DIMS: Record<string, number> = {
  'qwen3-embedding:0.6b': 1024,
  'qwen3-embedding:4b': 2560,
  'qwen3-embedding:8b': 4096,
  'nomic-embed-text': 768,
  'voyage-3-large': 1024,
  'text-embedding-3-large': 3072,
  'text-embedding-3-small': 1536,
}

function ResultNotice({ result }: { result: SettingsTestResult | null }) {
  if (!result) return null
  const health = result.health ? capabilityHealthPresentation(result.health) : null
  return (
    <div className={`notice ${result.ok ? 'ok' : 'danger'}`} style={{ marginTop: 12 }}>
      <div className="notice-title">{result.ok ? 'Test passed' : 'Test failed'}</div>
      {result.message}
      {result.details ? <div className="muted" style={{ marginTop: 6 }}>{result.details}</div> : null}
      {result.reason ? <div className="muted" style={{ marginTop: 6 }}>{result.reason}</div> : null}
      {health ? (
        <div className="settings-test-health" data-health-state={result.health?.state}>
          <span className={`state-badge ${health.tone}`}>{health.badge}</span>
          <span>{result.health?.safeMessage ?? health.message}</span>
          <span className="muted">Observed {health.observedAt}. Recovery: {health.recovery}</span>
        </div>
      ) : null}
    </div>
  )
}

function CapabilityHealthNotice({ health }: { health: ModelDependencyHealth }) {
  if (health.state === 'healthy' || health.state === 'unknown') return null
  const presentation = capabilityHealthPresentation(health)
  return (
    <div className={`notice ${presentation.tone === 'bad' ? 'danger' : 'warn'}`} data-health-state={health.state} style={{ marginBottom: 14 }}>
      <div className="notice-title">Capability health: {presentation.badge}</div>
      {health.safeMessage ?? presentation.message}
      <div className="muted" style={{ marginTop: 6 }}>Observed {presentation.observedAt}. Recovery: {presentation.recovery}</div>
    </div>
  )
}

export function SettingsForm({
  current,
  deploymentMode,
  showHeader = true,
}: {
  current: Settings
  deploymentMode: 'server' | 'local'
  showHeader?: boolean
}) {
  const router = useRouter()
  const [state, formAction, pending] = useActionState(saveSettingsAction, initial)
  // The embedding topology is an install-time fact, not a dashboard switch.
  // shown read-only below. This page only changes the embedding MODEL within that mode.
  const mode = current.embeddingMode
  const [model, setModel] = useState(current.activeEmbedModel)
  const [dim, setDim] = useState(current.activeEmbedDim)
  const [confirmed, setConfirmed] = useState(false)
  // Prototype d-settings: the pin reads as facts; changing it is a deliberate second step.
  const [editing, setEditing] = useState(false)
  const [testBusy, setTestBusy] = useState(false)
  const [testResult, setTestResult] = useState<SettingsTestResult | null>(null)

  const modeLabel = mode === 'client-bridge' ? 'Client-managed' : deploymentMode === 'local' ? 'Local personal stack' : 'Server-managed'
  // Model options = the known set + the current model if it's custom (so the Select shows it).
  const modelOptions = [...new Set([current.activeEmbedModel, ...Object.keys(MODEL_DIMS)])].map((m) => ({ value: m, label: m }))
  const selectModel = (m: string) => {
    setModel(m)
    if (MODEL_DIMS[m]) setDim(MODEL_DIMS[m]) // seed the canonical dim; still editable below
  }

  const pinChanged = model !== current.activeEmbedModel || dim !== current.activeEmbedDim
  const sw = current.embeddingSwitch
  const switchRunning = sw?.state === 'running'
  // Save is a dirty gate: enabled only when the pin actually changed (and the re-embed is
  // confirmed) — disabled when nothing changed, like the notifications form.
  const canSave = pinChanged && confirmed && !pending && !switchRunning

  const testEmbedding = async () => {
    setTestBusy(true)
    setTestResult(null)
    try {
      setTestResult(await testEmbeddingAction({ activeEmbedModel: model, activeEmbedDim: dim }))
    } catch {
      setTestResult({
        ok: false,
        model,
        message: 'Embedding test did not complete.',
        details: 'The API did not return a completed result. Check capability health and try again.',
      })
    } finally {
      setTestBusy(false)
    }
  }

  return (
    <form action={formAction}>
      {showHeader ? (
        <>
          <h2 className="card-title" style={{ marginBottom: 4 }}>Embeddings</h2>
          <p className="muted" style={{ marginBottom: 14, maxWidth: 680 }}>
            Server-side embedding pin and vector dimension. Model changes trigger the safe re-embed workflow.
          </p>
        </>
      ) : null}

      {/* Preserve the legacy wire alias while showing the topology as read-only. */}
      <input type="hidden" name="embeddingMode" value={mode} />

      <div className="kv settings-pin">
        <div className="kv-row"><span>Active model</span><code>{current.activeEmbedModel}</code></div>
        <div className="kv-row"><span>Dimensions</span><code>{current.activeEmbedDim}</code></div>
        <div className="kv-row"><span>Vector name</span><code>{current.activeVectorName}</code></div>
        <div className="kv-row">
          <span>Topology</span>
          <span className={`settings-pin-mode ${mode === 'server' ? 'ok' : 'warn'}`}>{modeLabel}</span>
        </div>
      </div>
      <p className="field-hint settings-pin-hint">
        {mode === 'server'
          ? 'The embedder runs on the server. The model can change here; the topology itself is fixed at install.'
          : 'No server embedder: each member’s MCP bridges to its local Ollama at the pinned model. Change the pin only when every client can use it.'}
      </p>

      {sw ? (
        <div className={`notice ${sw.state === 'failed' ? 'danger' : sw.state === 'running' ? 'warn' : 'ok'}`}>
          <div className="notice-title">
            Model switch: {sw.state} — {sw.from.model}@{sw.from.dim} → {sw.to.model}@{sw.to.dim}
          </div>
          {sw.state === 'running'
            ? `Re-embedding in the background (${sw.migrated} re-embedded so far). Search stays on the current pin until the flip — no restart. `
            : sw.state === 'failed'
              ? `Failed: ${sw.error ?? 'unknown error'}. The old pin is still active. Fix the cause and re-submit. `
              : `Done — ${sw.migrated} memories/chunks re-embedded onto the new pin. `}
          <button type="button" className="link" onClick={() => router.refresh()} style={{ marginLeft: 6 }}>
            Refresh status
          </button>
        </div>
      ) : null}

      <CapabilityHealthNotice health={current.capabilityHealth.embeddings} />

      {/* Always-on caution (verbatim from the install wizard) — the embedding pin is a
          deliberate, hard-to-reverse choice. */}
      <div className="notice with-icon warn">
        <span className="n-ic"><Icon name="warning" size={16} /></span>
        <span className="n-body">
          <span className="notice-title">Choose the embedding pin deliberately</span>
          Switching the model/dim later forces a full <b>re-embed migration</b> of the whole corpus —
          pick deliberately. Matryoshka lets you truncate down (2560 → 1024 → 768…) within qwen3.
        </span>
      </div>

      {!editing ? (
        <div className="btn-row">
          <button type="button" className="btn secondary" disabled={testBusy || switchRunning} onClick={() => void testEmbedding()}>
            {testBusy ? 'Testing…' : 'Test embeddings'}
          </button>
          <button type="button" className="btn secondary" disabled={switchRunning} onClick={() => setEditing(true)}>
            <Icon name="tune" size={15} /> Change embedding pin…
          </button>
          {switchRunning ? <span className="note">A switch is already running — wait for it to finish.</span> : null}
          {state.ok && !state.error ? (
            <span className="inline-icon-label settings-saved">
              <Icon name="check" size={14} />
              Saved &amp; persisted
            </span>
          ) : null}
        </div>
      ) : (
        <div className="settings-form-stack">
          {pinChanged ? (
            <div className="notice warn">
              <div className="notice-title">Re-embed migration</div>
              Changing the pin to <strong>{model}@{dim}</strong> re-embeds the entire corpus in the
              background for server-managed embeddings — search stays on the current pin until the new one is fully built, then
              flips automatically. No restart. With client-managed embeddings the server cannot re-embed: each
              member must re-pull the model locally and restart their MCP.
              <div style={{ marginTop: 10 }}>
                <Checkbox checked={confirmed} onChange={setConfirmed} label="I understand this re-embeds the corpus." />
              </div>
            </div>
          ) : null}

          <div className="field">
            <span className="field-label">Active model</span>
            <Select name="activeEmbedModel" ariaLabel="Active embedding model" value={model} onChange={selectModel} options={modelOptions} />
          </div>

          <div className="settings-field-grid">
            <div className="field">
              <label className="field-label" htmlFor="dim">Active dim</label>
              <Input
                id="dim"
                name="activeEmbedDim"
                type="number"
                min={1}
                value={dim}
                onChange={(e) => setDim(Number(e.target.value))}
                className="mono"
              />
            </div>
            <div className="field">
              <span className="field-label">Vector name (derived)</span>
              <Input className="mono" type="text" value={current.activeVectorName} disabled readOnly />
            </div>
          </div>

          <div className="btn-row">
            <button type="button" className="btn secondary" disabled={testBusy || switchRunning} onClick={() => void testEmbedding()}>
              {testBusy ? 'Testing…' : 'Test embeddings'}
            </button>
            <button type="submit" className="btn primary" disabled={!canSave}>
              {pending ? 'Saving…' : pinChanged ? 'Switch model' : 'Save pin'}
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setEditing(false)
                setModel(current.activeEmbedModel)
                setDim(current.activeEmbedDim)
                setConfirmed(false)
                setTestResult(null)
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <ResultNotice result={testResult} />

      {state.error ? (
        <div className="notice danger" style={{ marginTop: 14 }}>
          {state.error}
        </div>
      ) : null}
      {state.ok ? (
        <div
          className={state.modelChanged ? 'notice warn' : 'notice ok'}
          style={{ marginTop: 14 }}
        >
          Saved. {state.warning ?? 'Mode/pin updated. (No model change — data-safe.)'}
          {state.switchStarted ? (
            <>
              {' '}
              <button type="button" className="link" onClick={() => router.refresh()}>
                Refresh status
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </form>
  )
}

function providerLabel(provider: FactExtractionProvider): string {
  return provider === 'anthropic' ? 'Claude' : 'OpenAI'
}

export function FactExtractionForm({ current, showHeader = true }: { current: Settings; showHeader?: boolean }) {
  const router = useRouter()
  const [state, formAction, pending] = useActionState(saveFactExtractionAction, initial)
  const base = current.factExtraction
  const options = [...base.availableModels]
  if (!options.some((option) => option.value === base.model)) {
    options.unshift({ value: base.model, label: `${base.model} (current)`, provider: base.provider })
  }
  const [model, setModel] = useState(base.model)
  const [apiKey, setApiKey] = useState('')
  const [testBusy, setTestBusy] = useState(false)
  const [testResult, setTestResult] = useState<SettingsTestResult | null>(null)
  const [tested, setTested] = useState(false)

  const selected = options.find((option) => option.value === model)
  const provider = selected?.provider ?? base.provider
  const key = base.keys[provider]
  const dirty = model !== base.model || apiKey.trim().length > 0

  const resetTest = () => {
    setTested(false)
    setTestResult(null)
  }

  const selectModel = (next: string) => {
    setModel(next)
    resetTest()
  }

  // Prototype d-settings: the provider is a segmented choice and the model list follows it.
  const providers = [...new Set(options.map((option) => option.provider))]
  const selectProvider = (next: FactExtractionProvider) => {
    if (next === provider) return
    const first = options.find((option) => option.provider === next)
    if (first) selectModel(first.value)
  }

  const testFactExtraction = async () => {
    setTestBusy(true)
    setTestResult(null)
    setTested(false)
    try {
      const result = await testFactExtractionAction({
        model,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      setTestResult(result)
      setTested(result.ok)
    } catch {
      setTestResult({
        ok: false,
        model,
        message: 'Fact extraction test did not complete.',
        details: 'The API did not return a completed result. Check capability health and try again.',
      })
    } finally {
      setTestBusy(false)
    }
  }

  return (
    <form action={formAction}>
      {showHeader ? (
        <>
          <h2 className="card-title" style={{ marginBottom: 4 }}>Fact extraction</h2>
          <p className="muted" style={{ marginBottom: 14, maxWidth: 680 }}>
            Memory Shape-gate model and provider key. Saves use a backend seeded probe unless this form was tested successfully first.
          </p>
        </>
      ) : null}

      <input type="hidden" name="factExtractionTested" value={tested ? 'true' : 'false'} />

      <div className="settings-form-stack">
        <CapabilityHealthNotice health={current.capabilityHealth.factExtraction} />
        {providers.length > 1 ? (
          <div className="field">
            <span className="field-label">Provider</span>
            <SegmentedControl
              ariaLabel="Fact extraction provider"
              value={provider}
              onChange={selectProvider}
              options={providers.map((value) => ({ value, label: providerLabel(value) }))}
            />
          </div>
        ) : null}

        <div className="field">
          <span className="field-label">Model</span>
          <Select
            name="factExtractionModel"
            ariaLabel="Fact extraction model"
            value={model}
            onChange={selectModel}
            options={options
              .filter((option) => providers.length < 2 || option.provider === provider)
              .map((option) => ({ value: option.value, label: option.label }))}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="fact-api-key">API key for {providerLabel(provider)}</label>
          <Input
            id="fact-api-key"
            name="factExtractionApiKey"
            type="password"
            value={apiKey}
            placeholder={key.masked ? `Leave blank to keep ${key.masked}` : 'Paste API key'}
            onChange={(event) => {
              setApiKey(event.target.value)
              resetTest()
            }}
          />
          <span className={`field-hint${key.hasKey ? '' : ' warn'}`}>
            {key.hasKey
              ? `Current ${providerLabel(provider)} key source: ${key.source}. Leave blank to keep it.`
              : `No ${providerLabel(provider)} key is configured yet.`}
          </span>
        </div>

        <div className="btn-row">
          <button type="button" className="btn secondary" disabled={testBusy} onClick={() => void testFactExtraction()}>
            {testBusy ? 'Testing…' : 'Test fact extraction'}
          </button>
          <button type="submit" className="btn primary" disabled={pending || !dirty}>
            {pending ? 'Saving…' : 'Save fact extraction'}
          </button>
          {tested ? <span className="note">Tested for this model and key.</span> : null}
        </div>
      </div>

      <ResultNotice result={testResult} />
      {state.error ? <div className="notice danger" style={{ marginTop: 14 }}>{state.error}</div> : null}
      {state.ok ? (
        <div className="notice ok" style={{ marginTop: 14 }}>
          Saved fact extraction settings.
          <button type="button" className="link" onClick={() => router.refresh()} style={{ marginLeft: 6 }}>
            Refresh
          </button>
        </div>
      ) : null}
    </form>
  )
}
