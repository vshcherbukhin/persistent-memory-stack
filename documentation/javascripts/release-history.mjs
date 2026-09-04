const releaseDialog = document.querySelector('[data-pm-release-dialog]')
const releaseTrigger = document.querySelector('[data-pm-release-trigger]')
const releaseClose = document.querySelector('[data-pm-release-close]')
const releaseContent = document.querySelector('[data-pm-release-content]')
let releaseHistoryLoaded = false

const setReleaseMessage = (message, className = '') => {
  if (!releaseContent) return
  const messageElement = document.createElement('p')
  if (className) messageElement.className = className
  messageElement.textContent = message
  releaseContent.replaceChildren(messageElement)
}

const loadReleaseHistory = async () => {
  if (releaseHistoryLoaded || !releaseContent) return

  setReleaseMessage('Loading release history…', 'pm-release-loading')
  try {
    const response = await fetch('release-history.html', { cache: 'no-store' })
    if (!response.ok) throw new Error(`release history returned ${response.status}`)

    const documentPage = new DOMParser().parseFromString(await response.text(), 'text/html')
    const releaseArticle = documentPage.querySelector('.md-content__inner')
    if (!releaseArticle) throw new Error('release history content was unavailable')

    releaseContent.replaceChildren(
      ...[...releaseArticle.children].map((child) => document.importNode(child, true)),
    )
    releaseHistoryLoaded = true
  } catch {
    setReleaseMessage('Could not load release history. Please try again.', 'pm-release-error')
  }
}

const closeReleaseHistory = () => {
  if (releaseDialog?.open) releaseDialog.close()
}

releaseTrigger?.addEventListener('click', () => {
  if (!releaseDialog) return
  releaseDialog.showModal()
  void loadReleaseHistory()
})

releaseClose?.addEventListener('click', closeReleaseHistory)

releaseDialog?.addEventListener('click', (event) => {
  if (event.target === releaseDialog) closeReleaseHistory()
})

releaseDialog?.addEventListener('close', () => {
  releaseTrigger?.focus()
})
