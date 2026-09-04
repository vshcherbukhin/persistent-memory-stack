'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from 'react-force-graph-2d'
import type { MemoryGraphNode } from '@/lib/types'
import { buildSphericalGraph, endpointId, GRAPH_NODE_HIT_PIXELS, GRAPH_PULSE_DURATION_MS, graphNodeTooltip, graphViewportFit2D, pointerAreaRadius2D, projectColor, type RenderGraphEdge, type RenderGraphNode } from './memoryGraphLayout'

/** Painted dot radius in graph units, shared by the renderer and its pointer
 * area so a node is never smaller to click than it looks. */
const NODE_RADIUS: Record<RenderGraphNode['kind'], number> = { memory: 4.2, entity: 2.6 }
/** Target-wave travel, in screen pixels, for a pulsing node. */
const PULSE_WAVE_PIXELS = 14

export default function MemoryGraph2DCanvas({
  nodes,
  layoutNodes,
  edges,
  selectedId,
  pulseIds,
  pulseSignal,
  totalFilteredMemories,
  autoOverview,
  resetSignal,
  onSelect,
  onAutoOverviewChange,
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
  onSelect: (node: MemoryGraphNode) => void
  onAutoOverviewChange: (active: boolean) => void
}) {
  const graphRef = useRef<ForceGraphMethods<NodeObject<RenderGraphNode>, LinkObject<RenderGraphNode, RenderGraphEdge>> | undefined>(undefined)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const overviewScale = useRef(1)
  const programmaticMove = useRef(false)
  const pulseStartedAt = useRef(0)
  const [detailLevel, setDetailLevel] = useState(0)
  const [minZoom, setMinZoom] = useState(0.01)
  const data = useMemo(() => buildSphericalGraph(nodes, edges, totalFilteredMemories, layoutNodes), [nodes, layoutNodes, edges, totalFilteredMemories])
  const pulses = useMemo(() => new Set(pulseIds), [pulseIds])
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

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
    const graph = graphRef.current
    if (!graph || size.width <= 0 || size.height <= 0) return
    let settleId: number | null = null
    const duration = reducedMotion ? 0 : 500
    const id = window.setTimeout(() => {
      const fit = graphViewportFit2D(data.nodes, size.width, size.height)
      // The fitted scale is this view's overview, focused or not. Leaving the
      // focused baseline at 1 made the flat map report meaningless viewport
      // state back to the shell.
      overviewScale.current = fit.scale
      setMinZoom(fit.scale)
      if (!selectedId && !autoOverview) return
      programmaticMove.current = true
      graph.centerAt(fit.center.x, fit.center.y, duration)
      graph.zoom(fit.scale, duration)
      settleId = window.setTimeout(() => {
        programmaticMove.current = false
        setDetailLevel(selectedId ? (data.nodes.length <= 18 ? 2 : 1) : 0)
      }, duration + 80)
    }, 50)
    return () => {
      window.clearTimeout(id)
      if (settleId) window.clearTimeout(settleId)
      programmaticMove.current = false
    }
  }, [autoOverview, data, reducedMotion, resetSignal, selectedId, size.height, size.width])

  useEffect(() => {
    if (pulseIds.length === 0 || reducedMotion) return
    pulseStartedAt.current = performance.now()
  }, [pulseIds, pulseSignal, reducedMotion])

  return (
    <div ref={hostRef} className="memory-graph-canvas-renderer">
    {size.width > 0 && size.height > 0 ? <ForceGraph2D
      ref={graphRef}
      width={size.width}
      height={size.height}
      graphData={data}
      backgroundColor="#0a0d10"
      autoPauseRedraw={pulseIds.length === 0}
      enableNodeDrag={false}
      minZoom={minZoom}
      maxZoom={Math.max(48, minZoom * 40)}
      nodeLabel={(raw) => graphNodeTooltip(raw as RenderGraphNode)}
      nodePointerAreaPaint={(raw, color, context, scale) => {
        const node = raw as RenderGraphNode
        // The whole painted circle stays clickable at every zoom level, plus a
        // constant pixel margin that keeps distant dots easy to hit.
        const radius = pointerAreaRadius2D(NODE_RADIUS[node.kind], GRAPH_NODE_HIT_PIXELS[node.kind], scale)
        context.fillStyle = color
        context.beginPath()
        context.arc(node.x ?? 0, node.y ?? 0, radius, 0, Math.PI * 2)
        context.fill()
      }}
      nodeCanvasObjectMode={() => 'replace'}
      nodeCanvasObject={(raw, context, scale) => {
        const node = raw as RenderGraphNode
        const x = node.x ?? 0
        const y = node.y ?? 0
        const pulsing = pulses.has(node.id)
        const selected = selectedId === node.id
        const radius = NODE_RADIUS[node.kind]
        context.save()
        if (pulsing && !reducedMotion) {
          const elapsed = Math.max(0, performance.now() - pulseStartedAt.current)
          for (let ring = 0; ring < 3; ring += 1) {
            const phase = (elapsed / GRAPH_PULSE_DURATION_MS + ring / 3) % 1
            const waveRadius = radius + (2 + phase * PULSE_WAVE_PIXELS) / scale
            context.beginPath()
            context.arc(x, y, waveRadius, 0, Math.PI * 2)
            context.strokeStyle = `rgba(101, 231, 255, ${Math.max(0, (1 - phase) * 0.72)})`
            context.lineWidth = 1.2 / scale
            context.stroke()
          }
        }
        if (pulsing || selected) {
          context.shadowColor = pulsing ? '#65e7ff' : '#16a7db'
          context.shadowBlur = pulsing && !reducedMotion ? 15 : 10
        }
        context.beginPath()
        context.arc(x, y, radius, 0, Math.PI * 2)
        context.fillStyle = pulsing ? '#ffffff' : projectColor(node.project, node.kind, node.relation === 'granted')
        context.fill()
        if (selected) {
          context.strokeStyle = '#ffffff'
          context.lineWidth = 1 / scale
          context.stroke()
        }
        const showLabel = selected || pulsing || (detailLevel >= 1 && node.kind === 'memory') || detailLevel >= 2
        if (showLabel) {
          const fontSize = 11 / scale
          context.font = `${fontSize}px Source Sans Pro, sans-serif`
          context.textAlign = 'center'
          context.textBaseline = 'top'
          context.fillStyle = '#d8e5ea'
          context.fillText(node.displayLabel, x, y + radius + 2 / scale)
        }
        context.restore()
      }}
      linkColor={(raw) => (pulses.has(endpointId(raw.source)) || pulses.has(endpointId(raw.target))) ? 'rgba(104,234,255,.92)' : raw.historical ? 'rgba(131,131,131,.16)' : raw.kind === 'mentions' ? 'rgba(22,167,219,.26)' : 'rgba(129,192,213,.18)'}
      linkWidth={(raw) => (pulses.has(endpointId(raw.source)) || pulses.has(endpointId(raw.target))) ? 2.2 : raw.historical ? 0.3 : raw.kind === 'mentions' ? 0.72 : 0.48}
      linkDirectionalParticles={(raw) => (pulses.has(endpointId(raw.source)) || pulses.has(endpointId(raw.target))) ? 3 : 0}
      linkDirectionalParticleWidth={2}
      linkDirectionalParticleSpeed={0.012}
      onNodeClick={(raw) => onSelect(raw as RenderGraphNode)}
      onZoom={({ k }) => {
        if (programmaticMove.current) return
        const ratio = k / Math.max(0.001, overviewScale.current)
        if (ratio > 1.03) onAutoOverviewChange(false)
        else if (ratio <= 1.02) onAutoOverviewChange(true)
        setDetailLevel((current) => {
          if (current === 2 && ratio > 2.5) return current
          if (current === 1 && ratio > 1.45 && ratio < 1.8) return current
          return ratio > 3 ? 2 : ratio > 1.6 ? 1 : 0
        })
      }}
      warmupTicks={0}
      cooldownTicks={0}
    /> : null}
    </div>
  )
}
