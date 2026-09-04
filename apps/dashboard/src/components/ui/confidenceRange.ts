export type ConfidenceRange = { min: string; max: string }

const STEP = 0.1
const format = (value: number) => value.toFixed(1)
const clamp = (value: number) => Math.max(0, Math.min(1, Math.round(value * 10) / 10))

export function adjustConfidenceRange(current: ConfidenceRange, key: keyof ConfidenceRange, direction: -1 | 1): ConfidenceRange {
  const next = clamp(Number(current[key]) + direction * STEP)
  if ((key === 'min' && next > Number(current.max)) || (key === 'max' && next < Number(current.min))) return current
  return { ...current, [key]: format(next) }
}
