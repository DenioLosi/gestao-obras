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
    const { name, email, password, role, tenant_id, projects } = req.body

    const fullName = (name || '').toString().trim()
    const userEmail = (email || '').toString().trim().toLowerCase()
    const userPassword = (password || '').toString()
    const userRole = (role || '').toString().trim()
    const tenantId = (tenant_id || '').toString().trim()
    const projectIds = Array.isArray(projects) ? projects.filter(Boolean) : []

    if (!fullName) {
      return res.status(400).json({ error: 'Nome é obrigatório' })
    }

    if (!userEmail) {
      return res.status(400).json({ error: 'Email é obrigatório' })
    }

    if (!userPassword || userPassword.length < 6) {
      return res.status(400).json({ error: 'A senha inicial deve ter pelo menos 6 caracteres' })
    }

    if (!userRole) {
      return res.status(400).json({ error: 'Perfil do usuário é obrigatório' })
    }

    if (!tenantId) {
      return res.status(400).json({ error: 'tenant_id é obrigatório' })
    }

    // 1) cria usuário no Auth
    const { data: createData, error: createError } =
      await supabaseAdmin.auth.admin.createUser({
        email: userEmail,
        password: userPassword,
        email_confirm: true,
        user_metadata: {
          full_name: fullName,
        },
      })

    if (createError) {
      return res.status(400).json({ error: createError.message })
    }

    const userId = createData?.user?.id

    if (!userId) {
      return res.status(400).json({ error: 'Não foi possível obter o id do usuário criado.' })
    }

    // 2) cria/atualiza profile
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .upsert(
        {
          id: userId,
          full_name: fullName,
          role: userRole,
          status: 'active',
          tenant_id: tenantId,
          must_change_password: true,
        },
        { onConflict: 'id' }
      )

    if (profileError) {
      return res.status(400).json({ error: profileError.message })
    }

    // 3) remove acessos antigos
    const { error: deleteMembersError } = await supabaseAdmin
      .from('project_members')
      .delete()
      .eq('user_id', userId)

    if (deleteMembersError) {
      return res.status(400).json({ error: deleteMembersError.message })
    }

    // 4) grava acessos novos
    if (projectIds.length > 0) {
      const rows = projectIds.map((project_id) => ({
        user_id: userId,
        project_id,
      }))

      const { error: memberError } = await supabaseAdmin
        .from('project_members')
        .insert(rows)

      if (memberError) {
        return res.status(400).json({ error: memberError.message })
      }
    }

    return res.status(200).json({
      success: true,
      user_id: userId,
      message: 'Usuário criado com sucesso.',
    })
  } catch (error) {
    return res.status(500).json({
      error: error?.message || 'Erro interno no servidor',
    })
  }
}
