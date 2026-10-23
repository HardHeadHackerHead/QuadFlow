interface LabelBadgeProps {
  name: string
  color: string
  size?: 'sm' | 'md'
  onClick?: () => void
  onRemove?: () => void
}

export default function LabelBadge({ name, color, size = 'sm', onClick, onRemove }: LabelBadgeProps) {
  const sizeClasses = size === 'sm'
    ? 'text-xs px-1.5 py-0.5'
    : 'text-sm px-2 py-1'

  // Calculate contrasting text color based on background
  const getContrastColor = (hexColor: string) => {
    const hex = hexColor.replace('#', '')
    const r = parseInt(hex.substr(0, 2), 16)
    const g = parseInt(hex.substr(2, 2), 16)
    const b = parseInt(hex.substr(4, 2), 16)
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    return luminance > 0.5 ? '#000000' : '#ffffff'
  }

  const textColor = getContrastColor(color)

  return (
    <span
      className={`
        inline-flex items-center gap-1 rounded-full font-medium
        ${sizeClasses}
        ${onClick ? 'cursor-pointer hover:opacity-80' : ''}
      `}
      style={{ backgroundColor: color, color: textColor }}
      onClick={onClick}
    >
      {name}
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          aria-label={`Remove ${name} label`}
          className="hover:bg-black/20 rounded-full p-0.5 -mr-0.5"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </span>
  )
}
