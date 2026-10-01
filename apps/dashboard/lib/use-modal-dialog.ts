"use client"
import { useEffect, useRef } from "react"

/** Native modal dialogs supply Escape and a focus trap; restore the invoking control. */
export function useModalDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => { dialog?.close(); trigger?.focus() }
  }, [])
  return ref
}
