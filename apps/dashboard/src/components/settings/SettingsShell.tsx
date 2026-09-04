'use client'

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export interface SettingsNavItem {
  id: string
  label: string
  description: string
  href: string
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
      <div className="settings-shell">
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
                role="tab"
                onClick={() => selectItem(item)}
              >
                <span>{item.label}</span>
                <small>{item.description}</small>
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
  children,
}: {
  id: string
  title: string
  description?: string
  children: ReactNode
}) {
  const activeId = useContext(SettingsActiveContext)
  const active = activeId === null || activeId === id

  return (
    <section
      id={settingsPanelId(id)}
      className="panel settings-section"
      aria-labelledby={settingsTabId(id)}
      hidden={!active}
      role="tabpanel"
    >
      <div className="settings-section-head">
        <h2 className="card-title">{title}</h2>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {children}
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
