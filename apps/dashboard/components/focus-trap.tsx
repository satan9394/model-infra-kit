"use client"

import { useEffect, useRef, type RefObject } from "react"

/** Tab order candidates inside a modal layer. */
export const FOCUSABLE_SELECTOR =
  'a[href], area[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, object, embed, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'

/**
 * Where a Tab press inside a trap should jump to, or `null` to let the browser
 * move focus normally.
 *
 * Kept pure so the wrap-around can be unit-tested without a DOM:
 *  - an empty layer has nowhere to go (`null`);
 *  - focus outside the layer (index `-1`) enters at the first/last item;
 *  - `Tab` on the last item wraps to the first, `Shift+Tab` on the first wraps
 *    to the last;
 *  - every other position is left to the browser.
 */
export function trapTargetIndex(currentIndex: number, count: number, shift: boolean): number | null {
  if (count <= 0) return null
  if (currentIndex < 0) return shift ? count - 1 : 0
  if (shift && currentIndex === 0) return count - 1
  if (!shift && currentIndex === count - 1) return 0
  return null
}

export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
    if (element.hasAttribute("disabled")) return false
    if (element.getAttribute("aria-hidden") === "true") return false
    return element.tabIndex >= 0
  })
}

/**
 * Confine keyboard focus to `ref` while `active`, move focus inside on open, and
 * restore it to the element that opened the layer on close. Escape is handled
 * explicitly so a non-native overlay still has a keyboard close path.
 */
export function useFocusTrap<T extends HTMLElement>(
  ref: RefObject<T | null>,
  active: boolean,
  onEscape?: () => void,
) {
  const escapeRef = useRef(onEscape)
  escapeRef.current = onEscape
  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Respect an intentional initial focus (a modal's `autofocus` field) and only
    // pull focus in when it is still outside the layer.
    if (!container.contains(document.activeElement)) {
      const initial = focusableWithin(container)
      ;(initial[0] ?? container).focus()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        escapeRef.current?.()
        return
      }
      if (event.key !== "Tab") return
      const items = focusableWithin(container)
      const next = trapTargetIndex(items.indexOf(document.activeElement as HTMLElement), items.length, event.shiftKey)
      if (next === null) return
      event.preventDefault()
      items[next]?.focus()
    }

    container.addEventListener("keydown", onKeyDown)
    return () => {
      container.removeEventListener("keydown", onKeyDown)
      trigger?.focus()
    }
  }, [active, ref])
}
