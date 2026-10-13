/**
 * Fork lineage for the session lists. Pi writes the file a session was forked, cloned, or branched
 * from into that session's own header, so a listing already holds every relation it needs to show.
 * A child hangs under the row that owns the file its header names; a parent the list does not hold —
 * another project's session, a deleted one — leaves the row unmarked, which is how the list drew it
 * before lineage was read at all.
 */

/** The fields of a row the lineage reads. */
export interface SessionLineageItem {
  path: string
  modified: string
  parentSession?: string
}

/** A row marked as a fork: the parent it was forked from, when that session is one of the rows. */
export interface SessionFork {
  forkedFrom?: string
}

export type SessionForkRow<Row extends SessionLineageItem> = Row & SessionFork

/**
 * Marks every fork whose parent is one of `rows`, in the listing's own order. Like Pi's resume
 * picker, a subtree leads with the newest activity anywhere inside it — a fresh fork floats its
 * family to the top of a recency-sorted list instead of hiding under an older parent — and
 * `order: 'input'` keeps the caller's arrangement, for lists whose order belongs to the reader
 * rather than the clock.
 */
export function withSessionForks<Row extends SessionLineageItem>(
  rows: Row[],
  options: { order?: 'activity' | 'input' } = {}
): SessionForkRow<Row>[] {
  interface Node {
    row: Row
    children: Node[]
    parent: string | null
    latest: number
  }

  const nodes = new Map<string, Node>()
  for (const row of rows) {
    nodes.set(row.path, { row, children: [], parent: null, latest: modifiedAt(row.modified) })
  }
  const roots: Node[] = []
  for (const row of rows) {
    const node = nodes.get(row.path)!
    // A file naming itself as its own parent would loop the walk below; it is its own root.
    const parent = row.parentSession && row.parentSession !== row.path
      ? nodes.get(row.parentSession)
      : undefined
    if (parent) {
      node.parent = parent.row.path
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }
  const grow = (node: Node): number => {
    node.latest = node.children.reduce((latest, child) => Math.max(latest, grow(child)), node.latest)
    return node.latest
  }
  for (const root of roots) grow(root)
  if ((options.order ?? 'activity') === 'activity') {
    const sort = (branch: Node[]) => {
      branch.sort((a, b) => b.latest - a.latest)
      for (const node of branch) sort(node.children)
    }
    sort(roots)
  }

  const out: SessionForkRow<Row>[] = []
  const walk = (node: Node): void => {
    out.push(node.parent === null ? { ...node.row } : { ...node.row, forkedFrom: node.parent })
    for (const child of node.children) walk(child)
  }
  for (const root of roots) walk(root)
  // A header chain that loops (hand-edited data) has no root to hang from; whatever the walk did not
  // reach is still a session the list has to show.
  const emitted = new Set(out.map((row) => row.path))
  for (const node of nodes.values()) {
    if (emitted.has(node.row.path)) continue
    emitted.add(node.row.path)
    out.push({ ...node.row })
  }
  return out
}

function modifiedAt(iso: string): number {
  const time = Date.parse(iso)
  return Number.isFinite(time) ? time : 0
}
