import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { supabase } from '../lib/supabase'

export default function Home() {
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState(null)
  const [authUser, setAuthUser] = useState(null)

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase.auth.getUser()
      const u = data?.user

      if (error || !u) {
        router.replace('/login')
        return
      }

      setAuthUser(u)

      const { data: p, error: pErr } = await supabase
        .from('profiles')
        .select('id, full_name, role, status, tenant_id')
        .eq('id', u.id)
        .maybeSingle()

      if (pErr) {
        console.error('Erro ao carregar profile:', pErr)
        // Se der erro, ainda deixa entrar na home com mínimo (Obras),
        // mas sem Gestão de Usuários.
        setProfile(null)
        setLoading(false)
        return
      }

      // Se estiver inativo, joga pro login
      if (p?.status && p.status !== 'active') {
        await supabase.auth.signOut()
        router.replace('/login')
        return
      }

      setProfile(p || null)
      setLoading(false)
    }

    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function signOut() {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) {
    return (
      <div style={styles.container}>
        <h1 style={styles.title}>Gestão de Obras</h1>
        <p style={styles.subtitle}>Carregando…</p>
      </div>
    )
  }

  const firstName = (profile?.full_name || authUser?.email || '').split(' ')[0]
  const isAdmin = profile?.role === 'admin'

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Gestão de Obras</h1>

      <p style={styles.subtitle}>
        Olá, <b>{firstName || 'usuário'}</b> 👋
      </p>

      <div style={styles.actionsRow}>
        <Link href="/obras" style={{ textDecoration: 'none' }}>
          <div style={styles.actionCard}>
            <div style={styles.actionTitle}>Obras</div>
            <div style={styles.actionDesc}>Acompanhar obras, unidades, etapas e fotos</div>
          </div>
        </Link>

        {isAdmin ? (
          <Link href="/usuarios" style={{ textDecoration: 'none' }}>
            <div style={styles.actionCard}>
              <div style={styles.actionTitle}>Gestão de Usuários</div>
              <div style={styles.actionDesc}>Cadastrar e controlar acessos por obra</div>
            </div>
          </Link>
        ) : null}
      </div>

      <div style={styles.card}>
        <h2 style={{ marginTop: 0 }}>Acesso</h2>
        <p style={{ margin: '6px 0' }}>
          Perfil: <b>{profile?.role || '—'}</b>
        </p>
        <p style={{ margin: '6px 0' }}>
          Status: <b>{profile?.status || '—'}</b>
        </p>

        <div style={{ marginTop: 14, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button onClick={signOut} style={styles.btnSecondary}>
            Sair
          </button>
        </div>
      </div>
    </div>
  )
}

const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#f5f7fa',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'Arial, sans-serif',
    padding: '20px',
  },
  title: {
    fontSize: '32px',
    fontWeight: 'bold',
    marginBottom: '10px',
  },
  subtitle: {
    fontSize: '16px',
    marginBottom: '18px',
    color: '#555',
    textAlign: 'center',
  },
  actionsRow: {
    display: 'flex',
    gap: 16,
    flexWrap: 'wrap',
    justifyContent: 'center',
    marginBottom: 18,
  },
  actionCard: {
    backgroundColor: '#ffffff',
    padding: '18px 18px',
    borderRadius: '12px',
    boxShadow: '0 10px 25px rgba(0,0,0,0.10)',
    textAlign: 'left',
    width: 320,
    border: '1px solid #eee',
    cursor: 'pointer',
  },
  actionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 6,
    color: '#111',
  },
  actionDesc: {
    fontSize: 13,
    color: '#555',
    lineHeight: 1.4,
  },
  card: {
    backgroundColor: '#ffffff',
    padding: '18px 20px',
    borderRadius: '12px',
    boxShadow: '0 10px 25px rgba(0,0,0,0.08)',
    textAlign: 'center',
    maxWidth: '520px',
    width: '100%',
    border: '1px solid #eee',
  },
  btnSecondary: {
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid #ddd',
    background: '#fff',
    cursor: 'pointer',
    fontWeight: 800,
  },
}
