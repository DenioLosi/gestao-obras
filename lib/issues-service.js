import { supabase } from './supabase'

const ISSUE_COLUMNS = 'id, unit_id, unit_stage_id, title, description, priority, assigned_to, status, created_at, updated_at'
const ISSUE_STATUS = new Set(['open', 'in_progress', 'resolved'])
const ISSUE_PRIORITY = new Set(['low', 'medium', 'high'])

function safeStr(value) {
  return (value ?? '').toString()
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
