import { useCallback, useEffect, useRef, useState } from 'react'

import { DESKTOP_BREAKPOINT, Drawer, SIDEBAR_WIDTH } from './components/Drawer'
import { Header } from './components/Header'
import { StatusBar } from './components/StatusBar'
import { Terminal } from './components/Terminal'
import { useCmux } from './hooks/useCmux'
import { useGesture } from './hooks/useGesture'

const POLL_INTERVAL = 1000

export function App() {
  const {
    status,
    workspaces,
    currentWorkspace,
    panes,
    currentPane,
    notifications,
    listWorkspaces,
    selectWorkspace,
    listPanes,
    readText,
    listNotifications,
    navigateWorkspace,
    navigatePane,
  } = useCmux()

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [termContent, setTermContent] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  // Initial data fetch
  useEffect(() => {
    if (status !== 'connected') return

    listWorkspaces()
      .then(() => Promise.all([listPanes(), listNotifications()]))
      .catch((err) => console.error('[app] Init error:', err))
  }, [status, listWorkspaces, listPanes, listNotifications])

  // Re-fetch panes when workspace changes
  useEffect(() => {
    if (status !== 'connected' || !currentWorkspace) return
    listPanes(currentWorkspace).catch(() => {})
  }, [status, currentWorkspace, listPanes])

  // Poll terminal content using workspace_ref
  useEffect(() => {
    if (status !== 'connected' || !currentWorkspace) {
      if (pollRef.current) clearInterval(pollRef.current)
      return
    }

    const poll = async () => {
      try {
        const text = await readText(currentWorkspace)
        setTermContent(text)
      } catch (err) {
        console.error('[app] Poll error:', err)
      }
    }

    poll()
    pollRef.current = setInterval(poll, POLL_INTERVAL)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [status, currentWorkspace, readText])

  // Gesture handlers
  const onSwipeUp = useCallback(() => {
    navigateWorkspace('next')
  }, [navigateWorkspace])

  const onSwipeDown = useCallback(() => {
    navigateWorkspace('prev')
  }, [navigateWorkspace])

  const onSwipeLeft = useCallback(() => {
    navigatePane('next')
  }, [navigatePane])

  const onSwipeRight = useCallback(() => {
    navigatePane('prev')
  }, [navigatePane])

  const gestureRef = useGesture({
    onSwipeUp,
    onSwipeDown,
    onSwipeLeft,
    onSwipeRight,
  })

  const [isDesktop, setIsDesktop] = useState(typeof window !== 'undefined' && window.innerWidth >= DESKTOP_BREAKPOINT)

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT}px)`)
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const currentWs = workspaces.find((w) => w.ref === currentWorkspace)
  const currentPaneInfo = panes.find((p) => p.selected_surface_ref === currentPane)

  return (
    <div
      style={{
        display: 'flex',
        height: '100dvh',
        backgroundColor: '#1a1a2e',
        color: '#e0e0e0',
        overflow: 'hidden',
      }}
    >
      <Drawer
        open={drawerOpen}
        workspaces={workspaces}
        currentWorkspace={currentWorkspace}
        notifications={notifications}
        onSelect={(ref) => {
          selectWorkspace(ref)
        }}
        onClose={() => setDrawerOpen(false)}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          marginLeft: isDesktop ? SIDEBAR_WIDTH : 0,
          transition: 'margin-left 0.2s ease-out',
          overflow: 'hidden',
        }}
      >
        <Header
          workspaceName={currentWs?.title ?? null}
          onMenuToggle={() => setDrawerOpen((o) => !o)}
          showMenuButton={!isDesktop}
        />

        <Terminal content={termContent} gestureRef={gestureRef} />

        <StatusBar
          status={status}
          paneName={currentPaneInfo?.ref ?? currentPane}
          paneIndex={panes.findIndex((p) => p.selected_surface_ref === currentPane)}
          paneCount={panes.length}
        />
      </div>
    </div>
  )
}
