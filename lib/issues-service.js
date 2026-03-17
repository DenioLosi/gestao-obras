import { supabase } from './supabase'

const ISSUE_COLUMNS = 'id, unit_id, title, description, priority, assigned_to, status, created_at, updated_at'

export async function listIssuesByUnit(unitId) {
  return supabase
    .from('issues')
    .select(ISSUE_COLUMNS)
    .eq('unit_id', unitId)
    .order('created_at', { ascending: false })
}

export async function createIssue(payload) {
  return supabase
    .from('issues')
    .insert(payload)
    .select(ISSUE_COLUMNS)
    .maybeSingle()
}

export async function updateIssue(issueId, patch) {
  return supabase
    .from('issues')
    .update(patch)
    .eq('id', issueId)
    .select(ISSUE_COLUMNS)
    .maybeSingle()
}
