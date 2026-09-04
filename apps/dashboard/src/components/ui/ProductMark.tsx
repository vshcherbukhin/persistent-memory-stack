import type { SVGProps } from 'react'

/** Product-owned memory-graph mark used on the login and dashboard navigation surfaces. */
export function ProductMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M6.5 7.5 12 4l5.5 3.5v6L12 20l-5.5-3.5v-9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="m6.8 7.7 5.2 3.1 5.2-3.1M12 10.8V20" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="12" cy="4" r="2" fill="currentColor" />
      <circle cx="6.5" cy="7.5" r="1.75" fill="currentColor" />
      <circle cx="17.5" cy="7.5" r="1.75" fill="currentColor" />
      <circle cx="12" cy="20" r="2" fill="currentColor" />
    </svg>
  )
}
