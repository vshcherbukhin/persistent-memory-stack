import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { adjustConfidenceRange } from './confidenceRange'

const componentSource = () => readFileSync(new URL('./ConfidenceRangeSelect.tsx', import.meta.url), 'utf8')

describe('adjustConfidenceRange', () => {
  it('moves a bound by 0.1 without leaving 0.0–1.0', () => {
    expect(adjustConfidenceRange({ min: '0.0', max: '1.0' }, 'min', 1)).toEqual({ min: '0.1', max: '1.0' })
    expect(adjustConfidenceRange({ min: '0.0', max: '1.0' }, 'min', -1)).toEqual({ min: '0.0', max: '1.0' })
    expect(adjustConfidenceRange({ min: '0.0', max: '1.0' }, 'max', 1)).toEqual({ min: '0.0', max: '1.0' })
  })

  it('does not let min cross max or max cross min', () => {
    expect(adjustConfidenceRange({ min: '1.0', max: '1.0' }, 'min', 1)).toEqual({ min: '1.0', max: '1.0' })
    expect(adjustConfidenceRange({ min: '0.0', max: '0.0' }, 'max', -1)).toEqual({ min: '0.0', max: '0.0' })
  })

  it('applies each range adjustment immediately without an Apply action', () => {
    const component = componentSource()

    expect(component).toContain('onChange: (range: ConfidenceRange) => void')
    expect(component).toContain('onChange(next)')
    expect(component).not.toContain('onApply')
    expect(component).not.toContain('>Apply<')
    expect(component).not.toContain('confidence-range-actions')
  })
})
