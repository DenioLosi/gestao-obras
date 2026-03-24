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

async function requireUser(req) {
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

  return { user: data.user, profile }
}

async function ensureUnitAccess(unitId, profile) {
  const { data: unit, error: unitError } = await supabaseAdmin
    .from('units')
    .select('id, project_id')
    .eq('id', unitId)
    .maybeSingle()

  if (unitError || !unit) throw Object.assign(new Error(unitError?.message || 'Unidade nao encontrada.'), { statusCode: 404 })

  const { data: project, error: projectError } = await supabaseAdmin
    .from('projects')
    .select('id, tenant_id')
    .eq('id', unit.project_id)
    .maybeSingle()

  if (projectError || !project) throw Object.assign(new Error(projectError?.message || 'Obra nao encontrada.'), { statusCode: 404 })
  if (safeStr(project.tenant_id) !== safeStr(profile.tenant_id)) {
    throw Object.assign(new Error('Unidade fora do tenant do usuario.'), { statusCode: 403 })
  }

  if (profile.role === 'admin') return unit

  const { data: membership, error: memberError } = await supabaseAdmin
    .from('project_members')
    .select('project_id')
    .eq('project_id', project.id)
    .eq('user_id', profile.id)
    .maybeSingle()

  if (memberError) throw Object.assign(new Error(memberError.message), { statusCode: 400 })
  if (!membership) throw Object.assign(new Error('Usuario sem acesso a esta unidade.'), { statusCode: 403 })

  return unit
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo nao permitido' })
  }

  try {
    const { profile } = await requireUser(req)
    const unitId = safeStr(req.body?.unit_id).trim()
    if (!unitId) throw Object.assign(new Error('unit_id e obrigatorio.'), { statusCode: 400 })

    await ensureUnitAccess(unitId, profile)

    const { data: stageRows, error: stageError } = await supabaseAdmin
      .from('unit_stages')
      .select('id, unit_id, stage_id, status, notes, started_at, due_date, order_index, is_active')
      .eq('unit_id', unitId)
      .limit(1000000)

    if (stageError) throw Object.assign(new Error(stageError.message), { statusCode: 400 })

    const metrics = calculateUnitMetrics(stageRows || [])
    const patch = {
      progress: Math.round(metrics.progressPct * 100) / 100,
      status: metrics.generalStatus,
    }

    const { error: updateError } = await supabaseAdmin.from('units').update(patch).eq('id', unitId)
    if (updateError) throw Object.assign(new Error(updateError.message), { statusCode: 400 })

    return res.status(200).json({ success: true, unit: patch })
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      error: error?.message || 'Erro interno no servidor',
    })
  }
}
