// Tiny event-based snackbar bus: any screen calls toast('Deleted', { undo }),
// the <Snackbar/> host in App renders it. Undoable snackbars replace blocking
// confirm dialogs for recoverable actions (BUSINESS_RULES §15).

let listener = null
let seq = 0

export function toast(text, { undo, duration = 5000 } = {}) {
  listener?.({ id: ++seq, text, undo, duration })
}

export function onToast(cb) {
  listener = cb
  return () => { if (listener === cb) listener = null }
}
