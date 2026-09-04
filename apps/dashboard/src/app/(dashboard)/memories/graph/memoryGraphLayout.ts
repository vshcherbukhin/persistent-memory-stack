import type { MemoryGraphEdge, MemoryGraphNode } from '@/lib/types'

export interface RenderGraphNode extends MemoryGraphNode {
  x: number
  y: number
  z: number
  fx: number
  fy: number
  fz: number
}

export interface RenderGraphEdge extends Omit<MemoryGraphEdge, 'source' | 'target'> {
  source: string | RenderGraphNode
  target: string | RenderGraphNode
}

export interface RenderGraphData {
  nodes: RenderGraphNode[]
  links: RenderGraphEdge[]
}

export interface ProjectedGraphLabel {
  id: string
  kind: MemoryGraphNode['kind']
  label: string
  x: number
  y: number
  depth: number
}

export interface GraphCameraFit {
  center: { x: number; y: number; z: number }
  radius: number
}

export interface GraphViewportFit2D {
  center: { x: number; y: number }
  scale: number
}

export const GRAPH_PULSE_DURATION_MS = 3_200
export const LIVE_ACTIVITY_TTL_MS = 4_200

/** Smallest on-screen pointer target, in CSS pixels, for a graph node. The
 * painted dot is only a few pixels wide at overview distance, so hit areas are
 * widened in screen space instead of world space. */
export const GRAPH_NODE_HIT_PIXELS: Record<MemoryGraphNode['kind'], number> = { memory: 10, entity: 7 }

export interface GraphViewPan {
  x: number
  y: number
}

export interface GraphCameraState {
  position: { x: number; y: number; z: number }
  target: { x: number; y: number; z: number }
  up: { x: number; y: number; z: number }
  pan: GraphViewPan
}

/** World scale for a `sizeAttenuation: false` sprite so it always covers
 * `pixels` of screen height. Three.js multiplies such sprites by the negated
 * view-space depth, so the scale only depends on the vertical field of view and
 * the viewport height, never on the camera distance. */
export function screenSpaceSpriteScale(pixels: number, fovDegrees: number, viewportHeight: number): number {
  if (viewportHeight <= 0 || pixels <= 0) return 0
  const halfFov = Math.max(0.02, Math.min(Math.PI / 2 - 0.02, fovDegrees * Math.PI / 360))
  return 2 * pixels * Math.tan(halfFov) / viewportHeight
}

/** Pointer radius in 2D graph units. The painted dot grows with zoom while a
 * fixed pixel target shrinks, so a node stays clickable across its whole
 * visible circle at every zoom level. */
export function pointerAreaRadius2D(paintedRadius: number, minimumPixels: number, zoom: number): number {
  const scale = Math.max(0.001, zoom)
  return Math.max(paintedRadius + 3 / scale, minimumPixels / scale)
}

/** Right-drag moves the rendered graph through a camera view offset instead of
 * the orbit target, so the rotation pivot stays locked on the sphere center.
 * The travel is bounded so the corpus can never be dragged out of sight. */
export function clampGraphPan(pan: GraphViewPan, width: number, height: number): GraphViewPan {
  const limitX = Math.max(0, width * 0.55)
  const limitY = Math.max(0, height * 0.55)
  return {
    x: Math.min(limitX, Math.max(-limitX, pan.x)),
    y: Math.min(limitY, Math.max(-limitY, pan.y)),
  }
}

function stableNumber(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function projectColor(project: string, kind: MemoryGraphNode['kind'], granted = false): string {
  if (granted) return kind === 'memory' ? '#a985f5' : '#7055a6'
  const hue = 188 + (stableNumber(project) % 46)
  // Three.js currently parses the comma-separated CSS hsl() form reliably;
  // the newer space-separated form can silently fall back to white in WebGL.
  return kind === 'memory' ? `hsl(${hue}, 82%, 58%)` : `hsl(${hue}, 54%, 39%)`
}

function escapeTooltipText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!)
}

/** Force Graph renders nodeLabel as tooltip HTML, so every metadata field must
 * be escaped before it crosses that boundary. */
export function graphNodeTooltip(node: MemoryGraphNode): string {
  const category = node.category ? ` · ${escapeTooltipText(node.category)}` : ''
  return `${escapeTooltipText(node.displayLabel)}<br/>${escapeTooltipText(node.project)}${category}`
}

