/**
 * MinIO object-key scheme — team-first layout + path-traversal sanitization.
 *
 * The key is always derived from the SERVER-STAMPED teamId (never client input),
 * mirroring the Qdrant team_id payload boundary. These tests pin the exact layout
 * the worker + api both rely on, and prove the sanitizer collapses traversal /
 * weird bytes to a single safe segment.
 *
 *   originals:  team/<teamId>/<project>/<sourceId>/original/<safeFilename>
 *   artifacts:  team/<teamId>/<project>/<sourceId>/extracted/<safeName>
 *
 * Covered:
 *   • exact key for a clean input (originals + artifacts).
 *   • team segment leads (prefix-scope-per-team friendly).
 *   • the literal 'original' / 'extracted' discriminator segment.
 *   • teamId + sourceId are NOT sanitized (server-stamped uuids pass through);
 *     project + filename/name ARE sanitized (caller-influenced).
 *   • path traversal in filename ('../../etc/passwd') collapses to one segment
 *     — the resulting key never escapes the team/project/source prefix.
 *   • disallowed bytes (spaces, slashes, unicode) → underscore; allowed chars
 *     (A-Za-z0-9._-) survive verbatim.
 *   • originals vs artifacts differ only in the discriminator segment.
 */
import { describe, it, expect } from 'vitest'
import { originalKey, artifactKey } from '../src/storage/keys.ts'

describe('originalKey — layout', () => {
  it('produces the exact team-first original key for clean input', () => {
    const key = originalKey({
      teamId: 'team-123',
      project: 'general',
      sourceId: 'src-abc',
      filename: 'report.pdf',
    })
    expect(key).toBe('team/team-123/general/src-abc/original/report.pdf')
  })

  it('leads with the team segment', () => {
    const key = originalKey({ teamId: 't1', project: 'p', sourceId: 's', filename: 'f.txt' })
    expect(key.startsWith('team/t1/')).toBe(true)
  })

  it('carries the literal "original" discriminator segment', () => {
    const key = originalKey({ teamId: 't', project: 'p', sourceId: 's', filename: 'f.txt' })
    expect(key.split('/')).toContain('original')
  })
})

describe('artifactKey — layout', () => {
  it('produces the exact team-first extracted key for clean input', () => {
    const key = artifactKey({
      teamId: 'team-123',
      project: 'general',
      sourceId: 'src-abc',
      name: 'extracted.txt',
    })
    expect(key).toBe('team/team-123/general/src-abc/extracted/extracted.txt')
  })

  it('carries the literal "extracted" discriminator segment', () => {
    const key = artifactKey({ teamId: 't', project: 'p', sourceId: 's', name: 'page1.png' })
    expect(key.split('/')).toContain('extracted')
  })

  it('differs from the original key only in the discriminator segment', () => {
    const base = { teamId: 't', project: 'p', sourceId: 's' }
    const orig = originalKey({ ...base, filename: 'x.txt' })
    const art = artifactKey({ ...base, name: 'x.txt' })
    expect(orig.replace('/original/', '/SLOT/')).toBe(art.replace('/extracted/', '/SLOT/'))
  })
})

describe('key sanitization — caller-influenced segments', () => {
  it('collapses path traversal in filename to a single safe segment', () => {
    const key = originalKey({
      teamId: 'team-1',
      project: 'general',
      sourceId: 'src-1',
      filename: '../../../etc/passwd',
    })
    // seg() rewrites only chars OUTSIDE [A-Za-z0-9._-] — so the traversal SLASHES
    // become underscores (dots are in the allowed class and survive). The key
    // result is a single filename segment that cannot escape the prefix.
    expect(key).toBe('team/team-1/general/src-1/original/.._.._.._etc_passwd')
    // Crucially: the key has the fixed 6-segment shape; the filename cannot add
    // path segments that escape the team/project/source prefix.
    expect(key.split('/')).toHaveLength(6)
  })

  it('collapses traversal in the project segment too', () => {
    const key = originalKey({
      teamId: 'team-1',
      project: '../evil',
      sourceId: 'src-1',
      filename: 'f.txt',
    })
    expect(key.split('/')).toHaveLength(6)
    // Only the slash is rewritten; the leading '..' dots survive (allowed class).
    expect(key).toBe('team/team-1/.._evil/src-1/original/f.txt')
  })

  it('maps spaces, slashes, and unicode to underscore', () => {
    const key = artifactKey({
      teamId: 't',
      project: 'p',
      sourceId: 's',
      name: 'my file/ünïcode name.txt',
    })
    const last = key.split('/').at(-1)!
    expect(last).toBe('my_file__nïcode_name.txt'.replace(/[^A-Za-z0-9._-]/g, '_'))
    // No stray slash leaked into the name segment.
    expect(key.split('/')).toHaveLength(6)
  })

  it('preserves the allowed character class verbatim (A-Za-z0-9._-)', () => {
    const name = 'Doc_v1.2-FINAL.txt'
    const key = artifactKey({ teamId: 't', project: 'p', sourceId: 's', name })
    expect(key.split('/').at(-1)).toBe(name)
  })
})

describe('key sanitization — server-stamped segments pass through', () => {
  it('does NOT sanitize teamId or sourceId (trusted server uuids)', () => {
    // A realistic uuid contains hyphens (allowed) — the point is teamId/sourceId
    // are interpolated raw, not run through seg(). Use a value with a char that
    // seg() WOULD rewrite to prove it is untouched.
    const key = originalKey({
      teamId: 'team:with:colons',
      project: 'p',
      sourceId: 'src/slash',
      filename: 'f.txt',
    })
    expect(key).toContain('team/team:with:colons/')
    expect(key).toContain('/src/slash/')
  })
})
