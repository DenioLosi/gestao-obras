import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../../lib/supabase'

const ROLE_PT = {
  admin: 'Administrador',
  worker: 'Colaborador/Terceirizado',
  client: 'Cliente',
  collaborator: 'Colaborador',
  contractor: 'Terceirizado',
}

const STATUS_PT = {
  active: 'Ativo',
  disabled: 'Inativo',
  inactive: 'Inativo',
}

function safeStr(v) {
  return (v ?? '').toString()
}

function Modal({ open, title, children, onClose, busy = false }) {
  if (!open) return null
  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose?.()
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
          width: 'min(980px, 100%)',
          maxHeight: '92vh',
          background: '#fff',
          borderRadius: 16,
          border: '1px solid #eee',
          boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: 16,
            borderBottom: '1px solid #eee',
            display: 'flex',
            justifyContent: 'space-between',
            gap: 10,
            alignItems: 'center',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 900 }}>{title}</div>
          <button
            onClick={() => !busy && onClose?.()}
            style={{
              border: '1px solid #ddd',
              background: '#fff',
              borderRadius: 12,
              padding: '8px 10px',
              cursor: busy ? 'not-allowed' : 'pointer',
              fontWeight: 800,
            }}
            title="Fechar"
            disabled={busy}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            padding: 16,
            overflowY: 'auto',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}

