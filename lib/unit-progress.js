import { buildUnitStageDuplicateSummary } from './unit-stage-dedupe'

function safeStr(value) {
  return (value ?? '').toString()
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
