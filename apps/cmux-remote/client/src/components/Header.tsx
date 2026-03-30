interface HeaderProps {
  workspaceName: string | null
  onMenuToggle: () => void
  showMenuButton?: boolean
}

export function Header({ workspaceName, onMenuToggle, showMenuButton = true }: HeaderProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 44,
        padding: '0 12px',
        backgroundColor: '#16213e',
        color: '#e0e0e0',
        borderBottom: '1px solid #2a2a4e',
        flexShrink: 0,
      }}
    >
      {showMenuButton && (
        <button
          type="button"
          onClick={onMenuToggle}
          aria-label="Menu"
          style={{
            background: 'none',
            border: 'none',
            color: '#e0e0e0',
            fontSize: 22,
            padding: '4px 8px',
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          &#9776;
        </button>
      )}
      <span
        style={{
          marginLeft: showMenuButton ? 8 : 4,
          fontSize: 15,
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {workspaceName ?? 'cmux Remote'}
      </span>
    </header>
  )
}
