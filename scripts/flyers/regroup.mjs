// One-off (re-runnable) regrouping pass: folds near-duplicate items into the
// generic merge groups the db already uses ("Chips (All)", "Bacon", …), so the
// Home lists show grouped products instead of dozens of brand variants.
// Every fold goes through the app's own mergeItems, so prices, origNames, unit
// normalization and flyer-duplicate collapse behave exactly like a manual Merge.
//
//   node scripts/flyers/regroup.mjs [--dry-run]
//
// Each PLAN entry is [final name, ...item names to merge]. Names are matched
// case-insensitively against item names; an entry whose survivor is missing, or
// that resolves to fewer than 2 items, is skipped and reported.

import { openFamilyDoc, loadEnv, log } from './shared.mjs'
import { mergeItems, canMerge } from '../../src/lib/merge.js'

const dry = process.argv.includes('--dry-run')

const PLAN = [
  // --- meat ---
  ['Bacon', 'Bacon', 'Great Value Bacon', "Lou's Double Smoked Bacon", 'Schneiders Fully Cooked Bacon'],
  ['Chicken wings', 'Chicken wings', 'Best Buy Chicken Wings', 'Chicken Wing Split', 'Janes Ultimates Chicken Wings',
    'St. Louis Style Chicken Wings', 'Yorkshire Valley Farms Organic Chicken Wings', 'Selection Chicken Wings',
    'Zabiha Halal Chicken Wings', 'Maple Leaf Prime Chicken Wings'],
  ['Boneless Skinless Chicken Breast', 'Boneless Skinless Chicken Breast', 'Boneless Chicken Breast',
    'Watson Ridge Chicken Breasts', 'Sikorski Chicken Breast'],
  ['Chicken Thighs', 'Chicken thigh', 'Chicken Thighs', 'Boneless Chicken Thighs'],
  ['Breaded Chicken Strips & Nuggets', 'Janes Pub Style Chicken Strips', 'Janes Nuggets',
    'Janes Pub Style Chicken Nuggets', 'James Chicken Boneless Bites Tenders Fillets', 'Selection Breaded Chicken Strips'],
  ['Chicken Sausages & Wieners', 'Zabiha Halal Chicken Weiners', 'Gold Label Chicken Sausages',
    'Maple Lodge Chicken Sausages', 'Maple Lodge Farms Chicken Weiners', 'Harvest Creek Halal Chicken Wieners',
    'Zabiha Halal Chicken Sausages'],
  ['Chicken Burgers', 'Chicken Burgers', 'MarcAngelo Chicken Burger'],
  ['Beef Steak', 'Beef Steak', 'Fresh Boneless Beef Striploin'],
  ['Beef Fry Strips', 'Beef Fry Strips', 'Your Fresh Market Beef Fry Strips'],
  ['Jamaican Beef Patties', 'Jamaican Style Beef Patties', 'Sunquest Patty Jamaican-Style Beef Patties'],
  ['Pork Back Ribs', 'Pork Back Ribs', "Butcher's Selection or Lou's Pork Back Ribs", "Montana's Pork Back Ribs",
    'Swiss Chalet Pork Back Ribs'],
  ['Pork Chops', 'Pork Loin Chops', 'Fresh Bone-In Pork Combination Chops', 'Pork Sirloin Chops',
    'Boneless Pork Sirloin Chops Value Pack'],
  ['Pork Sausages', 'Marcangelo Italian Sausages or Meatballs', 'MarcAngelo Italian Style Pork Sausage',
    'MarcAngelo Sausages', 'Fresh Pork Sausages', 'Store Made Sausages'],
  ['Smoked Sausages', 'Selection Smoked Sausages', "Piller's Smoked Sausages", 'Brandt Kolbassa Sausage Chubs'],
  ['Hot Dogs & Wieners', 'Schneiders Red Hots', 'Maple Leaf or Schneiders Wieners', 'Maple Leaf Top Dogs',
    "Butcher's Selection Hot Dogs", 'Stampede Hotdogs'],
  ['Pepperoni Sticks', "Piller's Original Pepperoni", 'Irresistible Pepperoni Sticks', 'Schneiders Pepperettes'],
  ['Lamb Chops', 'Lamb Loin Chops', 'Lamb Shoulder Chops'],
  ['Fresh Salmon', 'Fresh Salmon', 'Coho Salmon Fillet', 'Cedar Planked Salmon', 'Store Made Salmon Kabobs'],
  ['Smoked Salmon', 'Irresistible Sliced Smoked Atlantic Salmon', 'Hot Smoked Wild Pink Salmon Nuggets',
    'Nanuk Smoked Coho', 'Smoked Steelhead Trout'],
  ['Shrimp', 'High Liner Shrimp', 'Ocean Prime Cooked Shrimp', 'Seaquest Pacific White Shrimp Raw Peeled',
    'Seaquest Raw Shrimp', 'Wild Pink Argentinean Raw Shrimp', 'Raw Shrimp Skewers',
    'Irresistibles Pacific White Shrimp Ring'],
  ['Breaded Fish', 'Janes Ultimates Breaded or Battered Fish', 'Janes Ultimates Breaded Haddock',
    'Janes Lightly Dusted Fish', 'Cedar Bay Air Fryer Fish & Chips Bites'],
  // --- grocery ---
  ['Chips (All)', 'Chips (All)', "Miss Vickie's Chips", 'Doritos', 'Takis Tortilla Chips', 'Quest Tortilla Chips',
    'Tostitos Tortilla Chips', 'Snackish Protein Potato Chips with Avocado Oil'],
  ['Cookies', 'Cookies', 'Christie Family Size Cookies', 'Compliments Cookies', 'Canteen Cumin Cookies',
    "Nairn's Cookies", 'Oreo Cookies', 'Oreo Cakesters'],
  ['Grapes', 'Grapes Green', 'Grapes Red', 'Green or Red Seedless Grapes', 'Seedless Grapes', 'Candy Heart Grapes'],
  ['Apples', 'Gala Apples', 'Granny smith apples', 'Sweet Market Golden Delicious Red Prince Apples'],
  ['Oranges', 'Oranges', 'Navel Oranges', "Farmer's Market Oranges"],
  ['Clementines', 'Clementines', "Farmer's Market Mandarins"],
  ['Raspberries', 'Raspberries', 'Blackberries'],
  ['Oikos Greek Yogurt', 'Oikos Greek Yogurt', 'Danone Oikos Yogurt'],
  ['Mozzarella Cheese', 'Mozzarella Cheese', 'Tre Stelle Mozzarella Ball'],
  ['Sparkling water', 'Sparkling water', 'Bubly Sparkling Water'],
]

