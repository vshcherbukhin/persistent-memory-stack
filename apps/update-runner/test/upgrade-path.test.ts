import { describe, expect, it } from 'vitest'
import {
  planUpgradePath,
  validateUpgradeContract,
  type ReleaseUpgradeContract,
} from '../../../layers/update-ops/release-versioning/upgrade-contract.ts'

const bootstrap: ReleaseUpgradeContract = {
  schemaVersion: 1,
  release: '4.0.29',
  minimumSupportedSource: '4.0.24',
  compatibleMajorLine: 4,
  directFrom: '>=4.0.24 <4.0.30',
  bridges: [],
  requiredStops: [],
  coordinator: { minimumVersion: 1, bootstrap: true },
}

describe('release upgrade path planning', () => {
  it('plans a direct previous-patch update to the target release', () => {
    expect(planUpgradePath('4.0.28', bootstrap, new Map([[bootstrap.release, bootstrap]]))).toEqual(['4.0.29'])
  })

  it('plans the earliest supported same-major source directly to the bootstrap release', () => {
    expect(planUpgradePath('4.0.24', bootstrap, new Map([[bootstrap.release, bootstrap]]))).toEqual(['4.0.29'])
  })

  it('refuses to downgrade a source that is newer than the target release', () => {
    expect(() => planUpgradePath(
      '4.0.30',
      bootstrap,
      new Map([[bootstrap.release, bootstrap]]),
    )).toThrow('newer than target release')
  })

  it('routes a previous-major source through its declared required stop', () => {
    const majorRelease: ReleaseUpgradeContract = {
      schemaVersion: 1,
      release: '5.0.0',
      minimumSupportedSource: '4.0.24',
      compatibleMajorLine: 5,
      directFrom: '>=4.0.29 <6.0.0',
      bridges: [{
        from: '>=4.0.29 <5.0.0',
        to: '5.0.0',
        requires: '>=4.0.29',
        reason: 'Installs the durable update coordinator before the major transition.',
      }],
      requiredStops: [{
        when: '>=4.0.24 <4.0.29',
        release: '4.0.29',
        reason: 'Installs the durable update coordinator.',
      }],
      coordinator: { minimumVersion: 1, bootstrap: false },
    }

    expect(planUpgradePath('4.0.24', majorRelease, new Map([
      [bootstrap.release, bootstrap],
      [majorRelease.release, majorRelease],
    ]))).toEqual(['4.0.29', '5.0.0'])
  })

  it('refuses a cross-major route without its declared bridge', () => {
    const majorRelease: ReleaseUpgradeContract = {
      schemaVersion: 1,
      release: '5.0.0',
      minimumSupportedSource: '4.0.24',
      compatibleMajorLine: 5,
      directFrom: '>=4.0.29 <6.0.0',
      bridges: [],
      requiredStops: [],
      coordinator: { minimumVersion: 1, bootstrap: false },
    }

    expect(() => planUpgradePath('4.0.29', majorRelease, new Map([
      [bootstrap.release, bootstrap],
      [majorRelease.release, majorRelease],
    ]))).toThrow('declared bridge is required')
  })

  it('rejects a release contract whose declared release does not match its package version', () => {
    expect(() => validateUpgradeContract(
      { ...bootstrap, release: '4.0.30' },
      { packageVersion: '4.0.29', availableReleases: new Set(['4.0.29']) },
    )).toThrow('does not match package version')
  })

  it('rejects an invalid bridge that does not terminate at the contract release', () => {
    expect(() => validateUpgradeContract(
      {
        ...bootstrap,
        bridges: [{
          from: '>=4.0.24 <5.0.0',
          to: '4.0.27',
          requires: '>=4.0.24',
          reason: 'This would leave the route ambiguous.',
        }],
      },
      { packageVersion: '4.0.29', availableReleases: new Set(['4.0.27', '4.0.29']) },
    )).toThrow('must target release 4.0.29')
  })

  it('rejects a required stop that is not earlier than its target release', () => {
    expect(() => validateUpgradeContract(
      {
        ...bootstrap,
        requiredStops: [{
          when: '>=4.0.24 <4.0.29',
          release: '4.0.29',
          reason: 'This is a redundant stop.',
        }],
      },
      { packageVersion: '4.0.29', availableReleases: new Set(['4.0.29']) },
    )).toThrow('must be earlier than target release')
  })

  it('does not accept prerelease identifiers in production release contracts', () => {
    expect(() => validateUpgradeContract(
      { ...bootstrap, release: '4.0.29-rc.1' },
      { packageVersion: '4.0.29-rc.1', availableReleases: new Set(['4.0.29-rc.1']) },
    )).toThrow('Invalid semantic version')
  })

  it('rejects a contract whose minimum source is newer than its release', () => {
    expect(() => validateUpgradeContract(
      { ...bootstrap, minimumSupportedSource: '4.0.30' },
      { packageVersion: '4.0.29', availableReleases: new Set(['4.0.29']) },
    )).toThrow('cannot be later than release')
  })

  it('rejects a direct route that can select a source newer than its target', () => {
    expect(() => validateUpgradeContract(
      { ...bootstrap, directFrom: '>=4.0.24 <5.0.0' },
      { packageVersion: '4.0.29', availableReleases: new Set(['4.0.29']) },
    )).toThrow('permits versions newer than target release')
  })

  it('rejects fields outside the published contract schema', () => {
    expect(() => validateUpgradeContract(
      { ...bootstrap, untrustedOverride: true },
      { packageVersion: '4.0.29', availableReleases: new Set(['4.0.29']) },
    )).toThrow('unsupported field')
  })

  it('rejects duplicate required stops', () => {
    const duplicateStop = {
      when: '>=4.0.24 <4.0.26',
      release: '4.0.26',
      reason: 'Installs a compatibility bridge.',
    }

    expect(() => validateUpgradeContract(
      {
        ...bootstrap,
        requiredStops: [duplicateStop, { ...duplicateStop, when: '>=4.0.26 <4.0.29' }],
      },
      { packageVersion: '4.0.29', availableReleases: new Set(['4.0.26', '4.0.29']) },
    )).toThrow('duplicated')
  })

  it('rejects a required stop that is absent from the trusted release history', () => {
    expect(() => validateUpgradeContract(
      {
        ...bootstrap,
        requiredStops: [{
          when: '>=4.0.24 <4.0.27',
          release: '4.0.27',
          reason: 'This stop is not present on the release branch.',
        }],
      },
      { packageVersion: '4.0.29', availableReleases: new Set(['4.0.29']) },
    )).toThrow('unavailable from the trusted branch')
  })

  it('refuses to plan from an unsupported source release', () => {
    expect(() => planUpgradePath(
      '4.0.23',
      bootstrap,
      new Map([[bootstrap.release, bootstrap]]),
    )).toThrow('older than the supported minimum')
  })
})
