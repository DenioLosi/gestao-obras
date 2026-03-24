import { buildUnitStageDuplicateSummary } from './unit-stage-dedupe'

function safeStr(value) {
  return (value ?? '').toString()
}

function clampPct(value) {
  const numeric = Number(value || 0)
  if (Number.isNaN(numeric)) return 0
  return Math.max(0, Math.min(100, numeric))
}

export function normalizeUnitStageStatus(status) {
  const value = safeStr(status).trim()
  if (value === 'pending' || value === 'in_progress' || value === 'done') return value
  return 'pending'
}

export function calculateUnitMetrics(stageRows, fallback = {}) {
  const summary = buildUnitStageDuplicateSummary(Array.isArray(stageRows) ? stageRows : [])
  const activeRows = summary.rows.filter((row) => row?.is_active !== false)

  const totalStages = activeRows.length
  const doneStages = activeRows.filter((row) => normalizeUnitStageStatus(row?.status) === 'done').length
  const pendingStages = activeRows.filter((row) => normalizeUnitStageStatus(row?.status) === 'pending').length
  const inProgressStages = activeRows.filter((row) => normalizeUnitStageStatus(row?.status) === 'in_progress').length
  const notesCount = activeRows.filter((row) => safeStr(row?.notes).trim()).length

  let progressPct = Number(fallback?.progress || 0)
  if (totalStages > 0) {
    progressPct = (doneStages / totalStages) * 100
  }

  let generalStatus = normalizeUnitStageStatus(fallback?.status)
  if (totalStages > 0) {
    if (doneStages === totalStages) generalStatus = 'done'
    else if (doneStages > 0 || inProgressStages > 0) generalStatus = 'in_progress'
    else generalStatus = 'pending'
  }

  return {
    rows: summary.rows,
    duplicateGroups: summary.duplicateGroups,
    reviewGroups: summary.reviewGroups,
    totalStages,
    doneStages,
    pendingStages,
    inProgressStages,
    notesCount,
    progressPct,
    generalStatus,
  }
}

export function applyUnitMetrics(unitRow, stageRows) {
  const metrics = calculateUnitMetrics(stageRows, {
    progress: unitRow?.progress,
    status: unitRow?.status,
  })

  return {
    ...(unitRow || {}),
    progress: metrics.progressPct,
    status: metrics.generalStatus,
    stageMetrics: metrics,
  }
}

export function calculateProjectMetrics(unitRows) {
  const counts = { pending: 0, in_progress: 0, done: 0 }
  const rows = Array.isArray(unitRows) ? unitRows : []

  let totalUnits = 0
  let sumProgress = 0
  let zeroProgressUnits = 0
  let doneUnits = 0

  for (const unit of rows) {
    const progressPct = clampPct(unit?.progress)
    let status = 'in_progress'

    if (progressPct <= 0) status = 'pending'
    else if (progressPct >= 100) status = 'done'
    else status = normalizeUnitStageStatus(unit?.status)

    counts[status] += 1
    sumProgress += progressPct
    totalUnits += 1

    if (progressPct <= 0) zeroProgressUnits += 1
    if (progressPct >= 100) doneUnits += 1
  }

  const progressPct = totalUnits > 0 ? sumProgress / totalUnits : 0

  let generalStatus = 'pending'
  if (totalUnits > 0) {
    if (doneUnits === totalUnits) generalStatus = 'done'
    else if (zeroProgressUnits === totalUnits) generalStatus = 'pending'
    else generalStatus = 'in_progress'
  }

  return {
    counts,
    totalUnits,
    progressPct,
    generalStatus,
  }
}
