const NAVIGATION_STATE_KEY = 'pm-docs-primary-navigation'

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual'
}

const primarySidebar = () =>
  document.querySelector('.md-sidebar--primary .md-sidebar__scrollwrap')

const saveNavigationState = (state) => {
  try {
    sessionStorage.setItem(NAVIGATION_STATE_KEY, JSON.stringify(state))
  } catch {
    // Storage may be disabled; navigation should continue normally.
  }
}

const takeNavigationState = () => {
  try {
    const value = sessionStorage.getItem(NAVIGATION_STATE_KEY)
    sessionStorage.removeItem(NAVIGATION_STATE_KEY)
    if (!value) return null

    const state = JSON.parse(value)
    if (typeof state.pathname !== 'string' || !Number.isFinite(state.scrollTop)) {
      return null
    }
    return state
  } catch {
    return null
  }
}

document.addEventListener('click', (event) => {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    !(event.target instanceof Element)
  ) return

  const link = event.target.closest('.md-nav--primary a[href]')
  if (!link || link.target && link.target !== '_self' || link.hasAttribute('download')) return

  const target = new URL(link.href, window.location.href)
  if (
    target.origin !== window.location.origin ||
    target.pathname === window.location.pathname
  ) return

  saveNavigationState({
    pathname: target.pathname,
    scrollTop: primarySidebar()?.scrollTop ?? 0,
  })
}, { capture: true })

const restoreNavigationState = () => {
  const state = takeNavigationState()
  if (!state || state.pathname !== window.location.pathname) return

  const restorePosition = () => {
    const sidebar = primarySidebar()
    sidebar?.scrollTo({ top: state.scrollTop, left: 0, behavior: 'instant' })
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }

  restorePosition()
  requestAnimationFrame(restorePosition)
}

restoreNavigationState()
window.addEventListener('pageshow', restoreNavigationState)
