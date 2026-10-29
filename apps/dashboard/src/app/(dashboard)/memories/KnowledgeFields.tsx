'use client'

import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import type { ClassificationDraft, KnowledgeSource } from '@/lib/knowledge'

const choices = (values: string[]) => values.map(value => ({ value, label: value.replaceAll('_', ' ') }))

export function KnowledgeFields({ draft, onChange }: { draft: ClassificationDraft; onChange: (draft: ClassificationDraft) => void }) {
  const set = <K extends keyof ClassificationDraft>(key: K, value: ClassificationDraft[K]) => onChange({ ...draft, [key]: value })
  const source = (index: number, patch: Partial<KnowledgeSource>) => set('sources', draft.sources.map((current, at) => at === index ? { ...current, ...patch } : current))
  return (
    <>
      <div className="new-memory-grid">
        <label className="new-memory-field"><span className="label">Memory type</span><Select ariaLabel="Memory type" value={draft.memoryType || null} onChange={value => set('memoryType', value as ClassificationDraft['memoryType'])} options={choices(['fact', 'decision', 'preference', 'procedure', 'event', 'constraint'])} /></label>
        <label className="new-memory-field"><span className="label">Assertion status</span><Select ariaLabel="Assertion status" value={draft.assertionStatus || null} onChange={value => set('assertionStatus', value as ClassificationDraft['assertionStatus'])} options={choices(['fact', 'observation', 'proposal', 'inference'])} /></label>
      </div>
      <p className="note">A source-reported assertion is not independently verified. Keep proposals and inferences explicit.</p>
      <div className="new-memory-grid">
        <label className="new-memory-field"><span className="label">Primary topic</span><Input value={draft.primaryTopic} onChange={event => set('primaryTopic', event.target.value)} placeholder="memory-retrieval" /></label>
        <label className="new-memory-field"><span className="label">Topic tags</span><Input value={draft.topicTags} onChange={event => set('topicTags', event.target.value)} placeholder="memory-retrieval, testing" /><small>Comma separated; include the primary topic.</small></label>
      </div>
      <div className="new-memory-grid">
        <label className="new-memory-field"><span className="label">Origin context</span><Select ariaLabel="Origin context" value={draft.originKind || null} onChange={value => set('originKind', value as ClassificationDraft['originKind'])} options={choices(['general', 'system', 'project'])} /></label>
        {draft.originKind && draft.originKind !== 'general' ? <label className="new-memory-field"><span className="label">Origin name</span><Input value={draft.originName} onChange={event => set('originName', event.target.value)} /></label> : null}
        <label className="new-memory-field"><span className="label">Applicability</span><Select ariaLabel="Applicability" value={draft.applicabilityState || null} onChange={value => onChange({ ...draft, applicabilityState: value as ClassificationDraft['applicabilityState'], ...(value !== 'associated' ? { projects: '', systems: '' } : {}) })} options={choices(['associated', 'general', 'unresolved'])} /></label>
      </div>
      {draft.applicabilityState === 'associated' ? <div className="new-memory-grid">
        <label className="new-memory-field"><span className="label">Applicable projects</span><Input value={draft.projects} onChange={event => set('projects', event.target.value)} placeholder="Comma separated" /></label>
        <label className="new-memory-field"><span className="label">Applicable systems</span><Input value={draft.systems} onChange={event => set('systems', event.target.value)} placeholder="Comma separated" /></label>
      </div> : null}
      {draft.applicabilityState === 'unresolved' ? <label className="new-memory-field"><span className="label">What remains unresolved</span><Input value={draft.applicabilityReason} onChange={event => set('applicabilityReason', event.target.value)} /></label> : null}
      {draft.sources.map((item, index) => <fieldset key={index} className="memory-record-section">
        <legend>Source {index + 1}</legend>
        <div className="new-memory-grid">
          <label className="new-memory-field"><span className="label">Source kind</span><Select ariaLabel={`Source ${index + 1} kind`} value={item.kind} onChange={value => source(index, { kind: value as KnowledgeSource['kind'] })} options={choices(['user', 'document', 'tool', 'web', 'agent', 'import'])} /></label>
          <label className="new-memory-field"><span className="label">Reference</span><Input value={item.reference} onChange={event => source(index, { reference: event.target.value })} placeholder="Document, conversation or tool result" /></label>
        </div>
        <label className="new-memory-field"><span className="label">Supporting evidence</span><textarea rows={3} value={item.evidence} onChange={event => source(index, { evidence: event.target.value })} style={{ width: '100%' }} /></label>
        {draft.sources.length > 1 ? <button type="button" className="btn sm secondary" onClick={() => set('sources', draft.sources.filter((_, at) => at !== index))}>Remove source</button> : null}
      </fieldset>)}
      <button type="button" className="btn sm secondary" disabled={draft.sources.length >= 20} onClick={() => set('sources', [...draft.sources, { kind: 'user', reference: '', evidence: '' }])}>Add supporting source</button>
      <div className="new-memory-grid">
        <label className="new-memory-field"><span className="label">Entities (optional)</span><Input value={draft.entities} onChange={event => set('entities', event.target.value)} placeholder="component_example, tool_example" /></label>
        <label className="new-memory-field"><span className="label">Additional tags (optional)</span><Input value={draft.additionalTags} onChange={event => set('additionalTags', event.target.value)} /></label>
      </div>
      {draft.relationships.map((item, index) => {
        const change = (patch: Partial<typeof item>) => set('relationships', draft.relationships.map((current, at) => at === index ? { ...current, ...patch } : current))
        return <fieldset className="memory-record-section" key={index}>
          <legend>Relationship {index + 1}</legend>
          <div className="new-memory-grid">
            <Select ariaLabel={`Relationship ${index + 1} type`} value={item.type} onChange={value => change({ type: value as typeof item.type })} options={choices(['ABOUT', 'USES', 'EVALUATES', 'PREFERS', 'SUPPORTED_BY', 'SUPERSEDES'])} />
            <Select ariaLabel={`Relationship ${index + 1} target kind`} value={item.target.kind} onChange={kind => change({ target: { ...item.target, kind: kind as typeof item.target.kind } })} options={choices(['memory', 'topic', 'project', 'system', 'entity'])} />
            <Input aria-label={`Relationship ${index + 1} target name`} value={item.target.name} onChange={event => change({ target: { ...item.target, name: event.target.value } })} placeholder="Exact name or memory ID" />
            <Select ariaLabel={`Relationship ${index + 1} evidence status`} value={item.status} onChange={value => change({ status: value as typeof item.status })} options={choices(['proposed', 'inferred', 'source_supported'])} />
          </div>
          <label className="new-memory-field"><span className="label">Supporting source references (one per line)</span><textarea rows={2} value={item.sourceReferences.join('\n')} onChange={event => change({ sourceReferences: event.target.value.split('\n') })} style={{ width: '100%' }} /><small>Use references listed in this record's sources. Similarity alone does not support a factual link.</small></label>
          <button type="button" className="btn sm secondary" onClick={() => set('relationships', draft.relationships.filter((_, at) => at !== index))}>Remove relationship</button>
        </fieldset>
      })}
      <button type="button" className="btn sm secondary" disabled={draft.relationships.length >= 12} onClick={() => set('relationships', [...draft.relationships, { type: 'ABOUT', target: { kind: 'topic', name: '' }, status: 'proposed', sourceReferences: [] }])}>Add optional relationship</button>
    </>
  )
}
