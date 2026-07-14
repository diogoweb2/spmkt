// Camera icon that opens a Google Images search for the item name, to check
// what the product actually is. Safe inside row <button>s (stops propagation).
export default function PhotoLink({ name, style }) {
  return (
    <span
      role="button"
      aria-label={`See photos of ${name}`}
      style={{ cursor: 'pointer', padding: '0 4px', ...style }}
      onClick={(e) => {
        e.stopPropagation()
        window.open(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(name)}`, '_blank', 'noopener')
      }}
    >
      📷
    </span>
  )
}
