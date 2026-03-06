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

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' })
    }

    // cria usuário no AUTH
    const { data: userData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true
      })

    if (authError) {
      return res.status(400).json({ error: authError.message })
    }

    const userId = userData.user.id

    // cria profile
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .insert({
        id: userId,
        full_name: name,
        role: role,
        tenant_id: tenant_id,
        status: 'active',
        must_change_password: true
      })

    if (profileError) {
      return res.status(400).json({ error: profileError.message })
    }

    // salva permissões de obras
    if (projects && projects.length > 0) {

      const rows = projects.map(project_id => ({
        user_id: userId,
        project_id
      }))

      const { error: memberError } = await supabaseAdmin
        .from('project_members')
        .insert(rows)

      if (memberError) {
        return res.status(400).json({ error: memberError.message })
      }
    }

    return res.status(200).json({ success: true })

  } catch (error) {

    return res.status(500).json({ error: error.message })

  }
}
