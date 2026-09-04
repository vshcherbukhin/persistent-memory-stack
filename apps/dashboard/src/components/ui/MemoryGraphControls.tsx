'use client'

import { useMemo, useState } from 'react'
import type { MemoryGraphFacet } from '@/lib/types'
import { Icon } from './Icon'
import { Input } from './Input'
import { Tooltip } from './Tooltip'

export function GraphViewportControls({
  autoOverview,
  onReset,
}: {
  autoOverview: boolean
  onReset: () => void
}) {
  return (
    <div className="memory-graph-viewport-controls">
      <span className={`memory-graph-auto-state${autoOverview ? ' active' : ''}`}>
        <span aria-hidden /> {autoOverview ? 'Auto overview' : 'Manual view'}
      </span>
      <Tooltip label="Restore the full graph and resume automatic framing">
        <button type="button" className="memory-graph-icon-button" onClick={onReset} aria-label="Reset graph view">
          <Icon name="center_focus_strong" size={18} />
        </button>
      </Tooltip>
    </div>
  )
}

export function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button type="button" className="memory-graph-filter-chip" onClick={onRemove} aria-label={`Remove ${label} filter`}>
      <span>{label}</span><Icon name="close" size={13} />
    </button>
  )
}

export function SearchableFacetPicker({
  title,
  icon,
  facets,
  selected,
  allOption,
  onToggle,
  onSearch,
}: {
  title: string
  icon: 'folder' | 'sell' | 'verified'
  facets: MemoryGraphFacet[]
  selected: string[]
  allOption?: { label: string; count: number; onSelect: () => void }
  onToggle: (value: string) => void
  onSearch: (query: string) => void
}) {
  const [query, setQuery] = useState('')
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return normalized ? facets.filter((facet) => facet.value.toLocaleLowerCase().includes(normalized)) : facets
  }, [facets, query])
  return (
    <section className="memory-graph-facet">
      <div className="memory-graph-section-title"><Icon name={icon} size={15} />{title}</div>
      <Input
        type="search"
        value={query}
        aria-label={`Search ${title.toLocaleLowerCase()}`}
        placeholder={`Find ${title.toLocaleLowerCase()}…`}
        icon={<Icon name="search" size={14} />}
        onChange={(event) => {
          setQuery(event.target.value)
          onSearch(event.target.value)
        }}
      />
      <div className="memory-graph-facet-list">
        {!query && allOption ? (
          <button
            type="button"
            className={selected.length === 0 ? 'active' : ''}
            aria-pressed={selected.length === 0}
            onClick={allOption.onSelect}
          >
            <span>{allOption.label}</span><small>{allOption.count.toLocaleString()}</small>
          </button>
        ) : null}
        {visible.map((facet) => {
          const active = selected.includes(facet.value)
          return (
            <button
              type="button"
              key={facet.value}
              className={active ? 'active' : ''}
              aria-pressed={active}
              onClick={() => onToggle(facet.value)}
            >
              <span>{facet.value}</span><small>{facet.count.toLocaleString()}</small>
            </button>
          )
        })}
        {visible.length === 0 ? <p>No matching values</p> : null}
      </div>
    </section>
  )
}

export function GraphValidityFilter({
  value,
  onChange,
}: {
  value: 'all' | 'current' | 'historical'
  onChange: (value: 'all' | 'current' | 'historical') => void
}) {
  const options = [
    ['all', 'All facts'],
    ['current', 'Current facts'],
    ['historical', 'Historical facts'],
  ] as const
  return (
    <section className="memory-graph-facet">
      <div className="memory-graph-section-title"><Icon name="history" size={15} />Fact history</div>
      <div className="memory-graph-facet-list">
        {options.map(([option, label]) => (
          <button
            type="button"
            key={option}
            className={value === option ? 'active' : ''}
            aria-pressed={value === option}
            onClick={() => onChange(option)}
          >
            <span>{label}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

export function GraphStatusLegend() {
  return (
    <div className="memory-graph-legend" aria-label="Graph legend">
      <span><i className="memory-dot" /> Memory</span>
      <span><i className="entity-dot" /> Entity</span>
      <span><i className="granted-dot" /> Mounted</span>
      <span><i className="historical-line" /> Historical</span>
    </div>
  )
}

export function GraphActivityBeacon({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="memory-graph-activity-beacon" role="status">
      <Icon name="flare" size={16} /> {message}
    </div>
  )
}

export function GraphEmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="memory-graph-empty">
      <Icon name="bubble_chart" size={34} />
      <strong>{filtered ? 'No connected memories match these filters' : 'Your memory graph will grow here'}</strong>
      <span>{filtered ? 'Remove a project, tag, or badge filter to bring nodes back.' : 'Create a memory with entities to begin forming the bubble.'}</span>
    </div>
  )
}
