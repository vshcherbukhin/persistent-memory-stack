import { describe, expect, it } from 'vitest'
import { classifyMemoryUpdate } from '../src/services/memory-update-routing.ts'

const existing = {
  content: '[component_widget] A durable memory with enough content for the write contract.',
  project: 'persistent-memory',
  sessionId: 'session-1',
  category: 'fix',
  entities: ['component_widget'],
}

describe('memory update routing', () => {
  it.each([
    ['empty patch', {}],
    ['exact content', { content: existing.content }],
    ['same project', { project: existing.project }],
    ['same session', { sessionId: existing.sessionId }],
    ['identical metadata', { category: existing.category, entities: existing.entities }],
  ])('keeps %s on the zero-change path', (_name, request) => {
    expect(classifyMemoryUpdate(existing, request)).toEqual({
      contentChanged: false,
      projectChanged: false,
      sessionChanged: false,
      metadataChanged: false,
      validationRequired: false,
      hasChanges: false,
    })
  })

  it('routes session-only and project-only changes without validation', () => {
    expect(classifyMemoryUpdate(existing, { sessionId: 'session-2' })).toMatchObject({ sessionChanged: true, validationRequired: false, hasChanges: true })
    expect(classifyMemoryUpdate(existing, { project: 'other-project' })).toMatchObject({ projectChanged: true, validationRequired: false, hasChanges: true })
  })

  it('requires validation for actual content or persisted metadata changes', () => {
    expect(classifyMemoryUpdate(existing, { content: `${existing.content} changed` })).toMatchObject({ contentChanged: true, validationRequired: true })
    expect(classifyMemoryUpdate(existing, { category: 'gotcha' })).toMatchObject({ metadataChanged: true, validationRequired: true })
    expect(classifyMemoryUpdate(existing, { entities: ['component_widget', 'service_api'] })).toMatchObject({ metadataChanged: true, validationRequired: true })
  })
})
