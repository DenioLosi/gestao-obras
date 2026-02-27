import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { supabase } from '../../lib/supabase'

const STATUS_LABEL = {
  pending: 'pendente',
  in_progress: 'em andamento',
  done: 'concluída',
}

const STATUS_PT = {
  pending: 'Pendente',
  in_progress: 'Em andamento',
  done: 'Concluída',
}

function safeStr(v) {
  return (v ?? '').toString()
}

function clampPct(n) {
  const v = Number(n || 0)
  if (Number.isNaN(v)) return 0
  return Math.max(0, Math.min(100, v))
}

function formatPct(n) {
  const v = Number(n || 0)
  if (Number.isNaN(v)) return '0%'
  const s = v % 1 === 0 ? v.toFixed(0) : v.toFixed(2)
  return `${s}%`
}

function includesText(v, q) {
  return safeStr(v).toLowerCase().includes(q)
}

function makeIdentifier(floor, unitIndex, pad2) {
  const suffix = pad2 ? String(unitIndex).padStart(2, '0') : String(unitIndex)
  return `${floor}${suffix}`
}

export default function ObraDetalhePage() {
  const router = useRouter()
  const { id } = router.query

  const projectId = useMemo(() => {
    if (!id) return null
    if (Array.isArray(id)) return id[0] || null
    return String(id)
  }, [id])

  const [loading, setLoading] = useState(true)
  const [userEmail, setUserEmail] = useState('')

  const [project, setProject] = useState(null)
  const [units, setUnits] = useState([])

  // UI
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all') // all | pending | in_progress | done
  const [sortBy, setSortBy] = useState('identifier_asc') // identifier_asc | identifier_desc | progress_desc | progress_asc

  // ====== GERAR UNIDADES EM MASSA (por pavimento) ======
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)

  const [bulkFloorStart, setBulkFloorStart] = useState(3)
  const [bulkFloorEnd, setBulkFloorEnd] = useState(30)
  const [bulkUnitsPerFloor, setBulkUnitsPerFloor] = useState(4)
  const [bulkPad2Digits, setBulkPad2Digits] = useState(true)
  const [bulkCreateStages, setBulkCreateStages] = useState(true)

  async function ensureAuth() {
    const { data, error } = await supabase.auth.getUser()
    if (error || !data?.user) {
      window.location.href = '/login'
      return null
    }
    setUserEmail(data.user.email || '')
    return data.user
  }

  async function loadData() {
    if (!router.isReady) return
    if (!projectId) return

    setLoading(true)

    const u = await ensureAuth()
    if (!u) return

    // 1) Projeto
    const { data: p, error: pErr } = await supabase
      .from('projects')
      .select('id, name, description, client_name, city, address, created_at')
      .eq('id', projectId)
      .maybeSingle()

    if (pErr) {
      alert(`Erro ao carregar obra: ${pErr.message}`)
      setProject(null)
      setUnits([])
      setLoading(false)
      return
    }

    setProject(p || null)

    // 2) Unidades
    const { data: uRows, error: uErr } = await supabase
      .from('units')
      .select('id, project_id, identifier, status, progress, created_at')
      .eq('project_id', projectId)
      .order('identifier', { ascending: true })

    if (uErr) {
      alert(`Erro ao carregar unidades: ${uErr.message}`)
      setUnits([])
      setLoading(false)
      return
    }

    setUnits(Array.isArray(uRows) ? uRows : [])
    setLoading(false)
  }

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, projectId])

  const stats = useMemo(() => {
    const counts = { pending: 0, in_progress: 0, done: 0 }
    let sum = 0
    let total = 0

    for (const u of units) {
      const st = u.status || 'pending'
      if (counts[st] === undefined) counts[st] = 0
      counts[st] += 1
      sum += clampPct(u.progress)
      total += 1
    }

    const avg = total > 0 ? sum / total : 0
    return { counts, total, avg }
  }, [units])

  const filteredUnits = useMemo(() => {
    const q = search.trim().toLowerCase()

    let list = [...(units || [])]

    // filtro status
    if (statusFilter !== 'all') {
      list = list.filter((u) => (u.status || 'pending') === statusFilter)
    }

    // busca (por identifier)
    if (q) {
      list = list.filter((u) => includesText(u.identifier, q))
    }

    // ordenação
    list.sort((a, b) => {
      const ai = safeStr(a.identifier)
      const bi = safeStr(b.identifier)

      if (sortBy === 'identifier_asc') return ai.localeCompare(bi, 'pt-BR', { numeric: true })
      if (sortBy === 'identifier_desc') return bi.localeCompare(ai, 'pt-BR', { numeric: true })
      if (sortBy === 'progress_desc') return clampPct(b.progress) - clampPct(a.progress)
      if (sortBy === 'progress_asc') return clampPct(a.progress) - clampPct(b.progress)

      return ai.localeCompare(bi, 'pt-BR', { numeric: true })
    })

    return list
  }, [units, search, statusFilter, sortBy])

  async function deleteUnit(unitId, identifier) {
    const ok = window.confirm(
      `Excluir unidade ${identifier || ''}?\n\nATENÇÃO: se existirem etapas/fotos vinculadas, o banco pode bloquear (ou apagar junto, dependendo do seu schema).`
    )
    if (!ok) return

    const { error } = await supabase.from('units').delete().eq('id', unitId)
    if (error) {
      alert(`Erro ao excluir unidade: ${error.message}`)
      return
    }
    await loadData()
  }

  async function generateUnitsByFloor() {
    if (!projectId) {
      alert('Projeto não encontrado.')
      return
    }

    const start = Number(bulkFloorStart)
    const end = Number(bulkFloorEnd)
    const perFloor = Number(bulkUnitsPerFloor)

    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(perFloor)) {
      alert('Preencha os campos corretamente.')
      return
    }
    if (start <= 0 || end <= 0 || perFloor <= 0) {
      alert('Valores devem ser maiores que zero.')
      return
    }
    if (end < start) {
      alert('Pavimento final deve ser maior ou igual ao inicial.')
      return
    }
    if (perFloor > 50) {
      alert('Unidades por pavimento muito alto. Confere?')
      return
    }

    // gera identifiers
    const identifiers = []
    for (let f = start; f <= end; f++) {
      for (let i = 1; i <= perFloor; i++) {
        identifiers.push(makeIdentifier(f, i, bulkPad2Digits))
      }
    }

    // evita duplicar
    const existing = new Set((units || []).map((u) => safeStr(u?.identifier)))
    const toCreate = identifiers.filter((x) => !existing.has(x))

    if (toCreate.length === 0) {
      alert('Todas as unidades desse padrão já existem.')
      return
    }

    const ok = window.confirm(
      `Gerar ${toCreate.length} unidades?\n\nExemplo: ${toCreate.slice(0, 12).join(', ')}${toCreate.length > 12 ? '...' : ''}`
    )
    if (!ok) return

    try {
      setBulkBusy(true)

      // 1) inserir units (em lotes)
      const payloadUnits = toCreate.map((identifier) => ({
        project_id: projectId,
        identifier,
        status: 'pending',
        progress: 0,
      }))

      const created = []
      const BATCH = 200

      for (let i = 0; i < payloadUnits.length; i += BATCH) {
        const chunk = payloadUnits.slice(i, i + BATCH)
        const { data, error } = await supabase
          .from('units')
          .insert(chunk)
          .select('id, identifier')

        if (error) {
          alert(`Erro ao criar unidades: ${error.message}`)
          return
        }
        if (Array.isArray(data)) created.push(...data)
      }

      // 2) opcional: criar unit_stages
      if (bulkCreateStages && created.length > 0) {
        const { data: stagesData, error: stErr } = await supabase
          .from('stages')
          .select('id')
          .order('id', { ascending: true })

        if (stErr) {
          alert(`Unidades criadas, mas erro ao carregar etapas: ${stErr.message}`)
        } else {
          const stageIds = (stagesData || []).map((s) => s.id)
          if (stageIds.length > 0) {
            const rows = []
            for (const u of created) {
              for (const sid of stageIds) {
                rows.push({
                  unit_id: u.id,
                  stage_id: sid,
                  status: 'pending',
                  progress: 0,
                })
              }
            }

            const B2 = 500
            for (let i = 0; i < rows.length; i += B2) {
              const chunk = rows.slice(i, i + B2)
              const { error: usErr } = await supabase.from('unit_stages').insert(chunk)
              if (usErr) {
                alert(`Unidades criadas, mas erro ao criar etapas: ${usErr.message}`)
                break
              }
            }
          }
        }
      }

      alert(`Criadas ${created.length} unidades.`)
      setBulkOpen(false)
      await loadData()
    } finally {
      setBulkBusy(false)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h1 style={{ margin: 0 }}>Unidades da obra</h1>
          <Link href="/obras">← Voltar</Link>
        </div>
        <div style={{ marginTop: 12 }}>Carregando…</div>
      </div>
    )
  }

  if (!project) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h1 style={{ margin: 0 }}>Obra não encontrada</h1>
          <Link href="/obras">← Voltar</Link>
        </div>
      </div>
    )
  }

  const pct = Math.round(stats.avg)

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Obra</div>
          <h1 style={{ margin: 0 }}>{project.name || '(Sem nome)'}</h1>

          <div style={{ color: '#444', marginTop: 6 }}>
            Usuário logado: <b>{userEmail}</b>
          </div>

          {(project.client_name || project.city) && (
            <div style={{ marginTop: 10, color: '#444' }}>
              {project.client_name ? <b>{project.client_name}</b> : null}
              {project.client_name && project.city ? ' • ' : null}
              {project.city ? project.city : null}
            </div>
          )}

          {project.address ? <div style={{ marginTop: 4, color: '#666' }}>{project.address}</div> : null}

          {project.description ? <div style={{ marginTop: 8, color: '#777' }}>{project.description}</div> : null}
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => setBulkOpen(true)}
            style={{
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid #ddd',
              background: '#111',
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 800,
            }}
          >
            + Gerar unidades
          </button>

          <Link href="/obras">← Voltar</Link>
        </div>
      </div>

      <hr style={{ margin: '18px 0' }} />

      {/* Métricas */}
      <div style={{ maxWidth: 1100, display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#444' }}>
            <span>Progresso médio</span>
            <b>{formatPct(stats.avg)}</b>
          </div>

          <div style={{ height: 10, background: '#f0f0f0', borderRadius: 999, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: '#111', opacity: 0.12 }} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(140px, 1fr))', gap: 10 }}>
          <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 12, color: '#666' }}>total</div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>{stats.total}</div>
          </div>
          <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 12, color: '#666' }}>{STATUS_LABEL.pending}</div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>{stats.counts.pending || 0}</div>
          </div>
          <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 12, color: '#666' }}>{STATUS_LABEL.in_progress}</div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>{stats.counts.in_progress || 0}</div>
          </div>
          <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10 }}>
            <div style={{ fontSize: 12, color: '#666' }}>{STATUS_LABEL.done}</div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>{stats.counts.done || 0}</div>
          </div>
        </div>
      </div>

      {/* Filtros */}
      <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar unidade (ex: 401, 1203...)"
          style={{
            width: 'min(420px, 100%)',
            padding: '10px 12px',
            borderRadius: 12,
            border: '1px solid #ddd',
            outline: 'none',
          }}
        />

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{
            padding: '10px 12px',
            borderRadius: 12,
            border: '1px solid #ddd',
            background: '#fff',
            cursor: 'pointer',
            fontWeight: 700,
          }}
        >
          <option value="all">Todas</option>
          <option value="pending">Pendente</option>
          <option value="in_progress">Em andamento</option>
          <option value="done">Concluída</option>
        </select>

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
          <option value="identifier_asc">Identificador: A → Z</option>
          <option value="identifier_desc">Identificador: Z → A</option>
          <option value="progress_desc">Progresso: maior → menor</option>
          <option value="progress_asc">Progresso: menor → maior</option>
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
          Mostrando <b>{filteredUnits.length}</b> de <b>{units.length}</b>
        </div>
      </div>

      {/* Lista */}
      <div style={{ marginTop: 14, maxWidth: 1100, display: 'grid', gap: 10 }}>
        {filteredUnits.length === 0 ? (
          <div style={{ color: '#666', marginTop: 8 }}>Nenhuma unidade encontrada.</div>
        ) : (
          filteredUnits.map((u) => {
            const st = u.status || 'pending'
            return (
              <div
                key={u.id}
                style={{
                  background: '#fff',
                  border: '1px solid #eee',
                  borderRadius: 14,
                  padding: 14,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
                  display: 'grid',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 20, fontWeight: 900 }}>Unidade {u.identifier || u.id}</div>
                    <span
                      style={{
                        fontSize: 12,
                        padding: '6px 10px',
                        borderRadius: 999,
                        border: '1px solid #ddd',
                        background: '#fff',
                        fontWeight: 800,
                        whiteSpace: 'nowrap',
                      }}
                      title="Status"
                    >
                      {STATUS_PT[st] || '—'}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 12, color: '#444' }}>
                      Progresso: <b>{formatPct(u.progress || 0)}</b>
                    </div>

                    <Link href={`/unidades/${u.id}`} style={{ textDecoration: 'none' }}>
                      <button
                        style={{
                          padding: '10px 12px',
                          borderRadius: 12,
                          border: '1px solid #ddd',
                          background: '#111',
                          color: '#fff',
                          cursor: 'pointer',
                          fontWeight: 800,
                        }}
                      >
                        Abrir →
                      </button>
                    </Link>

                    <button
                      onClick={() => deleteUnit(u.id, u.identifier)}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 12,
                        border: '1px solid #ddd',
                        background: '#fff',
                        cursor: 'pointer',
                        color: '#b00020',
                        fontWeight: 900,
                      }}
                      title="Excluir unidade"
                    >
                      Excluir
                    </button>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* MODAL: Gerar unidades */}
      {bulkOpen ? (
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !bulkBusy) setBulkOpen(false)
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            zIndex: 1000,
          }}
        >
          <div
            style={{
              width: 'min(760px, 100%)',
              background: '#fff',
              borderRadius: 16,
              border: '1px solid #eee',
              boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
              padding: 16,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 18, fontWeight: 900 }}>Gerar unidades por pavimento</div>
              <button
                onClick={() => !bulkBusy && setBulkOpen(false)}
                style={{
                  border: '1px solid #ddd',
                  background: '#fff',
                  borderRadius: 12,
                  padding: '8px 10px',
                  cursor: bulkBusy ? 'not-allowed' : 'pointer',
                  fontWeight: 800,
                }}
                title="Fechar"
                disabled={bulkBusy}
              >
                ✕
              </button>
            </div>

            <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: '#444' }}>Pavimento inicial</div>
                  <input
                    type="number"
                    value={bulkFloorStart}
                    onChange={(e) => setBulkFloorStart(e.target.value)}
                    style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd' }}
                    disabled={bulkBusy}
                  />
                </div>

                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: '#444' }}>Pavimento final</div>
                  <input
                    type="number"
                    value={bulkFloorEnd}
                    onChange={(e) => setBulkFloorEnd(e.target.value)}
                    style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd' }}
                    disabled={bulkBusy}
                  />
                </div>

                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: '#444' }}>Unidades por pavimento</div>
                  <input
                    type="number"
                    value={bulkUnitsPerFloor}
                    onChange={(e) => setBulkUnitsPerFloor(e.target.value)}
                    style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd' }}
                    disabled={bulkBusy}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: bulkBusy ? 'not-allowed' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={bulkPad2Digits}
                    onChange={(e) => setBulkPad2Digits(e.target.checked)}
                    disabled={bulkBusy}
                  />
                  <span style={{ fontSize: 13, color: '#444' }}>
                    Usar 2 dígitos (01, 02...) → Ex: 3 + 01 = <b>301</b>
                  </span>
                </label>

                <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: bulkBusy ? 'not-allowed' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={bulkCreateStages}
                    onChange={(e) => setBulkCreateStages(e.target.checked)}
                    disabled={bulkBusy}
                  />
                  <span style={{ fontSize: 13, color: '#444' }}>Criar etapas automaticamente (unit_stages)</span>
                </label>
              </div>

              <div style={{ fontSize: 13, color: '#666' }}>
                Exemplo (primeiras):{' '}
                <b>
                  {(() => {
                    const start = Number(bulkFloorStart) || 0
                    const per = Number(bulkUnitsPerFloor) || 0
                    const ex = []
                    for (let i = 1; i <= Math.min(6, per); i++) ex.push(makeIdentifier(start, i, bulkPad2Digits))
                    return ex.join(', ')
                  })()}
                </b>
              </div>

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button
                  onClick={() => setBulkOpen(false)}
                  disabled={bulkBusy}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 12,
                    border: '1px solid #ddd',
                    background: '#fff',
                    cursor: bulkBusy ? 'not-allowed' : 'pointer',
                    fontWeight: 800,
                  }}
                >
                  Cancelar
                </button>

                <button
                  onClick={generateUnitsByFloor}
                  disabled={bulkBusy}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 12,
                    border: '1px solid #ddd',
                    background: '#111',
                    color: '#fff',
                    cursor: bulkBusy ? 'not-allowed' : 'pointer',
                    fontWeight: 900,
                  }}
                >
                  {bulkBusy ? 'Gerando…' : 'Gerar unidades'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
