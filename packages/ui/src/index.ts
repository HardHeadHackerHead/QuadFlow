/**
 * @quadflow/ui — QuadFlow design tokens, theme runtime and React components
 * (docs/architecture/plugin-system.md §14). Shared by the shell and plugins.
 *
 * CSS: import '@quadflow/ui/tokens.css' once (the shell does this in index.css).
 * Tailwind: presets: [require('@quadflow/ui/tailwind-preset')].
 */

// Theme
export {
  applyTheme,
  getThemeSnapshot,
  onThemeChange,
  useTheme,
  resolveThemeMode,
  hexToTriplet,
  tripletToHex,
  COLOR_TOKENS,
  TERMINAL_TOKENS,
  SCALAR_TOKENS,
} from './theme'
export type { ThemeMode, ResolvedTheme, ThemeSnapshot, ApplyThemeOptions, ColorToken, TerminalToken } from './theme'

// Host bridge + overlays
export { configureUi, useOverlay, registerOverlay, unregisterOverlay, isAnyUiOverlayOpen } from './host'
export type { UiHostBridge, OverlayBridge, ToastOptions, ToastKind } from './host'

// Utilities
export { cx, computePosition } from './utils'
export type { Placement, Point } from './utils'

// Icons
export { Icon, ICONS, registerIcons } from './icons/Icon'
export type { IconName, IconProps, IconDef } from './icons/Icon'

// Components
export { Button, IconButton, ButtonGroup } from './components/Button'
export type { ButtonProps, IconButtonProps, ButtonGroupProps, ButtonVariant, ButtonSize } from './components/Button'

export { Field, Input, Textarea, SearchInput, Checkbox, Switch, Radio, Slider } from './components/Inputs'
export type { FieldProps, InputProps, TextareaProps, SearchInputProps, CheckboxProps, RadioProps, RadioOption, SliderProps } from './components/Inputs'

export { Select, Combobox } from './components/Select'
export type { SelectProps, SelectOption, ComboboxProps } from './components/Select'

export { Tabs, SplitPane } from './components/Layout'
export type { TabsProps, TabItem, SplitPaneProps } from './components/Layout'

export { Badge, LabelBadge, Tag, Avatar, Kbd, Card, Panel, PanelHeader, Toolbar, ScrollArea, Table } from './components/Display'
export type { Tone, BadgeProps, LabelBadgeProps, TagProps, AvatarProps, CardProps, PanelHeaderProps, ScrollAreaProps, TableProps, TableColumn } from './components/Display'

export { Spinner, Skeleton, ProgressBar, EmptyState } from './components/Feedback'
export type { SpinnerProps, SkeletonProps, ProgressBarProps, EmptyStateProps } from './components/Feedback'

export { Portal, FloatingLayer, Popover, Tooltip, FLOATING_SURFACE } from './components/Floating'
export type { FloatingLayerProps, PopoverProps, TooltipProps } from './components/Floating'

export { Menu, DropdownMenu, ContextMenu } from './components/Menu'
export type { MenuItem, MenuProps, DropdownMenuProps, ContextMenuProps } from './components/Menu'

export { Modal, Dialog, ConfirmDialog, Drawer } from './components/Modal'
export type { ModalProps, ConfirmDialogProps, DrawerProps } from './components/Modal'

export { toast, Toaster, ToastView } from './components/Toast'
export type { ToastViewProps } from './components/Toast'

export { Markdown, MarkdownEditor, CodeBlock } from './components/Markdown'
export type { MarkdownProps, MarkdownEditorProps, CodeBlockProps } from './components/Markdown'

export { SortableList, KanbanBoard } from './components/Dnd'
export type { SortableListProps, KanbanBoardProps, KanbanColumn } from './components/Dnd'

export { FormFromSchema, validateSchema, schemaDefaults } from './components/FormFromSchema'
export type { FormFromSchemaProps, JsonSchema, FormValue, FormErrors } from './components/FormFromSchema'
