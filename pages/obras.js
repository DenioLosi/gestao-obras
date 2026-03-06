import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../lib/supabase'

const STATUS_LABEL = {
  pending: 'pendente',
  in_progress: 'em andamento',
  done: 'concluída',
}

function safeStr(v) {
  return (v ?? '').toString()
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
  return safeStr(v).toLowerCase().includes(q)
}

function getTime(v) {
  const t = v?.created_at ? new Date(v.created_at).getTime() : 0
  return Number.isNaN(t) ? 0 : t
}

function Modal({ open, title, children, onClose }) {
  if (!open) return null
  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.()
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
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 900 }}>{title}</div>
          <button
            onClick={onClose}
            style={{
              border: '1px solid #ddd',
              background: '#fff',
              borderRadius: 12,
              padding: '8px 10px',
              cursor: 'pointer',
              fontWeight: 800,
            }}
            title="Fechar"
          >
            ✕
          </button>
        </div>
        <div style={{ marginTop: 12 }}>{children}</div>
      </div>
    </div>
  )
}

export default function ObrasPainelPage() {
  const [loading, setLoading] = useState(true)
  const [userEmail, setUserEmail] = useState('')
  const [profile, setProfile] = useState(null)
  const [projects, setProjects] = useState([])

  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('progress_desc')

  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editProjectId, setEditProjectId] = useState(null)

  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formClientName, setFormClientName] = useState('')
  const [formCity, setFormCity] = useState('')
  const [formAddress, setFormAddress] = useState('')

  async function ensureAuth() {
    const { data: authData, error: authErr } = await supabase.auth.getUser()
    if (authErr || !authData?.user) {
      window.location.href = '/login'
      return null
    }
    setUserEmail(authData.user.email || '')
    return authData.user
  }

  async function loadProfile(user) {
    // IMPORTANTE: se der erro de RLS (stack depth), ele vai cair aqui.
    const { data, error } = await supabase
      .from('profiles')
      .select('id, role, status, tenant_id')
      .eq('id', user.id)
      .maybeSingle()

    if (error) {
      alert(`Erro ao carregar perfil: ${error.message}`)
      return null
    }
    setProfile(data || null)
    return data || null
  }

  async function loadProjectsByTenant(tenantId) {
    const { data, error } = await supabase
      .from('projects')
      .select(
        `
        id,
        tenant_id,
        name,
        description,
        client_name,
        city,
        address,
        created_at,
        units (
          id,
          identifier,
          status,
          progress
        )
      `
      )
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('Erro ao carregar projects:', error)
      alert(`Erro ao carregar obras: ${error.message}`)
      setProjects([])
      return
    }

    setProjects(
      (data || []).map((p) => ({
        ...p,
        units: Array.isArray(p.units) ? p.units : [],
      }))
    )
  }

  async function loadData() {
    setLoading(true)

    const user = await ensureAuth()
    if (!user) return

    const prof = await loadProfile(user)
    if (!prof?.tenant_id) {
      setProjects([])
      setLoading(false)
      return
    }

    await loadProjectsByTenant(prof.tenant_id)
    setLoading(false)
  }

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cards = useMemo(() => {
    return projects.map((p) => {
      const total = p.units.length
      const counts = { pending: 0, in_progress: 0, done: 0 }
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
        tenant_id: p.tenant_id,
        name: p.name || '(Sem nome)',
        description: p.description || '',
        client_name: p.client_name || '',
        city: p.city || '',
        address: p.address || '',
        created_at: p.created_at || null,
        totalUnits: total,
        avgProgress: avg,
        counts,
      }
    })
  }, [projects])

  const filteredCards = useMemo(() => {
    const q = search.trim().toLowerCase()

    let list = !q
      ? [...cards]
      : cards.filter((c) => {
          return (
            includesText(c?.name, q) ||
            includesText(c?.description, q) ||
            includesText(c?.client_name, q) ||
            includesText(c?.city, q) ||
            includesText(c?.address, q)
          )
        })

    list.sort((a, b) => {
      // 1) critério principal
      let d = 0
      if (sortBy === 'progress_desc') d = clampPct(b.avgProgress) - clampPct(a.avgProgress)
      else if (sortBy === 'progress_asc') d = clampPct(a.avgProgress) - clampPct(b.avgProgress)
      else if (sortBy === 'inprogress_desc') d = (b.counts?.in_progress || 0) - (a.counts?.in_progress || 0)
      else if (sortBy === 'pending_desc') d = (b.counts?.pending || 0) - (a.counts?.pending || 0)
      else if (sortBy === 'newest') d = getTime(b) - getTime(a)
      else if (sortBy === 'oldest') d = getTime(a) - getTime(b)
      else if (sortBy === 'name_asc') d = safeStr(a?.name).localeCompare(safeStr(b?.name), 'pt-BR')

      // 2) desempate por nome
      if (d !== 0) return d
      return safeStr(a?.name).localeCompare(safeStr(b?.name), 'pt-BR')
    })

    return list
  }, [cards, search, sortBy])

  function openCreateModal() {
    setEditProjectId(null)
    setFormName('')
    setFormDescription('')
    setFormClientName('')
    setFormCity('')
    setFormAddress('')
    setModalOpen(true)
  }

  function openEditModal(card) {
    setEditProjectId(card.id)
    setFormName(card.name === '(Sem nome)' ? '' : safeStr(card.name))
    setFormDescription(safeStr(card.description))
    setFormClientName(safeStr(card.client_name))
    setFormCity(safeStr(card.city))
    setFormAddress(safeStr(card.address))
    setModalOpen(true)
  }

  function closeModal() {
    if (saving) return
    setModalOpen(false)
  }

  async function saveProject() {
    const name = safeStr(formName).trim()
    const description = safeStr(formDescription).trim()
    const client_name = safeStr(formClientName).trim()
    const city = safeStr(formCity).trim()
    const address = safeStr(formAddress).trim()

    if (!name) return alert('Informe o nome da obra.')
    if (!client_name) return alert('Informe o cliente.')
    if (!profile?.tenant_id) return alert('Seu perfil não tem tenant_id.')

    try {
      setSaving(true)

      const payload = { name, description, client_name, city, address, tenant_id: profile.tenant_id }

      if (editProjectId) {
        const { error } = await supabase.from('projects').update(payload).eq('id', editProjectId)
        if (error) return alert(`Erro ao editar obra: ${error.message}`)
      } else {
        const { error } = await supabase.from('projects').insert(payload)
        if (error) return alert(`Erro ao criar obra: ${error.message}`)
      }

      setModalOpen(false)
      await loadData()
    } finally {
      setSaving(false)
    }
  }

  async function deleteProject(card) {
    // admin-only (UI): se quiser, eu travo aqui também
    const ok = window.confirm(`Excluir a obra "${card.name}"?`)
    if (!ok) return

    try {
      setSaving(true)
      const { error } = await supabase.from('projects').delete().eq('id', card.id)
      if (error) return alert(`Erro ao excluir obra: ${error.message}`)
      await loadData()
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h1 style={{ marginBottom: 8 }}>Obras</h1>
          <Link href="/">← Home</Link>
        </div>
        <div>Carregando…</div>
      </div>
    )
  }

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ marginBottom: 10 }}>
            <Link href="/" style={{ textDecoration: 'none' }}>← Home</Link>
          </div>

          <h1 style={{ marginBottom: 6 }}>Obras</h1>

          <div style={{ color: '#444', marginBottom: 6 }}>
            Usuário logado: <b>{userEmail}</b>
          </div>

          <div style={{ color: '#666', fontSize: 12 }}>
            Perfil: <b>{profile?.role || '—'}</b> • Status: <b>{profile?.status || '—'}</b>
          </div>
        </div>

        <button
          onClick={openCreateModal}
          style={{
            padding: '10px 12px',
            borderRadius: 12,
            border: '1px solid #ddd',
            background: '#111',
            color: '#fff',
            cursor: 'pointer',
            fontWeight: 800,
            height: 'fit-content',
          }}
        >
          + Nova obra
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 14, marginBottom: 18 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por obra, cliente, cidade, endereço..."
          style={{
            width: 'min(620px, 100%)',
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
          <option value="inprogress_desc">Em andamento primeiro</option>
          <option value="pending_desc">Mais pendências primeiro</option>
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
        <div style={{ marginTop: 18, color: '#444' }}>Nenhuma obra cadastrada (ou sem permissão no tenant).</div>
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

                    {c.client_name || c.city ? (
                      <div style={{ color: '#444', fontSize: 13, lineHeight: 1.35 }}>
                        {c.client_name ? <b>{c.client_name}</b> : null}
                        {c.client_name && c.city ? ' • ' : null}
                        {c.city ? c.city : null}
                      </div>
                    ) : null}

                    {c.address ? <div style={{ color: '#666', fontSize: 13, lineHeight: 1.35 }}>{c.address}</div> : null}

                    {c.description ? (
                      <div style={{ color: '#777', fontSize: 13, lineHeight: 1.35, marginTop: 4 }}>{c.description}</div>
                    ) : null}
                  </div>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
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

                    <button
                      onClick={() => openEditModal(c)}
                      style={{
                        padding: '6px 10px',
                        borderRadius: 12,
                        border: '1px solid #ddd',
                        background: '#fff',
                        cursor: 'pointer',
                        fontWeight: 800,
                        height: 'fit-content',
                      }}
                      title="Editar obra"
                    >
                      ⚙️
                    </button>
                  </div>
                </div>

                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#444' }}>
                    <span>Progresso médio</span>
                    <b>{formatPct(c.avgProgress)}</b>
                  </div>

                  <div style={{ height: 10, background: '#f0f0f0', borderRadius: 999, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: '#111', opacity: 0.12 }} />
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 4 }}>
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

                  <button
                    onClick={() => deleteProject(c)}
                    disabled={saving}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 12,
                      border: '1px solid #ddd',
                      background: '#fff',
                      cursor: saving ? 'not-allowed' : 'pointer',
                      color: '#b00020',
                      fontWeight: 800,
                    }}
                    title="Excluir obra (admin)"
                  >
                    Excluir
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal open={modalOpen} title={editProjectId ? 'Editar obra' : 'Nova obra'} onClose={() => !saving && closeModal()}>
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 12, color: '#444', fontWeight: 800 }}>Nome da obra *</div>
            <input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="Ex: Edifício Solar / Residencial X"
              style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', outline: 'none' }}
              disabled={saving}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, color: '#444', fontWeight: 800 }}>Cliente *</div>
              <input
                value={formClientName}
                onChange={(e) => setFormClientName(e.target.value)}
                placeholder="Ex: Cliente XPTO"
                style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', outline: 'none' }}
                disabled={saving}
              />
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, color: '#444', fontWeight: 800 }}>Cidade</div>
              <input
                value={formCity}
                onChange={(e) => setFormCity(e.target.value)}
                placeholder="Ex: Goiânia"
                style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', outline: 'none' }}
                disabled={saving}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 12, color: '#444', fontWeight: 800 }}>Endereço</div>
            <input
              value={formAddress}
              onChange={(e) => setFormAddress(e.target.value)}
              placeholder="Ex: Rua X, Qd Y, Lt Z - Setor..."
              style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', outline: 'none' }}
              disabled={saving}
            />
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 12, color: '#444', fontWeight: 800 }}>Descrição</div>
            <textarea
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder="Ex: 93 piscinas • torre A e B • prazo 90 dias"
              style={{
                minHeight: 110,
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                outline: 'none',
                resize: 'vertical',
              }}
              disabled={saving}
            />
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 6 }}>
            <button
              onClick={closeModal}
              disabled={saving}
              style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', background: '#fff', cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 800 }}
            >
              Cancelar
            </button>

            <button
              onClick={saveProject}
              disabled={saving}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#111',
                color: '#fff',
                cursor: saving ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              {saving ? 'Salvando…' : editProjectId ? 'Salvar alterações' : 'Criar obra'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
