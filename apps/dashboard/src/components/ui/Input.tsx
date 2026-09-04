import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'

/**
 * Themed text input (P2). Forces the product-owned dark styling via an explicit class (so it
 * never falls back to a browser-default white box — see also the autofill override in
 * globals.css) and supports an optional leading icon (e.g. a search glyph). Forwards
 * the ref + all native input props, so it drops into existing forms unchanged.
 */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }>(
  function Input({ icon, className, ...props }, ref) {
    const cls = `ui-input${icon ? ' has-icon' : ''}${className ? ` ${className}` : ''}`
    if (!icon) return <input ref={ref} className={cls} {...props} />
    return (
      <span className="ui-input-wrap">
        <span className="ui-input-icon" aria-hidden>
          {icon}
        </span>
        <input ref={ref} className={cls} {...props} />
      </span>
    )
  },
)
