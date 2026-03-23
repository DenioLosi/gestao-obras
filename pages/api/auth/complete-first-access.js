import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'MÃ©todo nÃ£o permitido' })
  }

  try {
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (!token) {
      return res.status(401).json({ error: 'SessÃ£o invÃ¡lida.' })
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })

    const { data: authData, error: authError } = await supabaseAuth.auth.getUser()

    if (authError || !authData?.user) {
      return res.status(401).json({ error: authError?.message || 'UsuÃ¡rio nÃ£o autenticado.' })
    }

    const userId = authData.user.id
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey)

    const { data: existingProfile, error: profileReadError } = await supabaseAdmin
      .from('profiles')
      .select('id, must_change_password')
      .eq('id', userId)
      .maybeSingle()

    if (profileReadError) {
      return res.status(400).json({ error: profileReadError.message })
    }

    if (!existingProfile) {
      return res.status(404).json({ error: 'Perfil do usuÃ¡rio nÃ£o encontrado.' })
    }

    const { data: updatedProfile, error: profileUpdateError } = await supabaseAdmin
      .from('profiles')
      .update({ must_change_password: false })
      .eq('id', userId)
      .select('id, must_change_password')
      .maybeSingle()

    if (profileUpdateError) {
      return res.status(400).json({ error: profileUpdateError.message })
    }

    if (!updatedProfile) {
      return res.status(400).json({ error: 'NÃ£o foi possÃ­vel atualizar o perfil do usuÃ¡rio.' })
    }

    return res.status(200).json({
      success: true,
      profile: updatedProfile,
    })
  } catch (error) {
    return res.status(500).json({
      error: error?.message || 'Erro interno no servidor',
    })
  }
}
