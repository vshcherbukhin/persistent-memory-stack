/**
 * Neural Obsidian primitives for the wizard: the stroke icon set, the product
 * mark shared with the dashboard, the memory-lattice artwork and a notice with
 * its tone glyph. The installer must work offline, so icons are inline paths
 * taken from the design system's own set rather than a font or a CDN.
 */
import type { ReactNode } from 'react'

const PATHS = {
  arrow_left: '<path d="M19.5 12h-15M10.5 6l-6 6 6 6"/>',
  arrow_right: '<path d="M4.5 12h15M13.5 6l6 6-6 6"/>',
  bolt: '<path d="M13.4 3L5.8 13.4h5L10.2 21l7.9-10.6h-5.2z"/>',
  check: '<path d="M5 12.6l4.6 4.6L19 6.6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  cloud_sync: '<path d="M7.5 18A4.5 4.5 0 0 1 7 9a5.5 5.5 0 0 1 10.5 1.6A3.7 3.7 0 0 1 17 18"/><path d="M9.5 15.5A3 3 0 0 1 14 13m.5 4A3 3 0 0 1 10 19.5"/><path d="M9.5 13v2.5H12M14.5 19.5V17H12"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3.5v3.5M14 3.5v3.5M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5"/>',
  database: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
  error_outline: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.6v5M12 16.1h.01"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.4h9A1.5 1.5 0 0 1 21 9.9v8.6A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  hub: '<circle cx="12" cy="12" r="2.4"/><circle cx="12" cy="4" r="1.8"/><circle cx="19" cy="17" r="1.8"/><circle cx="5" cy="17" r="1.8"/><path d="M12 6.4v3.2M13.9 13.4l3.4 2.2M10.1 13.4l-3.4 2.2"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.4M12 7.9h.01"/>',
  key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M15.5 12v2.4"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/><path d="M12 14.5v2.4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20.2 4.4V10h-5.5"/>',
  sparkle: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7.5 10l3 2.5-3 2.5M13 15.2h4"/>',
  warning: '<path d="M12 3.6L21.2 19a1 1 0 0 1-.86 1.5H3.66A1 1 0 0 1 2.8 19z"/><path d="M12 9.4v4.4M12 17.2h.01"/>',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={`ic${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // Static, product-owned path data — never user input.
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  )
}

/** The memory-graph mark the dashboard uses, so the install hands off to the same brand. */
export function ProductMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6.5 7.5 12 4l5.5 3.5v6L12 20l-5.5-3.5v-9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="m6.8 7.7 5.2 3.1 5.2-3.1M12 10.8V20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="4" r="2" fill="currentColor" />
      <circle cx="6.5" cy="7.5" r="1.75" fill="currentColor" />
      <circle cx="17.5" cy="7.5" r="1.75" fill="currentColor" />
      <circle cx="12" cy="20" r="2" fill="currentColor" />
    </svg>
  )
}

const LATTICE_NODES: [number, number][] = [[24, 66], [52, 32], [74, 80], [100, 50], [128, 88], [150, 38], [172, 68], [96, 18]]
const LATTICE_EDGES: [number, number][] = [[0, 1], [1, 3], [3, 2], [2, 4], [3, 5], [5, 6], [4, 6], [1, 7], [7, 3], [0, 2]]
const LATTICE_FILL = ['var(--accent)', 'var(--accent-2)', 'var(--ok)']

/** Design-system lattice artwork: a small memory/entity/fact constellation. Decorative. */
export function Lattice({ width = 190, height = 108, className }: { width?: number; height?: number; className?: string }) {
  return (
    <svg className={`lattice${className ? ` ${className}` : ''}`} width={width} height={height} viewBox="0 0 190 108" fill="none" aria-hidden="true">
      {LATTICE_EDGES.map(([a, b]) => (
        <line key={`${a}-${b}`} x1={LATTICE_NODES[a][0]} y1={LATTICE_NODES[a][1]} x2={LATTICE_NODES[b][0]} y2={LATTICE_NODES[b][1]} stroke="var(--border-strong)" strokeWidth="1" />
      ))}
      {LATTICE_NODES.map(([x, y], index) => (
        <circle key={index} className="lattice-node" cx={x} cy={y} r={index % 3 === 0 ? 4.5 : 3} fill={LATTICE_FILL[index % 3]} style={{ animationDelay: `${index * 0.4}s` }} />
      ))}
    </svg>
  )
}

export type NoticeTone = 'info' | 'accent' | 'ok' | 'warn' | 'bad' | 'fault'

const TONE_ICON: Record<NoticeTone, IconName> = {
  info: 'info',
  accent: 'info',
  ok: 'check',
  warn: 'warning',
  bad: 'error_outline',
  fault: 'error_outline',
}

/** Prototype notice: tone glyph, optional title, body. `fault` adds the hazard treatment. */
export function Notice({
  tone = 'info',
  title,
  icon,
  role,
  className,
  children,
}: {
  tone?: NoticeTone
  title?: ReactNode
  icon?: IconName
  role?: 'alert' | 'status'
  className?: string
  children?: ReactNode
}) {
  const toneClass = tone === 'info' ? '' : tone === 'fault' ? ' bad fault' : ` ${tone}`
  return (
    <div className={`notice with-icon${toneClass}${className ? ` ${className}` : ''}`} role={role}>
      <span className="n-ic"><Icon name={icon ?? TONE_ICON[tone]} size={16} /></span>
      <div className="n-body">
        {title ? <span className="notice-title">{title}</span> : null}
        {children}
      </div>
    </div>
  )
}
