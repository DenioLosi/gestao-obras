const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

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

function toSet(values) {
  return new Set((Array.isArray(values) ? values : []).map((value) => safeStr(value)).filter(Boolean))
}

function isSubset(subset, superset) {
  for (const value of subset) {
    if (!superset.has(value)) return false
  }
  return true
}

function buildSnapshot(row) {
  return {
    status: normalizeStatus(row.status),
    statusRank: progressRank(normalizeStatus(row.status)),
    notes: normalizeText(row.notes),
    startedAt: normalizeDateValue(row.started_at),
    dueDate: normalizeDateValue(row.due_date),
    photoPaths: toSet(row.photo_paths),
    logKeys: toSet(row.log_keys),
  }
}

function hasRelevantData(row) {
  const snapshot = buildSnapshot(row)
  return (
    snapshot.status !== 'pending' ||
    !!snapshot.notes ||
    !!snapshot.startedAt ||
    !!snapshot.dueDate ||
    snapshot.photoPaths.size > 0 ||
    snapshot.logKeys.size > 0
  )
}

function compareRows(a, b) {
  const left = buildSnapshot(a)
  const right = buildSnapshot(b)

  if (right.statusRank !== left.statusRank) return right.statusRank - left.statusRank
  if (right.photoPaths.size !== left.photoPaths.size) return right.photoPaths.size - left.photoPaths.size
  if (right.logKeys.size !== left.logKeys.size) return right.logKeys.size - left.logKeys.size
  if (!!right.notes !== !!left.notes) return Number(!!right.notes) - Number(!!left.notes)
  if (!!right.startedAt !== !!left.startedAt) return Number(!!right.startedAt) - Number(!!left.startedAt)
  if (!!right.dueDate !== !!left.dueDate) return Number(!!right.dueDate) - Number(!!left.dueDate)
  return safeStr(a.id).localeCompare(safeStr(b.id))
}

function canSafelyRemove(preferred, candidate) {
  const keep = buildSnapshot(preferred)
  const drop = buildSnapshot(candidate)

  if (!hasRelevantData(candidate)) return true
  if (drop.logKeys.size > 0) return false
  if (drop.notes && drop.notes !== keep.notes) return false
  if (drop.startedAt && drop.startedAt !== keep.startedAt) return false
  if (drop.dueDate && drop.dueDate !== keep.dueDate) return false
  if (keep.statusRank < drop.statusRank) return false
  if (!isSubset(drop.photoPaths, keep.photoPaths)) return false
  return true
}

async function loadRows() {
  const [{ data: stageRows, error: stageError }, { data: photos, error: photosError }, { data: logs, error: logsError }] =
    await Promise.all([
      supabase
        .from('unit_stages')
        .select('id, unit_id, stage_id, status, notes, started_at, due_date, order_index, custom_name, stages ( name ), units ( identifier )')
        .not('stage_id', 'is', null)
        .limit(1000000),
      supabase.from('unit_stage_photos').select('id, unit_stage_id, path').limit(1000000),
      supabase.from('unit_stage_logs').select('id, unit_stage_id, action, created_at').limit(1000000),
    ])

  if (stageError) throw stageError
  if (photosError) throw photosError
  if (logsError) throw logsError

  const photoPathsByStageId = new Map()
  for (const row of photos || []) {
    const key = safeStr(row.unit_stage_id)
    if (!photoPathsByStageId.has(key)) photoPathsByStageId.set(key, [])
    photoPathsByStageId.get(key).push(row.path)
  }

  const logKeysByStageId = new Map()
  for (const row of logs || []) {
    const key = safeStr(row.unit_stage_id)
    if (!logKeysByStageId.has(key)) logKeysByStageId.set(key, [])
    logKeysByStageId.get(key).push(`${safeStr(row.action)}::${safeStr(row.created_at)}`)
  }

  return (stageRows || []).map((row) => ({
    ...row,
    photo_paths: photoPathsByStageId.get(safeStr(row.id)) || [],
    log_keys: logKeysByStageId.get(safeStr(row.id)) || [],
    stage_name: row.custom_name || row.stages?.name || '(Sem nome)',
    unit_label: row.units?.identifier || row.unit_id,
  }))
}

async function deleteRows(deleteIds) {
  for (const chunk of Array.from({ length: Math.ceil(deleteIds.length / 200) }, (_, index) => deleteIds.slice(index * 200, index * 200 + 200))) {
    await supabase.from('unit_stage_photos').delete().in('unit_stage_id', chunk)
    await supabase.from('unit_stage_logs').delete().in('unit_stage_id', chunk)
    const { error } = await supabase.from('unit_stages').delete().in('id', chunk)
    if (error) throw error
  }
}

async function main() {
  const apply = process.argv.includes('--apply')
  const rows = await loadRows()
  const groups = new Map()

  for (const row of rows) {
    const key = `${safeStr(row.unit_id)}::${safeStr(row.stage_id)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  const safeGroups = []
  const reviewGroups = []
  const deleteIds = []

  for (const groupRows of groups.values()) {
    if (groupRows.length <= 1) continue

    const sorted = [...groupRows].sort(compareRows)
    const keep = sorted[0]
    const duplicates = sorted.slice(1)
    const safe = duplicates.every((row) => canSafelyRemove(keep, row))

    const summary = {
      unit: keep.unit_label,
      stage: keep.stage_name,
      keepId: keep.id,
      deleteIds: duplicates.map((row) => row.id),
    }

    if (safe) {
      safeGroups.push(summary)
      deleteIds.push(...summary.deleteIds)
    } else {
      reviewGroups.push({
        ...summary,
        rows: sorted.map((row) => ({
          id: row.id,
          status: normalizeStatus(row.status),
          notes: normalizeText(row.notes),
          started_at: normalizeDateValue(row.started_at),
          due_date: normalizeDateValue(row.due_date),
          photos: row.photo_paths.length,
          logs: row.log_keys.length,
        })),
      })
    }
  }

  console.log(JSON.stringify({
    apply,
    safe_groups: safeGroups.length,
    rows_to_delete: deleteIds.length,
    review_groups: reviewGroups.length,
    review_items: reviewGroups,
  }, null, 2))

  if (apply && deleteIds.length > 0) {
    await deleteRows(deleteIds)
    console.log(`Deleted ${deleteIds.length} duplicate unit_stage row(s).`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
