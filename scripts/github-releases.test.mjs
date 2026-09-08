import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchPublishedRelease, fetchPublishedReleaseMetadata, listPublishedReleases } from './github-releases.mjs'

const sha = 'a'.repeat(40)
const tagSha = 'b'.repeat(40)
const repository = 'vshcherbukhin/persistent-memory-stack'
const api = `https://api.github.com/repos/${repository}/`
const history = version => `# Release History\n<!-- persistent-memory-release-line: public-v1 -->\n\n## ${version} - 2026-09-07\n\nChanges.\n`
const release = (version = '1.1.0', overrides = {}) => ({
  tag_name: `v${version}`, draft: false, prerelease: false,
  published_at: '2026-09-07T12:00:00Z', target_commitish: 'master',
  html_url: `https://github.com/${repository}/releases/tag/v${version}`, ...overrides,
})

function fixture({ version = '1.1.0', overrides = {}, annotated = false, responder } = {}) {
  const requests = []
  const fetchImpl = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    const custom = responder?.(url)
    if (custom !== undefined) return custom
    if (url === `${api}releases/latest` || url === `${api}releases/tags/v${version}`) return Response.json(release(version, overrides))
    if (url === `${api}git/ref/tags/v${version}`) return Response.json({ ref: `refs/tags/v${version}`, object: { type: annotated ? 'tag' : 'commit', sha: annotated ? tagSha : sha } })
    if (url === `${api}git/tags/${tagSha}`) return Response.json({ sha: tagSha, object: { type: 'commit', sha } })
    if (url === `${api}contents/package.json?ref=${sha}`) return Response.json({ version, persistentMemoryReleaseLine: 'public-v1' })
    if (url === `${api}contents/release-history.md?ref=${sha}`) return new Response(history(version))
    throw new Error(`Unexpected fixture request: ${url}`)
  }
  return { fetchImpl, requests }
}

test('latest resolves a lightweight release tag and never a moving target_commitish branch', async () => {
  const { fetchImpl, requests } = fixture({ overrides: { target_commitish: 'dev-with-unreleased-changes' } })
  assert.deepEqual(await fetchPublishedRelease({ fetchImpl }), { tag: 'v1.1.0', version: '1.1.0', commit: sha, url: release().html_url })
  assert.deepEqual(requests.map(({ url }) => url.slice(api.length)), [
    'releases/latest', 'git/ref/tags/v1.1.0', `contents/package.json?ref=${sha}`, `contents/release-history.md?ref=${sha}`,
  ])
  assert.equal(new Set(requests.map(({ init }) => init.signal)).size, 1)
  for (const { init } of requests) {
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal instanceof AbortSignal)
    assert.equal(Object.keys(init.headers).some(key => key.toLowerCase() === 'authorization'), false)
  }
})

test('an exact requested version resolves its annotated tag before reading content', async () => {
  const { fetchImpl, requests } = fixture({ version: '1.0.0', annotated: true })
  assert.deepEqual(await fetchPublishedRelease({ version: '1.0.0', fetchImpl }), { tag: 'v1.0.0', version: '1.0.0', commit: sha, url: release('1.0.0').html_url })
  assert.equal(requests[0].url, `${api}releases/tags/v1.0.0`)
  assert.equal(requests[2].url, `${api}git/tags/${tagSha}`)
  assert.equal(requests.length, 5)
})

test('metadata reuses the validated history without refetching immutable content', async () => {
  const { fetchImpl, requests } = fixture()
  const metadata = await fetchPublishedReleaseMetadata({ fetchImpl })
  assert.equal(metadata.releaseHistory, history('1.1.0'))
  assert.equal(requests.length, 4)
})

for (const [name, overrides] of [
  ['draft', { draft: true }], ['prerelease', { prerelease: true }], ['missing draft flag', { draft: undefined }],
  ['unpublished', { published_at: null }], ['invalid publication date', { published_at: 'not a date' }],
  ['noncanonical tag', { tag_name: 'release-next' }], ['prerelease tag', { tag_name: 'v1.1.0-rc.1' }],
  ['zero-padded tag', { tag_name: 'v01.1.0' }], ['external link', { html_url: 'https://evil.example/release' }],
]) {
  test(`rejects ${name} before resolving a tag`, async () => {
    const { fetchImpl, requests } = fixture({ overrides })
    await assert.rejects(fetchPublishedRelease({ fetchImpl }), /invalid release metadata/)
    assert.equal(requests.length, 1)
  })
}

test('missing releases and unpublished bare tags fail without a branch or Git tag fallback', async () => {
  for (const version of [undefined, '1.1.0']) {
    const { fetchImpl, requests } = fixture({ responder: url => url.includes('/releases/') ? new Response('private upstream body', { status: 404 }) : undefined })
    await assert.rejects(fetchPublishedRelease({ version, fetchImpl }), error => /HTTP 404/.test(error.message) && !error.message.includes('private'))
    assert.equal(requests.length, 1)
  }
})

