import { describe, expect, it } from 'vitest'
import type { MemoryGraphEdge, MemoryGraphNode } from '@/lib/types'
import { buildFocusedGraph, buildSphericalGraph, cameraDistanceForGraph, cameraPositionAtDistance, clampGraphPan, endpointId, graphCameraFit, graphNodeTooltip, graphViewportFit2D, pointerAreaRadius2D, projectColor, screenSpaceSpriteScale, selectViewportLabelIds } from './memoryGraphLayout'

const nodes: MemoryGraphNode[] = [
  { id: 'memory:a', kind: 'memory', displayLabel: 'fix memory a', project: 'alpha', category: 'fix', relation: 'own', surface: 'personal', memoryId: 'a', entityUuid: null, graphStatus: 'ok' },
  { id: 'entity:b', kind: 'entity', displayLabel: 'Graphiti', project: 'alpha', category: null, relation: 'own', surface: 'personal', memoryId: null, entityUuid: 'b', graphStatus: null },
  { id: 'memory:c', kind: 'memory', displayLabel: 'gotcha memory c', project: 'beta', category: 'gotcha', relation: 'granted', surface: 'personal', memoryId: 'c', entityUuid: null, graphStatus: 'ok' },
]
const edges: MemoryGraphEdge[] = [
  { id: 'mention:a:b', source: 'memory:a', target: 'entity:b', kind: 'mentions', label: null, historical: false, project: 'alpha', relation: 'own', surface: 'personal' },
]

