'use client'

import { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'

/**
 * Hand-written memory, saved through POST /memories — the same Shape gate agents
 * use. The form validates the rules that gate enforces up front, so a rejection
 * is the exception rather than the way a user discovers the format.
 */

// `prd` requires Confluence provenance fields (pageId, confluenceUrl) and stays an
// agent/ingest path; everything else can be written by hand.
const CATEGORIES = ['gotcha', 'fix', 'user-correction', 'tool-gap', 'migration-pattern', 'data-constraint', 'permission', 'flag-state']
// `confluence` needs the same page fields, so it is not offered for a manual note.
const SOURCES = ['user-correction', 'gotcha-discovered', 'postmortem', 'test-failure', 'heal-cycle']
// Entities are lowercase snake_case with a type prefix, e.g. component_auth_guard.
const ENTITY_SHAPE = /^[a-z][a-z0-9]*_[a-z0-9_]+$/
const MIN_CONTENT = 40

export interface NewMemoryInput {
  content: string
  project: string
  category: string
  entities: string[]
  source: string
}

export function NewMemoryModal({
  projects,
  busy,
  onClose,
  onCreate,
}: {
  projects: string[]
  busy: boolean
  onClose: () => void
  onCreate: (input: NewMemoryInput) => void
}) {
  const [content, setContent] = useState('')
  const [project, setProject] = useState(projects[0] ?? 'general')
  const [category, setCategory] = useState('gotcha')
  const [source, setSource] = useState('user-correction')
  const [entitiesText, setEntitiesText] = useState('')

  const trimmed = content.trim()
  const entities = Array.from(new Set(entitiesText.split(/[\s,]+/).map((entity) => entity.trim()).filter(Boolean)))
  const malformed = entities.filter((entity) => !ENTITY_SHAPE.test(entity))
  // The gate requires every entity to appear verbatim in the content.
  const notInContent = entities.filter((entity) => ENTITY_SHAPE.test(entity) && !trimmed.includes(entity))
  const contentShort = trimmed.length < MIN_CONTENT
  const canSave = !busy
    && !contentShort
    && project.trim().length > 0
    && entities.length > 0
    && malformed.length === 0
    && notInContent.length === 0

  return (
    <Modal
      title="New memory"
      onClose={onClose}
      width={720}
      footer={
        <>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!canSave}
            onClick={() => onCreate({ content: trimmed, project: project.trim(), category, entities, source })}
          >
            {busy ? 'Saving…' : 'Save memory'}
          </button>
        </>
      }
    >
      <p className="note" style={{ margin: 0 }}>
        Saved through the same Shape gate your agents use, then embedded and added to the graph.
        Name at least one entity and include it word-for-word in the text.
      </p>

      <label className="new-memory-field">
        <span className="label">Content</span>
        <textarea
          rows={6}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="[component_example] What happened, why it matters, and what to do next time."
          style={{ width: '100%' }}
        />
        <span className={`field-hint${contentShort && trimmed.length > 0 ? ' danger' : ''}`}>
          {trimmed.length} / {MIN_CONTENT} characters minimum
        </span>
      </label>

      <div className="new-memory-grid">
        <label className="new-memory-field">
          <span className="label">Project</span>
          <Input value={project} onChange={(event) => setProject(event.target.value)} placeholder="general" />
        </label>
        <label className="new-memory-field">
          <span className="label">Category</span>
          <Select ariaLabel="Category" value={category} onChange={setCategory} options={CATEGORIES.map((value) => ({ value, label: value }))} />
        </label>
        <label className="new-memory-field">
          <span className="label">Source</span>
          <Select ariaLabel="Source" value={source} onChange={setSource} options={SOURCES.map((value) => ({ value, label: value }))} />
        </label>
      </div>

      <label className="new-memory-field">
        <span className="label">Entities</span>
        <Input
          value={entitiesText}
          onChange={(event) => setEntitiesText(event.target.value)}
          placeholder="component_example, tool_add_memory"
          className="mono"
        />
        {malformed.length > 0 ? (
          <span className="field-hint danger">
            {malformed.join(', ')} — use lowercase snake_case with a type prefix, such as component_auth_guard.
          </span>
        ) : notInContent.length > 0 ? (
          <span className="field-hint danger">
            {notInContent.join(', ')} must appear word-for-word in the content.
          </span>
        ) : (
          <span className="field-hint">Comma or space separated. Each one must appear in the content.</span>
        )}
      </label>
    </Modal>
  )
}
