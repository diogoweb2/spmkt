// Top-right toggle for how weight prices are displayed ($/lb vs $/kg).
export default function UnitToggle({ db, update }) {
  const wu = db.displayWeightUnit ?? 'lb'
  return (
    <div className="seg" style={{ marginLeft: 'auto', flexWrap: 'nowrap' }}>
      {['lb', 'kg'].map((u) => (
        <button
          key={u}
          type="button"
          className={wu === u ? 'on' : ''}
          style={{ flex: 'none', minWidth: 0, padding: '7px 10px', fontSize: 13 }}
          onClick={() => update((d) => { d.displayWeightUnit = u })}
        >
          $/{u}
        </button>
      ))}
    </div>
  )
}
