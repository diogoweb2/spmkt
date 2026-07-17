// Renders flyerInfo() text; when the record carries a flyer URL (stored by the
// weekly import) the text opens the flyer site — at the exact page when the
// page number is known (#p=N), otherwise the flyer's first page. Plain span
// for older records with no stored URL. window.open instead of <a>: these
// badges live inside row <button>s, where a nested anchor is invalid HTML.
export default function FlyerLink({ fi, className, style }) {
  if (!fi) return null
  return (
    <span
      className={className}
      role={fi.url ? 'link' : undefined}
      style={{ ...(fi.url ? { cursor: 'pointer', textDecoration: 'underline' } : null), ...style }}
      onPointerDown={fi.url ? (e) => e.stopPropagation() : undefined}
      onClick={fi.url ? (e) => { e.stopPropagation(); window.open(fi.url, '_blank', 'noopener') } : undefined}
    >
      {fi.text}
    </span>
  )
}
