import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../lib/supabase'

const STATUS_LABEL = {
  pending: 'pendente',
  in_progress: 'em andamento',
  done: 'concluída',
}

function normalize(str) {
  return (str || '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function formatPct(n) {
  const v = Number(n || 0)
  if (Number.isNaN(v)) return '0%'
  const s = v % 1 === 0 ? v.toFixed(0) : v.toFixed(2)
  return `${s}%`
}

export default function ObrasPage() {
  const [loading, setLoading] = useState(true)
  const [userEmail, setUserEmail] = useState('')
  const [projects, setProjects] = useState([])

  // Controles da tela (B)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all') // all | pending | in_progress | done
  const [progressFilter, setProgressFilter] = useState('all') // all | 0 | 1_99 | 100
  const [sortBy, setSortBy] = useState('unit_number_asc') // unit_number_asc | unit_number_desc | progress_desc | progress_asc | status

  async function loadData() {
    setLoading(true)

    // 1) Sessão / usuário
    const { data: authData, error: authErr } = await supabase.auth.getUser()
    if (authErr || !authData?.user) {
      window.location.href = '/login'
      return
    }
    setUserEmail(authData.user.email || '')

    // 2) Buscar obras (projects) + unidades (units)
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
          project_id,
          identifier,
          type,
          status,
          progress,
          created_at
        )
      `
      )
      .order('created_at', { ascending: true })

    if (error) {
      console.error('Erro ao carregar projects/units:', error)
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

  // 3) Aplicar filtros/busca/ordenação (client-side)
  const filteredProjects = useMemo(() => {
    const q = normalize(search)

    const matchesStatus = (u) => {
      if (statusFilter === 'all') return true
      return (u.status || '') === statusFilter
    }

    const matchesProgress = (u) => {
      const p = Number(u.progress || 0)
      if (progressFilter === 'all') return true
      if (progressFilter === '0') return p === 0
      if (progressFilter === '1_99') return p > 0 && p < 100
      if (progressFilter === '100') return p >= 100
      return true
    }

    const matchesSearch = (u) => {
      if (!q) return true
      const idf = normalize(u.identifier)
      const st = normalize(STATUS_LABEL[u.status] || u.status)
      return idf.includes(q) || st.includes(q)
    }

    const sortUnits = (units) => {
      const arr = [...units]

      const asNumberOrString = (v) => {
        const n = Number(v)
        return Number.isNaN(n) ? String(v || '') : n
      }

      if (sortBy === 'unit_number_asc') {
        arr.sort((a, b) => (asNumberOrString(a.identifier) > asNumberOrString(b.identifier) ? 1 : -1))
      } else if (sortBy === 'unit_number_desc') {
        arr.sort((a, b) => (asNumberOrString(a.identifier) < asNumberOrString(b.identifier) ? 1 : -1))
      } else if (sortBy === 'progress_desc') {
        arr.sort((a, b) => Number(b.progress || 0) - Number(a.progress || 0))
      } else if (sortBy === 'progress_asc') {
        arr.sort((a, b) => Number(a.progress || 0) - Number(b.progress || 0))
      } else if (sortBy === 'status') {
        const rank = { in_progress: 0, pending: 1, done: 2 }
        arr.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))
      }

      return arr
    }

    const result = []

    for (const p of projects) {
      const unitsFiltered = p.units.filter(matchesStatus).filter(matchesProgress).filter(matchesSearch)

      if (unitsFiltered.length > 0 || (!search && statusFilter === 'all' && progressFilter === 'all')) {
        result.push({
          ...p,
          units: sortUnits(unitsFiltered),
          __totalUnits: p.units.length,
        })
      }
    }

    return result
  }, [projects, search, statusFilter, progressFilter, sortBy])

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
      <div style={{ color: '#444', marginBottom: 16 }}>
        Usuário logado: <b>{userEmail}</b>
      </div>

      {/* Barra de controles (busca + filtros + ordenação) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 220px 220px 260px',
          gap: 12,
          alignItems: 'end',
          marginBottom: 18,
          maxWidth: 1100,
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: '#444', marginBottom: 6 }}>Buscar unidade</div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ex: 401, 502, pendente..."
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid #ddd',
              outline: 'none',
            }}
          />
        </div>

        <div>
          <div style={{ fontSize: 12, color: '#444', marginBottom: 6 }}>Status</div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid #ddd',
            }}
          >
            <option value="all">Todos</option>
            <option value="pending">Pendente</option>
            <option value="in_progress">Em andamento</option>
            <option value="done">Concluída</option>
          </select>
        </div>

        <div>
          <div style={{ fontSize: 12, color: '#444', marginBottom: 6 }}>Progresso</div>
          <select
            value={progressFilter}
            onChange={(e) => setProgressFilter(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid #ddd',
            }}
          >
            <option value="all">Todos</option>
            <option value="0">0%</option>
            <option value="1_99">1% a 99%</option>
            <option value="100">100%</option>
          </select>
        </div>

        <div>
          <div style={{ fontSize: 12, color: '#444', marginBottom: 6 }}>Ordenar unidades</div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid #ddd',
            }}
          >
            <option value="unit_number_asc">Número (crescente)</option>
            <option value="unit_number_desc">Número (decrescente)</option>
            <option value="progress_desc">Progresso (maior → menor)</option>
            <option value="progress_asc">Progresso (menor → maior)</option>
            <option value="status">Status (andamento → pendente → concluída)</option>
          </select>
        </div>
      </div>

      {/* Lista de obras */}
      {filteredProjects.length === 0 ? (
        <div style={{ marginTop: 18, color: '#444' }}>Nenhuma unidade encontrada com esses filtros.</div>
      ) : (
        <div style={{ display: 'grid', gap: 14, maxWidth: 900 }}>
          {filteredProjects.map((p) => {
            const shown = p.units.length
            const total = p.__totalUnits ?? p.units.length

            return (
              <div
                key={p.id}
                style={{
                  background: '#fff',
                  border: '1px solid #eee',
                  borderRadius: 14,
                  padding: 18,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
                }}
              >
                <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>{p.name || '(Sem nome)'}</div>

                <div style={{ color: '#666', fontSize: 13, marginBottom: 10 }}>
                  Unidades exibidas: <b>{shown}</b> / {total}
                </div>

                {p.units.length === 0 ? (
                  <div style={{ color: '#444' }}>(Sem unidades para exibir com os filtros atuais)</div>
                ) : (
                  <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
                    {p.units.map((u) => {
                      const pct = Number(u.progress || 0)
                      const icon = pct >= 100 ? '✅' : pct > 0 ? '🟡' : '⏳'

                      return (
                        <li
                          key={u.id}
                          style={{
                            lineHeight: 1.35,
                            display: 'flex',
                            gap: 10,
                            alignItems: 'center',
                            justifyContent: 'space-between',
                          }}
                        >
                          {/* Área clicável (texto) */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <Link
                              href={`/unidades/${u.id}`}
                              style={{
                                color: 'inherit',
                                textDecoration: 'none',
                              }}
                            >
                              <span
                                style={{
                                  fontWeight: 800,
                                  textDecoration: 'underline',
                                  cursor: 'pointer',
                                }}
                              >
                                {u.identifier}
                              </span>
                              {' — '}
                              status: <span>{STATUS_LABEL[u.status] || u.status || '—'}</span>
                              {' — '}
                              progresso: <b>{formatPct(u.progress)}</b> {icon}
                            </Link>
                          </div>

                          {/* Botão explícito (fica muito claro pro usuário) */}
                          <Link href={`/unidades/${u.id}`}>
                            <button
                              style={{
                                padding: '8px 10px',
                                borderRadius: 10,
                                border: '1px solid #ddd',
                                background: '#fff',
                                cursor: 'pointer',
                              }}
                            >
                              Abrir
                            </button>
                          </Link>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
