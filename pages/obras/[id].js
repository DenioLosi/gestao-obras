import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { supabase } from '../../lib/supabase'

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

function UnitRow({ u }) {
  const [hover, setHover] = useState(false)

  const pct = Number(u.progress || 0)
  const icon = pct >= 100 ? '✅' : pct > 0 ? '🟡' : '⏳'

  return (
    <li
      style={{ lineHeight: 1.35, listStyle: 'none' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px',
          borderRadius: 12,
          border: hover ? '1px solid #d6d6d6' : '1px solid transparent',
          background: hover ? 'rgba(0,0,0,0.03)' : 'transparent',
          transition: 'all 120ms ease',
        }}
      >
        <Link
          href={`/unidades/${u.id}`}
          style={{
            color: 'inherit',
            textDecoration: 'none',
            flex: 1,
            minWidth: 0,
            display: 'block',
          }}
        >
          <span style={{ fontWeight: 800, textDecoration: 'underline' }}>{u.identifier}</span>
          {' — '}
          status: <span>{STATUS_LABEL[u.status] || u.status || '—'}</span>
          {' — '}
          progresso: <b>{formatPct(u.progress)}</b> {icon}
        </Link>

        <Link href={`/unidades/${u.id}`}>
          <button
            style={{
              padding: '8px 10px',
              borderRadius: 10,
              border: hover ? '1px solid #cfcfcf' : '1px solid #ddd',
              background: '#fff',
              cursor: 'pointer',
              boxShadow: hover ? '0 2px 10px rgba(0,0,0,0.06)' : 'none',
              transition: 'all 120ms ease',
              whiteSpace: 'nowrap',
            }}
          >
            Abrir
          </button>
        </Link>
      </div>
    </li>
  )
}

export default function ObraDetalhePage() {
  const router = useRouter()
  const { id } = router.query

  const [loading, setLoading] = useState(true)
  const [userEmail, setUserEmail] = useState('')
  const [project, setProject] = useState(null)
  const [units, setUnits] = useState([])

  // Controles
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [progressFilter, setProgressFilter] = useState('all')
  const [sortBy, setSortBy] = useState('unit_number_asc')

  const projectId = useMemo(() => {
    if (!id) return null
    if (Array.isArray(id)) return id[0] || null
    return String(id)
  }, [id])

  async function loadData() {
    if (!router.isReady) return
    if (!projectId) return

    setLoading(true)

    const { data: authData, error: authErr } = await supabase.auth.getUser()
    if (authErr || !authData?.user) {
      window.location.href = '/login'
      return
    }
    setUserEmail(authData.user.email || '')

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
      .eq('id', projectId)
      .maybeSingle()

    if (error) {
      console.error('Erro ao carregar obra:', error)
      setProject(null)
      setUnits([])
      setLoading(false)
      return
    }

    setProject(data || null)
    setUnits(Array.isArray(data?.units) ? data.units : [])
    setLoading(false)
  }

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, projectId])

  const filteredUnits = useMemo(() => {
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

    const sortUnits = (arr) => {
      const out = [...arr]
      const asNumberOrString = (v) => {
        const n = Number(v)
        return Number.isNaN(n) ? String(v || '') : n
      }

      if (sortBy === 'unit_number_asc') {
        out.sort((a, b) => (asNumberOrString(a.identifier) > asNumberOrString(b.identifier) ? 1 : -1))
      } else if (sortBy === 'unit_number_desc') {
        out.sort((a, b) => (asNumberOrString(a.identifier) < asNumberOrString(b.identifier) ? 1 : -1))
      } else if (sortBy === 'progress_desc') {
        out.sort((a, b) => Number(b.progress || 0) - Number(a.progress || 0))
      } else if (sortBy === 'progress_asc') {
        out.sort((a, b) => Number(a.progress || 0) - Number(b.progress || 0))
      } else if (sortBy === 'status') {
        const rank = { in_progress: 0, pending: 1, done: 2 }
        out.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))
      }
      return out
    }

    return sortUnits(units.filter(matchesStatus).filter(matchesProgress).filter(matchesSearch))
  }, [units, search, statusFilter, progressFilter, sortBy])

  if (loading) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        <h1 style={{ marginBottom: 8 }}>Obra</h1>
        <div>Carregando…</div>
      </div>
    )
  }

  if (!project) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        <h1 style={{ marginBottom: 8 }}>Obra</h1>
        <div style={{ marginBottom: 12, color: '#444' }}>Obra não encontrada.</div>
        <Link href="/obras">← Voltar ao painel</Link>
      </div>
    )
  }

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h1 style={{ marginBottom: 6 }}>{project.name || '(Sem nome)'}</h1>
          <div style={{ color: '#444', marginBottom: 10 }}>
            Usuário logado: <b>{userEmail}</b>
          </div>
        </div>
        <Link href="/obras">← Voltar ao painel</Link>
      </div>

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

      <div
        style={{
          background: '#fff',
          border: '1px solid #eee',
          borderRadius: 14,
          padding: 18,
          boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
          maxWidth: 900,
        }}
      >
        <div style={{ color: '#666', fontSize: 13, marginBottom: 10 }}>
          Unidades exibidas: <b>{filteredUnits.length}</b> / {units.length}
        </div>

        {filteredUnits.length === 0 ? (
          <div style={{ marginTop: 12, color: '#444' }}>Nenhuma unidade encontrada com esses filtros.</div>
        ) : (
          <ul style={{ margin: 0, padding: 0, display: 'grid', gap: 6 }}>
            {filteredUnits.map((u) => (
              <UnitRow key={u.id} u={u} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
