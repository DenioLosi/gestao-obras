const { createClient } = require('@supabase/supabase-js')

function safeStr(value) {
  return (value ?? '').toString()
}

function normalizeStatus(status) {
  const value = safeStr(status).trim()
  if (value === 'pending' || value === 'in_progress' || value === 'done') return value
  return 'pending'
}

function buildUnitStageDuplicateSummary(rows) {
  const grouped = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = row?.stage_id ? `stage:${safeStr(row.stage_id)}` : `row:${safeStr(row.id)}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(row)
  }

  const dedupedRows = []
  for (const groupRows of grouped.values()) {
    const sorted = [...groupRows].sort((a, b) => safeStr(a.id).localeCompare(safeStr(b.id)))
    dedupedRows.push(sorted[0])
  }

  return dedupedRows
}

function calculateUnitMetrics(stageRows, fallback = {}) {
  const activeRows = buildUnitStageDuplicateSummary(stageRows).filter((row) => row?.is_active !== false)
  const totalStages = activeRows.length
  const doneStages = activeRows.filter((row) => normalizeStatus(row?.status) === 'done').length
  const inProgressStages = activeRows.filter((row) => normalizeStatus(row?.status) === 'in_progress').length

  let progressPct = Number(fallback?.progress || 0)
  if (totalStages > 0) progressPct = (doneStages / totalStages) * 100

  let generalStatus = normalizeStatus(fallback?.status)
  if (totalStages > 0) {
    if (doneStages === totalStages) generalStatus = 'done'
    else if (doneStages > 0 || inProgressStages > 0) generalStatus = 'in_progress'
    else generalStatus = 'pending'
  }

  return { progressPct, generalStatus }
}

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const tenantId = safeStr(process.argv[2]).trim()
  if (!tenantId) {
    throw new Error('Use: node scripts/recalculate-all-units.js <tenant_id>')
  }

  const { data: units, error: unitsError } = await supabase
    .from('units')
    .select('id, progress, status, projects!inner ( tenant_id )')
    .eq('projects.tenant_id', tenantId)
    .limit(1000000)

  if (unitsError) throw unitsError

  const unitIds = (units || []).map((unit) => unit.id).filter(Boolean)
  const { data: stageRows, error: stageError } = await supabase
    .from('unit_stages')
    .select('id, unit_id, stage_id, status, is_active')
    .in('unit_id', unitIds)
    .limit(1000000)

  if (stageError) throw stageError

  const grouped = {}
  for (const row of stageRows || []) {
    const key = safeStr(row.unit_id)
    if (!grouped[key]) grouped[key] = []
    grouped[key].push(row)
  }

  let updated = 0
  for (const unit of units || []) {
    const metrics = calculateUnitMetrics(grouped[safeStr(unit.id)] || [], unit)
    const nextProgress = Math.round(metrics.progressPct * 100) / 100
    const nextStatus = metrics.generalStatus
    const currentProgress = Number(unit.progress || 0)
    const currentStatus = safeStr(unit.status).trim() || 'pending'

    if (Math.abs(currentProgress - nextProgress) < 0.0001 && currentStatus === nextStatus) continue

    const { error } = await supabase.from('units').update({ progress: nextProgress, status: nextStatus }).eq('id', unit.id)
    if (error) throw error
    updated += 1
  }

  console.log(`Updated ${updated} unit(s) in tenant ${tenantId}.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
