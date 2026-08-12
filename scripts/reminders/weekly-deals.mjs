// Wednesday 8:00 web-push nudge: new flyers are out, go check the deals.
// Since the automatic weekly extraction was retired (§12 → §17), deals only get
// in when the user opens the Flyers tab and crops them — so the reminder is the
// whole trigger for the week. Always sends (no "nothing to do" case); a no-op
// without registered devices or the admin SDK (sendPush handles both).
//
// Scheduled by scripts/reminders/com.spmkt.weekly-deals.plist.
import { loadEnv, log, sendPush } from '../flyers/shared.mjs'

const dryRun = process.argv.includes('--dry-run')

const title = '🛒 Check this week’s deals'
const body = 'New flyers are out — open the Flyers tab and crop what’s worth importing.'

if (dryRun) {
  log(`weekly-deals: dry run — would push "${title}" · "${body}"`)
} else {
  await sendPush(loadEnv(), { title, body })
}