export function sphericalGraphRadius(totalFilteredMemories: number): number {
  return Math.max(46, Math.cbrt(Math.max(1, totalFilteredMemories)) * 28)
}

/** Bounding sphere for a rendered subset. The deterministic graph coordinates
 * make this safe to calculate before Three.js has built its scene objects. */
export function graphCameraFit(nodes: Array<Pick<RenderGraphNode, 'x' | 'y' | 'z'>>): GraphCameraFit {
  if (nodes.length === 0) return { center: { x: 0, y: 0, z: 0 }, radius: 6 }
  const bounds = nodes.reduce((current, node) => ({
    minX: Math.min(current.minX, node.x),
    maxX: Math.max(current.maxX, node.x),
    minY: Math.min(current.minY, node.y),
    maxY: Math.max(current.maxY, node.y),
    minZ: Math.min(current.minZ, node.z),
    maxZ: Math.max(current.maxZ, node.z),
  }), {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
  })
  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
  }
  const radius = nodes.reduce((maximum, node) => Math.max(
    maximum,
    Math.hypot(node.x - center.x, node.y - center.y, node.z - center.z),
  ), 0)
  return { center, radius: Math.max(6, radius + 5) }
}

/** Fit a sphere into the limiting camera axis. This value is also the 3D
 * OrbitControls maxDistance: once the complete visible graph fits, dolly-out
 * has no useful additional range. */
export function cameraDistanceForGraph(
  radius: number,
  verticalFovDegrees: number,
  aspect: number,
  padding = 1.12,
): number {
  const verticalHalfAngle = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, verticalFovDegrees * Math.PI / 360))
  const horizontalHalfAngle = Math.atan(Math.tan(verticalHalfAngle) * Math.max(0.1, aspect))
  const limitingHalfAngle = Math.min(verticalHalfAngle, horizontalHalfAngle)
  return Math.max(12, radius * padding / Math.sin(limitingHalfAngle))
}

/** Move along the current camera-to-target ray so changing the fitted distance
 * never resets the user's azimuth or polar angle. */
export function cameraPositionAtDistance(
  position: { x: number; y: number; z: number },
  currentTarget: { x: number; y: number; z: number },
  nextTarget: { x: number; y: number; z: number },
  nextDistance: number,
): { x: number; y: number; z: number } {
  const offset = {
    x: position.x - currentTarget.x,
    y: position.y - currentTarget.y,
    z: position.z - currentTarget.z,
  }
  const magnitude = Math.hypot(offset.x, offset.y, offset.z)
  const direction = magnitude > 0.0001
    ? { x: offset.x / magnitude, y: offset.y / magnitude, z: offset.z / magnitude }
    : { x: 0, y: 0, z: 1 }
  return {
    x: nextTarget.x + direction.x * nextDistance,
    y: nextTarget.y + direction.y * nextDistance,
    z: nextTarget.z + direction.z * nextDistance,
  }
}

/** Exact 2D center/scale counterpart used by the flat fallback and its
 * minZoom limit. */
export function graphViewportFit2D(
  nodes: Array<Pick<RenderGraphNode, 'x' | 'y'>>,
  width: number,
  height: number,
  padding = 60,
): GraphViewportFit2D {
  if (nodes.length === 0 || width <= padding * 2 || height <= padding * 2) {
    return { center: { x: 0, y: 0 }, scale: 1 }
  }
  const xs = nodes.map((node) => node.x)
  const ys = nodes.map((node) => node.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const spanX = Math.max(12, maxX - minX + 10)
  const spanY = Math.max(12, maxY - minY + 10)
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    scale: Math.max(0.01, Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY)),
  }
}

/** A deterministic, nested sphere: memories form the luminous shell and entity
 * subnodes occupy the inner volume. Radius grows with the visible corpus. */
