// Bundled supermarket logos (imported so Vite ships them with the build).
// Matched loosely against the store name; stores without a match show text.
import costco from '../assets/logos/costco.svg'
import walmart from '../assets/logos/walmart.svg'
import nofrills from '../assets/logos/nofrills.jpg'
import superstore from '../assets/logos/superstore.png'
import metro from '../assets/logos/metro.svg'
import freshco from '../assets/logos/freshco.svg'
import sobeys from '../assets/logos/sobeys.svg'

const LOGOS = [
  { match: ['costco'], src: costco },
  { match: ['walmart'], src: walmart },
  { match: ['nofrills'], src: nofrills },
  { match: ['superstore', 'realcanadian'], src: superstore },
  { match: ['metro'], src: metro },
  { match: ['freshco'], src: freshco },
  { match: ['sobeys'], src: sobeys },
]

export function storeLogo(name) {
  const n = (name || '').toLowerCase().replace(/[^a-z]/g, '')
  return LOGOS.find((l) => l.match.some((m) => n.includes(m)))?.src ?? null
}
