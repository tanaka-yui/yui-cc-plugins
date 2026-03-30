import { useCallback, useEffect, useRef, useState } from 'react'
import Hammer from 'hammerjs'

interface UseGestureOptions {
  onSwipeUp: () => void
  onSwipeDown: () => void
  onSwipeLeft: () => void
  onSwipeRight: () => void
}

const SWIPE_THRESHOLD = 50

export function useGesture(options: UseGestureOptions) {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options

  const ref = useCallback((el: HTMLElement | null) => {
    setElement(el)
  }, [])

  useEffect(() => {
    if (!element) return

    const mc = new Hammer.Manager(element)
    mc.add(
      new Hammer.Pan({
        direction: Hammer.DIRECTION_ALL,
        pointers: 2,
        threshold: SWIPE_THRESHOLD,
      }),
    )

    let handled = false

    mc.on('panstart', () => {
      handled = false
    })

    mc.on('panend', (e) => {
      if (handled) return
      handled = true

      const { deltaX, deltaY } = e
      const absX = Math.abs(deltaX)
      const absY = Math.abs(deltaY)

      if (absX < SWIPE_THRESHOLD && absY < SWIPE_THRESHOLD) return

      if (absY > absX) {
        if (deltaY < 0) {
          optionsRef.current.onSwipeUp()
        } else {
          optionsRef.current.onSwipeDown()
        }
      } else {
        if (deltaX < 0) {
          optionsRef.current.onSwipeLeft()
        } else {
          optionsRef.current.onSwipeRight()
        }
      }

      // Haptic feedback
      if (navigator.vibrate) {
        navigator.vibrate(10)
      }
    })

    return () => {
      mc.destroy()
    }
  }, [element])

  return ref
}
