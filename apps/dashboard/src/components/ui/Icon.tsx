import type { CSSProperties, HTMLAttributes } from 'react'
import type { MaterialIcon } from 'material-icons'

export type IconName = MaterialIcon

export function Icon({
  name,
  size = 18,
  className,
  style,
  title,
  decorative = true,
  ...props
}: {
  name: IconName
  size?: number
  title?: string
  decorative?: boolean
  className?: string
  style?: CSSProperties
} & Omit<HTMLAttributes<HTMLSpanElement>, 'children'>) {
  return (
    <span
      className={`material-icons-outlined ui-icon${className ? ` ${className}` : ''}`}
      style={{ fontSize: size, ...style }}
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : title ?? name}
      {...props}
    >
      {name}
    </span>
  )
}
