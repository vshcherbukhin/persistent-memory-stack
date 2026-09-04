'use client'

import { useActionState, useState } from 'react'
import { Input } from '@/components/ui/Input'
import { renameTeamAction, type RenameState } from './actions'

const INIT: RenameState = {}

interface UserRow {
  id: string
  displayName: string | null
  email: string | null
  role: string
  createdAt: string
}

const COLS = '1.4fr 1.8fr .9fr 1fr'

/** Local-only single-team view (P1): rename the team + a searchable users table
 * (display name / email / role / registered). One user in local mode; the search is
 * client-side. (Infinite-scroll pagination belongs on the multi-user server Users
 * page, not this single-user local view.) */
export function TeamSettings({ teamId, teamName, users }: { teamId: string; teamName: string; users: UserRow[] }) {
  const [state, action, pending] = useActionState(renameTeamAction, INIT)
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const filtered = needle
    ? users.filter((u) => (u.email ?? '').toLowerCase().includes(needle) || (u.displayName ?? '').toLowerCase().includes(needle))
    : users

  return (
    <div className="page-fill team-page">
      <div className="panel">
        <div className="section-label">Team</div>
        <form action={action} className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <input type="hidden" name="teamId" value={teamId} />
          <div className="field" style={{ flex: 1, marginBottom: 0, maxWidth: 360 }}>
            <label htmlFor="tname">Team name</label>
            <Input id="tname" name="name" defaultValue={teamName} placeholder="QA" />
          </div>
          <button type="submit" className="primary" disabled={pending}>{pending ? 'Saving…' : 'Rename'}</button>
        </form>
        {state.error ? <div className="notice danger" style={{ marginBottom: 0 }}>{state.error}</div> : null}
        {state.ok ? <div className="notice ok" style={{ marginBottom: 0 }}>Renamed.</div> : null}
      </div>

      <div className="panel table-panel">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 12 }}>
          <div className="section-label" style={{ margin: 0 }}>Users ({users.length})</div>
          <div style={{ minWidth: 220 }}>
            <Input
              placeholder="Search name or email…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              icon={
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <circle cx="11" cy="11" r="7" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
              }
            />
          </div>
        </div>
        <div className="gt table-scroll">
          <div className="gt-head" style={{ gridTemplateColumns: COLS }}>
            <div>Display name</div>
            <div>Email</div>
          <div>Role</div>
          <div>Registered</div>
        </div>
        <div className="gt-scroll-body">
          {filtered.map((u) => (
            <div className="gt-row" key={u.id} style={{ gridTemplateColumns: COLS }}>
              <div>{u.displayName ?? <span className="muted">(no name)</span>}</div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--soft)' }}>{u.email ?? '—'}</div>
              <div>
                <span className={`level-chip ${u.role === 'Super Admin' ? 'superuser' : u.role === 'Team Admin' ? 'admin' : 'member'}`}>{u.role}</span>
              </div>
              <div style={{ color: 'var(--soft)', fontSize: 12 }}>{new Date(u.createdAt).toLocaleDateString()}</div>
            </div>
          ))}
          {filtered.length === 0 ? <div className="gt-empty">No users match.</div> : null}
        </div>
      </div>
        <p className="note" style={{ margin: '12px 2px 0' }}>
          Single-user local install — manage your name, email, and the optional dashboard password from your
          profile (bottom-left).
        </p>
      </div>
    </div>
  )
}
