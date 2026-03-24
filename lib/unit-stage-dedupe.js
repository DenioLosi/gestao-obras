function safeStr(value) {
  return (value ?? '').toString()
}

function normalizeStatus(status) {
  const value = safeStr(status).trim()
  if (value === 'done' || value === 'in_progress' || value === 'pending') return value
  return 'pending'
}

function progressRank(status) {
  if (status === 'done') return 2
  if (status === 'in_progress') return 1
  return 0
}

function normalizeText(value) {
  return safeStr(value).trim()
}

function normalizeDateValue(value) {
  const raw = safeStr(value).trim()
  return raw ? raw.slice(0, 19) : ''
}

function getPhotoCount(row) {
  if (Array.isArray(row?.photos)) return row.photos.length
  if (Array.isArray(row?.unit_stage_photos)) return row.unit_stage_photos.length
  const count = Number(row?.photo_count || 0)
  return Number.isFinite(count) ? count : 0
}

function getLogCount(row) {
  const count = Number(row?.log_count || 0)
  return Number.isFinite(count) ? count : 0
}

function getComparableSnapshot(row) {
  const status = normalizeStatus(row?.status)
  return {
    status,
    statusRank: progressRank(status),
    notes: normalizeText(row?.notes),
    startedAt: normalizeDateValue(row?.started_at),
    dueDate: normalizeDateValue(row?.due_date),
    photoCount: getPhotoCount(row),
    logCount: getLogCount(row),
  }
}

function completenessScore(row) {
  const snapshot = getComparableSnapshot(row)
  let score = snapshot.statusRank * 100
  if (snapshot.notes) score += 10
  if (snapshot.startedAt) score += 6
  if (snapshot.dueDate) score += 4
  score += snapshot.photoCount * 3
  score += snapshot.logCount * 2
  return score
}

function compareRows(a, b) {
  const scoreDiff = completenessScore(b) - completenessScore(a)
  if (scoreDiff !== 0) return scoreDiff

  const aSnapshot = getComparableSnapshot(a)
  const bSnapshot = getComparableSnapshot(b)

  const notesDiff = bSnapshot.notes.length - aSnapshot.notes.length
  if (notesDiff !== 0) return notesDiff

  const aOrder = Number(a?.order_index || 0)
  const bOrder = Number(b?.order_index || 0)
  if (aOrder !== bOrder) return aOrder - bOrder

  return safeStr(a?.id).localeCompare(safeStr(b?.id))
}

function hasAnyRelevantData(row) {
  const snapshot = getComparableSnapshot(row)
  return (
    snapshot.status !== 'pending' ||
    !!snapshot.notes ||
    !!snapshot.startedAt ||
    !!snapshot.dueDate ||
    snapshot.photoCount > 0 ||
    snapshot.logCount > 0
  )
}

function isContainedBy(preferred, candidate) {
  const preferredSnapshot = getComparableSnapshot(preferred)
  const candidateSnapshot = getComparableSnapshot(candidate)

  if (preferredSnapshot.statusRank < candidateSnapshot.statusRank) return false
  if (candidateSnapshot.notes && preferredSnapshot.notes !== candidateSnapshot.notes) return false
  if (candidateSnapshot.startedAt && preferredSnapshot.startedAt !== candidateSnapshot.startedAt) return false
  if (candidateSnapshot.dueDate && preferredSnapshot.dueDate !== candidateSnapshot.dueDate) return false
  if (preferredSnapshot.photoCount < candidateSnapshot.photoCount) return false
  if (preferredSnapshot.logCount < candidateSnapshot.logCount) return false
  return true
}

function getGroupKey(row) {
  const stageId = safeStr(row?.stage_id).trim()
  if (!stageId) return `row:${safeStr(row?.id)}`
  return `stage:${stageId}`
}

export function dedupeUnitStageRows(rows) {
  const grouped = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = getGroupKey(row)
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(row)
  }

  const dedupedRows = []
  const duplicateGroups = []

  for (const groupRows of grouped.values()) {
    if (groupRows.length <= 1) {
      dedupedRows.push(...groupRows)
      continue
    }

    const sorted = [...groupRows].sort(compareRows)
    const keep = sorted[0]
    const duplicates = sorted.slice(1)
    const emptyGroup = sorted.every((row) => !hasAnyRelevantData(row))
    const safeToCollapse = emptyGroup || duplicates.every((row) => isContainedBy(keep, row))

    dedupedRows.push(keep)
    duplicateGroups.push({
      key: getGroupKey(keep),
      keep,
      duplicates,
      total: sorted.length,
      safeToAutoRemove: safeToCollapse,
      requiresReview: !safeToCollapse,
    })
  }

  dedupedRows.sort((a, b) => {
    const aOrder = Number(a?.order_index || 0)
    const bOrder = Number(b?.order_index || 0)
    if (aOrder !== bOrder) return aOrder - bOrder
    return safeStr(a?.id).localeCompare(safeStr(b?.id))
  })

  return {
    rows: dedupedRows,
    duplicateGroups,
    hasReviewItems: duplicateGroups.some((group) => group.requiresReview),
  }
}

export function buildUnitStageDuplicateSummary(rows) {
  const result = dedupeUnitStageRows(rows)
  return {
    ...result,
    safeGroups: result.duplicateGroups.filter((group) => group.safeToAutoRemove),
    reviewGroups: result.duplicateGroups.filter((group) => group.requiresReview),
  }
}