export default function UsuariosPage() {
  const [loading, setLoading] = useState(true)
  const [me, setMe] = useState(null)
  const [users, setUsers] = useState([])
  const [projects, setProjects] = useState([])

  const [selectedUserId, setSelectedUserId] = useState(null)
  const selectedUser = useMemo(() => users.find((u) => u.id === selectedUserId) || null, [users, selectedUserId])

  const [memberProjectIds, setMemberProjectIds] = useState(new Set())
  const [busyAccess, setBusyAccess] = useState(false)

  const [roleDraft, setRoleDraft] = useState('worker')
  const [statusDraft, setStatusDraft] = useState('active')
  const [savingUser, setSavingUser] = useState(false)

  const [alertOpen, setAlertOpen] = useState(false)
  const [alertMsg, setAlertMsg] = useState('')

  // modal criar usuário
  const [createOpen, setCreateOpen] = useState(false)
  const [creatingUser, setCreatingUser] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createEmail, setCreateEmail] = useState('')
  const [createPassword, setCreatePassword] = useState('123456')
  const [createRole, setCreateRole] = useState('worker')
  const [createProjectIds, setCreateProjectIds] = useState(new Set())

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

    const { data: myProfile, error: pErr } = await supabase
      .from('profiles')
      .select('id, full_name, role, status, tenant_id, must_change_password')
      .eq('id', authData.user.id)
      .maybeSingle()

    if (pErr || !myProfile) {
      showAlert(`Erro ao carregar perfil: ${pErr?.message || 'perfil não encontrado'}`)
      setLoading(false)
      return
    }

    if (myProfile.role !== 'admin') {
      window.location.href = '/'
      return
    }

    setMe({ user: authData.user, profile: myProfile })

    const { data: tenantUsers, error: uErr } = await supabase
      .from('profiles')
      .select('id, full_name, role, status, tenant_id, created_at, must_change_password')
      .eq('tenant_id', myProfile.tenant_id)
      .order('created_at', { ascending: true })

    if (uErr) {
      showAlert(`Erro ao carregar usuários: ${uErr.message}`)
      setUsers([])
    } else {
      setUsers(Array.isArray(tenantUsers) ? tenantUsers : [])
    }

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
  }, [])

  useEffect(() => {
    if (!selectedUser) return
    setRoleDraft(selectedUser.role || 'worker')
    setStatusDraft(selectedUser.status || 'active')
    loadSelectedUserAccess(selectedUser.id)
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

  function openCreateModal() {
    setCreateName('')
    setCreateEmail('')
    setCreatePassword('123456')
    setCreateRole('worker')
    setCreateProjectIds(new Set())
    setCreateOpen(true)
  }

  function toggleCreateProject(projectId) {
    setCreateProjectIds((prev) => {
      const next = new Set(prev)
      const k = safeStr(projectId)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  function createMarkAll() {
    setCreateProjectIds(new Set(projects.map((p) => safeStr(p.id))))
  }

  function createUnmarkAll() {
    setCreateProjectIds(new Set())
  }

  async function createUser() {
    const name = safeStr(createName).trim()
    const email = safeStr(createEmail).trim().toLowerCase()
    const password = safeStr(createPassword)
    const role = safeStr(createRole)

    if (!name) return showAlert('Informe o nome do usuário.')
    if (!email) return showAlert('Informe o email do usuário.')
    if (!password || password.length < 6) return showAlert('A senha inicial deve ter pelo menos 6 caracteres.')
    if (!me?.profile?.tenant_id) return showAlert('Tenant do admin não encontrado.')

    setCreatingUser(true)
    try {
      const response = await fetch('/api/admin/create-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          email,
          password,
          role,
          tenant_id: me.profile.tenant_id,
          projects: [...createProjectIds],
        }),
      })

      const json = await response.json()

      if (!response.ok) {
        showAlert(json?.error || 'Erro ao criar usuário.')
        return
      }

      setCreateOpen(false)
      await loadMeAndTenantData()
      showAlert(
        `Usuário criado com sucesso.\n\nEmail: ${email}\nSenha inicial: ${password}\n\nNa primeira entrada ele será obrigado a alterar a senha.`
      )
    } catch (err) {
      showAlert(`Erro ao criar usuário: ${err.message}`)
    } finally {
      setCreatingUser(false)
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

          <button
            onClick={openCreateModal}
            style={{
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid #ddd',
              background: '#111',
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 900,
            }}
          >
            + Adicionar usuário
          </button>
        </div>
      </div>

      <hr style={{ margin: '18px 0' }} />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: 16, alignItems: 'start' }}>
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
                const label = u.full_name || u.id
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
                      <div style={{ fontWeight: 900, wordBreak: 'break-word' }}>{label}</div>
                      <div style={{ fontSize: 12, color: u.status === 'disabled' || u.status === 'inactive' ? '#b00020' : '#111', fontWeight: 900 }}>
                        {STATUS_PT[u.status] || u.status || '—'}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                      Role: <b>{ROLE_PT[u.role] || u.role || '—'}</b>
                    </div>
                    <div style={{ fontSize: 12, color: '#777', marginTop: 4 }}>
                      Troca de senha pendente: <b>{u.must_change_password ? 'sim' : 'não'}</b>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>

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
                Usuário: <b>{selectedUser.full_name || selectedUser.id}</b>
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
                    <option value="collaborator">Colaborador</option>
                    <option value="contractor">Terceirizado</option>
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
                    <option value="inactive">Inativo</option>
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
                  Dica: admin tem acesso total no tenant; os demais dependem das obras marcadas.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <Modal open={createOpen} title="Adicionar usuário" onClose={() => setCreateOpen(false)} busy={creatingUser}>
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Nome *</div>
              <input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="Nome do usuário"
                disabled={creatingUser}
                style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', outline: 'none' }}
              />
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Email *</div>
              <input
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                placeholder="email@exemplo.com"
                disabled={creatingUser}
                style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', outline: 'none' }}
              />
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Perfil *</div>
              <select
                value={createRole}
                onChange={(e) => setCreateRole(e.target.value)}
                disabled={creatingUser}
                style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', background: '#fff', fontWeight: 800 }}
              >
                <option value="admin">Administrador</option>
                <option value="worker">Colaborador/Terceirizado</option>
                <option value="client">Cliente</option>
                <option value="collaborator">Colaborador</option>
                <option value="contractor">Terceirizado</option>
              </select>
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Senha inicial *</div>
              <input
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
                placeholder="Senha inicial"
                disabled={creatingUser}
                style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', outline: 'none' }}
              />
            </div>
          </div>

          <hr style={{ margin: '4px 0' }} />

          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ fontWeight: 900 }}>Permissões de Obras</div>
            <div style={{ fontSize: 12, color: '#666' }}>
              Marque as obras que este usuário poderá acessar.
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                onClick={createMarkAll}
                disabled={creatingUser || projects.length === 0}
                style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', background: '#fff', cursor: creatingUser ? 'not-allowed' : 'pointer', fontWeight: 900 }}
              >
                Marcar todas
              </button>
              <button
                onClick={createUnmarkAll}
                disabled={creatingUser}
                style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', background: '#fff', cursor: creatingUser ? 'not-allowed' : 'pointer', fontWeight: 900 }}
              >
                Desmarcar todas
              </button>
            </div>

            {projects.length === 0 ? (
              <div style={{ color: '#666' }}>Nenhuma obra encontrada.</div>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {projects.map((p) => {
                  const checked = createProjectIds.has(safeStr(p.id))
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
                        cursor: creatingUser ? 'not-allowed' : 'pointer',
                        opacity: creatingUser ? 0.7 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleCreateProject(p.id)}
                        disabled={creatingUser}
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
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              onClick={() => setCreateOpen(false)}
              disabled={creatingUser}
              style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', background: '#fff', cursor: creatingUser ? 'not-allowed' : 'pointer', fontWeight: 900 }}
            >
              Cancelar
            </button>

            <button
              onClick={createUser}
              disabled={creatingUser}
              style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', background: '#111', color: '#fff', cursor: creatingUser ? 'not-allowed' : 'pointer', fontWeight: 900 }}
            >
              {creatingUser ? 'Criando…' : 'Criar usuário'}
            </button>
          </div>

          <div style={{ fontSize: 12, color: '#777' }}>
            Após o primeiro login, o usuário será obrigado a alterar a senha.
          </div>
        </div>
      </Modal>

      <Modal open={alertOpen} title="Aviso" onClose={() => setAlertOpen(false)}>
        <div style={{ color: '#333', whiteSpace: 'pre-wrap' }}>{alertMsg}</div>
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
