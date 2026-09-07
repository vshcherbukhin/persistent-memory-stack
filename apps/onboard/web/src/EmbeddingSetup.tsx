import { useEffect, useState } from 'react'
import { RESOURCE_MODELS, evaluateResources, recommendResources, type ResourceProvider, type ResourceSnapshot } from '../../shared/resource-policy'
import { getJSON, postJSON, streamNDJSON } from './api'
import { Field, Terminal } from './components'
import { ResourceSummary } from './ResourceSummary'
import { modelPresence } from './flow'
import { PrereqProgress } from './PrereqProgress'
import { prereqProgressEvent, type PrereqProgressState } from './prereq-progress'

export interface EmbeddingAnswers {
  embedProvider: ResourceProvider
  embedModel: string
  embedDim: number
  openaiApiKey: string
  voyageApiKey: string
  resourceAcknowledged: boolean
}

export function embeddingTestSignature(answers: EmbeddingAnswers): string {
  const key = answers.embedProvider === 'voyage' ? answers.voyageApiKey : answers.openaiApiKey
  return `${answers.embedProvider}\n${answers.embedModel}\n${answers.embedDim}\n${key.trim()}`
}

const MODEL_NOTES: Record<string, string> = {
  'text-embedding-3-small': 'Recommended for value · lower API cost and smaller vectors',
  'text-embedding-3-large': 'Higher retrieval quality · higher API cost and vector storage',
  'voyage-4': 'Recommended for Voyage · balanced retrieval quality and efficiency',
  'voyage-4-large': 'Highest retrieval quality in the Voyage 4 family',
  'voyage-4-lite': 'Lower latency and cost in the Voyage 4 family',
  'voyage-3-large': 'Previous generation · retained for your existing configuration',
  'nomic-embed-text': 'Smallest supported local model · lighter memory use',
  'qwen3-embedding:0.6b': 'Compact multilingual local model',
  'qwen3-embedding:4b': 'Larger local model · substantial memory required',
  'qwen3-embedding:8b': 'Largest local option · for machines with ample memory',
}

