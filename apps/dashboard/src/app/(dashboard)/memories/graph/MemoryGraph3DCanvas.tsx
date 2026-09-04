'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import ForceGraph3D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-3d'
import * as THREE from 'three'
import SpriteText from 'three-spritetext'
import type { MemoryGraphNode } from '@/lib/types'
import {
  buildSphericalGraph,
  cameraDistanceForGraph,
  cameraPositionAtDistance,
  clampGraphPan,
  endpointId,
  GRAPH_NODE_HIT_PIXELS,
  graphNodeTooltip,
  projectColor,
  screenSpaceSpriteScale,
  selectViewportLabelIds,
  sphericalGraphRadius,
  type GraphCameraState,
  type GraphViewPan,
  type ProjectedGraphLabel,
  type RenderGraphEdge,
  type RenderGraphNode,
} from './memoryGraphLayout'

/** react-force-graph-3d builds TrackballControls by default, where panning is
 * disabled through `noPan`. `enablePan` belongs to OrbitControls and is
 * silently ignored here, which is why right-drag used to move the orbit target
 * away from the sphere center. */
interface GraphControls {
  addEventListener: (name: string, fn: () => void) => void
  removeEventListener: (name: string, fn: () => void) => void
  noPan: boolean
  enablePan: boolean
  maxDistance: number
  minDistance: number
  target: THREE.Vector3
  update: () => void
}

const DEFAULT_CAMERA_FOV = 50

