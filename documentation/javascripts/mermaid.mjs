const pmMermaid = window.mermaid

if (!pmMermaid) throw new Error('Mermaid browser runtime did not load')

pmMermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
  themeVariables: {
    background: '#0a0d10',
    primaryColor: '#10212a',
    primaryTextColor: '#d3d3d3',
    primaryBorderColor: '#16a7db',
    secondaryColor: '#16191d',
    tertiaryColor: '#0c0f13',
    lineColor: '#aeb2b7',
    textColor: '#d3d3d3',
    clusterBkg: '#101419',
    clusterBorder: '#474747',
    edgeLabelBackground: '#0a0d10',
  },
})

window.mermaid = pmMermaid

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
let diagramSequence = 0

function materialIcon(name) {
  const icon = document.createElement('span')
  icon.className = 'material-icons-outlined'
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = name
  return icon
}

function iconButton(name, label, className = '') {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.setAttribute('aria-label', label)
  button.title = label
  button.append(materialIcon(name))
  return button
}

function svgSize(svg) {
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/\s+/).map(Number)
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    return { width: Math.max(1, viewBox[2]), height: Math.max(1, viewBox[3]) }
  }
  return {
    width: Math.max(1, Number.parseFloat(svg.getAttribute('width') || '') || 1200),
    height: Math.max(1, Number.parseFloat(svg.getAttribute('height') || '') || 800),
  }
}

function openDiagram(source) {
  const sourceSvg = source.querySelector('svg')
  if (!sourceSvg) return

  const dialog = document.createElement('dialog')
  dialog.className = 'pm-diagram-dialog'
  dialog.setAttribute('aria-label', 'Diagram viewer')

  const shell = document.createElement('div')
  shell.className = 'pm-diagram-shell'
  const toolbar = document.createElement('div')
  toolbar.className = 'pm-diagram-toolbar'
  const stage = document.createElement('div')
  stage.className = 'pm-diagram-stage'
  stage.tabIndex = 0
  stage.setAttribute('aria-label', 'Pan and zoom diagram')
  const canvas = document.createElement('div')
  canvas.className = 'pm-diagram-canvas'

  const svg = sourceSvg.cloneNode(true)
  const size = svgSize(svg)
  svg.setAttribute('width', String(size.width))
  svg.setAttribute('height', String(size.height))
  canvas.append(svg)
  stage.append(canvas)

  const zoomOut = iconButton('zoom_out', 'Zoom out')
  const reset = iconButton('fit_screen', 'Fit diagram')
  const zoomIn = iconButton('zoom_in', 'Zoom in')
  const close = iconButton('close', 'Close diagram', 'pm-diagram-close')
  toolbar.append(zoomOut, reset, zoomIn, close)
  shell.append(toolbar, stage)
  dialog.append(shell)
  document.body.append(dialog)

  let scale = 1
  let x = 0
  let y = 0
  let activePointer = null
  let pointerX = 0
  let pointerY = 0
  const previousFocus = document.activeElement

  const render = () => {
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
  }

  const fit = () => {
    const width = stage.clientWidth
    const height = stage.clientHeight
    scale = clamp(Math.min((width - 72) / size.width, (height - 72) / size.height), 0.1, 2)
    x = (width - size.width * scale) / 2
    y = (height - size.height * scale) / 2
    render()
  }

  const zoomAt = (nextScale, clientX, clientY) => {
    const rect = stage.getBoundingClientRect()
    const pointX = clientX - rect.left
    const pointY = clientY - rect.top
    const diagramX = (pointX - x) / scale
    const diagramY = (pointY - y) / scale
    scale = clamp(nextScale, 0.1, 6)
    x = pointX - diagramX * scale
    y = pointY - diagramY * scale
    render()
  }

  const zoomCenter = (factor) => {
    const rect = stage.getBoundingClientRect()
    zoomAt(scale * factor, rect.left + rect.width / 2, rect.top + rect.height / 2)
  }

  zoomOut.addEventListener('click', () => zoomCenter(0.8))
  zoomIn.addEventListener('click', () => zoomCenter(1.25))
  reset.addEventListener('click', fit)
  close.addEventListener('click', () => dialog.close())

  stage.addEventListener('wheel', (event) => {
    event.preventDefault()
    zoomAt(scale * (event.deltaY < 0 ? 1.12 : 0.89), event.clientX, event.clientY)
  }, { passive: false })

  stage.addEventListener('pointerdown', (event) => {
    activePointer = event.pointerId
    pointerX = event.clientX
    pointerY = event.clientY
    stage.classList.add('is-dragging')
    stage.setPointerCapture(event.pointerId)
  })

  stage.addEventListener('pointermove', (event) => {
    if (event.pointerId !== activePointer) return
    x += event.clientX - pointerX
    y += event.clientY - pointerY
    pointerX = event.clientX
    pointerY = event.clientY
    render()
  })

  const stopDrag = (event) => {
    if (event.pointerId !== activePointer) return
    activePointer = null
    stage.classList.remove('is-dragging')
  }
  stage.addEventListener('pointerup', stopDrag)
  stage.addEventListener('pointercancel', stopDrag)

  stage.addEventListener('keydown', (event) => {
    const panStep = event.shiftKey ? 80 : 30
    if (event.key === '+' || event.key === '=') zoomCenter(1.25)
    else if (event.key === '-') zoomCenter(0.8)
    else if (event.key === '0') fit()
    else if (event.key === 'ArrowLeft') x += panStep
    else if (event.key === 'ArrowRight') x -= panStep
    else if (event.key === 'ArrowUp') y += panStep
    else if (event.key === 'ArrowDown') y -= panStep
    else return
    event.preventDefault()
    render()
  })

  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })
  dialog.addEventListener('close', () => {
    dialog.remove()
    if (previousFocus instanceof HTMLElement) previousFocus.focus()
  })

  dialog.showModal()
  requestAnimationFrame(() => {
    fit()
    stage.focus()
  })
}

