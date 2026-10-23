/**
 * DEV ONLY — @quadflow/ui visual test page (/ui-gallery). Renders every kit
 * component in a dark and a light `data-theme` subtree side by side, plus the
 * legacy `vibe-*` classes and the terminal palette, so token changes can be
 * checked by eye. Not part of production builds.
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  applyTheme,
  configureUi,
  getThemeSnapshot,
  useTheme,
  COLOR_TOKENS,
  TERMINAL_TOKENS,
  ICONS,
  Avatar,
  Badge,
  Button,
  ButtonGroup,
  Card,
  Checkbox,
  CodeBlock,
  Combobox,
  ConfirmDialog,
  ContextMenu,
  Drawer,
  DropdownMenu,
  EmptyState,
  FormFromSchema,
  Icon,
  IconButton,
  Input,
  KanbanBoard,
  Kbd,
  LabelBadge,
  Markdown,
  MarkdownEditor,
  Modal,
  Panel,
  PanelHeader,
  Popover,
  ProgressBar,
  Radio,
  ScrollArea,
  SearchInput,
  Select,
  Skeleton,
  Slider,
  SortableList,
  Spinner,
  SplitPane,
  Switch,
  Table,
  Tabs,
  Tag,
  Textarea,
  Toaster,
  Toolbar,
  Tooltip,
  toast,
  type JsonSchema,
  type ThemeMode,
} from '@quadflow/ui'

// Track overlay registrations so the page can show that floating components register.
const openOverlays = new Set<string>()
const overlaySubs = new Set<() => void>()
configureUi({
  overlay: {
    register: (id) => {
      openOverlays.add(id)
      overlaySubs.forEach((s) => s())
    },
    unregister: (id) => {
      openOverlays.delete(id)
      overlaySubs.forEach((s) => s())
    },
  },
})

function useOverlayCount() {
  const [n, setN] = useState(openOverlays.size)
  useEffect(() => {
    const s = () => setN(openOverlays.size)
    overlaySubs.add(s)
    return () => {
      overlaySubs.delete(s)
    }
  }, [])
  return n
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-qf-border pb-5">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-qf-text-muted">{title}</h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>
}

const SCHEMA: JsonSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', title: 'Display name', minLength: 2, 'x-placeholder': 'My plugin' },
    apiUrl: { type: 'string', title: 'API URL', format: 'uri', default: 'https://example.com' },
    token: { type: 'string', title: 'Token', 'x-widget': 'password', description: 'Stored in the OS keychain.' },
    mode: { type: 'string', oneOf: [{ const: 'fast', title: 'Fast' }, { const: 'thorough', title: 'Thorough' }], default: 'fast' },
    level: { type: 'string', enum: ['low', 'medium', 'high'], 'x-widget': 'radio', default: 'medium' },
    retries: { type: 'integer', minimum: 0, maximum: 10, default: 3 },
    opacity: { type: 'number', minimum: 0, maximum: 1, multipleOf: 0.05, 'x-widget': 'slider', default: 0.8 },
    enabled: { type: 'boolean', title: 'Enable sync', description: 'Poll every 30 s.', default: true },
    color: { type: 'string', format: 'color', default: '#7c3aed' },
    tags: { type: 'array', items: { type: 'string' }, default: ['alpha'] },
    events: { type: 'array', items: { type: 'string', enum: ['push', 'pr', 'release'] }, default: ['push'] },
    notes: { type: 'string', 'x-widget': 'textarea' },
    advanced: {
      type: 'object',
      title: 'Advanced',
      properties: {
        timeoutMs: { type: 'integer', title: 'Timeout (ms)', minimum: 100, default: 5000 },
        verbose: { type: 'boolean', default: false },
      },
    },
  },
}

const MD = `### Markdown
Some **bold**, _italic_, \`inline code\` and a [link](https://example.com).

- [x] GFM task
- [ ] Another

| Col | Value |
| --- | ----- |
| a   | 1     |

\`\`\`ts
const x: number = 42
\`\`\`
<script>alert('raw html is not rendered')</script>`

interface Card_ {
  id: string
  title: string
  col: string
}

function Showcase() {
  const [tab, setTab] = useState('one')
  const [pill, setPill] = useState('a')
  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  const [checked, setChecked] = useState(true)
  const [sw, setSw] = useState(false)
  const [radio, setRadio] = useState('x')
  const [slider, setSlider] = useState(40)
  const [sel, setSel] = useState<string | null>('b')
  const [combo, setCombo] = useState<string | null>(null)
  const [modal, setModal] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const [md, setMd] = useState('Edit **me**')
  const [list, setList] = useState(['First', 'Second', 'Third', 'Fourth'])
  const [cards, setCards] = useState<Card_[]>([
    { id: '1', title: 'Design tokens', col: 'todo' },
    { id: '2', title: 'Tailwind preset', col: 'doing' },
    { id: '3', title: 'Gallery page', col: 'doing' },
    { id: '4', title: 'Light theme', col: 'done' },
  ])
  const [form, setForm] = useState<Record<string, unknown>>({})
  const options = [
    { value: 'a', label: 'Alpha', description: 'First option' },
    { value: 'b', label: 'Bravo' },
    { value: 'c', label: 'Charlie', disabled: true },
    { value: 'd', label: 'Delta' },
  ]

  return (
    <div className="flex flex-col gap-5">
      <Section title="Buttons">
        <Row>
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="primary" loading>
            Saving
          </Button>
          <Button disabled>Disabled</Button>
        </Row>
        <Row>
          <Button size="xs">xs</Button>
          <Button size="sm" leftIcon={<Icon name="plus" className="h-3.5 w-3.5" />}>
            New
          </Button>
          <Button size="lg">Large</Button>
          <IconButton label="Settings">
            <Icon name="settings" />
          </IconButton>
          <IconButton label="Active" active>
            <Icon name="eye" />
          </IconButton>
          <ButtonGroup attached>
            <Button size="sm">Left</Button>
            <Button size="sm">Mid</Button>
            <Button size="sm">Right</Button>
          </ButtonGroup>
        </Row>
      </Section>

      <Section title="Inputs">
        <Input placeholder="Input" value={text} onChange={(e) => setText(e.target.value)} />
        <Input placeholder="Invalid" invalid size="sm" />
        <SearchInput value={search} onChange={setSearch} />
        <Textarea placeholder="Textarea" rows={2} />
        <Row>
          <Checkbox checked={checked} onChange={setChecked} label="Checkbox" description="With description" />
          <Checkbox checked={false} onChange={() => {}} indeterminate label="Indeterminate" />
          <Switch checked={sw} onChange={setSw} label="Switch" />
        </Row>
        <Radio
          direction="row"
          value={radio}
          onChange={setRadio}
          options={[
            { value: 'x', label: 'Radio X' },
            { value: 'y', label: 'Radio Y' },
            { value: 'z', label: 'Disabled', disabled: true },
          ]}
        />
        <Slider value={slider} onChange={setSlider} showValue aria-label="Slider" />
        <Select value={sel} onChange={setSel} options={options} aria-label="Select" />
        <Combobox value={combo} onChange={setCombo} options={options} onCreate={(t) => toast({ message: `Create “${t}”` })} />
      </Section>

      <Section title="Tabs">
        <Tabs value={tab} onChange={setTab} items={[{ value: 'one', label: 'Overview' }, { value: 'two', label: 'Steps', badge: <Badge tone="primary">3</Badge> }, { value: 'three', label: 'Disabled', disabled: true }]} />
        <Tabs variant="pills" size="sm" value={pill} onChange={setPill} items={[{ value: 'a', label: 'List' }, { value: 'b', label: 'Board' }]} />
      </Section>

      <Section title="Badges, tags, avatars, kbd">
        <Row>
          {(['neutral', 'primary', 'secondary', 'success', 'warning', 'error'] as const).map((t) => (
            <Badge key={t} tone={t}>
              {t}
            </Badge>
          ))}
          <Badge dot tone="success" />
          <Badge dot tone="error" />
        </Row>
        <Row>
          <LabelBadge name="bug" color="#ef4444" />
          <LabelBadge name="feature" color="#22c55e" onRemove={() => {}} />
          <Tag>Tag</Tag>
          <Tag selected onClick={() => {}}>
            Selected
          </Tag>
          <Tag onRemove={() => {}}>Removable</Tag>
        </Row>
        <Row>
          <Avatar name="Ada Lovelace" size="xs" />
          <Avatar name="Grace Hopper" />
          <Avatar name="Linus" size="md" />
          <Avatar name="Agent Smith" size="lg" />
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </Row>
      </Section>

      <Section title="Feedback">
        <Row>
          <Spinner size="xs" />
          <Spinner />
          <Spinner size="md" />
          <Spinner size="lg" />
        </Row>
        <ProgressBar value={65} />
        <ProgressBar value={30} tone="warning" />
        <ProgressBar />
        <Row>
          <Skeleton circle className="h-8 w-8" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </Row>
        <Card padding="none">
          <EmptyState icon={<Icon name="issues" />} title="No issues" description="Create one to start tracking work." action={<Button size="sm" variant="primary">New issue</Button>} />
        </Card>
        <Row>
          {(['info', 'success', 'warning', 'error'] as const).map((k) => (
            <Button key={k} size="sm" onClick={() => toast({ kind: k, title: k, message: `A ${k} toast` })}>
              Toast {k}
            </Button>
          ))}
        </Row>
      </Section>

      <Section title="Cards, panels, toolbar, scroll">
        <Row>
          <Card className="w-40">Card</Card>
          <Card className="w-40" interactive>
            Interactive
          </Card>
          <Card className="w-40" selected>
            Selected
          </Card>
        </Row>
        <div className="h-48 overflow-hidden rounded-lg border border-qf-border">
          <Panel>
            <PanelHeader title="Panel header" subtitle="Subtitle" icon={<Icon name="plans" />} actions={<IconButton label="More"><Icon name="more" /></IconButton>} />
            <Toolbar>
              <IconButton label="Add">
                <Icon name="plus" />
              </IconButton>
              <IconButton label="Refresh">
                <Icon name="refresh" />
              </IconButton>
            </Toolbar>
            <ScrollArea className="flex-1 p-2 text-xs">
              {Array.from({ length: 20 }, (_, i) => (
                <div key={i} className="py-0.5 text-qf-text-muted">
                  Scrollable row {i + 1}
                </div>
              ))}
            </ScrollArea>
          </Panel>
        </div>
        <div className="h-32 overflow-hidden rounded-lg border border-qf-border">
          <SplitPane first={<div className="p-2 text-xs">List (drag the divider)</div>} second={<div className="p-2 text-xs text-qf-text-muted">Detail</div>} />
        </div>
      </Section>

      <Section title="Table">
        <Table
          dense
          rowKey={(r) => r.id}
          selectedKey="2"
          onRowClick={(r) => toast(`Row ${r.id}`)}
          columns={[
            { key: 'id', header: '#', width: '3rem' },
            { key: 'name', header: 'Name' },
            { key: 'status', header: 'Status', render: (r) => <Badge tone={r.status === 'done' ? 'success' : 'warning'}>{r.status}</Badge> },
          ]}
          rows={[
            { id: '1', name: 'Tokens', status: 'done' },
            { id: '2', name: 'Preset', status: 'done' },
            { id: '3', name: 'Migration', status: 'todo' },
          ]}
        />
      </Section>

      <Section title="Floating (register overlays)">
        <Row>
          <Tooltip content="Tooltips do not register as overlays">
            <Button size="sm">Hover me</Button>
          </Tooltip>
          <Popover trigger={<Button size="sm">Popover</Button>}>
            {(close) => (
              <div className="flex w-56 flex-col gap-2 text-sm">
                Popover content
                <Button size="sm" onClick={close}>
                  Close
                </Button>
              </div>
            )}
          </Popover>
          <DropdownMenu
            trigger={<Button size="sm" rightIcon={<Icon name="chevron-down" className="h-3.5 w-3.5" />}>Menu</Button>}
            items={[
              { type: 'label', label: 'Actions' },
              { id: 'edit', label: 'Edit', icon: <Icon name="edit" className="h-3.5 w-3.5" />, shortcut: 'E', onSelect: () => toast('Edit') },
              { id: 'copy', label: 'Duplicate', icon: <Icon name="copy" className="h-3.5 w-3.5" />, onSelect: () => toast('Duplicate') },
              { id: 'pin', label: 'Pinned', checked: true },
              { id: 'dis', label: 'Disabled', disabled: true },
              { type: 'separator' },
              { id: 'del', label: 'Delete', danger: true, icon: <Icon name="trash" className="h-3.5 w-3.5" />, onSelect: () => toast({ kind: 'error', message: 'Deleted' }) },
            ]}
          />
          <Button size="sm" onClick={() => setModal(true)}>
            Modal
          </Button>
          <Button size="sm" onClick={() => setConfirm(true)}>
            Confirm
          </Button>
          <Button size="sm" onClick={() => setDrawer(true)}>
            Drawer
          </Button>
        </Row>
        <ContextMenu
          items={[
            { id: 'a', label: 'Context action', onSelect: () => toast('Context action') },
            { id: 'b', label: 'Another' },
          ]}
        >
          <div className="rounded-md border border-dashed border-qf-border-strong p-4 text-center text-xs text-qf-text-muted">Right-click here</div>
        </ContextMenu>
        <Modal
          open={modal}
          onClose={() => setModal(false)}
          title="Modal title"
          description="Registers with the overlay system while open."
          footer={
            <>
              <Button variant="ghost" onClick={() => setModal(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setModal(false)}>
                Save
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Input placeholder="Focus is trapped inside" />
            <Select value={sel} onChange={setSel} options={options} />
            <DropdownMenu trigger={<Button size="sm">Nested menu (Esc closes only this)</Button>} items={[{ id: 'x', label: 'Item' }]} />
          </div>
        </Modal>
        <ConfirmDialog open={confirm} title="Delete item?" message="This cannot be undone." danger confirmLabel="Delete" onCancel={() => setConfirm(false)} onConfirm={() => new Promise<void>((r) => setTimeout(() => { setConfirm(false); r() }, 600))} />
        <Drawer open={drawer} onClose={() => setDrawer(false)} title="Drawer">
          <p className="text-sm text-qf-text-muted">Edge sheet content.</p>
        </Drawer>
      </Section>

      <Section title="Markdown / code">
        <Card>
          <Markdown>{MD}</Markdown>
        </Card>
        <CodeBlock language="bash" code={'npm run dev\nnpx tsc --noEmit'} />
        <MarkdownEditor value={md} onChange={setMd} rows={3} />
      </Section>

      <Section title="Drag and drop">
        <SortableList items={list} getId={(s) => s} onReorder={setList} renderItem={(s) => <Card padding="sm">{s}</Card>} />
        <div className="h-64">
          <KanbanBoard
            columns={[
              { id: 'todo', title: 'To do', color: '#94a3b8' },
              { id: 'doing', title: 'In progress', color: '#f59e0b' },
              { id: 'done', title: 'Done', color: '#22c55e' },
            ]}
            items={cards}
            getId={(c) => c.id}
            getColumn={(c) => c.col}
            renderCard={(c) => <Card padding="sm" className="text-sm">{c.title}</Card>}
            onMove={(id, to, index) =>
              setCards((prev) => {
                const item = prev.find((c) => c.id === id)!
                const rest = prev.filter((c) => c.id !== id)
                const inCol = rest.filter((c) => c.col === to)
                const anchor = inCol[index]
                const moved = { ...item, col: to }
                if (!anchor) return [...rest, moved]
                const at = rest.indexOf(anchor)
                return [...rest.slice(0, at), moved, ...rest.slice(at)]
              })
            }
          />
        </div>
      </Section>

      <Section title="FormFromSchema">
        <FormFromSchema schema={SCHEMA} value={form} onChange={setForm} />
        <CodeBlock language="json" code={JSON.stringify(form, null, 2)} maxHeight="10rem" />
      </Section>

      <Section title="Icons">
        <div className="grid grid-cols-8 gap-2">
          {Object.keys(ICONS).map((n) => (
            <Tooltip key={n} content={n}>
              <span className="flex h-8 w-8 items-center justify-center rounded border border-qf-border text-qf-text-muted">
                <Icon name={n} />
              </span>
            </Tooltip>
          ))}
        </div>
      </Section>

      <Section title="Legacy vibe-* classes (preset → tokens)">
        <div className="grid grid-cols-2 gap-1 text-xs">
          {['bg-vibe-bg', 'bg-vibe-bg-lighter', 'bg-vibe-surface', 'bg-vibe-border', 'bg-vibe-border-bright', 'bg-vibe-primary', 'bg-vibe-primary-hover', 'bg-vibe-secondary', 'bg-vibe-success', 'bg-vibe-warning', 'bg-vibe-error', 'bg-vibe-primary/20'].map((c) => (
            <div key={c} className="flex items-center gap-2">
              <span className={`h-5 w-8 rounded border border-vibe-border ${c}`} />
              <span className="font-mono text-vibe-muted">{c}</span>
            </div>
          ))}
        </div>
        <div className="rounded border border-vibe-border bg-vibe-surface p-2 text-sm text-vibe-text">
          text-vibe-text on bg-vibe-surface · <span className="text-vibe-muted">text-vibe-muted</span> · <span className="text-vibe-primary">text-vibe-primary</span>
        </div>
      </Section>
    </div>
  )
}

function TokenSwatches() {
  const t = useTheme()
  const [snap, setSnap] = useState(t)
  // Snapshot of *this* subtree (the column's own data-theme).
  const ref = (el: HTMLDivElement | null) => {
    if (el) {
      const s = getThemeSnapshot(el)
      if (JSON.stringify(s.colors) !== JSON.stringify(snap.colors)) setSnap(s)
    }
  }
  return (
    <div ref={ref} className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-1 text-[11px]">
        {COLOR_TOKENS.map((k) => (
          <div key={k} className="flex items-center gap-2">
            <span className="h-4 w-6 rounded border border-qf-border" style={{ background: `rgb(var(--qf-${k}))` }} />
            <span className="font-mono text-qf-text-muted">
              {k} {snap.colors[k]}
            </span>
          </div>
        ))}
      </div>
      <div className="rounded p-2 font-mono text-xs" style={{ background: 'rgb(var(--qf-term-bg))', color: 'rgb(var(--qf-term-fg))' }}>
        <div>$ terminal palette</div>
        <div className="flex flex-wrap gap-1 pt-1">
          {TERMINAL_TOKENS.filter((k) => !['bg', 'fg', 'cursor', 'cursor-accent', 'selection-fg'].includes(k)).map((k) => (
            <span key={k} title={k} style={{ color: `rgb(var(--qf-term-${k}))` }}>
              ■
            </span>
          ))}
          <span style={{ background: 'rgb(var(--qf-term-selection))', color: 'rgb(var(--qf-term-selection-fg))' }}>selection</span>
        </div>
      </div>
    </div>
  )
}

function Column({ theme }: { theme: 'dark' | 'light' }) {
  return (
    <div data-theme={theme} className="qf-themed min-w-0 flex-1 rounded-xl border border-qf-border p-5">
      <h1 className="mb-4 text-sm font-semibold text-qf-text">data-theme="{theme}"</h1>
      <div className="flex flex-col gap-5">
        <Section title="Tokens">
          <TokenSwatches />
        </Section>
        <Showcase />
      </div>
    </div>
  )
}

export default function UiGallery() {
  const [mode, setMode] = useState<ThemeMode>('dark')
  const [layout, setLayout] = useState<'both' | 'page'>('both')
  const overlays = useOverlayCount()
  const snap = useTheme()
  useEffect(() => {
    applyTheme({ mode })
  }, [mode])
  return (
    <div className="qf-themed h-full overflow-auto">
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-qf-border bg-qf-surface px-5 py-2">
        <span className="text-sm font-semibold">@quadflow/ui gallery</span>
        <Badge tone="warning">dev only</Badge>
        <span className="flex-1" />
        <span className="text-xs text-qf-text-muted">
          open overlays: <span className="font-mono text-qf-text">{overlays}</span>
        </span>
        <Tabs
          variant="pills"
          size="sm"
          value={layout}
          onChange={setLayout}
          items={[
            { value: 'both', label: 'Dark + light' },
            { value: 'page', label: 'Page theme' },
          ]}
        />
        <Tabs
          variant="pills"
          size="sm"
          value={mode}
          onChange={setMode}
          items={[
            { value: 'dark', label: 'Dark', icon: <Icon name="moon" className="h-3.5 w-3.5" /> },
            { value: 'light', label: 'Light', icon: <Icon name="sun" className="h-3.5 w-3.5" /> },
            { value: 'system', label: `System (${snap.mode})`, icon: <Icon name="monitor" className="h-3.5 w-3.5" /> },
          ]}
        />
      </div>
      <div className="flex gap-5 p-5">
        {layout === 'both' ? (
          <>
            <Column theme="dark" />
            <Column theme="light" />
          </>
        ) : (
          <div className="mx-auto w-full max-w-2xl">
            <Section title={`Page theme: ${snap.mode}`}>
              <TokenSwatches />
            </Section>
            <div className="pt-5">
              <Showcase />
            </div>
          </div>
        )}
      </div>
      <Toaster />
    </div>
  )
}
