/**
 * The memory-lattice artwork from the design system (prototype `lattice()`):
 * a small memory/entity/fact constellation used by empty states. Decorative only.
 */
const NODES: [number, number][] = [[24, 66], [52, 32], [74, 80], [100, 50], [128, 88], [150, 38], [172, 68], [96, 18]]
const EDGES: [number, number][] = [[0, 1], [1, 3], [3, 2], [2, 4], [3, 5], [5, 6], [4, 6], [1, 7], [7, 3], [0, 2]]
const NODE_FILL = ['var(--node-memory)', 'var(--node-entity)', 'var(--node-fact)']

export function MemoryLattice({
  width = 190,
  height = 108,
  opacity = 1,
  className,
}: {
  width?: number
  height?: number
  opacity?: number
  className?: string
}) {
  return (
    <svg
      className={`memory-lattice${className ? ` ${className}` : ''}`}
      width={width}
      height={height}
      viewBox="0 0 190 108"
      fill="none"
      style={{ opacity }}
      aria-hidden="true"
    >
      {EDGES.map(([a, b]) => (
        <line key={`${a}-${b}`} x1={NODES[a][0]} y1={NODES[a][1]} x2={NODES[b][0]} y2={NODES[b][1]} stroke="var(--graph-edge)" strokeWidth="1" />
      ))}
      {NODES.map(([x, y], index) => (
        <circle key={index} cx={x} cy={y} r={index % 3 === 0 ? 4.5 : 3} fill={NODE_FILL[index % 3]} opacity=".9">
          <animate attributeName="opacity" values="0.35;1;0.35" dur={`${3 + index * 0.4}s`} repeatCount="indefinite" />
        </circle>
      ))}
    </svg>
  )
}
