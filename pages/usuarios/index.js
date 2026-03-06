import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../../lib/supabase'

const ROLE_PT = {
  admin: 'Administrador',
  worker: 'Colaborador/Terceirizado',
  client: 'Cliente',
}

const STATUS_PT = {
  active: 'Ativo',
  disabled: 'Inativo',
}

function safeStr(v) {
  return (v ?? '').toString()
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
          width: 'min(960px, 100%)',
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

export default function UsuariosPage() {
  const [loading, setLoading] = useState(true)
  const [me, setMe] = useState(null) // { user, profile }
  const [users, setUsers] = useState([]) // profiles do tenant
  const [projects, setProjects] = useState([]) // obras do tenant

  const [selectedUserId, setSelectedUserId] = useState(null)
  const selectedUser = useMemo(() => users.find((u) => u.id === selectedUserId) || null, [users, selectedUserId])

  // acessos (checkbox)
  const [memberProjectIds, setMemberProjectIds] = useState(new Set()) // obras marcadas para o usuário selecionado
  const [busyAccess, setBusyAccess] = useState(false)

  // editar usuário
  const [roleDraft, setRoleDraft] = useState('worker')
  const [statusDraft, setStatusDraft] = useState('active')
  const [savingUser, setSavingUser] = useState(false)

  const [alertOpen, setAlertOpen] = useState(false)
  const [alertMsg, setAlertMsg] = useState('')

  function showAlert(msg) {
    setAlertMsg(msg)
    setAlertOpen(true)
  }

  async function loadMeAndTenantData() {
    setLoading(true)

    const { data: authData, error: authErr } = await supabase.auth.getUser()
    if (authErr || !authData?.user) {
      window.location.href = '/login'
      return
    }

    // meu profile (para checar role/tenant)
    const { data: myProfile, error: pErr } = await supabase
      .from('profiles')
      .select('id, email, role, status, tenant_id')
      .eq('id', authData.user.id)
      .maybeSingle()

    if (pErr || !myProfile) {
      showAlert(`Erro ao carregar perfil: ${pErr?.message || 'perfil não encontrado'}`)
      setLoading(false)
      return
    }

    // só admin entra
    if (myProfile.role !== 'admin') {
      window.location.href = '/'
      return
    }

    setMe({ user: authData.user, profile: myProfile })

    // usuários do tenant
    const { data: tenantUsers, error: uErr } = await supabase
      .from('profiles')
      .select('id, email, role, status, tenant_id, created_at')
      .eq('tenant_id', myProfile.tenant_id)
      .order('created_at', { ascending: true })

    if (uErr) {
      showAlert(`Erro ao carregar usuários: ${uErr.message}`)
      setUsers([])
    } else {
      setUsers(Array.isArray(tenantUsers) ? tenantUsers : [])
    }

    // obras do tenant
    const { data: prj, error: prjErr } = await supabase
      .from('projects')
      .select('id, name, client_name, city, address, created_at, tenant_id')
      .eq('tenant_id', myProfile.tenant_id)
      .order('created_at', { ascending: true })

    if (prjErr) {
      showAlert(`Erro ao carregar obras: ${prjErr.message}`)
      setProjects([])
    } else {
      setProjects(Array.isArray(prj) ? prj : [])
    }

    setLoading(false)
  }

  async function loadSelectedUserAccess(userId) {
    if (!userId) return
    setBusyAccess(true)
    try {
      const { data, error } = await supabase
        .from('project_members')
        .select('project_id, user_id')
        .eq('user_id', userId)
        .limit(1000000)

      if (error) {
        showAlert(`Erro ao carregar acessos do usuário: ${error.message}`)
        setMemberProjectIds(new Set())
        return
      }

      const s = new Set((data || []).map((r) => safeStr(r.project_id)))
      setMemberProjectIds(s)
    } finally {
      setBusyAccess(false)
    }
  }

  useEffect(() => {
    loadMeAndTenantData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // quando seleciona usuário, carrega role/status e acessos
  useEffect(() => {
    if (!selectedUser) return
    setRoleDraft(selectedUser.role || 'worker')
    setStatusDraft(selectedUser.status || 'active')
    loadSelectedUserAccess(selectedUser.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUserId])

  function toggleProject(projectId) {
    setMemberProjectIds((prev) => {
      const next = new Set(prev)
      const k = safeStr(projectId)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  function markAll() {
    setMemberProjectIds(new Set(projects.map((p) => safeStr(p.id))))
  }

  function unmarkAll() {
    setMemberProjectIds(new Set())
  }

  async function saveUserRoleAndStatus() {
    if (!selectedUser) return
    setSavingUser(true)
    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          role: roleDraft,
          status: statusDraft,
        })
        .eq('id', selectedUser.id)

      if (error) {
        showAlert(`Erro ao salvar usuário: ${error.message}`)
        return
      }

      await loadMeAndTenantData()
      showAlert('Usuário atualizado com sucesso.')
    } finally {
      setSavingUser(false)
    }
  }

  async function saveAccess() {
    if (!selectedUser) return
    setBusyAccess(true)
    try {
      // 1) ler acessos atuais
      const { data: existing, error: exErr } = await supabase
        .from('project_members')
        .select('project_id, user_id')
        .eq('user_id', selectedUser.id)
        .limit(1000000)

      if (exErr) {
        showAlert(`Erro ao ler acessos atuais: ${exErr.message}`)
        return
      }

      const oldSet = new Set((existing || []).map((r) => safeStr(r.project_id)))
      const newSet = new Set([...memberProjectIds].map((x) => safeStr(x)))

      const toAdd = [...newSet].filter((pid) => !oldSet.has(pid))
      const toRemove = [...oldSet].filter((pid) => !newSet.has(pid))

      // 2) adicionar
      if (toAdd.length > 0) {
        const rows = toAdd.map((pid) => ({
          project_id: pid,
          user_id: selectedUser.id,
        }))
        const { error: insErr } = await supabase.from('project_members').insert(rows)
        if (insErr) {
          showAlert(`Erro ao adicionar acessos: ${insErr.message}`)
          return
        }
      }

      // 3) remover
      if (toRemove.length > 0) {
        const { error: delErr } = await supabase
          .from('project_members')
          .delete()
          .eq('user_id', selectedUser.id)
          .in('project_id', toRemove)

        if (delErr) {
          showAlert(`Erro ao remover acessos: ${delErr.message}`)
          return
        }
      }

      showAlert('Acessos salvos com sucesso.')
      await loadSelectedUserAccess(selectedUser.id)
    } finally {
      setBusyAccess(false)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        <div>Carregando…</div>
      </div>
    )
  }

  const isAdmin = me?.profile?.role === 'admin'

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>{isAdmin ? 'Admin' : '—'}</div>
          <h1 style={{ margin: 0 }}>Gestão de Usuários</h1>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link href="/" style={{ textDecoration: 'none' }}>Home</Link>
          <Link href="/obras" style={{ textDecoration: 'none' }}>Obras</Link>
        </div>
      </div>

      <hr style={{ margin: '18px 0' }} />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: 16, alignItems: 'start' }}>
        {/* Lista usuários */}
        <div
          style={{
            border: '1px solid #eee',
            borderRadius: 16,
            padding: 14,
            background: '#fff',
            boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 6 }}>Usuários</div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
            Apenas admins veem esta tela. Usuários inativos não devem operar no sistema.
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            {users.length === 0 ? (
              <div style={{ color: '#666' }}>Nenhum usuário encontrado no tenant.</div>
            ) : (
              users.map((u) => {
                const selected = u.id === selectedUserId
                return (
                  <button
                    key={u.id}
                    onClick={() => setSelectedUserId(u.id)}
                    style={{
                      textAlign: 'left',
                      border: selected ? '2px solid #111' : '1px solid #eee',
                      background: '#fff',
                      borderRadius: 14,
                      padding: 12,
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                      <div style={{ fontWeight: 900, wordBreak: 'break-word' }}>{u.email || u.id}</div>
                      <div style={{ fontSize: 12, color: u.status === 'disabled' ? '#b00020' : '#111', fontWeight: 900 }}>
                        {STATUS_PT[u.status] || u.status || '—'}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                      Role: <b>{ROLE_PT[u.role] || u.role || '—'}</b>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>

        {/* Detalhes */}
        <div
          style={{
            border: '1px solid #eee',
            borderRadius: 16,
            padding: 14,
            background: '#fff',
            boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
            minHeight: 220,
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 6 }}>Detalhes e Acessos</div>

          {!selectedUser ? (
            <div style={{ color: '#666' }}>Selecione um usuário para gerenciar.</div>
          ) : (
            <div style={{ display: 'grid', gap: 14 }}>
              <div style={{ fontSize: 12, color: '#666' }}>
                Usuário: <b>{selectedUser.email || selectedUser.id}</b>
              </div>

              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Role</div>
                  <select
                    value={roleDraft}
                    onChange={(e) => setRoleDraft(e.target.value)}
                    disabled={savingUser}
                    style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', background: '#fff', fontWeight: 800 }}
                  >
                    <option value="admin">Administrador</option>
                    <option value="worker">Colaborador/Terceirizado</option>
                    <option value="client">Cliente</option>
                  </select>
                </div>

                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Status</div>
                  <select
                    value={statusDraft}
                    onChange={(e) => setStatusDraft(e.target.value)}
                    disabled={savingUser}
                    style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', background: '#fff', fontWeight: 800 }}
                  >
                    <option value="active">Ativo</option>
                    <option value="disabled">Inativo</option>
                  </select>
                </div>

                <button
                  onClick={saveUserRoleAndStatus}
                  disabled={savingUser}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 12,
                    border: '1px solid #ddd',
                    background: '#111',
                    color: '#fff',
                    cursor: savingUser ? 'not-allowed' : 'pointer',
                    fontWeight: 900,
                    height: 'fit-content',
                  }}
                >
                  {savingUser ? 'Salvando…' : 'Salvar usuário'}
                </button>
              </div>

              <hr style={{ margin: '6px 0' }} />

              <div style={{ display: 'grid', gap: 10 }}>
                <div style={{ fontWeight: 900 }}>Acesso às Obras</div>
                <div style={{ fontSize: 12, color: '#666' }}>
                  Marque quais obras este usuário pode acessar.
                </div>

                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    onClick={markAll}
                    disabled={busyAccess || projects.length === 0}
                    style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', background: '#fff', cursor: busyAccess ? 'not-allowed' : 'pointer', fontWeight: 900 }}
                  >
                    Marcar todas
                  </button>
                  <button
                    onClick={unmarkAll}
                    disabled={busyAccess}
                    style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', background: '#fff', cursor: busyAccess ? 'not-allowed' : 'pointer', fontWeight: 900 }}
                  >
                    Desmarcar todas
                  </button>
                  <button
                    onClick={saveAccess}
                    disabled={busyAccess}
                    style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', background: '#111', color: '#fff', cursor: busyAccess ? 'not-allowed' : 'pointer', fontWeight: 900 }}
                  >
                    {busyAccess ? 'Salvando…' : 'Salvar acessos'}
                  </button>
                </div>

                {projects.length === 0 ? (
                  <div style={{ color: '#666' }}>Nenhuma obra encontrada.</div>
                ) : (
                  <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
                    {projects.map((p) => {
                      const checked = memberProjectIds.has(safeStr(p.id))
                      return (
                        <label
                          key={p.id}
                          style={{
                            display: 'flex',
                            gap: 10,
                            alignItems: 'center',
                            border: '1px solid #eee',
                            borderRadius: 12,
                            padding: 10,
                            background: '#fff',
                            cursor: busyAccess ? 'not-allowed' : 'pointer',
                            opacity: busyAccess ? 0.7 : 1,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleProject(p.id)}
                            disabled={busyAccess}
                          />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {p.name || '(Sem nome)'}
                            </div>
                            <div style={{ fontSize: 12, color: '#666' }}>
                              {p.client_name ? <b>{p.client_name}</b> : null}
                              {p.client_name && p.city ? ' • ' : null}
                              {p.city || ''}
                              {p.address ? ` • ${p.address}` : ''}
                            </div>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}

                <div style={{ fontSize: 12, color: '#777', marginTop: 6 }}>
                  Dica: admin tem acesso total no tenant; worker/client dependem das obras marcadas.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <Modal open={alertOpen} title="Aviso" onClose={() => setAlertOpen(false)}>
        <div style={{ color: '#333' }}>{alertMsg}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button
            onClick={() => setAlertOpen(false)}
            style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', background: '#111', color: '#fff', cursor: 'pointer', fontWeight: 900 }}
          >
            OK
          </button>
        </div>
      </Modal>
    </div>
  )
}
