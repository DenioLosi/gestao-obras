import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { supabase } from '../../lib/supabase'

const ROLE_LABEL = {
  admin: 'Administrador',
  collaborator: 'Colaborador',
  contractor: 'Terceirizado',
  client: 'Cliente',
}

const STATUS_LABEL = {
  active: 'Ativo',
  inactive: 'Inativo',
}

function safeStr(v) {
  return (v ?? '').toString()
}

function defaultPermissionForRole(role) {
  if (role === 'admin') return 'admin'
  if (role === 'client') return 'view'
  return 'work' // collaborator/contractor
}

export default function UsuariosPage() {
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [me, setMe] = useState(null) // { id, role, tenant_id }
  const [users, setUsers] = useState([]) // profiles do tenant
  const [projects, setProjects] = useState([]) // obras do tenant (via RLS)
  const [selectedUserId, setSelectedUserId] = useState(null)

  const [membershipsByProjectId, setMembershipsByProjectId] = useState({}) // project_id -> { id, permission }
  const [busy, setBusy] = useState(false)

  const selectedUser = useMemo(() => users.find((u) => u.id === selectedUserId) || null, [users, selectedUserId])

  async function ensureAdmin() {
    const { data } = await supabase.auth.getUser()
    const u = data?.user
    if (!u) {
      router.replace('/login')
      return null
    }

    const { data: p, error: pErr } = await supabase
      .from('profiles')
      .select('id, full_name, role, status, tenant_id')
      .eq('id', u.id)
      .maybeSingle()

    if (pErr || !p) {
      router.replace('/login')
      return null
    }

    if (p.status !== 'active') {
      await supabase.auth.signOut()
      router.replace('/login')
      return null
    }

    if (p.role !== 'admin') {
      router.replace('/')
      return null
    }

    setMe(p)
    return p
  }

  async function loadUsersAndProjects(adminProfile) {
    // usuários do tenant
    const { data: people, error: e1 } = await supabase
      .from('profiles')
      .select('id, full_name, phone, role, status, tenant_id, created_at')
      .eq('tenant_id', adminProfile.tenant_id)
      .order('created_at', { ascending: false })

    if (e1) {
      alert(`Erro ao carregar usuários: ${e1.message}`)
      setUsers([])
    } else {
      setUsers(Array.isArray(people) ? people : [])
    }

    // obras (RLS já limita ao tenant)
    const { data: projs, error: e2 } = await supabase
      .from('projects')
      .select('id, name, city, client_name, tenant_id')
      .order('created_at', { ascending: false })

    if (e2) {
      alert(`Erro ao carregar obras: ${e2.message}`)
      setProjects([])
    } else {
      setProjects(Array.isArray(projs) ? projs : [])
    }
  }

  async function loadMembershipsForUser(userId) {
    setMembershipsByProjectId({})
    if (!userId) return

    const { data, error } = await supabase
      .from('project_members')
      .select('id, project_id, user_id, permission')
      .eq('user_id', userId)

    if (error) {
      alert(`Erro ao carregar acessos do usuário: ${error.message}`)
      return
    }

    const map = {}
    for (const row of data || []) {
      map[row.project_id] = { id: row.id, permission: row.permission }
    }
    setMembershipsByProjectId(map)
  }

  async function hydrateAll() {
    setLoading(true)
    const adminProfile = await ensureAdmin()
    if (!adminProfile) return

    await loadUsersAndProjects(adminProfile)
    setLoading(false)
  }

  useEffect(() => {
    hydrateAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selectedUserId) return
    loadMembershipsForUser(selectedUserId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUserId])

  async function updateUserRole(userId, role) {
    setBusy(true)
    try {
      const { error } = await supabase.from('profiles').update({ role }).eq('id', userId)
      if (error) {
        alert(`Erro ao salvar role: ${error.message}`)
        return
      }

      // opcional: se quiser “ajustar” automaticamente a permission das obras existentes,
      // você pode atualizar project_members.permission aqui.
      await hydrateAll()
      setSelectedUserId(userId)
      await loadMembershipsForUser(userId)
    } finally {
      setBusy(false)
    }
  }

  async function updateUserStatus(userId, status) {
    setBusy(true)
    try {
      const { error } = await supabase.from('profiles').update({ status }).eq('id', userId)
      if (error) {
        alert(`Erro ao salvar status: ${error.message}`)
        return
      }
      await hydrateAll()
      setSelectedUserId(userId)
    } finally {
      setBusy(false)
    }
  }

  function toggleProjectAccess(projectId) {
    if (!selectedUser) return

    setMembershipsByProjectId((prev) => {
      const next = { ...prev }
      if (next[projectId]) {
        // remove local (vai deletar no save)
        delete next[projectId]
      } else {
        next[projectId] = {
          id: null,
          permission: defaultPermissionForRole(selectedUser.role),
        }
      }
      return next
    })
  }

  function markAllProjects() {
    if (!selectedUser) return
    const perm = defaultPermissionForRole(selectedUser.role)

    setMembershipsByProjectId(() => {
      const next = {}
      for (const p of projects) {
        next[p.id] = { id: null, permission: perm }
      }
      return next
    })
  }

  function unmarkAllProjects() {
    setMembershipsByProjectId({})
  }

  async function saveAccesses() {
    if (!selectedUser) return
    setBusy(true)

    try {
      // 1) buscar estado atual no banco para comparar
      const { data: currentRows, error: e0 } = await supabase
        .from('project_members')
        .select('id, project_id, user_id, permission')
        .eq('user_id', selectedUser.id)

      if (e0) {
        alert(`Erro ao ler acessos atuais: ${e0.message}`)
        return
      }

      const currentMap = {}
      for (const r of currentRows || []) currentMap[r.project_id] = r

      const desiredProjectIds = new Set(Object.keys(membershipsByProjectId))

      const toDelete = []
      const toUpsert = []

      // 2) deletar o que existia e não está marcado
      for (const projectId of Object.keys(currentMap)) {
        if (!desiredProjectIds.has(projectId)) toDelete.push(currentMap[projectId].id)
      }

      // 3) upsert do que está marcado
      for (const projectId of desiredProjectIds) {
        const desired = membershipsByProjectId[projectId]
        const perm = desired?.permission || defaultPermissionForRole(selectedUser.role)

        const exists = currentMap[projectId]
        if (exists) {
          if (exists.permission !== perm) {
            toUpsert.push({ id: exists.id, project_id: projectId, user_id: selectedUser.id, permission: perm })
          }
        } else {
          toUpsert.push({ project_id: projectId, user_id: selectedUser.id, permission: perm })
        }
      }

      if (toDelete.length > 0) {
        const { error: eDel } = await supabase.from('project_members').delete().in('id', toDelete)
        if (eDel) {
          alert(`Erro ao remover acessos: ${eDel.message}`)
          return
        }
      }

      if (toUpsert.length > 0) {
        const { error: eUp } = await supabase.from('project_members').upsert(toUpsert, { onConflict: 'project_id,user_id' })
        if (eUp) {
          alert(`Erro ao salvar acessos: ${eUp.message}`)
          return
        }
      }

      await loadMembershipsForUser(selectedUser.id)
      alert('Acessos salvos com sucesso.')
    } finally {
      setBusy(false)
    }
  }

  function isChecked(projectId) {
    return !!membershipsByProjectId[projectId]
  }

  if (loading) {
    return (
      <div style={styles.page}>
        <div>Carregando…</div>
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <div style={styles.topbar}>
        <div>
          <div style={{ fontSize: 12, color: '#666' }}>Admin</div>
          <h1 style={{ margin: 0 }}>Gestão de Usuários</h1>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link href="/">Home</Link>
          <Link href="/obras">Obras</Link>
        </div>
      </div>

      <div style={styles.grid}>
        {/* COLUNA 1: Usuários */}
        <div style={styles.card}>
          <div style={styles.cardTitle}>Usuários</div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 10 }}>
            Apenas admins veem esta tela. Usuários inativos não devem operar no sistema.
          </div>

          {users.length === 0 ? <div style={{ color: '#666' }}>Nenhum usuário encontrado.</div> : null}

          <div style={{ display: 'grid', gap: 10 }}>
            {users.map((u) => {
              const selected = u.id === selectedUserId
              return (
                <button
                  key={u.id}
                  onClick={() => setSelectedUserId(u.id)}
                  style={{
                    ...styles.userRow,
                    borderColor: selected ? '#111' : '#eee',
                    background: selected ? '#f3f3f3' : '#fff',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                    <div style={{ fontWeight: 900 }}>{u.full_name || u.id}</div>
                    <div style={{ fontSize: 12, color: '#666' }}>{STATUS_LABEL[u.status] || u.status}</div>
                  </div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>
                    Role: <b>{ROLE_LABEL[u.role] || u.role}</b>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* COLUNA 2: Detalhes + Acessos */}
        <div style={styles.card}>
          <div style={styles.cardTitle}>Detalhes e Acessos</div>

          {!selectedUser ? (
            <div style={{ color: '#666' }}>Selecione um usuário para gerenciar.</div>
          ) : (
            <>
              <div style={{ display: 'grid', gap: 10, marginBottom: 14 }}>
                <div style={{ fontSize: 14 }}>
                  Usuário: <b>{selectedUser.full_name || selectedUser.id}</b>
                </div>

                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <div style={{ fontSize: 12, color: '#666', minWidth: 70 }}>Role</div>
                  <select
                    value={selectedUser.role}
                    disabled={busy}
                    onChange={(e) => updateUserRole(selectedUser.id, e.target.value)}
                    style={styles.select}
                  >
                    <option value="admin">Administrador</option>
                    <option value="collaborator">Colaborador</option>
                    <option value="contractor">Terceirizado</option>
                    <option value="client">Cliente</option>
                  </select>

                  <div style={{ fontSize: 12, color: '#666', minWidth: 70 }}>Status</div>
                  <select
                    value={selectedUser.status}
                    disabled={busy}
                    onChange={(e) => updateUserStatus(selectedUser.id, e.target.value)}
                    style={styles.select}
                  >
                    <option value="active">Ativo</option>
                    <option value="inactive">Inativo</option>
                  </select>
                </div>
              </div>

              <hr style={{ margin: '12px 0' }} />

              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 900 }}>Acesso às Obras</div>
                  <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                    Marque quais obras este usuário pode acessar.
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button onClick={markAllProjects} disabled={busy || projects.length === 0} style={styles.btn}>
                    Marcar todas
                  </button>
                  <button onClick={unmarkAllProjects} disabled={busy} style={styles.btnSecondary}>
                    Desmarcar todas
                  </button>
                  <button onClick={saveAccesses} disabled={busy} style={styles.btnPrimary}>
                    {busy ? 'Salvando…' : 'Salvar acessos'}
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
                {projects.length === 0 ? (
                  <div style={{ color: '#666' }}>Nenhuma obra encontrada.</div>
                ) : (
                  projects.map((p) => {
                    const checked = isChecked(p.id)
                    return (
                      <label key={p.id} style={styles.projectRow}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={busy}
                          onChange={() => toggleProjectAccess(p.id)}
                          style={{ transform: 'scale(1.1)' }}
                        />
                        <div style={{ display: 'grid', gap: 3 }}>
                          <div style={{ fontWeight: 900 }}>{p.name || p.id}</div>
                          <div style={{ fontSize: 12, color: '#666' }}>
                            {p.city ? `${p.city}` : ''}
                            {p.client_name ? ` • Cliente: ${p.client_name}` : ''}
                          </div>
                          <div style={{ fontSize: 12, color: '#777' }}>
                            Permissão: <b>{checked ? membershipsByProjectId[p.id]?.permission : '—'}</b>{' '}
                            <span style={{ color: '#999' }}>
                              (auto: {defaultPermissionForRole(selectedUser.role)})
                            </span>
                          </div>
                        </div>
                      </label>
                    )
                  })
                )}
              </div>

              <div style={{ marginTop: 12, fontSize: 12, color: '#777' }}>
                Dica: por padrão, a permissão é automática conforme a role do usuário:
                {' '}
                <b>cliente=view</b>, <b>colaborador/terceirizado=work</b>, <b>admin=admin</b>.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const styles = {
  page: {
    padding: 24,
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    background: '#fafafa',
    minHeight: '100vh',
  },
  topbar: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'baseline',
    flexWrap: 'wrap',
    marginBottom: 16,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1.3fr',
    gap: 16,
    alignItems: 'start',
  },
  card: {
    background: '#fff',
    border: '1px solid #eee',
    borderRadius: 14,
    padding: 16,
    boxShadow: '0 8px 24px rgba(0,0,0,0.06)',
  },
  cardTitle: { fontWeight: 900, marginBottom: 10 },
  userRow: {
    textAlign: 'left',
    padding: 12,
    borderRadius: 12,
    border: '1px solid #eee',
    background: '#fff',
    cursor: 'pointer',
  },
  projectRow: {
    display: 'grid',
    gridTemplateColumns: '22px 1fr',
    gap: 10,
    alignItems: 'start',
    padding: 12,
    borderRadius: 12,
    border: '1px solid #eee',
    background: '#fff',
  },
  select: {
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid #ddd',
    background: '#fff',
    fontWeight: 800,
    cursor: 'pointer',
  },
  btn: {
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid #ddd',
    background: '#fff',
    cursor: 'pointer',
    fontWeight: 900,
  },
  btnSecondary: {
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid #ddd',
    background: '#fff',
    cursor: 'pointer',
    fontWeight: 900,
  },
  btnPrimary: {
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid #ddd',
    background: '#111',
    color: '#fff',
    cursor: 'pointer',
    fontWeight: 900,
  },
}