test('requested version cannot resolve to a different released version', async () => {
  const { fetchImpl, requests } = fixture({ responder: url => url.includes('/releases/tags/') ? Response.json(release('1.2.0')) : undefined })
  await assert.rejects(fetchPublishedRelease({ version: '1.1.0', fetchImpl }), /invalid release metadata/)
  assert.equal(requests.length, 1)
})

test('rejects malformed requested versions without making a request', async () => {
  const { fetchImpl, requests } = fixture()
  for (const version of ['latest', 'v1.1.0', '1.1.0-rc.1', '../master', 123]) {
    await assert.rejects(fetchPublishedRelease({ version, fetchImpl }), /invalid release metadata/)
  }
  assert.equal(requests.length, 0)
})

for (const object of [{ type: 'commit', sha: 'master' }, { type: 'tree', sha }, null]) {
  test(`rejects a tag ref with invalid commit object ${JSON.stringify(object)}`, async () => {
    const { fetchImpl } = fixture({ responder: url => url.includes('/git/ref/') ? Response.json({ ref: 'refs/tags/v1.1.0', object }) : undefined })
    await assert.rejects(fetchPublishedRelease({ fetchImpl }), /invalid release metadata/)
  })
}

test('rejects the wrong tag ref and a cycle of annotated tags', async () => {
  const wrong = fixture({ responder: url => url.includes('/git/ref/') ? Response.json({ ref: 'refs/tags/v1.2.0', object: { type: 'commit', sha } }) : undefined })
  await assert.rejects(fetchPublishedRelease(wrong), /invalid release metadata/)
  const cycle = fixture({ annotated: true, responder: url => url.includes('/git/tags/') ? Response.json({ sha: tagSha, object: { type: 'tag', sha: tagSha } }) : undefined })
  await assert.rejects(fetchPublishedRelease(cycle), /invalid release metadata/)
  assert.equal(cycle.requests.length, 3)
})

test('requires package version and public release lineage to match the selected release', async () => {
  for (const pkg of [{ version: '1.2.0', persistentMemoryReleaseLine: 'public-v1' }, { version: '1.1.0' }, { version: '1.1.0', persistentMemoryReleaseLine: 'private-v0' }]) {
    const { fetchImpl, requests } = fixture({ responder: url => url.includes('/contents/package.json') ? Response.json(pkg) : undefined })
    await assert.rejects(fetchPublishedRelease({ fetchImpl }), /invalid release metadata|public release line is not available/)
    assert.equal(requests.length, 3)
  }
})

test('requires marked history with the same top release entry at the immutable commit', async () => {
  for (const text of [history('1.2.0'), history('1.1.0').replace('public-v1', 'private-v0'), history('1.1.0').replace('## 1.1.0', '## Not a release'), '']) {
    const { fetchImpl } = fixture({ responder: url => url.includes('/contents/release-history.md') ? new Response(text) : undefined })
    await assert.rejects(fetchPublishedRelease({ fetchImpl }), /invalid release metadata/)
  }
})

test('listing filters drafts and prereleases without resolving every candidate commit', async () => {
  const calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    return Response.json([release('1.2.0', { draft: true }), release('1.2.0-rc.1', { prerelease: true }), release('1.1.0'), release('1.0.0')])
  }
  assert.deepEqual(await listPublishedReleases({ fetchImpl }), ['1.1.0', '1.0.0'].map(version => ({ version, tag: `v${version}`, url: release(version).html_url })))
  assert.deepEqual(calls, [`${api}releases?per_page=100&page=1`])
})

test('listing follows bounded pages and rejects empty or malformed stable releases', async () => {
  const calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    return Response.json(calls.length === 1 ? Array.from({ length: 100 }, (_, i) => release(`1.0.${i}`)) : [release('1.1.0')])
  }
  assert.equal((await listPublishedReleases({ fetchImpl })).length, 101)
  assert.equal(calls[1], `${api}releases?per_page=100&page=2`)
  await assert.rejects(listPublishedReleases({ fetchImpl: async () => Response.json([]) }), /No stable published release/)
  await assert.rejects(listPublishedReleases({ fetchImpl: async () => Response.json([release('1.1.0'), release('1.1.0')]) }), /invalid release metadata/)
  await assert.rejects(listPublishedReleases({ fetchImpl: async () => Response.json([{}]) }), /invalid release metadata/)
})

test('rate limits remain typed safe failures with an explicit retry deadline', async () => {
  const fetchImpl = async () => new Response('do not expose this body', { status: 429, headers: { 'retry-after': '1800' } })
  await assert.rejects(fetchPublishedRelease({ fetchImpl, now: () => 0 }), error => error.retryAt === 1_800_000 && !error.message.includes('body'))
})
