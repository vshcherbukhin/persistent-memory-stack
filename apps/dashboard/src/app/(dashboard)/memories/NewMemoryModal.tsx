'use client'

import { useRef, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { classificationDraft, classificationFromDraft, operationKey, type ClassifiedWrite, type KnowledgeResolution } from '@/lib/knowledge'
import { KnowledgeFields } from './KnowledgeFields'
import { ClassificationCatalog } from './ClassificationCatalog'

export type NewMemoryInput = ClassifiedWrite

export function NewMemoryModal({ busy, onClose, onCreate }: {
  projects: string[]; busy: boolean; onClose: () => void; onCreate: (input: NewMemoryInput) => void
}) {
  const [content, setContent] = useState('')
  const [draft, setDraft] = useState(() => classificationDraft())
  const [resolutions, setResolutions] = useState<KnowledgeResolution[]>([])
  const [error, setError] = useState('')
  const operation = useRef<{ fingerprint: string; key: string } | null>(null)
  const submit = () => {
    try {
      if (content.trim().length < 40) throw new Error('Use at least 40 characters of self-contained content.')
      const payload = { contractVersion: 2 as const, content: content.trim(), classification: classificationFromDraft(draft), ...(resolutions.length ? { resolutions } : {}) }
      operation.current = operationKey(operation.current, payload, () => crypto.randomUUID())
      setError('')
      onCreate({ ...payload, idempotencyKey: operation.current.key })
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Check the classification.') }
  }
  return <Modal title="New memory" onClose={onClose} width={820} footer={<>
    <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
    <button type="button" className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Save memory'}</button>
  </>}>
    <p className="note">Capture a self-contained claim with explicit classification and evidence. Saving and derived processing are reported separately.</p>
    {error ? <p className="notice danger" role="alert">{error}</p> : null}
    <label className="new-memory-field"><span className="label">Content</span><textarea rows={6} value={content} onChange={event => setContent(event.target.value)} style={{ width: '100%' }} /><small>{content.trim().length} / 40 characters minimum</small></label>
    <KnowledgeFields draft={draft} onChange={setDraft} />
    <ClassificationCatalog resolutions={resolutions} onChange={setResolutions} />
  </Modal>
}
