'use client'

import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import type { KnowledgeCatalog, KnowledgeResolution } from '@/lib/knowledge'
import { getMemoryCatalogAction } from './actions'

export function ClassificationCatalog({ resolutions, onChange }: { resolutions: KnowledgeResolution[]; onChange: (value: KnowledgeResolution[]) => void }) {
  const [catalog, setCatalog] = useState<KnowledgeCatalog | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = async (cursor?: string) => {
    setLoading(true); setError('')
    try { setCatalog(await getMemoryCatalogAction(cursor)) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Catalog unavailable. Try again before saving unknown names.') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const change = (index: number, patch: Partial<KnowledgeResolution>) => onChange(resolutions.map((item, at) => at === index ? { ...item, ...patch } : item))
  return <section className="memory-record-section">
    <div className="section-label">Available classifications</div>
    {loading ? <p className="note">Loading catalog…</p> : null}
    {error ? <p className="notice danger" role="alert">{error}</p> : null}
    {catalog ? <>
      <div className="memory-detail-badges">{catalog.classifications.map(item => <span key={`${item.kind}:${item.name}`} className="chip">{item.kind} · {item.name}{item.aliases.length ? ` (${item.aliases.join(', ')})` : ''}</span>)}</div>
      {!catalog.classifications.length ? <p className="note">No registered classifications on this page.</p> : null}
      <div className="btn-row"><button type="button" className="btn sm secondary" disabled={loading} onClick={() => void load()}>First page</button>{catalog.nextCursor ? <button type="button" className="btn sm secondary" disabled={loading} onClick={() => void load(catalog.nextCursor!)}>Next page</button> : null}</div>
    </> : <button type="button" className="btn sm secondary" disabled={loading} onClick={() => void load()}>Retry catalog</button>}
    <p className="note">Use existing names or aliases. Register a new classification only when its meaning is clear; the server rejects ambiguous aliases.</p>
    {resolutions.map((item, index) => <div key={index} className="new-memory-field">
      <div className="new-memory-grid">
        <Select ariaLabel={`New classification ${index + 1} kind`} value={item.kind} onChange={kind => change(index, { kind: kind as KnowledgeResolution['kind'] })} options={['topic', 'project', 'system'].map(value => ({ value, label: value }))} />
        <Input aria-label={`New classification ${index + 1} name`} value={item.name} onChange={event => change(index, { name: event.target.value })} placeholder="New classification name" />
        <Input aria-label={`New classification ${index + 1} reason`} value={item.reason} onChange={event => change(index, { reason: event.target.value })} placeholder="Why a new classification is needed" />
      </div>
      <button type="button" className="btn sm secondary" onClick={() => onChange(resolutions.filter((_, at) => at !== index))}>Remove classification registration</button>
    </div>)}
    <button type="button" className="btn sm secondary" disabled={resolutions.length >= 8} onClick={() => onChange([...resolutions, { kind: 'topic', name: '', action: 'create', reason: '' }])}>Register a new classification</button>
  </section>
}