const { db, save } = await openFamilyDoc(loadEnv())
const before = { items: db.items.length, records: db.records.length }
const used = new Set()
let merged = 0

for (const [finalName, ...names] of PLAN) {
  // Duplicate item names exist (two groups were both called "Cookies"), so take
  // every item matching each name, in plan order, first-listed item surviving.
  const ids = []
  for (const n of names) {
    for (const i of db.items) {
      if (i.name.toLowerCase() === n.toLowerCase() && !used.has(i.id)) ids.push(i.id)
    }
  }
  const items = ids.map((id) => db.items.find((i) => i.id === id))
  if (items.length < 2) {
    log(`skip "${finalName}": ${items.length} item(s) matched (${names.join(', ')})`)
    continue
  }
  if (!canMerge(items)) {
    log(`skip "${finalName}": mixed kinds — ${items.map((i) => `${i.name} [${i.kind}]`).join(', ')}`)
    continue
  }
  log(`${finalName} ← ${items.slice(1).map((i) => i.name).join(' | ')}`)
  for (const id of ids) used.add(id)
  if (!dry) mergeItems(db, ids, finalName)
  merged++
}

log(`${merged} group(s); items ${before.items} → ${dry ? before.items : db.items.length}, records ${before.records} → ${dry ? before.records : db.records.length}`)
if (dry) log('dry run — nothing written')
else {
  await save(db)
  log('saved')
}
process.exit(0)