function distance(
  position: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): number {
  return Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z)
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export default function MemoryGraph3DCanvas({
  nodes,
  layoutNodes,
  edges,
  selectedId,
  pulseIds,
  pulseSignal,
  totalFilteredMemories,
  autoOverview,
  resetSignal,
  viewStateRef,
  restoreView,
  onSelect,
  onAutoOverviewChange,
  onFallback,
}: {
  nodes: MemoryGraphNode[]
  layoutNodes: MemoryGraphNode[]
  edges: Parameters<typeof buildSphericalGraph>[1]
  selectedId: string | null
  pulseIds: string[]
  pulseSignal: number
  totalFilteredMemories: number
  autoOverview: boolean
  resetSignal: number
  viewStateRef: RefObject<GraphCameraState | null>
  restoreView: boolean
  onSelect: (node: MemoryGraphNode) => void
  onAutoOverviewChange: (active: boolean) => void
  onFallback: (reason: string) => void
}) {
  const graphRef = useRef<ForceGraphMethods<NodeObject<RenderGraphNode>, LinkObject<RenderGraphNode, RenderGraphEdge>> | undefined>(undefined)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const overviewDistance = useRef(0)
  // Starts engaged: a freshly built TrackballControls emits `change` on its first
  // frame and again whenever maxDistance clamps the default camera. Those are not
  // user input, and letting them through would report auto-overview and overwrite
  // the remembered viewpoint with the default camera before it can be restored.
  const programmaticMove = useRef(true)
  const viewportRefreshTimer = useRef<number | null>(null)
  const [detailLevel, setDetailLevel] = useState(0)
  const detailLevelRef = useRef(0)
  const selectedIdRef = useRef(selectedId)
  const sizeRef = useRef(size)
  const panRef = useRef<GraphViewPan>(viewStateRef.current && restoreView ? { ...viewStateRef.current.pan } : { x: 0, y: 0 })
  // The saved viewpoint is consumed once, on the mount that follows a cleared
  // selection. Later graph reloads keep whatever the user is looking at.
  const restorePending = useRef(restoreView)
  const [visibleLabelIds, setVisibleLabelIds] = useState<string[]>([])
  const [selectedOverlay, setSelectedOverlay] = useState<{ x: number; y: number; label: string; meta: string } | null>(null)
  const [pulseOverlays, setPulseOverlays] = useState<Array<{ id: string; x: number; y: number }>>([])
  const data = useMemo(() => buildSphericalGraph(nodes, edges, totalFilteredMemories, layoutNodes), [nodes, layoutNodes, edges, totalFilteredMemories])
  const dataRef = useRef(data)
  dataRef.current = data
  detailLevelRef.current = detailLevel
  selectedIdRef.current = selectedId
  sizeRef.current = size
  const pulses = useMemo(() => new Set(pulseIds), [pulseIds])
  const pulsesRef = useRef(pulses)
  pulsesRef.current = pulses
  const geometries = useMemo(() => ({
    memory: new THREE.SphereGeometry(1.65, 12, 12),
    entity: new THREE.SphereGeometry(0.82, 10, 10),
    memoryHalo: new THREE.SphereGeometry(4.8, 12, 12),
    entityHalo: new THREE.SphereGeometry(2.8, 10, 10),
    memoryHit: new THREE.SphereGeometry(6.2, 10, 10),
    entityHit: new THREE.SphereGeometry(4.2, 8, 8),
  }), [])
  const materialCache = useRef(new Map<string, THREE.MeshBasicMaterial>())
  const hitSpriteMaterial = useMemo(() => new THREE.SpriteMaterial({ sizeAttenuation: false, depthTest: false }), [])
  const labelIds = useMemo(() => new Set(visibleLabelIds), [visibleLabelIds])
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const captureViewState = useCallback(() => {
    const graph = graphRef.current
    if (!graph) return
    const camera = graph.camera()
    const controls = graph.controls() as GraphControls
    const target = controls?.target ?? new THREE.Vector3(0, 0, 0)
    viewStateRef.current = {
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      target: { x: target.x, y: target.y, z: target.z },
      up: { x: camera.up.x, y: camera.up.y, z: camera.up.z },
      pan: { ...panRef.current },
    }
  }, [viewStateRef])

  /** Pan through the camera view offset instead of the controls target: the
   * projection slides up/down/left/right while rotation keeps pivoting around
   * the sphere center. */
  const applyPan = useCallback(() => {
    const graph = graphRef.current
    if (!graph) return
    const camera = graph.camera() as THREE.PerspectiveCamera
    const { width, height } = sizeRef.current
    if (width <= 0 || height <= 0) return
    const pan = panRef.current
    if (pan.x === 0 && pan.y === 0) camera.clearViewOffset()
    else camera.setViewOffset(width, height, -pan.x, -pan.y, width, height)
  }, [])

  const scheduleViewportRefresh = useCallback((delay = 90) => {
    if (viewportRefreshTimer.current !== null) window.clearTimeout(viewportRefreshTimer.current)
    viewportRefreshTimer.current = window.setTimeout(() => {
      viewportRefreshTimer.current = null
      const graph = graphRef.current
      if (!graph) return
      const camera = graph.camera()
      camera.updateMatrixWorld()
      const viewport = sizeRef.current
      const projected = new THREE.Vector3()
      const candidates: ProjectedGraphLabel[] = []
      const nextPulseOverlays: Array<{ id: string; x: number; y: number }> = []
      for (const node of dataRef.current.nodes) {
        projected.set(node.x, node.y, node.z).project(camera)
        if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || !Number.isFinite(projected.z)) continue
        const screen = graph.graph2ScreenCoords(node.x, node.y, node.z)
        if (
          pulsesRef.current.has(node.id)
          && projected.z > -1
          && projected.z < 1
          && screen.x >= 0
          && screen.x <= viewport.width
          && screen.y >= 0
          && screen.y <= viewport.height
        ) nextPulseOverlays.push({ id: node.id, x: screen.x, y: screen.y })
        if (node.id === selectedIdRef.current) continue
        candidates.push({
          id: node.id,
          kind: node.kind,
          label: node.displayLabel,
          x: screen.x,
          y: screen.y,
          depth: projected.z,
        })
      }
      const nextLabels = selectViewportLabelIds(candidates, detailLevelRef.current, viewport.width, viewport.height)
      setVisibleLabelIds((current) => sameIds(current, nextLabels) ? current : nextLabels)
      setPulseOverlays(nextPulseOverlays)

      const selected = dataRef.current.nodes.find((node) => node.id === selectedIdRef.current)
      if (!selected) {
        setSelectedOverlay(null)
        return
      }
      projected.set(selected.x, selected.y, selected.z).project(camera)
      if (projected.z <= -1 || projected.z >= 1) {
        setSelectedOverlay(null)
        return
      }
      const screen = graph.graph2ScreenCoords(selected.x, selected.y, selected.z)
      setSelectedOverlay({
        x: Math.max(18, Math.min(viewport.width - 18, screen.x)),
        y: Math.max(56, Math.min(viewport.height - 18, screen.y)),
        label: selected.displayLabel,
        meta: `${selected.project}${selected.category ? ` · ${selected.category}` : ''}`,
      })
    }, delay)
  }, [])

  useEffect(() => () => {
    Object.values(geometries).forEach((geometry) => geometry.dispose())
    materialCache.current.forEach((material) => material.dispose())
    materialCache.current.clear()
    hitSpriteMaterial.dispose()
    if (viewportRefreshTimer.current !== null) window.clearTimeout(viewportRefreshTimer.current)
  }, [geometries, hitSpriteMaterial])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) })
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const handleContextLoss = (event: Event) => {
      event.preventDefault()
      onFallback('The 3D WebGL context was lost, so the same graph is now shown in 2D.')
    }
    host.addEventListener('webglcontextlost', handleContextLoss, true)
    return () => host.removeEventListener('webglcontextlost', handleContextLoss, true)
  }, [onFallback])

  // Right-drag pan. The pointer is not captured so TrackballControls keeps its
  // own pointer bookkeeping intact while it stays idle in its disabled PAN state.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let pointerId: number | null = null
    let origin = { x: 0, y: 0 }
    let start: GraphViewPan = { x: 0, y: 0 }
    const onPointerMove = (event: PointerEvent) => {
      if (pointerId === null || event.pointerId !== pointerId) return
      panRef.current = clampGraphPan(
        { x: start.x + event.clientX - origin.x, y: start.y + event.clientY - origin.y },
        sizeRef.current.width,
        sizeRef.current.height,
      )
      applyPan()
      scheduleViewportRefresh(0)
    }
    const onPointerUp = (event: PointerEvent) => {
      if (pointerId === null || event.pointerId !== pointerId) return
      pointerId = null
      host.classList.remove('panning')
      captureViewState()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 2 || pointerId !== null) return
      pointerId = event.pointerId
      origin = { x: event.clientX, y: event.clientY }
      start = { ...panRef.current }
      host.classList.add('panning')
      event.preventDefault()
    }
    const onContextMenu = (event: MouseEvent) => event.preventDefault()
    host.addEventListener('pointerdown', onPointerDown)
    host.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      host.removeEventListener('pointerdown', onPointerDown)
      host.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [applyPan, captureViewState, scheduleViewportRefresh])

  // Three.js keeps the stale full-size of a view offset across a resize, so the
  // current pan has to be re-projected whenever the canvas changes size.
  useEffect(() => {
    if (size.width <= 0 || size.height <= 0) return
    applyPan()
  }, [applyPan, size.height, size.width])

  // A deliberate viewport reset re-centers the projection as well as the camera.
  const mountedResetSignal = useRef(resetSignal)
  useEffect(() => {
    if (resetSignal === mountedResetSignal.current) return
    mountedResetSignal.current = resetSignal
    panRef.current = { x: 0, y: 0 }
    applyPan()
    captureViewState()
    scheduleViewportRefresh(0)
  }, [applyPan, captureViewState, resetSignal, scheduleViewportRefresh])

  useEffect(() => {
    const graph = graphRef.current
    if (!graph || size.width <= 0 || size.height <= 0) return
    let settleId: number | null = null
    const restored = restorePending.current ? viewStateRef.current : null
    const id = window.setTimeout(() => {
      const camera = graph.camera() as THREE.PerspectiveCamera
      const controls = graph.controls() as GraphControls
      programmaticMove.current = true
      const currentTarget = controls.target?.clone() ?? new THREE.Vector3(0, 0, 0)
      const fullRadius = sphericalGraphRadius(totalFilteredMemories) + currentTarget.length()
      const fullDistance = cameraDistanceForGraph(fullRadius, camera.fov, camera.aspect)
      overviewDistance.current = fullDistance
      controls.maxDistance = fullDistance
      controls.minDistance = Math.max(2, Math.min(24, fullDistance * 0.07))
      controls.update()

      if (restored) {
        // Returning from a focused 2D view: the pre-selection rotation, zoom and
        // pan are reinstated without an animation so the corpus reappears
        // exactly where the user left it.
        restorePending.current = false
        camera.up.set(restored.up.x, restored.up.y, restored.up.z)
        panRef.current = { ...restored.pan }
        // Assigned directly rather than through cameraPosition(), which is gated on
        // the renderer's `initialised` flag and swaps the controls target instance.
        camera.position.set(restored.position.x, restored.position.y, restored.position.z)
        controls.target.set(restored.target.x, restored.target.y, restored.target.z)
        applyPan()
        controls.update()
        settleId = window.setTimeout(() => {
          programmaticMove.current = false
          // Semantic zoom follows the reinstated distance, so a focused view that
          // was zoomed in comes back with its labels already resolved.
          const ratio = distance(camera.position, controls.target) / (overviewDistance.current || 1)
          const restoredDetail = ratio < 0.45 ? 2 : ratio < 0.72 ? 1 : 0
          detailLevelRef.current = restoredDetail
          setDetailLevel(restoredDetail)
          captureViewState()
          scheduleViewportRefresh(0)
        }, 60)
        return
      }

      if (!autoOverview) {
        programmaticMove.current = false
        return
      }
      const nextPosition = cameraPositionAtDistance(camera.position, currentTarget, currentTarget, fullDistance)
      const distanceShift = Math.abs(distance(camera.position, currentTarget) - fullDistance)
      const duration = reducedMotion ? 0 : 650
      if (distanceShift > 0.5) graph.cameraPosition(nextPosition, currentTarget, duration)
      settleId = window.setTimeout(() => {
        programmaticMove.current = false
        detailLevelRef.current = 0
        setDetailLevel(0)
        setVisibleLabelIds([])
        captureViewState()
        scheduleViewportRefresh(0)
      }, duration + 80)
    }, restored ? 0 : 80)
    return () => {
      window.clearTimeout(id)
      if (settleId) window.clearTimeout(settleId)
    }
  }, [applyPan, autoOverview, captureViewState, data, reducedMotion, resetSignal, scheduleViewportRefresh, size.height, size.width, totalFilteredMemories, viewStateRef])

  useEffect(() => {
    scheduleViewportRefresh(0)
  }, [data, detailLevel, scheduleViewportRefresh, selectedId, size.height, size.width])

  useEffect(() => {
    graphRef.current?.refresh()
    scheduleViewportRefresh(0)
  }, [pulseIds, pulseSignal, scheduleViewportRefresh])

  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    const controls = graph.controls() as GraphControls
    controls.noPan = true
    controls.enablePan = false
    const updateCameraState = () => {
      if (programmaticMove.current) return
      const currentDistance = distance(graph.camera().position, controls.target)
      const overview = overviewDistance.current || currentDistance
      const ratio = currentDistance / overview
      if (ratio < 0.98) onAutoOverviewChange(false)
      else if (ratio >= 0.98) onAutoOverviewChange(true)
      const nextDetail = ratio < 0.45 ? 2 : ratio < 0.72 ? 1 : 0
      setDetailLevel((current) => {
        const resolved = current === 2 && ratio < 0.51
          ? current
          : current === 1 && ratio > 0.67 && ratio < 0.78
            ? current
            : nextDetail
        detailLevelRef.current = resolved
        return resolved
      })
      captureViewState()
      scheduleViewportRefresh()
    }
    const end = () => updateCameraState()
    // OrbitControls can emit `change` without a matching wheel `end` on some
    // browsers/input devices. Distance comparison keeps rotation in overview
    // while making dolly/pinch state reliable.
    controls.addEventListener('change', updateCameraState)
    controls.addEventListener('end', end)
    return () => {
      controls.removeEventListener('change', updateCameraState)
      controls.removeEventListener('end', end)
    }
  }, [captureViewState, onAutoOverviewChange, scheduleViewportRefresh, size.height, size.width])

  return (
    <div ref={hostRef} className="memory-graph-canvas-renderer">
    {size.width > 0 && size.height > 0 ? <ForceGraph3D
      ref={graphRef}
      width={size.width}
      height={size.height}
      graphData={data}
      backgroundColor="#0a0d10"
      showNavInfo={false}
      enableNodeDrag={false}
      nodeLabel={(raw: RenderGraphNode) => graphNodeTooltip(raw as RenderGraphNode)}
      nodeThreeObject={(raw) => {
        const node = raw as RenderGraphNode
        const pulsing = pulses.has(node.id)
        const selected = selectedId === node.id
        const radius = node.kind === 'memory' ? 1.65 : 0.82
        const group = new THREE.Group()
        // Two invisible pointer targets, unioned by the raycaster: a world-space
        // sphere that always exceeds the painted dot when zoomed in, and a
        // screen-space sprite that keeps a constant pixel target when zoomed out.
        const hitMaterialKey = 'hit-target'
        let hitMaterial = materialCache.current.get(hitMaterialKey)
        if (!hitMaterial) {
          hitMaterial = new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.001, depthWrite: false })
          materialCache.current.set(hitMaterialKey, hitMaterial)
        }
        const hitTarget = new THREE.Mesh(node.kind === 'memory' ? geometries.memoryHit : geometries.entityHit, hitMaterial)
        hitTarget.visible = false
        group.add(hitTarget)
        const hitSprite = new THREE.Sprite(hitSpriteMaterial)
        hitSprite.visible = false
        hitSprite.scale.setScalar(screenSpaceSpriteScale(
          GRAPH_NODE_HIT_PIXELS[node.kind] * 2,
          (graphRef.current?.camera() as THREE.PerspectiveCamera | undefined)?.fov ?? DEFAULT_CAMERA_FOV,
          sizeRef.current.height,
        ))
        group.add(hitSprite)
        const color = pulsing ? '#ffffff' : projectColor(node.project, node.kind, node.relation === 'granted')
        const materialKey = `${color}:${node.relation}`
        let material = materialCache.current.get(materialKey)
        if (!material) {
          material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: node.relation === 'granted' ? 0.64 : node.kind === 'memory' ? 0.9 : 0.68 })
          materialCache.current.set(materialKey, material)
        }
        const sphere = new THREE.Mesh(geometries[node.kind], material)
        if (pulsing || selected) {
          const haloKey = pulsing ? 'halo:pulse' : 'halo:selected'
          let haloMaterial = materialCache.current.get(haloKey)
          if (!haloMaterial) {
            haloMaterial = new THREE.MeshBasicMaterial({ color: pulsing ? '#65e7ff' : '#16a7db', transparent: true, opacity: 0.18 })
            materialCache.current.set(haloKey, haloMaterial)
          }
          const halo = new THREE.Mesh(
            node.kind === 'memory' ? geometries.memoryHalo : geometries.entityHalo,
            haloMaterial,
          )
          halo.scale.setScalar(pulsing && !reducedMotion ? 0.62 : 0.72)
          group.add(halo)
        }
        group.add(sphere)
        const showLabel = labelIds.has(node.id)
        if (showLabel) {
          const label = new SpriteText(node.displayLabel)
          label.color = pulsing ? '#ffffff' : '#d8e5ea'
          label.textHeight = detailLevel >= 2 ? 1.4 : 1.75
          label.backgroundColor = 'rgba(10, 13, 16, .78)'
          label.padding = 2
          label.position.set(0, radius + 2.8, 0)
          label.material.depthTest = false
          label.material.depthWrite = false
          label.renderOrder = 10
          group.add(label)
        }
        return group
      }}
      linkSource="source"
      linkTarget="target"
      linkColor={(raw) => (pulses.has(endpointId(raw.source)) || pulses.has(endpointId(raw.target))) ? '#68eaff' : raw.historical ? '#343c42' : raw.kind === 'mentions' ? '#155a72' : '#31515d'}
      linkWidth={(raw) => (pulses.has(endpointId(raw.source)) || pulses.has(endpointId(raw.target))) ? 0.72 : raw.historical ? 0.035 : raw.kind === 'mentions' ? 0.11 : 0.065}
      linkOpacity={0.34}
      linkDirectionalParticles={(raw) => (pulses.has(endpointId(raw.source)) || pulses.has(endpointId(raw.target))) ? 3 : 0}
      linkDirectionalParticleColor={() => '#b9f7ff'}
      linkDirectionalParticleWidth={1.8}
      linkDirectionalParticleSpeed={0.012}
      onNodeClick={(raw) => onSelect(raw as RenderGraphNode)}
      onLinkClick={(raw) => {
        const id = endpointId(raw.source as string | RenderGraphNode)
        const node = data.nodes.find((candidate) => candidate.id === id)
        if (node) onSelect(node)
      }}
      warmupTicks={0}
      cooldownTicks={0}
    /> : null}
    {selectedOverlay ? (
      <div className="memory-graph-selected-label" style={{ left: selectedOverlay.x, top: selectedOverlay.y }}>
        <strong>{selectedOverlay.label}</strong>
        <span>{selectedOverlay.meta}</span>
      </div>
    ) : null}
    {pulseOverlays.map((overlay) => (
      <div
        key={`${pulseSignal}:${overlay.id}`}
        className="memory-graph-node-pulse"
        style={{ left: overlay.x, top: overlay.y }}
        aria-hidden
      >
        <span /><span /><span />
      </div>
    ))}
    </div>
  )
}