function enhanceDiagrams(root = document) {
  for (const diagram of root.querySelectorAll('.pm-mermaid-diagram')) {
    if (diagram.dataset.pmDiagramEnhanced === 'true' || !diagram.querySelector('svg')) continue
    diagram.dataset.pmDiagramEnhanced = 'true'
    diagram.tabIndex = 0
    diagram.setAttribute('role', 'button')
    diagram.setAttribute('aria-label', 'Open diagram viewer')
    diagram.addEventListener('click', () => openDiagram(diagram))
    diagram.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      openDiagram(diagram)
    })
  }
}

async function renderDiagrams(root = document) {
  for (const source of root.querySelectorAll('.pm-mermaid-source')) {
    if (source.dataset.pmDiagramRendering === 'true') continue
    source.dataset.pmDiagramRendering = 'true'
    const definition = source.textContent?.trim()
    if (!definition) continue

    try {
      const id = `pm-mermaid-${++diagramSequence}`
      const { svg, bindFunctions } = await pmMermaid.render(id, definition)
      const diagram = document.createElement('div')
      diagram.className = 'pm-mermaid-diagram'
      diagram.innerHTML = svg
      source.replaceWith(diagram)
      bindFunctions?.(diagram)
    } catch (error) {
      source.dataset.pmDiagramRendering = 'failed'
      source.classList.add('pm-mermaid-error')
      console.error('[documentation] Mermaid render failed', error)
    }
  }
  enhanceDiagrams(root)
}

const observer = new MutationObserver(() => {
  void renderDiagrams()
})

function startEnhancements() {
  observer.observe(document.body, { childList: true, subtree: true })
  void renderDiagrams()
}

if (window.document$?.subscribe) {
  window.document$.subscribe(() => startEnhancements())
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startEnhancements, { once: true })
} else {
  startEnhancements()
}
