import { describe, expect, it } from 'vitest'
import { downloadPercent, formatDownloadBytes, prereqProgressEvent } from '../web/src/prereq-progress'

describe('prerequisite progress', () => {
  it('uses measured byte counts and never rounds an unfinished download to 100%', () => {
    const state = prereqProgressEvent({ type: 'progress', stage: 'download', downloadedBytes: 999, totalBytes: 1000 })!
    expect(downloadPercent(state)).toBe(99)
    expect(downloadPercent({ ...state, downloadedBytes: 1000 })).toBe(100)
    expect(downloadPercent({ ...state, downloadedBytes: 1200 })).toBe(100)
  })

  it('keeps unknown, invalid, or zero totals indeterminate', () => {
    for (const totalBytes of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
      const state = prereqProgressEvent({ type: 'progress', stage: 'download', downloadedBytes: 50, totalBytes })!
      expect(downloadPercent(state)).toBeUndefined()
      expect(state.downloadedBytes).toBe(50)
    }
    expect(downloadPercent(prereqProgressEvent({ type: 'progress', stage: 'download', totalBytes: 100 })!)).toBeUndefined()
  })

  it('clears download metrics for verification, installation, startup, and readiness', () => {
    for (const stage of ['verify', 'install', 'start', 'ready']) {
      const state = prereqProgressEvent({ type: 'progress', stage, downloadedBytes: 100, totalBytes: 100 })!
      expect(downloadPercent(state)).toBeUndefined()
      expect(state.downloadedBytes).toBeUndefined()
    }
    expect(prereqProgressEvent({ type: 'progress', stage: 'ready' })?.label).toBe('Checking readiness')
  })

  it('preserves actual macOS step names without inventing percentages', () => {
    const state = prereqProgressEvent({ type: 'step-start', name: 'Install Ollama via Homebrew' })!
    expect(state).toEqual({ label: 'Install Ollama via Homebrew' })
    expect(downloadPercent(state)).toBeUndefined()
    expect(prereqProgressEvent({ type: 'stdout', chunk: '50%' })).toBeNull()
    expect(prereqProgressEvent({ type: 'progress', stage: 'unknown' })).toBeNull()
  })

  it('formats compact binary byte counts with explicit units', () => {
    expect(formatDownloadBytes(512)).toBe('512 B')
    expect(formatDownloadBytes(1024)).toBe('1.0 KiB')
    expect(formatDownloadBytes(512 * 1024 ** 2)).toBe('512.0 MiB')
    expect(formatDownloadBytes(1024 ** 3)).toBe('1.0 GiB')
  })
})
