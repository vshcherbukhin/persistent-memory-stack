'use client'

import { useActionState, useEffect, useState } from 'react'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import type { Team } from '@/lib/types'
import { createTeamAction, deleteTeamAction, renameTeamAction, type TeamActionState } from './actions'

const initial: TeamActionState = {}

function TeamError({ state }: { state: TeamActionState }) {
  if (!state.error) return null
  return <div className="notice danger" style={{ marginTop: 10 }}>{state.error}</div>
}

export function TeamsClient({ teams }: { teams: Team[] }) {
  const [createState, createFormAction, createPending] = useActionState(createTeamAction, initial)
  const [renameState, renameFormAction, renamePending] = useActionState(renameTeamAction, initial)
  const [deleteState, deleteFormAction, deletePending] = useActionState(deleteTeamAction, initial)
  const [renaming, setRenaming] = useState<Team | null>(null)
  const [deleting, setDeleting] = useState<Team | null>(null)

  useEffect(() => {
    if (renameState.ok) setRenaming(null)
  }, [renameState.nonce, renameState.ok])

  useEffect(() => {
    if (deleteState.ok) setDeleting(null)
  }, [deleteState.nonce, deleteState.ok])

  return (
    <div className="teams-page">
      <div className="panel">
        <h2 className="card-title" style={{ marginBottom: 12 }}>Create team</h2>
        <form action={createFormAction} className="team-create-form">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="new-team">Name</label>
            <Input id="new-team" name="name" type="text" placeholder="e.g. Platform QA" required />
          </div>
          <button type="submit" disabled={createPending}>{createPending ? 'Creating…' : 'Create'}</button>
        </form>
        <TeamError state={createState} />
      </div>

      <div className="section-label" style={{ marginBottom: 10 }}>
        {teams.length} team(s)
      </div>
      <div className="team-list">
        {teams.map((team) => (
          <div key={team.id} className="team-row">
            <div className="team-row-main">
              <div className="team-name">{team.name}</div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
                {team.memberCount} member{team.memberCount === 1 ? '' : 's'} · created {new Date(team.createdAt).toLocaleDateString()}
              </div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="secondary" onClick={() => setRenaming(team)}>Rename</button>
              <button type="button" className="danger" onClick={() => setDeleting(team)}>Delete</button>
            </div>
          </div>
        ))}
        {teams.length === 0 ? <div className="empty-state">No teams yet.</div> : null}
      </div>

      {renaming ? (
        <Modal
          title="Rename team"
          onClose={() => setRenaming(null)}
          width={520}
          footer={
            <>
              <button type="button" className="secondary" onClick={() => setRenaming(null)}>Cancel</button>
              <button type="submit" form="rename-team-form" disabled={renamePending}>{renamePending ? 'Renaming…' : 'Rename'}</button>
            </>
          }
        >
          <form id="rename-team-form" action={renameFormAction} className="modal-form">
            <input type="hidden" name="id" value={renaming.id} />
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="rename-team-name">Team name</label>
              <Input id="rename-team-name" name="name" type="text" defaultValue={renaming.name} required autoFocus />
            </div>
            <TeamError state={renameState} />
          </form>
        </Modal>
      ) : null}

      {deleting ? (
        <Modal
          title="Delete team"
          onClose={() => setDeleting(null)}
          width={520}
          footer={
            <>
              <button type="button" className="secondary" onClick={() => setDeleting(null)}>Cancel</button>
              <button type="submit" form="delete-team-form" className="danger" disabled={deletePending}>
                {deletePending ? 'Deleting…' : 'Delete team'}
              </button>
            </>
          }
        >
          <form id="delete-team-form" action={deleteFormAction} className="modal-form">
            <input type="hidden" name="id" value={deleting.id} />
            <p className="muted" style={{ margin: 0, lineHeight: 1.55 }}>
              Delete <strong>{deleting.name}</strong>? The server refuses this while the team still has members or owned data.
            </p>
            <TeamError state={deleteState} />
          </form>
        </Modal>
      ) : null}
    </div>
  )
}
