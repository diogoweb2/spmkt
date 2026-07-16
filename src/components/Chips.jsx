// Horizontally scrollable chip row; wheel + drag scrolling for mouse users
// (the scrollbar is hidden and mice have no horizontal wheel).
export default function Chips({ children, style }) {
  const drag = (e) => {
    const el = e.currentTarget
    const startX = e.clientX
    const startLeft = el.scrollLeft
    const move = (ev) => { el.scrollLeft = startLeft - (ev.clientX - startX) }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div
      className="chips"
      style={style}
      onWheel={(e) => { e.currentTarget.scrollLeft += e.deltaY + e.deltaX }}
      onPointerDown={(e) => { if (e.pointerType === 'mouse') drag(e) }}
    >
      {children}
    </div>
  )
}
