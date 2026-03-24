import { createClient } from '@supabase/supabase-js'
import { calculateUnitMetrics } from '../../../lib/unit-progress'

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const supabaseAuth = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
})

function safeStr(value) {
  return (value ?? '').toString()
}

function readBearerToken(req) {
  const header = safeStr(req.headers.authorization).trim()
  if (!header.toLowerCase().startsWith('bearer ')) return ''
  return header.slice(7).trim()
}

async function requireAdmin(req) {
  const token = readBearerToken(req)
  if (!token) throw Object.assign(new Error('Sessao invalida. Entre novamente.'), { statusCode: 401 })

  const { data, error } = await supabaseAuth.auth.getUser(token)
  if (error || !data?.user) throw Object.assign(new Error(error?.message || 'Usuario nao autenticado.'), { statusCode: 401 })

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, role, status, tenant_id')
    .eq('id', data.user.id)
    .maybeSingle()

  if (profileError || !profile) throw Object.assign(new Error(profileError?.message || 'Perfil nao encontrado.'), { statusCode: 403 })
  if (profile.status === 'inactive' || profile.status === 'disabled') {
    throw Object.assign(new Error('Seu usuario esta inativo.'), { statusCode: 403 })
  }
  if (profile.role !== 'admin') throw Object.assign(new Error('Apenas administradores podem recalcular em lote.'), { statusCode: 403 })

  return profile
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo nao permitido' })
  }

  try {
    const profile = await requireAdmin(req)

    const { data: units, error: unitsError } = await supabaseAdmin
      .from('units')
      .select('id, progress, status, projects!inner ( tenant_id )')
      .eq('projects.tenant_id', profile.tenant_id)
      .limit(1000000)

    if (unitsError) throw Object.assign(new Error(unitsError.message), { statusCode: 400 })

    const unitIds = (units || []).map((unit) => unit.id).filter(Boolean)
    if (unitIds.length === 0) {
      return res.status(200).json({ success: true, updated: 0 })
    }

    const { data: stageRows, error: stageError } = await supabaseAdmin
      .from('unit_stages')
      .select('id, unit_id, stage_id, status, notes, started_at, due_date, order_index, is_active')
      .in('unit_id', unitIds)
      .limit(1000000)

    if (stageError) throw Object.assign(new Error(stageError.message), { statusCode: 400 })

    const grouped = {}
    for (const row of stageRows || []) {
      const key = safeStr(row.unit_id)
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(row)
    }

    let updated = 0
    for (const unit of units || []) {
      const metrics = calculateUnitMetrics(grouped[safeStr(unit.id)] || [], {
        progress: unit.progress,
        status: unit.status,
      })
      const patch = {
        progress: Math.round(metrics.progressPct * 100) / 100,
        status: metrics.generalStatus,
      }

      const currentProgress = Number(unit.progress || 0)
      const nextProgress = Number(patch.progress || 0)
      const currentStatus = safeStr(unit.status).trim() || 'pending'

      if (Math.abs(currentProgress - nextProgress) < 0.0001 && currentStatus === patch.status) {
        continue
      }

      const { error } = await supabaseAdmin.from('units').update(patch).eq('id', unit.id)
      if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
      updated += 1
    }

    return res.status(200).json({ success: true, updated })
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      error: error?.message || 'Erro interno no servidor',
    })
  }
}