export function buildSphericalGraph(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  totalFilteredMemories = nodes.filter((node) => node.kind === 'memory').length,
  layoutNodes: MemoryGraphNode[] = nodes,
): RenderGraphData {
  const ordered = [...layoutNodes].sort((a, b) => a.id.localeCompare(b.id))
  const radius = sphericalGraphRadius(totalFilteredMemories)
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  const kindTotals = ordered.reduce<Record<MemoryGraphNode['kind'], number>>((totals, node) => {
    totals[node.kind] += 1
    return totals
  }, { memory: 0, entity: 0 })
  const kindIndices: Record<MemoryGraphNode['kind'], number> = { memory: 0, entity: 0 }
  const layout = new Map(ordered.map((node, index) => {
    // Distribute each semantic layer over the complete sphere. A single global
    // lexical index clusters `entity:*` above `memory:*`, producing a visually
    // lopsided half-bright bubble even though every coordinate is in bounds.
    const kindIndex = kindIndices[node.kind]++
    const kindTotal = kindTotals[node.kind]
    const yUnit = kindTotal === 1 ? 0 : 1 - (kindIndex / (kindTotal - 1)) * 2
    const ring = Math.sqrt(Math.max(0, 1 - yUnit * yUnit))
    const theta = goldenAngle * (index + (stableNumber(node.id) % 17) / 17)
    const shell = node.kind === 'memory' ? 1 : 0.38 + ((stableNumber(node.id) % 51) / 100)
    const nodeRadius = radius * shell
    const x = Math.cos(theta) * ring * nodeRadius
    const y = yUnit * nodeRadius
    const z = Math.sin(theta) * ring * nodeRadius
    return [node.id, { x, y, z, fx: x, fy: y, fz: z }] as const
  }))
  const rendered = [...nodes].sort((a, b) => a.id.localeCompare(b.id)).map((node) => {
    const position = layout.get(node.id)
    if (!position) throw new Error(`Missing spherical layout position for ${node.id}`)
    return { ...node, ...position }
  })
  return {
    nodes: rendered,
    links: edges.map((edge) => ({ ...edge })),
  }
}

export function endpointId(value: string | RenderGraphNode): string {
  return typeof value === 'string' ? value : value.id
}

/** Keep semantic-zoom labels tied to what the camera can actually see. Nearer
 * nodes win and simple screen-space collision rejection prevents a label wall. */
export function selectViewportLabelIds(
  candidates: ProjectedGraphLabel[],
  detailLevel: number,
  width: number,
  height: number,
): string[] {
  if (detailLevel <= 0 || width <= 0 || height <= 0) return []
  const budget = detailLevel >= 2 ? 72 : 28
  const margin = 24
  const occupied: Array<{ left: number; right: number; top: number; bottom: number }> = []
  const selected: string[] = []
  const ordered = candidates
    .filter((candidate) => (
      candidate.depth > -1
      && candidate.depth < 1
      && candidate.x >= margin
      && candidate.x <= width - margin
      && candidate.y >= margin
      && candidate.y <= height - margin
      && (detailLevel >= 2 || candidate.kind === 'memory')
    ))
    .sort((left, right) => left.depth - right.depth || Number(right.kind === 'memory') - Number(left.kind === 'memory') || left.id.localeCompare(right.id))

  for (const candidate of ordered) {
    const labelWidth = Math.min(188, Math.max(54, candidate.label.length * 6.2))
    const box = {
      left: candidate.x - labelWidth / 2 - 5,
      right: candidate.x + labelWidth / 2 + 5,
      top: candidate.y - 30,
      bottom: candidate.y - 6,
    }
    const collides = occupied.some((other) => !(
      box.right < other.left
      || box.left > other.right
      || box.bottom < other.top
      || box.top > other.bottom
    ))
    if (collides) continue
    selected.push(candidate.id)
    occupied.push(box)
    if (selected.length >= budget) break
  }
  return selected
}

/** Return the selected node and its direct neighborhood without mutating the
 * canonical graph DTO. This keeps camera coordinates stable when focus clears. */
export function buildFocusedGraph(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphEdge[],
  selectedId: string | null,
): { nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] } {
  if (!selectedId || !nodes.some((node) => node.id === selectedId)) return { nodes, edges }
  const relatedIds = new Set([selectedId])
  const focusedEdges = edges.filter((edge) => {
    const connected = edge.source === selectedId || edge.target === selectedId
    if (connected) {
      relatedIds.add(edge.source)
      relatedIds.add(edge.target)
    }
    return connected
  })
  return {
    nodes: nodes.filter((node) => relatedIds.has(node.id)),
    edges: focusedEdges,
  }
}
