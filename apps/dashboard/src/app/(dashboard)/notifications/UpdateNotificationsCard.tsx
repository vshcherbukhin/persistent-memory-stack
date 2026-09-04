'use client'

import { useActionState, useEffect, useMemo, useState } from 'react'
import { Checkbox } from '@/components/ui/Checkbox'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { useToast } from '@/components/ui/Toast'
import type { UpdateBitbucketScope, UpdateNotificationSettings } from '@/lib/types'
import type { NotifyState } from './actions'

const INIT: NotifyState = {}

type Action = (prev: NotifyState, fd: FormData) => Promise<NotifyState>

interface FormVals {
  enabled: boolean
  url: string
  token: string
  scope: UpdateBitbucketScope
  project: string
  user: string
  repo: string
  branch: string
}

function seedFrom(current: UpdateNotificationSettings): FormVals {
  return {
    enabled: current.enabled && current.provider === 'bitbucket',
    url: current.bitbucket.url,
    token: '',
    scope: current.bitbucket.scope,
    project: current.bitbucket.project,
    user: current.bitbucket.user,
    repo: current.bitbucket.repo,
    branch: current.bitbucket.branch,
  }
}

export function UpdateNotificationsCard({
  action,
  testAction,
  current,
  error,
}: {
  action: Action
  testAction: Action
  current: UpdateNotificationSettings | null
  error?: string | null
}) {
  const [state, formAction, pending] = useActionState(action, INIT)
  const [testState, testFormAction, testing] = useActionState(testAction, INIT)
  const toast = useToast()

  const fallback = useMemo<UpdateNotificationSettings>(
    () => ({
      enabled: false,
      provider: 'none',
      bitbucket: {
        url: '',
        tokenConfigured: false,
        scope: 'project',
        project: '',
        user: '',
        repo: '',
        branch: 'master',
      },
    }),
    [],
  )
  const source = current ?? fallback
  const seed = useMemo(() => seedFrom(source), [source])
  const [vals, setVals] = useState<FormVals>(seed)
  const [base, setBase] = useState<FormVals>(seed)
  const [tokenConfigured, setTokenConfigured] = useState(source.bitbucket.tokenConfigured)
  const dirty = useMemo(() => JSON.stringify(vals) !== JSON.stringify(base), [vals, base])
  const set = <K extends keyof FormVals>(k: K, v: FormVals[K]) => setVals((s) => ({ ...s, [k]: v }))
  const owner = vals.scope === 'user' ? vals.user.trim() : vals.project.trim()
  const tokenReady = tokenConfigured || Boolean(vals.token.trim())
  const requiredReady = !vals.enabled || Boolean(vals.url.trim() && tokenReady && owner && vals.repo.trim() && vals.branch.trim())

  useEffect(() => {
    if (!state.nonce) return
    if (state.ok) {
      toast.success('Application update settings saved.')
      if (vals.token.trim()) setTokenConfigured(true)
      const saved = { ...vals, token: '' }
      setVals(saved)
      setBase(saved)
    } else if (state.error) toast.error(state.error)
  }, [state.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="settings-form-stack">
      {error ? <p className="muted" style={{ color: 'var(--coral-soft)', marginTop: 0 }}>{error}</p> : null}

      <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 780 }}>
        <Checkbox name="enabled" checked={vals.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />

        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="bitbucketUrl">Bitbucket URL</label>
          <Input
            id="bitbucketUrl"
            name="bitbucketUrl"
            type="url"
            placeholder="https://stash.company.com"
            value={vals.url}
            onChange={(e) => set('url', e.target.value)}
          />
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="bitbucketToken">Bitbucket token</label>
          <Input
            id="bitbucketToken"
            name="bitbucketToken"
            type="password"
            autoComplete="off"
            placeholder={tokenConfigured ? 'configured - leave blank to keep' : 'Paste token'}
            value={vals.token}
            onChange={(e) => set('token', e.target.value)}
          />
          {tokenConfigured ? <span className="field-hint">A token is configured. Enter a new token to replace it.</span> : null}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="bitbucketScope">Repository type</label>
            <Select
              name="bitbucketScope"
              ariaLabel="Repository type"
              value={vals.scope}
              onChange={(v) => set('scope', v === 'user' ? 'user' : 'project')}
              options={[
                { value: 'user', label: 'Personal repo' },
                { value: 'project', label: 'Project repo' },
              ]}
            />
          </div>

          {vals.scope === 'user' ? (
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="bitbucketUser">User</label>
              <Input
                id="bitbucketUser"
                name="bitbucketUser"
                type="text"
                placeholder="example.user"
                value={vals.user}
                onChange={(e) => set('user', e.target.value)}
              />
              <input type="hidden" name="bitbucketProject" value={vals.project} />
            </div>
          ) : (
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="bitbucketProject">Project</label>
              <Input
                id="bitbucketProject"
                name="bitbucketProject"
                type="text"
                placeholder="ENG"
                value={vals.project}
                onChange={(e) => set('project', e.target.value)}
              />
              <input type="hidden" name="bitbucketUser" value={vals.user} />
            </div>
          )}

          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="bitbucketRepo">Repo</label>
            <Input
              id="bitbucketRepo"
              name="bitbucketRepo"
              type="text"
              placeholder="example-service"
              value={vals.repo}
              onChange={(e) => set('repo', e.target.value)}
            />
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="bitbucketBranch">Branch</label>
            <Input
              id="bitbucketBranch"
              name="bitbucketBranch"
              type="text"
              placeholder="master"
              value={vals.branch}
              onChange={(e) => set('branch', e.target.value)}
            />
          </div>
        </div>

        <div className="row">
          <button type="submit" className="primary" disabled={pending || !dirty || !requiredReady}>
            {pending ? 'Saving...' : 'Save'}
          </button>
          <button type="submit" formAction={testFormAction} disabled={testing || !requiredReady}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {!requiredReady ? <span className="field-hint">Enabled checks need URL, token, owner, repo, and branch.</span> : null}
        </div>
        {testState.connection ? (
          <p className="notice ok">Connection verified: {testState.connection.repository} · {testState.connection.branch} · {testState.connection.latestCommit.slice(0, 12)}</p>
        ) : null}
        {testState.error ? <p className="notice bad">Connection failed: {testState.error}</p> : null}
      </form>
    </div>
  )
}