describe('spherical memory graph layout', () => {
  it('is deterministic and keeps entity subnodes inside the memory shell', () => {
    const first = buildSphericalGraph(nodes, edges)
    const second = buildSphericalGraph(nodes, edges)
    expect(first).toEqual(second)
    const memory = first.nodes.find((node) => node.id === 'memory:a')!
    const entity = first.nodes.find((node) => node.id === 'entity:b')!
    expect(Math.hypot(entity.x, entity.y, entity.z)).toBeLessThan(Math.hypot(memory.x, memory.y, memory.z))
  })

  it('balances memory and entity layers independently across both hemispheres', () => {
    const balancedNodes: MemoryGraphNode[] = [
      ...nodes,
      { id: 'entity:d', kind: 'entity', displayLabel: 'FalkorDB', project: 'alpha', category: null, relation: 'own', surface: 'personal', memoryId: null, entityUuid: 'd', graphStatus: null },
    ]
    const data = buildSphericalGraph(balancedNodes, edges)
    for (const kind of ['memory', 'entity'] as const) {
      const yValues = data.nodes.filter((node) => node.kind === kind).map((node) => node.y)
      expect(Math.min(...yValues)).toBeLessThan(0)
      expect(Math.max(...yValues)).toBeGreaterThan(0)
    }
  })

  it('clones link data so force-graph mutation cannot change the canonical DTO', () => {
    const data = buildSphericalGraph(nodes, edges)
    expect(data.links[0]).not.toBe(edges[0])
    data.links[0]!.source = data.nodes[0]!
    expect(edges[0]!.source).toBe('memory:a')
    expect(endpointId(data.links[0]!.source)).toBe(data.nodes[0]!.id)
  })

  it('keeps project colors stable and visually distinguishes mounted nodes', () => {
    expect(projectColor('alpha', 'memory')).toBe(projectColor('alpha', 'memory'))
    expect(projectColor('alpha', 'memory')).not.toBe(projectColor('alpha', 'memory', true))
  })

  it('grows the fitted corpus radius monotonically with total filtered memories', () => {
    const small = buildSphericalGraph(nodes, edges, 8).nodes.find((node) => node.id === 'memory:a')!
    const large = buildSphericalGraph(nodes, edges, 1000).nodes.find((node) => node.id === 'memory:a')!
    expect(Math.hypot(large.x, large.y, large.z)).toBeGreaterThan(Math.hypot(small.x, small.y, small.z))
  })

  it('escapes every metadata field before force-graph renders tooltip HTML', () => {
    expect(graphNodeTooltip({
      ...nodes[0]!,
      displayLabel: '<img src=x onerror="alert(1)">',
      project: 'R&D <admin>',
      category: "owner's \"fix\"",
    })).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;<br/>R&amp;D &lt;admin&gt; · owner&#39;s &quot;fix&quot;')
  })

  it('keeps overview labels hidden and chooses nearer visible nodes as detail increases', () => {
    const candidates = [
      { id: 'back', kind: 'memory' as const, label: 'Back node', x: 120, y: 120, depth: 0.8 },
      { id: 'front', kind: 'memory' as const, label: 'Front node', x: 280, y: 120, depth: -0.6 },
      { id: 'entity', kind: 'entity' as const, label: 'Visible entity', x: 440, y: 120, depth: -0.4 },
      { id: 'outside', kind: 'memory' as const, label: 'Outside viewport', x: 900, y: 120, depth: -0.9 },
    ]
    expect(selectViewportLabelIds(candidates, 0, 600, 400)).toEqual([])
    expect(selectViewportLabelIds(candidates, 1, 600, 400)).toEqual(['front', 'back'])
    expect(selectViewportLabelIds(candidates, 2, 600, 400)).toEqual(['front', 'entity', 'back'])
  })

  it('isolates the selected node and only its direct connections', () => {
    const focused = buildFocusedGraph(nodes, edges, 'memory:a')
    expect(focused.nodes.map((node) => node.id)).toEqual(['memory:a', 'entity:b'])
    expect(focused.edges.map((edge) => edge.id)).toEqual(['mention:a:b'])
    expect(buildFocusedGraph(nodes, edges, null)).toEqual({ nodes, edges })
  })

  it('preserves full-corpus coordinates when rendering a focused subgraph', () => {
    const full = buildSphericalGraph(nodes, edges, 100)
    const focused = buildSphericalGraph([nodes[0]!, nodes[1]!], edges, 100, nodes)
    expect(focused.nodes.find((node) => node.id === 'memory:a')).toMatchObject(
      full.nodes.find((node) => node.id === 'memory:a')!,
    )
  })

  it('changes camera distance without changing the current viewing angle', () => {
    const next = cameraPositionAtDistance(
      { x: 30, y: 40, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 8, y: -4, z: 2 },
      100,
    )
    expect(next).toEqual({ x: 68, y: 76, z: 2 })
    expect(Math.hypot(next.x - 8, next.y + 4, next.z - 2)).toBeCloseTo(100)
  })

  it('keeps a screen-space hit sprite the same pixel size at every camera distance', () => {
    // Mirrors the three.js sprite shader for sizeAttenuation:false, where the
    // world size is multiplied by the view depth before projection.
    const renderedPixels = (scale: number, fov: number, height: number, depth: number) =>
      (scale * depth) / (depth * Math.tan(fov * Math.PI / 360)) * height / 2
    const scale = screenSpaceSpriteScale(20, 50, 800)
    for (const depth of [50, 900, 5_000]) expect(renderedPixels(scale, 50, 800, depth)).toBeCloseTo(20)
    expect(screenSpaceSpriteScale(20, 50, 0)).toBe(0)
    expect(screenSpaceSpriteScale(20, 50, 1600)).toBeLessThan(scale)
  })

  it('never makes a 2D pointer target smaller than the painted dot', () => {
    for (const zoom of [0.05, 1, 8, 40]) {
      expect(pointerAreaRadius2D(4.2, 10, zoom)).toBeGreaterThan(4.2)
    }
    // Zoomed out the fixed pixel target wins; zoomed in the painted circle does.
    expect(pointerAreaRadius2D(4.2, 10, 0.1)).toBeCloseTo(100)
    expect(pointerAreaRadius2D(4.2, 10, 20)).toBeCloseTo(4.35)
  })

  it('bounds right-drag panning inside the viewport', () => {
    expect(clampGraphPan({ x: 40, y: -25 }, 1000, 600)).toEqual({ x: 40, y: -25 })
    expect(clampGraphPan({ x: 9_000, y: -9_000 }, 1000, 600)).toEqual({ x: 550, y: -330 })
    expect(clampGraphPan({ x: 12, y: 12 }, 0, 0)).toEqual({ x: 0, y: 0 })
  })

  it('fits focused 3D and 2D nodes with bounded overview distances', () => {
    const rendered = buildSphericalGraph(nodes, edges, 100)
    const fit3d = graphCameraFit(rendered.nodes.slice(0, 2))
    const distance = cameraDistanceForGraph(fit3d.radius, 50, 16 / 9)
    expect(fit3d.radius).toBeGreaterThan(5)
    expect(distance).toBeGreaterThan(fit3d.radius)

    const fit2d = graphViewportFit2D(rendered.nodes, 1200, 700)
    expect(fit2d.scale).toBeGreaterThan(0)
    expect(fit2d.center.x).toBeTypeOf('number')
  })
})
