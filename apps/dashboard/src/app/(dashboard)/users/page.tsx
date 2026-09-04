import { requireControlPlane, isSuperuser } from '@/lib/session'
import { api } from '@/lib/api'
import { SubmitButton } from '@/components/SubmitButton'
import { FormSelect } from '@/components/ui/FormSelect'
import {
  createUserAction,
  updateUserAction,
  setAdminLevelAction,
  deleteUserAction,
} from './actions'
import { PasswordResetButton } from './PasswordResetButton'

export const dynamic = 'force-dynamic'

export default async function UsersPage() {
  const who = await requireControlPlane()
  const superuser = isSuperuser(who)
  const [users, teams] = await Promise.all([api.listUsers(), api.listTeams()])
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id.slice(0, 8)

  return (
    <div className="page-fill users-page">
      <div className="panel">
        <h2 className="card-title" style={{ marginBottom: 12 }}>Create user</h2>
        <form action={createUserAction} className="row">
          <div className="field" style={{ marginBottom: 0, minWidth: 170 }}>
            <label>Team</label>
            <FormSelect name="teamId" ariaLabel="Team" defaultValue={teams[0]?.id} options={teams.map((t) => ({ value: t.id, label: t.name }))} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="cu-email">Email (optional)</label>
            <input id="cu-email" name="email" type="email" placeholder="user@team.dev" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="cu-name">Display name (optional)</label>
            <input id="cu-name" name="displayName" type="text" />
          </div>
          <SubmitButton pendingText="Creating…">Create</SubmitButton>
        </form>
        <p className="note">
          A new user has no token. Issue one on the Tokens page.
        </p>
      </div>

      <div className="panel table-panel">
        <h2 className="card-title" style={{ marginBottom: 12 }}>{users.length} user(s)</h2>
        <div className="table-scroll native-table-scroll">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Team</th>
                <th>admin_level</th>
                <th>Token</th>
                {superuser ? <th>Password</th> : null}
                <th>Delete</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div>{u.displayName ?? u.email ?? <span className="muted">(no name)</span>}</div>
                    <div className="muted mono" style={{ fontSize: 11 }}>
                      {u.id.slice(0, 8)}…{u.email ? ` · ${u.email}` : ''}
                    </div>
                  </td>
                  <td>
                    <form action={updateUserAction} className="row" style={{ gap: 6 }}>
                      <input type="hidden" name="id" value={u.id} />
                      <div style={{ minWidth: 150 }}>
                        <FormSelect
                          name="teamId"
                          ariaLabel="Team"
                          defaultValue={u.teamId ?? ''}
                          options={[{ value: '', label: '(none — global)' }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
                        />
                      </div>
                      <SubmitButton className="secondary" pendingText="…">
                        Save
                      </SubmitButton>
                    </form>
                  </td>
                  <td>
                    {/* THE ESCALATION FIREWALL (UI side): the admin_level control is
                        DISABLED unless the viewer is a superuser. The server's
                        requireSuperuser on PATCH .../admin-level is the real gate. */}
                    <form action={setAdminLevelAction} className="row" style={{ gap: 6 }}>
                      <input type="hidden" name="id" value={u.id} />
                      <div style={{ minWidth: 130 }}>
                        <FormSelect
                          name="adminLevel"
                          ariaLabel="admin level"
                          defaultValue={u.adminLevel}
                          disabled={!superuser}
                          options={[{ value: 'none', label: 'none' }, { value: 'admin', label: 'admin' }, { value: 'superuser', label: 'superuser' }]}
                        />
                      </div>
                      {superuser ? (
                        <SubmitButton
                          className="secondary"
                          pendingText="…"
                          confirm={`Change ${u.displayName ?? u.email ?? u.id.slice(0, 8)}'s admin_level? This is a privileged control-plane change.`}
                        >
                          Apply
                        </SubmitButton>
                      ) : (
                        <span
                          className={`level-chip ${u.adminLevel === 'superuser' ? 'superuser' : u.adminLevel === 'admin' ? 'admin' : 'member'}`}
                        >
                          {u.adminLevel}
                        </span>
                      )}
                    </form>
                  </td>
                  <td>
                    {u.hasToken ? (
                      (() => {
                        const expired =
                          !!u.tokenExpires && new Date(u.tokenExpires).getTime() < Date.now()
                        return (
                          <span className={`tok-status ${expired ? 'expired' : 'active'}`}>
                            {expired ? 'expired' : 'active'}
                            {u.tokenExpires
                              ? ` · exp ${new Date(u.tokenExpires).toLocaleDateString()}`
                              : ''}
                          </span>
                        )
                      })()
                    ) : (
                      <span className="tok-status none">none</span>
                    )}
                  </td>
                  {superuser ? (
                    <td>
                      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <span className={`tok-status ${u.hasPassword ? 'active' : 'none'}`}>
                          {u.hasPassword ? (u.passwordTemporary ? 'temporary' : 'set') : 'none'}
                        </span>
                        <PasswordResetButton userId={u.id} userLabel={u.displayName ?? u.email ?? u.id.slice(0, 8)} />
                      </div>
                    </td>
                  ) : null}
                  <td>
                    <form action={deleteUserAction} className="inline-form">
                      <input type="hidden" name="id" value={u.id} />
                      <SubmitButton
                        className="danger"
                        pendingText="…"
                        confirm={`Delete user ${u.displayName ?? u.email ?? u.id.slice(0, 8)}?`}
                      >
                        Delete
                      </SubmitButton>
                    </form>
                  </td>
                </tr>
              ))}
              {users.length === 0 ? (
                <tr>
                  <td colSpan={superuser ? 6 : 5} className="muted">
                    No users yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="note">
          One team per user (or none, for a global super-admin). Teams come from the Teams page. Your
          own session: {who.teamId ? teamName(who.teamId) : '(global super-admin — no team)'}.
        </p>
      </div>
    </div>
  )
}
