'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '@/components/ui/Icon'

export interface SettingsNavItem {
  id: string
  label: string
  description: string
  href: string
  /** Prototype d-settings: each settings group reads as a navlink with its own glyph. */
  icon?: IconName
}

export interface SettingsSectionBadge {
  label: string
  tone: 'ok' | 'warn' | 'bad' | 'neutral'
}

const SettingsActiveContext = createContext<string | null>(null)

export function SettingsPageFrame({
  children,
}: {
  children: ReactNode
}) {
  return (
    <div className="settings-page-frame">
      {children}
    </div>
  )
}

export function SettingsLayout({
  items,
  activeId,
  children,
}: {
  items: SettingsNavItem[]
  activeId: string
  children: ReactNode
}) {
  const fallbackId = items[0]?.id ?? ''
  const itemIds = useMemo(() => items.map((item) => item.id), [items])
  const [currentId, setCurrentId] = useState(() => resolveActiveId(itemIds, activeId, fallbackId))

  useEffect(() => {
    setCurrentId(resolveActiveId(itemIds, activeId, fallbackId))
  }, [activeId, fallbackId, itemIds])

  useEffect(() => {
    const handlePopState = () => {
      const requestedId = new URLSearchParams(window.location.search).get('setting')
      setCurrentId(resolveActiveId(itemIds, requestedId, fallbackId))
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [fallbackId, itemIds])

  const selectItem = (item: SettingsNavItem) => {
    if (item.id === currentId) return
    setCurrentId(item.id)
    window.history.pushState({ setting: item.id }, '', item.href)
  }

  return (
    <SettingsActiveContext.Provider value={currentId}>
      {/* A single settings group needs no navigation rail (prototype d-notifications). */}
      <div className={`settings-shell${items.length === 1 ? ' single' : ''}`}>
        <aside className="settings-nav" aria-label="Settings sections" role="tablist">
          {items.map((item) => {
            const selected = item.id === currentId
            return (
              <button
                key={item.id}
                id={settingsTabId(item.id)}
                type="button"
                className={`settings-nav-item${selected ? ' active' : ''}`}
                aria-controls={settingsPanelId(item.id)}
                aria-selected={selected}
                aria-description={item.description}
                role="tab"
                onClick={() => selectItem(item)}
              >
                {item.icon ? <Icon name={item.icon} size={16} /> : null}
                <span>{item.label}</span>
              </button>
            )
          })}
        </aside>
        <div className="settings-detail">{children}</div>
      </div>
    </SettingsActiveContext.Provider>
  )
}

export function SettingsSection({
  id,
  title,
  description,
  badge,
  plain = false,
  children,
}: {
  id: string
  title: string
  description?: string
  /** Render the panel content without its own card chrome, for pages composed of several cards. */
  plain?: boolean
  /** Prototype d-settings: the card head carries the group's state, e.g. "operational" or "pinned". */
  badge?: SettingsSectionBadge
  children: ReactNode
}) {
  const activeId = useContext(SettingsActiveContext)
  const active = activeId === null || activeId === id

  return (
    <section
      id={settingsPanelId(id)}
      className={plain ? 'settings-section plain' : 'panel settings-section'}
      aria-labelledby={settingsTabId(id)}
      hidden={!active}
      role="tabpanel"
    >
      {plain ? children : <>
      <div className="card-head settings-section-head">
        <div>
          <h2 className="card-title">{title}</h2>
          {description ? <p className="card-sub">{description}</p> : null}
        </div>
        {badge ? <span className={`badge up${badge.tone === 'neutral' ? '' : ` ${badge.tone}`}`}>{badge.label}</span> : null}
      </div>
      {children}
      </>}
    </section>
  )
}

function resolveActiveId(itemIds: string[], requestedId: string | null | undefined, fallbackId: string): string {
  return requestedId && itemIds.includes(requestedId) ? requestedId : fallbackId
}

function settingsDomId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function settingsPanelId(id: string): string {
  return `settings-panel-${settingsDomId(id)}`
}

function settingsTabId(id: string): string {
  return `settings-tab-${settingsDomId(id)}`
}
