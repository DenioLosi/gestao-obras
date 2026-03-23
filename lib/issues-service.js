import { supabase } from './supabase'

const ISSUE_COLUMNS = 'id, unit_id, unit_stage_id, title, description, priority, assigned_to, status, started_at, due_date, created_at, updated_at'
const ISSUE_STATUS = new Set(['open', 'in_progress', 'resolved'])
const ISSUE_PRIORITY = new Set(['low', 'medium', 'high'])

function safeStr(value) {
  return (value ?? '').toString()
}

function normalizeDateValue(value) {
  const raw = safeStr(value).trim()
  return raw || null
}

function startOfToday(dateValue) {
  const date = dateValue ? new Date(dateValue) : new Date()
  date.setHours(0, 0, 0, 0)
  return date
}

function toDateOnlyKey(value) {
  const raw = safeStr(value).trim()
  if (!raw) return ''
  return raw.slice(0, 10)
}

export function getIssueUrgencyBucket(issue, now = new Date()) {
  const dueDateKey = toDateOnlyKey(issue?.due_date)
  if (!dueDateKey) return 3

  const today = startOfToday(now)
  const dueDate = startOfToday(`${dueDateKey}T12:00:00`)

  if (dueDate.getTime() < today.getTime()) return 0
  if (dueDate.getTime() === today.getTime()) return 1
  return 2
}

export function compareIssuesByUrgency(a, b, now = new Date()) {
  const bucketDiff = getIssueUrgencyBucket(a, now) - getIssueUrgencyBucket(b, now)
  if (bucketDiff !== 0) return bucketDiff

  const dueA = toDateOnlyKey(a?.due_date)
  const dueB = toDateOnlyKey(b?.due_date)
  if (dueA && dueB && dueA !== dueB) return dueA.localeCompare(dueB)
  if (dueA && !dueB) return -1
  if (!dueA && dueB) return 1

  const updatedAtA = new Date(a?.updated_at || a?.created_at || 0).getTime()
  const updatedAtB = new Date(b?.updated_at || b?.created_at || 0).getTime()
  return updatedAtB - updatedAtA
}

export function sortIssuesByUrgency(items, now = new Date()) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => compareIssuesByUrgency(a, b, now))
}

function normalizeIssuePatch(payload, { requireTitle = false } = {}) {
  const title = safeStr(payload?.title).trim()
  const data = {}

  if (requireTitle && !title) {
    throw new Error('Título da pendência é obrigatório.')
  }

  if (requireTitle || Object.prototype.hasOwnProperty.call(payload || {}, 'title')) {
    data.title = title
  }

  if (requireTitle || Object.prototype.hasOwnProperty.call(payload || {}, 'description')) {
    data.description = safeStr(payload?.description).trim()
  }

  if (requireTitle || Object.prototype.hasOwnProperty.call(payload || {}, 'priority')) {
    data.priority = ISSUE_PRIORITY.has(payload?.priority) ? payload.priority : 'medium'
  }

  if (requireTitle || Object.prototype.hasOwnProperty.call(payload || {}, 'assigned_to')) {
    const assignedTo = safeStr(payload?.assigned_to).trim()
    data.assigned_to = assignedTo || null
  }

  if (requireTitle || Object.prototype.hasOwnProperty.call(payload || {}, 'status')) {
    data.status = ISSUE_STATUS.has(payload?.status) ? payload.status : 'open'
  }

  if (requireTitle || Object.prototype.hasOwnProperty.call(payload || {}, 'started_at')) {
    data.started_at = payload?.started_at ? payload.started_at : requireTitle ? new Date().toISOString() : null
  }

  if (requireTitle || Object.prototype.hasOwnProperty.call(payload || {}, 'due_date')) {
    data.due_date = normalizeDateValue(payload?.due_date)
  }

  return data
}

export async function listIssuesByUnit(unitId) {
  return supabase
    .from('issues')
    .select(ISSUE_COLUMNS)
    .eq('unit_id', unitId)
    .order('created_at', { ascending: false })
}

export async function createIssue(payload) {
  const normalized = normalizeIssuePatch(payload, { requireTitle: true })

  return supabase
    .from('issues')
    .insert({
      tenant_id: payload.tenant_id || null,
      project_id: payload.project_id || null,
      unit_id: payload.unit_id,
      unit_stage_id: payload.unit_stage_id,
      created_by: payload.created_by,
      ...normalized,
    })
    .select(ISSUE_COLUMNS)
    .maybeSingle()
}

export async function updateIssue(issueId, patch) {
  const normalized = normalizeIssuePatch(patch)

  return supabase
    .from('issues')
    .update(normalized)
    .eq('id', issueId)
    .select(ISSUE_COLUMNS)
    .maybeSingle()
}

export async function deleteIssue(issueId) {
  return supabase.from('issues').delete().eq('id', issueId)
}
