import { supabase } from './supabase'

async function getAccessToken() {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  return data?.session?.access_token || ''
}

export async function runAdminAction(action, payload = {}) {
  const token = await getAccessToken()
  const response = await fetch('/api/admin/structural-action', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      action,
      ...payload,
    }),
  })

  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(json?.error || 'Falha ao executar a acao administrativa.')
  }

  return json
}
