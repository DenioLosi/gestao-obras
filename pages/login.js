import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    async function checkSession() {
      const { data } = await supabase.auth.getSession()
      if (data?.session) {
        window.location.href = '/'
        return
      }
      setChecking(false)
    }

    checkSession()
  }, [])

  async function handleLogin(e) {
    e.preventDefault()
    setErrorMsg('')

    const userEmail = email.trim().toLowerCase()
    const userPassword = password

    if (!userEmail) {
      setErrorMsg('Informe seu e-mail.')
      return
    }

    if (!userPassword) {
      setErrorMsg('Informe sua senha.')
      return
    }

    setLoading(true)

    const { error } = await supabase.auth.signInWithPassword({
      email: userEmail,
      password: userPassword,
    })

    if (error) {
      setErrorMsg(error.message)
      setLoading(false)
      return
    }

    window.location.href = '/'
  }

  if (checking) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f5f7fa',
          fontFamily: 'Arial, sans-serif',
        }}
      >
        Carregando…
      </div>
    )
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f5f7fa',
        padding: 24,
        fontFamily: 'Arial, sans-serif',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          background: '#fff',
          border: '1px solid #eee',
          borderRadius: 16,
          padding: 24,
          boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
        }}
      >
        <h1 style={{ marginTop: 0, marginBottom: 8 }}>Entrar</h1>
        <div style={{ color: '#666', marginBottom: 18 }}>
          Login com e-mail e senha
        </div>

        <form onSubmit={handleLogin} style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: '#444' }}>
              E-mail
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seuemail@exemplo.com"
              autoComplete="email"
              style={{
                padding: '12px 14px',
                borderRadius: 12,
                border: '1px solid #ddd',
                outline: 'none',
              }}
              disabled={loading}
            />
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: '#444' }}>
              Senha
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Sua senha"
              autoComplete="current-password"
              style={{
                padding: '12px 14px',
                borderRadius: 12,
                border: '1px solid #ddd',
                outline: 'none',
              }}
              disabled={loading}
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: 4,
              padding: '12px 14px',
              borderRadius: 12,
              border: '1px solid #111',
              background: '#111',
              color: '#fff',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontWeight: 800,
            }}
          >
            {loading ? 'Entrando…' : 'Entrar'}
          </button>
        </form>

        {errorMsg ? (
          <div style={{ marginTop: 14, color: '#b00020' }}>
            Erro: {errorMsg}
          </div>
        ) : null}
      </div>
    </div>
  )
}
