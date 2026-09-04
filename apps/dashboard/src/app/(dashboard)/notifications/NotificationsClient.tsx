'use client'

import { useMemo, useState } from 'react'
import type { MemorySurface, NotifySettings } from '@/lib/types'
import { NotifyForm } from './NotifyForm'
import { saveNotifyTargetAction } from './actions'

export interface NotificationTarget {
  id: string
  kind: 'team' | 'system'
  name: string
  description: string
  teamId: string | null
  current: NotifySettings | null
}

export function NotificationsClient({
  targets,
  surface,
  showTargets = true,
  personalMode = false,
}: {
  targets: NotificationTarget[]
  surface: MemorySurface
  showTargets?: boolean
  personalMode?: boolean
}) {
  const [selectedId, setSelectedId] = useState(targets[0]?.id ?? '')
  const selected = useMemo(
    () => targets.find((target) => target.id === selectedId) ?? targets[0] ?? null,
    [selectedId, targets],
  )

  if (!selected) {
    return <div className="empty-state">No notification targets available.</div>
  }

  return (
    <div className="notifications-layout">
      {showTargets ? (
        <aside className="notifications-targets">
          <div className="section-label">Targets</div>
          {targets.map((target) => (
            <button
              key={target.id}
              type="button"
              className={`notifications-target${target.id === selected.id ? ' active' : ''}`}
              onClick={() => setSelectedId(target.id)}
            >
              <span>{target.name}</span>
              <span>{target.description}</span>
            </button>
          ))}
        </aside>
      ) : null}

      <section className="panel notifications-settings-panel">
        <div className="notifications-settings-head">
          <div>
            <h2 className="card-title" style={{ marginBottom: 4 }}>{selected.name}</h2>
            <p className="muted" style={{ margin: 0, maxWidth: 640 }}>{selected.description}</p>
          </div>
        </div>
        <NotifyForm
          key={selected.id}
          action={saveNotifyTargetAction}
          current={selected.current}
          targetKind={selected.kind}
          teamId={selected.teamId}
          surface={surface}
          personalMode={personalMode}
        />
      </section>
    </div>
  )
}
