import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' })
  }

  try {
    const { user_id } = req.body || {}
    const userId = (user_id || '').toString().trim()

    if (!userId) {
      return res.status(400).json({ error: 'user_id é obrigatório' })
    }

    const { data: profile, error: profileReadError } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, email, role, tenant_id')
      .eq('id', userId)
      .maybeSingle()

    if (profileReadError) {
      return res.status(400).json({ error: profileReadError.message })
    }

    if (!profile) {
      return res.status(404).json({ error: 'Usuário não encontrado no perfil.' })
    }

    const tenantId = profile.tenant_id

    if (!tenantId) {
      return res.status(400).json({ error: 'tenant_id do usuário não encontrado.' })
    }

    if (profile.role === 'admin') {
      const { count: adminCount, error: adminCountError } = await supabaseAdmin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('role', 'admin')

      if (adminCountError) {
        return res.status(400).json({ error: adminCountError.message })
      }

      if ((adminCount || 0) <= 1) {
        return res.status(400).json({
          error: 'Não é permitido excluir o último administrador da empresa.',
        })
      }
    }

    const { error: deleteMembersError } = await supabaseAdmin
      .from('project_members')
      .delete()
      .eq('user_id', userId)

    if (deleteMembersError) {
      return res.status(400).json({ error: deleteMembersError.message })
    }

    const { error: deleteProfileError } = await supabaseAdmin
      .from('profiles')
      .delete()
      .eq('id', userId)

    if (deleteProfileError) {
      return res.status(400).json({ error: deleteProfileError.message })
    }

    const { error: deleteAuthError } = await supabaseAdmin.auth.admin.deleteUser(userId)

    if (deleteAuthError) {
      return res.status(400).json({ error: deleteAuthError.message })
    }

    return res.status(200).json({
      success: true,
      message: 'Usuário excluído com sucesso.',
    })
  } catch (error) {
    return res.status(500).json({
      error: error?.message || 'Erro interno no servidor',
    })
  }
}
