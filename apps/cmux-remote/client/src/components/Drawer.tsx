import type { CmuxNotification, Workspace } from '../lib/cmux-rpc'

const SIDEBAR_WIDTH = 220
const DESKTOP_BREAKPOINT = 768

interface DrawerProps {
  open: boolean
  workspaces: Workspace[]
  currentWorkspace: string | null
  notifications: CmuxNotification[]
  onSelect: (id: string) => void
  onClose: () => void
}

/** Default palette for workspaces without custom_color (matches cmux desktop) */
const DEFAULT_PALETTE = [
  '#4A5C18',
  '#C0392B',
  '#1565C0',
  '#32A06D',
  '#8E44AD',
  '#D35400',
  '#2980B9',
  '#27AE60',
  '#E74C3C',
  '#16A085',
  '#F39C12',
  '#3498DB',
  '#2ECC71',
  '#E67E22',
  '#9B59B6',
]

function paletteColor(index: number): string {
  return DEFAULT_PALETTE[index % DEFAULT_PALETTE.length] ?? '#3E4B5E'
}

/** Extract folder name from path */
function folderName(path?: string): string | null {
  if (!path) return null
  const parts = path.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || null
}

/** Get latest notification per workspace */
function latestNotificationByWorkspace(notifications: CmuxNotification[]): Map<string, CmuxNotification> {
  const latest = new Map<string, CmuxNotification>()
  for (const n of notifications) {
    // Keep the last one per workspace (API returns in order)
    latest.set(n.workspace_id, n)
  }
  return latest
}

/** Count unread notifications per workspace */
function unreadCountByWorkspace(notifications: CmuxNotification[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const n of notifications) {
    if (!n.is_read) {
      counts.set(n.workspace_id, (counts.get(n.workspace_id) ?? 0) + 1)
    }
  }
  return counts
}

/** Derive status from notification */
function deriveStatus(n?: CmuxNotification): { label: string; color: string } | null {
  if (!n) return null
  const body = n.body.toLowerCase()
  const subtitle = n.subtitle.toLowerCase()

  if (body.includes('waiting for your input') || subtitle === 'waiting') {
    return { label: 'Needs input', color: '#F39C12' }
  }
  if (body.includes('permission')) {
    return { label: 'Permission', color: '#E74C3C' }
  }
  if (subtitle.includes('completed') || body.includes('完了')) {
    return { label: 'Idle', color: '#7f8c8d' }
  }
  return null
}

function WorkspaceItem({
  ws,
  index,
  isCurrent,
  unreadCount,
  notification,
  onClick,
}: {
  ws: Workspace
  index: number
  isCurrent: boolean
  unreadCount: number
  notification?: CmuxNotification
  onClick: () => void
}) {
  const color = ws.custom_color ?? paletteColor(index)
  const folder = folderName(ws.current_directory)
  const status = deriveStatus(notification)

  // Truncate notification body for preview
  const notifPreview = notification?.body
    ? notification.body.slice(0, 60) + (notification.body.length > 60 ? '...' : '')
    : null

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        gap: 8,
        width: '100%',
        padding: '8px 10px',
        background: isCurrent ? 'rgba(255, 255, 255, 0.08)' : 'none',
        border: 'none',
        borderLeft: `3px solid ${isCurrent ? color || '#64ffda' : 'transparent'}`,
        color: '#e0e0e0',
        fontSize: 12,
        textAlign: 'left',
        cursor: 'pointer',
        alignItems: 'flex-start',
      }}
    >
      {/* Color dot */}
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: color,
          flexShrink: 0,
          marginTop: 4,
        }}
      />

      {/* Content */}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        {/* Title */}
        <span
          style={{
            display: 'block',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: isCurrent ? '#fff' : '#ccc',
            fontWeight: isCurrent ? 600 : 400,
          }}
        >
          {ws.title || ws.ref}
        </span>

        {/* Notification preview */}
        {notifPreview && (
          <span
            style={{
              display: 'block',
              fontSize: 10,
              color: '#999',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginTop: 1,
            }}
          >
            {notifPreview}
          </span>
        )}

        {/* Status badge */}
        {status && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              fontSize: 10,
              color: status.color,
              marginTop: 2,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                backgroundColor: status.color,
              }}
            />
            {status.label}
          </span>
        )}

        {/* Folder path */}
        {folder && (
          <span
            style={{
              display: 'block',
              fontSize: 10,
              color: '#555',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginTop: 1,
            }}
          >
            ~/git/{folder}
          </span>
        )}
      </span>

      {/* Unread badge */}
      {unreadCount > 0 && (
        <span
          style={{
            minWidth: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor:
              status?.label === 'Needs input' || status?.label === 'Permission' ? status.color : '#e74c3c',
            color: '#fff',
            fontSize: 10,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 4px',
            flexShrink: 0,
            marginTop: 2,
          }}
        >
          {unreadCount}
        </span>
      )}
    </button>
  )
}

function WorkspaceList({ workspaces, currentWorkspace, notifications, onSelect, onClose }: Omit<DrawerProps, 'open'>) {
  const unreadCounts = unreadCountByWorkspace(notifications)
  const latestNotifs = latestNotificationByWorkspace(notifications)

  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: '4px 0',
        flex: 1,
        overflowY: 'auto',
      }}
    >
      {workspaces.map((ws, i) => (
        <li key={ws.ref} style={{ borderBottom: '1px solid #1a2340' }}>
          <WorkspaceItem
            ws={ws}
            index={i}
            isCurrent={ws.ref === currentWorkspace}
            unreadCount={unreadCounts.get(ws.id) ?? 0}
            notification={latestNotifs.get(ws.id)}
            onClick={() => {
              onSelect(ws.ref)
              onClose()
            }}
          />
        </li>
      ))}
      {workspaces.length === 0 && <li style={{ padding: '12px 16px', color: '#666', fontSize: 12 }}>No workspaces</li>}
    </ul>
  )
}

export { DESKTOP_BREAKPOINT, SIDEBAR_WIDTH }

export function Drawer({ open, workspaces, currentWorkspace, notifications, onSelect, onClose }: DrawerProps) {
  const isDesktop = typeof window !== 'undefined' && window.innerWidth >= DESKTOP_BREAKPOINT

  const sidebarContent = (
    <WorkspaceList
      workspaces={workspaces}
      currentWorkspace={currentWorkspace}
      notifications={notifications}
      onSelect={onSelect}
      onClose={onClose}
    />
  )

  // Desktop: static sidebar
  if (isDesktop) {
    return (
      <nav
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: SIDEBAR_WIDTH,
          backgroundColor: '#0f1729',
          borderRight: '1px solid #1e2a42',
          display: 'flex',
          flexDirection: 'column',
          paddingTop: 'env(safe-area-inset-top)',
          zIndex: 50,
        }}
      >
        <div
          style={{
            padding: '0 12px',
            fontSize: 13,
            fontWeight: 700,
            color: '#888',
            height: 44,
            display: 'flex',
            alignItems: 'center',
            borderBottom: '1px solid #1e2a42',
          }}
        >
          cmux Remote
        </div>
        {sidebarContent}
      </nav>
    )
  }

  // Mobile: overlay drawer
  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close drawer"
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            zIndex: 90,
            border: 'none',
            padding: 0,
            cursor: 'default',
          }}
        />
      )}
      <nav
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          width: 260,
          backgroundColor: '#0f1729',
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.2s ease-out',
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
          paddingTop: 'env(safe-area-inset-top)',
        }}
      >
        {sidebarContent}
      </nav>
    </>
  )
}
