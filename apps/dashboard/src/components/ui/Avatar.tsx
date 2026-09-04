/**
 * Avatar (P2) — colored initials for user identity. Pure presentational (no
 * hooks) so it renders in server or client components.
 */
/** Initials, preferring the email's local-part (e.g. `first.last@…` → "FL") since
 * display names are often a single word; falls back to the name's words. */
function initialsOf(name: string, email?: string): string {
  if (email && email.includes('@')) {
    const parts = email.split('@')[0]!.split(/[._-]+/).filter(Boolean)
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
    if (parts.length === 1 && parts[0]!.length >= 2) return parts[0]!.slice(0, 2).toUpperCase()
  }
  const w = name.trim().split(/\s+/).filter(Boolean)
  if (w.length === 0) return '?'
  if (w.length === 1) return w[0]!.slice(0, 2).toUpperCase()
  return (w[0]![0]! + w[w.length - 1]![0]!).toUpperCase()
}

export function Avatar({
  name,
  email,
  size = 30,
}: {
  name: string
  email?: string
  size?: number
}) {
  return (
    <span
      className="ui-avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden
    >
      {initialsOf(name, email)}
    </span>
  )
}
