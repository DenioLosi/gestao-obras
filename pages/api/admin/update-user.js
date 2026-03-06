import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function findUserByEmail(email) {
  let page = 1
  const perPage = 200

  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage,
    })

    if (error) throw new Error(error.message)

    const users = data?.users || []
    const found = users.find(
      (u) => (u.email || '').toLowerCase() === email.toLowerCase()
    )

    if (found) return found
    if (users.length < perPage) return null

    page += 1
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' })
  }

  try {
    const {
      user_id,
      name,
      email,
      phone,
      role,
      status,
      tenant_id,
      projects,
      reset_password,
    } = req.body

    const userId = (user_id || '').toString().trim()
    const fullName = (name || '').toString().trim()
    const userEmail = (email || '').toString().trim().toLowerCase()
    const userPhone = (phone || '').toString().trim()
    const userRole = (role || '').toString().trim()
    const userStatus = (status || '').toString().trim()
    const tenantId = (tenant_id || '').toString().trim()
    const projectIds = Array.isArray(projects) ? projects.filter(Boolean) : []
    const resetPassword = !!reset_password

    if (!userId) return res.status(400).json({ error: 'user_id é obrigatório' })
    if (!fullName) return res.status(400).json({ error: 'Nome é obrigatório' })
    if (!userEmail) return res.status(400).json({ error: 'Email é obrigatório' })
    if (!userRole) return res.status(400).json({ error: 'Perfil é obrigatório' })
    if (!userStatus) return res.status(400).json({ error: 'Status é obrigatório' })
    if (!tenantId) return res.status(400).json({ error: 'tenant_id é obrigatório' })

    const existingByEmail = await findUserByEmail(userEmail)
    if (existingByEmail && existingByEmail.id !== userId) {
      return res.status(400).json({ error: 'Já existe outro usuário com este email.' })
    }

    const payloadAuth = {
      email: userEmail,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        phone: userPhone,
      },
    }

    if (resetPassword) {
      payloadAuth.password = '123456'
    }

    const { error: updAuthErr } = await supabaseAdmin.auth.admin.updateUserById(
      userId,
      payloadAuth
    )

    if (updAuthErr) {
      return res.status(400).json({ error: updAuthErr.message })
    }

    const profilePayload = {
      id: userId,
      full_name: fullName,
      email: userEmail,
      phone: userPhone,
      role: userRole,
      status: userStatus,
      tenant_id: tenantId,
    }

    if (resetPassword) {
      profilePayload.must_change_password = true
    }

    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .upsert(profilePayload, { onConflict: 'id' })

    if (profileError) {
      return res.status(400).json({ error: profileError.message })
    }

    const { error: deleteMembersError } = await supabaseAdmin
      .from('project_members')
      .delete()
      .eq('user_id', userId)

    if (deleteMembersError) {
      return res.status(400).json({ error: deleteMembersError.message })
    }

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
      message: resetPassword
        ? 'Usuário atualizado. A senha foi resetada para 123456 e a troca será obrigatória no próximo acesso.'
        : 'Usuário atualizado com sucesso.',
    })
  } catch (error) {
    return res.status(500).json({
      error: error?.message || 'Erro interno no servidor',
    })
  }
}
