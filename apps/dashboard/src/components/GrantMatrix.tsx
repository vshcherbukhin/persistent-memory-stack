'use client'

import { useMemo, useState, useTransition } from 'react'
import { toggleGrantAction } from '@/app/(dashboard)/grants/actions'
import { Checkbox } from '@/components/ui/Checkbox'
import type { TeamRef, Grant } from '@/lib/types'

/**
 * Reader-focused mount editor.
 *
 * Stored row shape stays the same: TeamGrant(grantor=X, grantee=Y) means team Y
 * mounts team X and can read X's memories through MCP. The UI starts with the
 * reader team, then lists which source teams are mounted for that reader.
 */
export function GrantMatrix({ teams, grants }: { teams: TeamRef[]; grants: Grant[] }) {
  const [readerId, setReaderId] = useState(teams[0]?.id ?? '')
  const [isPending, startTransition] = useTransition()
  const reader = teams.find((team) => team.id === readerId) ?? teams[0] ?? null
  const has = (grantor: string, grantee: string) =>
    grants.some((grant) => grant.grantorTeamId === grantor && grant.granteeTeamId === grantee)

  const owners = useMemo(() => teams.filter((team) => team.id !== reader?.id), [teams, reader?.id])

  function toggle(grantor: string, grantee: string, on: boolean) {
    const fd = new FormData()
    fd.set('grantorTeamId', grantor)
    fd.set('granteeTeamId', grantee)
    fd.set('on', on ? 'true' : 'false')
    startTransition(() => {
      void toggleGrantAction(fd)
    })
  }

  if (teams.length === 0 || !reader) {
    return <p className="muted">No teams yet — create teams first.</p>
  }

  const mountedCount = owners.filter((owner) => has(owner.id, reader.id)).length

  return (
    <div className="mounts-layout">
      <aside className="mounts-reader-list" aria-label="Reader teams">
        <div className="section-label">Selected reader</div>
        {teams.map((team) => (
          <button
            key={team.id}
            type="button"
            className={`mounts-reader${team.id === reader.id ? ' active' : ''}`}
            onClick={() => setReaderId(team.id)}
          >
            <span>{team.name}</span>
            <span>{teams.filter((owner) => owner.id !== team.id && has(owner.id, team.id)).length} mounted</span>
          </button>
        ))}
      </aside>

      <section className="mounts-editor">
        <div className="mounts-editor-head">
          <div>
            <h2 className="card-title" style={{ marginBottom: 4 }}>{reader.name}</h2>
            <p className="muted" style={{ margin: 0 }}>
              Choose which teams this reader can mount as read-only memory sources in MCP.
            </p>
          </div>
          <span className="badge">{mountedCount} mounted</span>
        </div>

        <div className="section-label" style={{ marginTop: 18, marginBottom: 8 }}>
          Mounted memory sources
        </div>
        <div className="mounts-source-list">
          {owners.map((owner) => {
            const checked = has(owner.id, reader.id)
            return (
              <div key={owner.id} className={`mounts-source${checked ? ' active' : ''}`}>
                <div>
                  <div className="team-name">{owner.name}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {reader.name} can read {owner.name} memories; writes stay with {reader.name}.
                  </div>
                </div>
                <Checkbox
                  checked={checked}
                  disabled={isPending}
                  onChange={(on) => toggle(owner.id, reader.id, on)}
                  label={checked ? 'Mounted' : 'Mount'}
                />
              </div>
            )
          })}
          {owners.length === 0 ? <div className="empty-state">Create at least two teams to configure mounts.</div> : null}
        </div>

        <p className="note" style={{ maxWidth: 720 }}>
          Mounts gate <b>memory only</b>, and only on the MCP. Documents, graph, and investigations remain universally shared; dashboard reads are still role-based.
          {isPending ? ' Saving…' : ''}
        </p>
      </section>
    </div>
  )
}
