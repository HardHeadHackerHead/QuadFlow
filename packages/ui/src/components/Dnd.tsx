import { useMemo, useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { cx } from '../utils'
import { Icon } from '../icons/Icon'

function useDndSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
}

function SortableRow({ id, children, handle, className }: { id: string; children: ReactNode; handle: boolean; className?: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx('flex items-center gap-1.5', isDragging && 'opacity-40', className)}
      {...(handle ? {} : { ...attributes, ...listeners })}
    >
      {handle && (
        <button type="button" aria-label="Drag to reorder" className="cursor-grab touch-none text-qf-text-muted hover:text-qf-text" {...attributes} {...listeners}>
          <Icon name="grip" className="h-4 w-4" />
        </button>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export interface SortableListProps<T> {
  items: T[]
  getId: (item: T) => string
  renderItem: (item: T, index: number) => ReactNode
  onReorder: (items: T[], from: number, to: number) => void
  /** Show a drag handle instead of making the whole row draggable. Default true. */
  handle?: boolean
  className?: string
  itemClassName?: string
}

/** Vertical drag-to-reorder list (dnd-kit). */
export function SortableList<T>({ items, getId, renderItem, onReorder, handle = true, className, itemClassName }: SortableListProps<T>) {
  const sensors = useDndSensors()
  const ids = useMemo(() => items.map(getId), [items, getId])
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const from = ids.indexOf(String(e.active.id))
    const to = ids.indexOf(String(e.over.id))
    if (from < 0 || to < 0) return
    onReorder(arrayMove(items, from, to), from, to)
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className={cx('flex flex-col gap-1', className)}>
          {items.map((item, i) => (
            <SortableRow key={ids[i]} id={ids[i]} handle={handle} className={itemClassName}>
              {renderItem(item, i)}
            </SortableRow>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

export interface KanbanColumn {
  id: string
  title: ReactNode
  /** Accent color for the column header dot (hex or CSS color). */
  color?: string
  footer?: ReactNode
}

export interface KanbanBoardProps<T> {
  columns: KanbanColumn[]
  items: T[]
  getId: (item: T) => string
  getColumn: (item: T) => string
  renderCard: (item: T) => ReactNode
  /** Called when a card is dropped in another column (or reordered within one). */
  onMove: (itemId: string, toColumn: string, toIndex: number) => void
  className?: string
  columnClassName?: string
  emptyText?: ReactNode
}

function KanbanCard({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx('touch-none', isDragging && 'opacity-30')}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  )
}

function KanbanColumnView({ column, ids, children, className, emptyText }: { column: KanbanColumn; ids: string[]; children: ReactNode; className?: string; emptyText?: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${column.id}` })
  return (
    <div data-kanban-column={column.id} className={cx('flex w-72 shrink-0 flex-col rounded-lg border border-qf-border bg-qf-surface', isOver && 'border-qf-primary/50', className)}>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: column.color ?? 'rgb(var(--qf-text-muted))' }} />
        <span className="flex-1 truncate text-xs font-semibold uppercase tracking-wide text-qf-text">{column.title}</span>
        <span className="text-xs text-qf-text-muted">{ids.length}</span>
      </div>
      <SortableContext id={column.id} items={ids} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="flex min-h-[4rem] flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {children}
          {ids.length === 0 && <div className="py-4 text-center text-xs text-qf-text-muted/70">{emptyText ?? 'Drop here'}</div>}
        </div>
      </SortableContext>
      {column.footer && <div className="border-t border-qf-border px-2 py-1.5">{column.footer}</div>}
    </div>
  )
}

/** Column board with drag-and-drop between columns (dnd-kit). */
export function KanbanBoard<T>({ columns, items, getId, getColumn, renderCard, onMove, className, columnClassName, emptyText }: KanbanBoardProps<T>) {
  const sensors = useDndSensors()
  const [activeId, setActiveId] = useState<string | null>(null)
  const byColumn = useMemo(() => {
    const m = new Map<string, T[]>()
    columns.forEach((c) => m.set(c.id, []))
    items.forEach((it) => m.get(getColumn(it))?.push(it))
    return m
  }, [columns, items, getColumn])
  const columnOf = (id: string) => {
    if (id.startsWith('column:')) return id.slice(7)
    const it = items.find((i) => getId(i) === id)
    return it ? getColumn(it) : null
  }
  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id))
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null)
    if (!e.over) return
    const itemId = String(e.active.id)
    const overId = String(e.over.id)
    const to = columnOf(overId)
    if (!to) return
    const list = (byColumn.get(to) ?? []).map(getId).filter((id) => id !== itemId)
    const idx = overId.startsWith('column:') ? list.length : Math.max(0, list.indexOf(overId))
    if (to === columnOf(itemId) && overId === itemId) return
    onMove(itemId, to, idx)
  }
  const active = activeId ? items.find((i) => getId(i) === activeId) : undefined
  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
      <div className={cx('flex h-full min-h-0 gap-3 overflow-x-auto p-1', className)}>
        {columns.map((c) => {
          const list = byColumn.get(c.id) ?? []
          const ids = list.map(getId)
          return (
            <KanbanColumnView key={c.id} column={c} ids={ids} className={columnClassName} emptyText={emptyText}>
              {list.map((it, i) => (
                <KanbanCard key={ids[i]} id={ids[i]}>
                  {renderCard(it)}
                </KanbanCard>
              ))}
            </KanbanColumnView>
          )
        })}
      </div>
      <DragOverlay>{active ? <div className="rotate-1 opacity-90">{renderCard(active)}</div> : null}</DragOverlay>
    </DndContext>
  )
}
