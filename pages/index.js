import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../lib/supabase'

export default function Home() {
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [profile, setProfile] = useState(null)

  async function load() {
    setLoading(true)

    const { data: authData, error: authErr } = await supabase.auth.getUser()

    if (authErr || !authData?.user) {
      window.location.href = '/login'
      return
    }

    setEmail(authData.user.email || '')

    const { data: p, error } = await supabase
      .from('profiles')
      .select('id, full_name, role, status, tenant_id, must_change_password')
      .eq('id', authData.user.id)
      .maybeSingle()

    if (error) {
      alert(`Erro ao carregar perfil: ${error.message}`)
      setProfile(null)
      setLoading(false)
      return
    }

    if (!p) {
      alert('Perfil do usuário não encontrado.')
      setLoading(false)
      return
    }

    if (p.status === 'disabled' || p.status === 'inactive') {
      alert('Seu usuário está inativo. Procure o administrador.')
      await supabase.auth.signOut()
      window.location.href = '/login'
      return
    }

    setProfile(p)

    // força troca de senha no primeiro acesso
    if (p.must_change_password) {
      window.location.href = '/alterar-senha'
      return
    }

    setLoading(false)
  }

  async function signOut() {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  useEffect(() => {
    load()
  }, [])

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'Arial, sans-serif',
          background: '#f5f7fa',
        }}
      >
        Carregando…
      </div>
    )
  }

  const isAdmin = profile?.role === 'admin'

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#f5f7fa',
        padding: 24,
        fontFamily: 'Arial, sans-serif',
      }}
    >
      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <h1 style={{ margin: 0, fontSize: 34, fontWeight: 900 }}>Gestão de Obras</h1>

        <div style={{ marginTop: 8, color: '#444' }}>
          Olá, <b>{profile?.full_name || email}</b> 👋
        </div>

        <div
          style={{
            marginTop: 18,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 14,
          }}
        >
          <Link href="/obras" style={{ textDecoration: 'none' }}>
            <div
              style={{
                background: '#fff',
                border: '1px solid #eee',
                borderRadius: 14,
                padding: 16,
                boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
                cursor: 'pointer',
              }}
            >
              <div style={{ fontWeight: 900, fontSize: 18 }}>Obras</div>
              <div style={{ color: '#666', marginTop: 6 }}>
                Acompanhar obras, unidades, etapas e fotos
              </div>
            </div>
          </Link>

          {isAdmin ? (
            <Link href="/usuarios" style={{ textDecoration: 'none' }}>
              <div
                style={{
                  background: '#fff',
                  border: '1px solid #eee',
                  borderRadius: 14,
                  padding: 16,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 900, fontSize: 18 }}>Gestão de Usuários</div>
                <div style={{ color: '#666', marginTop: 6 }}>
                  Cadastrar, definir perfil e liberar acesso às obras
                </div>
              </div>
            </Link>
          ) : null}
        </div>

        <div
          style={{
            marginTop: 18,
            background: '#fff',
            border: '1px solid #eee',
            borderRadius: 14,
            padding: 16,
            boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 6 }}>Acesso</div>
          <div style={{ fontSize: 14, color: '#333' }}>
            Perfil: <b>{profile?.role || '—'}</b>
          </div>
          <div style={{ fontSize: 14, color: '#333' }}>
            Status: <b>{profile?.status || '—'}</b>
          </div>

          <div style={{ marginTop: 12 }}>
            <button
              onClick={signOut}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#fff',
                cursor: 'pointer',
                fontWeight: 900,
              }}
            >
              Sair
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
