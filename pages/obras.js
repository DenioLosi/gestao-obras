import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../lib/supabase'

const STATUS_LABEL = {
  pending: 'pendente',
  in_progress: 'em andamento',
  done: 'concluída',
}

function formatPct(n) {
  const v = Number(n || 0)
  if (Number.isNaN(v)) return '0%'
  const s = v % 1 === 0 ? v.toFixed(0) : v.toFixed(2)
  return `${s}%`
}

function clampPct(n) {
  const v = Number(n || 0)
  if (Number.isNaN(v)) return 0
  return Math.max(0, Math.min(100, v))
}

function includesText(v, q) {
  return (v ?? '').toString().toLowerCase().includes(q)
}

export default function ObrasPainelPage() {
  const [loading, setLoading] = useState(true)
  const [userEmail, setUserEmail] = useState('')
  const [projects, setProjects] = useState([])

  // ✅ busca
  const [search, setSearch] = useState('')

  // ✅ ordenação
  // progress_desc | progress_asc | newest | oldest | name_asc
  const [sortBy, setSortBy] = useState('progress_desc')

  async function loadData() {
    setLoading(true)

    // 1) Sessão / usuário
    const { data: authData, error: authErr } = await supabase.auth.getUser()
    if (authErr || !authData?.user) {
      window.location.href = '/login'
      return
    }
    setUserEmail(authData.user.email || '')

    // 2) Buscar obras + unidades (para métricas do card)
    const { data, error } = await supabase
      .from('projects')
      .select(
        `
        id,
        name,
        description,
        created_at,
        units (
          id,
          identifier,
          status,
          progress
        )
      `
      )
      .order('created_at', { ascending: true })

    if (error) {
      console.error('Erro ao carregar projects:', error)
      setProjects([])
      setLoading(false)
      return
    }

    const normalized = (data || []).map((p) => ({
      ...p,
      units: Array.isArray(p.units) ? p.units : [],
    }))

    setProjects(normalized)
    setLoading(false)
  }

  useEffect(() => {
    loadData()
  }, [])

  // ✅ cards (com created_at pra ordenação por recência)
  const cards = useMemo(() => {
    return projects.map((p) => {
      const total = p.units.length

      const counts = {
        pending: 0,
        in_progress: 0,
        done: 0,
      }

      let sumProgress = 0

      for (const u of p.units) {
        const st = u.status || 'pending'
        if (counts[st] === undefined) counts[st] = 0
        counts[st] += 1

        sumProgress += clampPct(u.progress)
      }

      const avg = total > 0 ? sumProgress / total : 0

      return {
        id: p.id,
        name: p.name || '(Sem nome)',
        description: p.description || '',
        created_at: p.created_at || null,

        // ✅ campos futuros (se você criar depois, já funciona na busca)
        client_name: p.client_name || '',
        city: p.city || '',

        totalUnits: total,
        avgProgress: avg,
        counts,
      }
    })
  }, [projects])

  // ✅ filtra + ordena
  const filteredCards = useMemo(() => {
    const q = search.trim().toLowerCase()

    // 1) filtra
    let list = !q
      ? [...cards]
      : (cards || []).filter((c) => {
          return (
            includesText(c?.name, q) ||
            includesText(c?.description, q) ||
            includesText(c?.client_name, q) ||
            includesText(c?.city, q)
          )
        })

    // 2) ordena
    const getTime = (v) => {
      const t = v?.created_at ? new Date(v.created_at).getTime() : 0
      return Number.isNaN(t) ? 0 : t
    }

    list.sort((a, b) => {
      if (sortBy === 'progress_desc') {
        return clampPct(b.avgProgress) - clampPct(a.avgProgress)
      }
      if (sortBy === 'progress_asc') {
        return clampPct(a.avgProgress) - clampPct(b.avgProgress)
      }
      if (sortBy === 'newest') {
        return getTime(b) - getTime(a)
      }
      if (sortBy === 'oldest') {
        return getTime(a) - getTime(b)
      }
      if (sortBy === 'name_asc') {
        return safeStr(a?.name).localeCompare(safeStr(b?.name))
      }
      return 0
    })

    return list
  }, [cards, search, sortBy])

  function safeStr(v) {
    return (v ?? '').toString()
  }

  if (loading) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        <h1 style={{ marginBottom: 8 }}>Obras</h1>
        <div>Carregando…</div>
      </div>
    )
  }

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      <h1 style={{ marginBottom: 6 }}>Obras</h1>
      <div style={{ color: '#444', marginBottom: 12 }}>
        Usuário logado: <b>{userEmail}</b>
      </div>

      {/* ✅ BUSCA + ORDENAÇÃO */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 18 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por obra, cliente, cidade..."
          style={{
            width: 'min(520px, 100%)',
            padding: '10px 12px',
            borderRadius: 12,
            border: '1px solid #ddd',
            outline: 'none',
          }}
        />

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          style={{
            padding: '10px 12px',
            borderRadius: 12,
            border: '1px solid #ddd',
            background: '#fff',
            cursor: 'pointer',
            fontWeight: 700,
          }}
          title="Ordenar"
        >
          <option value="progress_desc">Progresso: maior → menor</option>
          <option value="progress_asc">Progresso: menor → maior</option>
          <option value="newest">Mais recentes</option>
          <option value="oldest">Mais antigas</option>
          <option value="name_asc">Nome: A → Z</option>
        </select>

        {search ? (
          <button
            onClick={() => setSearch('')}
            style={{
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid #ddd',
              background: '#fff',
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            Limpar
          </button>
        ) : null}

        <div style={{ fontSize: 12, color: '#666' }}>
          Mostrando <b>{filteredCards.length}</b> de <b>{cards.length}</b>
        </div>
      </div>

      {cards.length === 0 ? (
        <div style={{ marginTop: 18, color: '#444' }}>Nenhuma obra cadastrada.</div>
      ) : filteredCards.length === 0 ? (
        <div style={{ marginTop: 18, color: '#444' }}>
          Nenhuma obra encontrada para: <b>{search}</b>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 14,
            maxWidth: 1100,
          }}
        >
          {filteredCards.map((c) => {
            const pct = Math.round(c.avgProgress)

            return (
              <div
                key={c.id}
                style={{
                  background: '#fff',
                  border: '1px solid #eee',
                  borderRadius: 14,
                  padding: 18,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
                  display: 'grid',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>{c.name}</div>
                    {c.description ? (
                      <div style={{ color: '#666', fontSize: 13, lineHeight: 1.35 }}>{c.description}</div>
                    ) : null}
                  </div>

                  <div
                    style={{
                      fontSize: 12,
                      padding: '6px 10px',
                      borderRadius: 999,
                      border: '1px solid #ddd',
                      height: 'fit-content',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.totalUnits} unidades
                  </div>
                </div>

                {/* Progresso médio */}
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#444' }}>
                    <span>Progresso médio</span>
                    <b>{formatPct(c.avgProgress)}</b>
                  </div>

                  <div style={{ height: 10, background: '#f0f0f0', borderRadius: 999, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: '#111',
                        opacity: 0.12,
                      }}
                    />
                  </div>
                </div>

                {/* Contadores */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: 10,
                    marginTop: 4,
                  }}
                >
                  <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10 }}>
                    <div style={{ fontSize: 12, color: '#666' }}>{STATUS_LABEL.pending}</div>
                    <div style={{ fontSize: 18, fontWeight: 800 }}>{c.counts.pending || 0}</div>
                  </div>

                  <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10 }}>
                    <div style={{ fontSize: 12, color: '#666' }}>{STATUS_LABEL.in_progress}</div>
                    <div style={{ fontSize: 18, fontWeight: 800 }}>{c.counts.in_progress || 0}</div>
                  </div>

                  <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10 }}>
                    <div style={{ fontSize: 12, color: '#666' }}>{STATUS_LABEL.done}</div>
                    <div style={{ fontSize: 18, fontWeight: 800 }}>{c.counts.done || 0}</div>
                  </div>
                </div>

                {/* Ações */}
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
                  <Link href={`/obras/${c.id}`} style={{ textDecoration: 'none' }}>
                    <button
                      style={{
                        padding: '10px 12px',
                        borderRadius: 12,
                        border: '1px solid #ddd',
                        background: '#111',
                        color: '#fff',
                        cursor: 'pointer',
                        fontWeight: 700,
                      }}
                    >
                      Acessar unidades →
                    </button>
                  </Link>

                  <Link href={`/obras/${c.id}/estoque`} style={{ textDecoration: 'none' }}>
                    <button
                      style={{
                        padding: '10px 12px',
                        borderRadius: 12,
                        border: '1px solid #ddd',
                        background: '#fff',
                        cursor: 'pointer',
                      }}
                      title="Em breve"
                    >
                      Estoque
                    </button>
                  </Link>

                  <Link href={`/obras/${c.id}/relatorios`} style={{ textDecoration: 'none' }}>
                    <button
                      style={{
                        padding: '10px 12px',
                        borderRadius: 12,
                        border: '1px solid #ddd',
                        background: '#fff',
                        cursor: 'pointer',
                      }}
                      title="Em breve"
                    >
                      Relatórios
                    </button>
                  </Link>
                </div>

                <div style={{ fontSize: 12, color: '#777' }}>
                  Dica: clique em <b>Acessar unidades</b> para usar filtros por status e progresso.
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
