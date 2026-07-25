// Lets the node scripts import the app's own modules from src/lib (which use
// extensionless relative imports, as Vite allows) by appending `.js` when the
// bare specifier doesn't resolve. Used via --import by regroup.mjs.
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

if (!process.env.SPMKT_LOADER) {
  process.env.SPMKT_LOADER = '1'
  register('./src-loader.mjs', pathToFileURL(import.meta.filename))
}

export function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    try {
      return next(specifier + '.js', context)
    } catch {
      /* fall through to the original specifier */
    }
  }
  return next(specifier, context)
}
