import { useCallback, useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

interface TerminalProps {
  content: string
  gestureRef: (el: HTMLDivElement | null) => void
}

export function Terminal({ content, gestureRef }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const prevContentRef = useRef<string>('')

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: false,
      fontSize: 13,
      fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        selectionBackground: '#3a3a5e',
      },
      scrollback: 1000,
      convertEol: true,
      disableStdin: true,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    const resizeObserver = new ResizeObserver(() => {
      fit.fit()
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      term.dispose()
    }
  }, [])

  useEffect(() => {
    const term = termRef.current
    if (!term || !content) return

    if (content === prevContentRef.current) return
    prevContentRef.current = content

    // Strip trailing whitespace from each line to prevent wrapping artifacts
    // caused by cmux read-screen padding lines to full terminal width
    const cleaned = content
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
    term.clear()
    term.write(cleaned)
  }, [content])

  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el
      gestureRef(el)
    },
    [gestureRef],
  )

  return (
    <div
      ref={setRefs}
      style={{
        flex: 1,
        width: '100%',
        overflow: 'hidden',
        touchAction: 'none',
      }}
    />
  )
}
