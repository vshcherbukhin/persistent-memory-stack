import { redirect } from 'next/navigation'
import { requireControlPlane, isSuperuser } from '@/lib/session'
import { api } from '@/lib/api'
import { SubmitButton } from '@/components/SubmitButton'
import { TokenModal } from '@/components/TokenModal'
import { revokeTokenAction } from './actions'

export const dynamic = 'force-dynamic'

export default async function TokensPage() {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) redirect('/memories')
  const [users, teams] = await Promise.all([api.listUsers(), api.listTeams()])
  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? id.slice(0, 8)

  return (
    <div className="page-fill tokens-page">
      <div className="panel table-panel">
        <div className="table-scroll native-table-scroll">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Team</th>
                <th>Status</th>
                <th style={{ width: 320 }}>Issue / rotate</th>
                <th>Revoke</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const label = u.displayName ?? u.email ?? u.id.slice(0, 8)
                return (
                  <tr key={u.id}>
                    <td>
                      {label}
                      <div className="muted mono" style={{ fontSize: 11 }}>
                        {u.id.slice(0, 8)}…
                      </div>
                    </td>
                    <td className="muted">{u.teamId ? teamName(u.teamId) : '(global)'}</td>
                    <td>
                      {u.hasToken ? (
                        (() => {
                          const expired =
                            !!u.tokenExpires && new Date(u.tokenExpires).getTime() < Date.now()
                          return (
                            <span className={`tok-status ${expired ? 'expired' : 'active'}`}>
                              {expired ? 'expired' : 'active'}
                              {u.tokenId ? (
                                <>
                                  {' · '}
                                  <span className="mono">{u.tokenId}</span>
                                </>
                              ) : (
                                ''
                              )}
                              {u.tokenExpires
                                ? ` · exp ${new Date(u.tokenExpires).toLocaleDateString()}`
                                : ' · non-expiring'}
                              {u.tokenIssuedAt
                                ? ` · issued ${new Date(u.tokenIssuedAt).toLocaleDateString()}`
                                : ' · issued unknown'}
                            </span>
                          )
                        })()
                      ) : (
                        <span className="tok-status none">no token</span>
                      )}
                    </td>
                    <td>
                      <TokenModal userId={u.id} userLabel={label} hasToken={u.hasToken} />
                    </td>
                    <td>
                      {u.hasToken ? (
                        <form action={revokeTokenAction} className="inline-form">
                          <input type="hidden" name="id" value={u.id} />
                          <SubmitButton
                            className="danger"
                            pendingText="…"
                            confirm={`Revoke ${label}'s token? They will be signed out everywhere.`}
                          >
                            Revoke
                          </SubmitButton>
                        </form>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No users yet — create one on the Users page.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