export function EmbeddingSetup({ answers, set, resources, resourceError, refreshResources, setNextDisabled, tested, setTested }: {
  answers: EmbeddingAnswers
  set: <K extends keyof EmbeddingAnswers>(key: K, value: EmbeddingAnswers[K]) => void
  resources: ResourceSnapshot | null
  resourceError: string | null
  refreshResources: () => Promise<void>
  setNextDisabled: (value: boolean) => void
  tested: string
  setTested: (value: string) => void
}) {
  const [models, setModels] = useState<string[]>([])
  const [ollamaReady, setOllamaReady] = useState(false)
  const [savedKeys, setSavedKeys] = useState({ openai: false, voyage: false })
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string; details?: string } | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [progress, setProgress] = useState<PrereqProgressState | null>(null)
  const local = answers.embedProvider === 'ollama'
  const key = answers.embedProvider === 'voyage' ? answers.voyageApiKey : answers.openaiApiKey
  const keyPresent = Boolean(key.trim()) || (answers.embedProvider === 'voyage' ? savedKeys.voyage : savedKeys.openai)
  const signature = embeddingTestSignature(answers)
  const assessment = resources ? evaluateResources(resources, { provider: answers.embedProvider, model: answers.embedModel }) : null
  const recommendation = resources ? recommendResources(resources) : null
  const warningsAccepted = !assessment?.warnings.length || answers.resourceAcknowledged
  const testPassed = tested === signature
  const checkOllama = async () => {
    const status = await getJSON<{ models: string[]; ollama: { ok: boolean } }>('/api/prereqs')
    setModels(status.models); setOllamaReady(status.ollama.ok)
  }
  useEffect(() => {
    let active = true
    void getJSON<{ openaiKeyPresent: boolean; voyageKeyPresent: boolean }>('/api/env/existing').then(r => { if (active) setSavedKeys({ openai: r.openaiKeyPresent, voyage: r.voyageKeyPresent }) }).catch(() => {})
    void checkOllama().catch(() => setOllamaReady(false))
    return () => { active = false }
  }, [])
  useEffect(() => { setNextDisabled(busy || !assessment?.allowed || !warningsAccepted || (local ? !ollamaReady : !keyPresent || !testPassed)) }, [busy, assessment?.allowed, warningsAccepted, local, ollamaReady, keyPresent, testPassed])
  const select = (provider: ResourceProvider, model?: string) => {
    if (!model && provider === 'voyage') model = 'voyage-4'
    const choice = RESOURCE_MODELS.find(item => item.provider === provider && (!model || item.model === model))!
    set('embedProvider', choice.provider); set('embedModel', choice.model); set('embedDim', choice.dim); set('resourceAcknowledged', false)
    setResult(null); setTested('')
  }
  const test = async () => {
    setBusy(true); setResult(null); setTested('')
    try {
      const response = await postJSON<{ ok: boolean; message: string; details?: string }>('/api/embedding/test', { provider: answers.embedProvider, model: answers.embedModel, dim: answers.embedDim, apiKey: local ? '' : key, resourceAcknowledged: answers.resourceAcknowledged })
      setResult(response); if (response.ok) setTested(signature)
    } catch (error) { setResult({ ok: false, message: error instanceof Error ? error.message : String(error) }) }
    finally { setBusy(false) }
  }
  const prepareOllama = async () => {
    setBusy(true); setResult(null); setLog([])
    setProgress({ label: 'Preparing Ollama' })
    try {
      let failed: string | null = null
      await streamNDJSON('/api/prereqs/install', { component: 'ollama', resourceAcknowledged: answers.resourceAcknowledged }, event => {
        const update = prereqProgressEvent(event)
        if (update) setProgress(update)
        if (event.type === 'stdout') setLog(lines => [...lines.slice(-100), String(event.chunk)])
        if (event.type === 'error') failed = String(event.message ?? 'Ollama preparation failed. Check the output and retry.')
      })
      if (failed) throw new Error(failed)
      await checkOllama(); await refreshResources()
    } catch (error) { setResult({ ok: false, message: error instanceof Error ? error.message : String(error) }) }
    finally { setBusy(false); setProgress(null) }
  }
  return <section>
    <h2>Embeddings</h2>
    <p>Choose where memory text is converted to vectors. Your memory database stays on this computer with either option.</p>
    {recommendation ? <div className="notice"><b>Suggested for this computer: {recommendation.model}</b><p>{recommendation.reason}</p>{answers.embedModel !== recommendation.model ? <button type="button" disabled={busy} onClick={() => select(recommendation.provider, recommendation.model)}>Use suggested option</button> : null}</div> : <p className="notice warn">{resourceError ?? 'Checking machine resources…'}</p>}
    <div className="seg-group"><span className="seg-label">Embedding provider</span><div className="seg-row">
      {(['openai', 'voyage', 'ollama'] as const).map(provider => <button type="button" key={provider} className={`seg${answers.embedProvider === provider ? ' active' : ''}`} disabled={busy || (provider === 'ollama' && !recommendation?.localEnabled)} onClick={() => select(provider)}>{provider === 'ollama' ? 'Ollama · local' : provider === 'openai' ? 'OpenAI · API' : 'Voyage · API'}</button>)}
    </div></div>
    {recommendation && !recommendation.localEnabled ? <p className="notice warn">Local Ollama is unavailable because even the smallest supported model does not meet this installation’s minimum resource budget. Use a remote embedding API, or free resources and check again.</p> : null}
    <div className="modellist">{RESOURCE_MODELS.filter(item => item.provider === answers.embedProvider && (item.model !== 'voyage-3-large' || answers.embedModel === item.model)).map(item => <button type="button" className={`modelrow${answers.embedModel === item.model ? ' active' : ''}`} key={item.model} disabled={busy} onClick={() => select(item.provider, item.model)}>
      <span className="modelradio" aria-hidden /><span className="modelrow-main"><span className="modelrow-name">{item.model}</span> <span className="modelrow-dim">{item.dim} dimensions</span><span className="modelrow-note">{MODEL_NOTES[item.model]}</span></span>
      <span className="modelrow-ram">RAM: {item.budget.minimum.hostMemoryGiB} GiB min / {item.budget.recommended.hostMemoryGiB} GiB recommended</span>
      {local ? <span className="modelrow-rec">{modelPresence(models, item.model) === 'installed' ? 'installed' : 'downloaded during installation'}</span> : null}
    </button>)}</div>
    {resources && assessment ? <ResourceSummary snapshot={resources} assessment={assessment} acknowledged={answers.resourceAcknowledged} onAcknowledge={value => set('resourceAcknowledged', value)} /> : null}
    <button type="button" disabled={busy} onClick={() => void refreshResources()}>Check resources again</button>
    {!local ? <>
      {answers.embedProvider === 'voyage' ? <p className="field-hint">Anthropic recommends Voyage for embeddings. A Claude / Anthropic API key cannot be used here; Voyage requires its own API key.</p> : null}
      <p className="notice">Embedding requests send memory and search text to {answers.embedProvider === 'openai' ? 'OpenAI' : 'Voyage'}. An internet connection and provider API billing are required. The connection test sends a short sample and may incur a small charge.</p>
      <Field label={answers.embedProvider === 'voyage' ? 'Voyage API key' : 'OpenAI API key'} hint={answers.embedProvider === 'openai' ? 'Also used if you choose OpenAI for fact extraction. Saved locally and masked in review.' : 'Saved locally and masked in review.'}><input type="password" autoComplete="off" value={key} placeholder={keyPresent && !key ? 'Existing key — leave blank to keep' : 'Paste your provider API key'} onChange={event => { set(answers.embedProvider === 'voyage' ? 'voyageApiKey' : 'openaiApiKey', event.target.value); setResult(null); setTested('') }} /></Field>
      <button type="button" disabled={busy || !keyPresent || !assessment?.allowed || !warningsAccepted} onClick={() => void test()}>{busy ? 'Testing…' : 'Test embedding connection'}</button>
      {!testPassed ? <p className="field-hint">A successful connection test is required before continuing with API embeddings.</p> : null}
      {testPassed && !result ? <p className="notice ok">Embedding connection verified for this model and key.</p> : null}
    </> : <>
      {!ollamaReady ? <><p className="notice warn">Ollama must be installed and running for local embeddings. The model itself is downloaded later.</p><button type="button" disabled={busy || !assessment?.allowed || !warningsAccepted} onClick={() => void prepareOllama()}>Install / start Ollama</button></> : <p className="notice ok">Ollama is ready. Installation will reuse the selected model or download it once.</p>}
      {modelPresence(models, answers.embedModel) === 'installed' ? <button type="button" disabled={busy || !assessment?.allowed || !warningsAccepted} onClick={() => void test()}>{busy ? 'Testing…' : 'Test local embedding model'}</button> : null}
    </>}
    {result ? <p className={`notice ${result.ok ? 'ok' : 'bad'}`} role="status">{result.message} {result.details}</p> : null}
    {progress ? <PrereqProgress progress={progress} component="Ollama" /> : null}
    {log.length ? <Terminal lines={log} /> : null}
    <p className="notice warn">Changing the embedding model or dimensions after storing memories requires a re-embedding migration from the dashboard. Setup preserves an existing corpus’s model.</p>
  </section>
}
