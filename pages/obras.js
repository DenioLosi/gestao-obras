import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '../lib/supabase'
import { runAdminAction } from '../lib/admin-api'

const STATUS_LABEL = {
  pending: 'pendente',
  in_progress: 'em andamento',
  done: 'concluída',
}

const ROLE_PT = {
  admin: 'admin',
  worker: 'colaborador',
  client: 'cliente',
  collaborator: 'colaborador',
  contractor: 'terceirizado',
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

function normalizeLookupKey(v) {
  return safeStr(v).trim().toLowerCase()
}

function normalizeImportedStageStatus(status) {
  const value = safeStr(status).trim().toLowerCase()
  if (!value) return 'pending'
  if (value === 'pending' || value === 'in_progress' || value === 'done') return value
  return null
}

function parseCsvLine(line) {
  const out = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i += 1
        continue
      }

      inQuotes = !inQuotes
      continue
    }

    if (char === ',' && !inQuotes) {
      out.push(current)
      current = ''
      continue
    }

    current += char
  }

  out.push(current)
  return out.map((value) => safeStr(value).trim())
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
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 900 }}>{title}</div>
          <button
            type="button"
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
  const [showArchived, setShowArchived] = useState(false)

  const [modalOpen, setModalOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editProjectId, setEditProjectId] = useState(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [importCsvText, setImportCsvText] = useState('')
  const [importFileName, setImportFileName] = useState('')
  const [importSummary, setImportSummary] = useState(null)

  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formClientName, setFormClientName] = useState('')
  const [formCity, setFormCity] = useState('')
  const [formAddress, setFormAddress] = useState('')

  const [openMenuProjectId, setOpenMenuProjectId] = useState(null)

  useEffect(() => {
    function closeMenus() {
      setOpenMenuProjectId(null)
    }
    window.addEventListener('click', closeMenus)
    return () => window.removeEventListener('click', closeMenus)
  }, [])

  function setNormalizedProjects(projectRows) {
    setProjects((projectRows || []).map((x) => ({
      ...x,
      is_active: x.is_active !== false,
      units: (Array.isArray(x.units) ? x.units : []).map((unit) => ({
        ...unit,
        is_active: unit?.is_active !== false,
      })),
    })))
  }

  async function recalculateUnitsAndProjects(unitIds) {
    const uniqueUnitIds = [...new Set((Array.isArray(unitIds) ? unitIds : []).map((value) => safeStr(value).trim()).filter(Boolean))]
    if (uniqueUnitIds.length === 0) return null

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    if (sessionError) throw sessionError

    const response = await fetch('/api/units/recalculate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sessionData?.session?.access_token
          ? { Authorization: `Bearer ${sessionData.session.access_token}` }
          : {}),
      },
      body: JSON.stringify({ unit_ids: uniqueUnitIds }),
    })

    const json = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(json?.error || 'Nao foi possivel recalcular progresso e status.')
    }

    return json
  }

  async function loadData() {
    setLoading(true)

    const { data: authData, error: authErr } = await supabase.auth.getUser()
    if (authErr || !authData?.user) {
      window.location.href = '/login'
      return
    }
    setUserEmail(authData.user.email || '')

    const { data: p, error: pErr } = await supabase
      .from('profiles')
      .select('id, full_name, role, status, tenant_id')
      .eq('id', authData.user.id)
      .maybeSingle()

    if (pErr || !p) {
      alert(`Erro ao carregar perfil: ${pErr?.message || 'perfil não encontrado'}`)
      setProjects([])
      setLoading(false)
      return
    }

    setProfile(p)

    if (p.status === 'disabled' || p.status === 'inactive') {
      alert('Seu usuário está inativo. Procure o administrador.')
      window.location.href = '/'
      return
    }

    const baseSelect = `
      id,
      name,
      description,
      client_name,
      city,
      address,
      created_at,
      tenant_id,
      is_active,
      progress,
      status,
      units (
        id,
        identifier,
        status,
        progress,
        is_active
      )
    `

    if (p.role === 'admin') {
      const { data, error } = await supabase
        .from('projects')
        .select(baseSelect)
        .eq('tenant_id', p.tenant_id)
        .order('created_at', { ascending: true })

      if (error) {
        console.error('Erro ao carregar projects:', error)
        alert(`Erro ao carregar obras: ${error.message}`)
        setProjects([])
        setLoading(false)
        return
      }

      setNormalizedProjects(data || [])
      setLoading(false)
      return
    }

    const { data: mem, error: memErr } = await supabase
      .from('project_members')
      .select('project_id')
      .eq('user_id', p.id)
      .limit(1000000)

    if (memErr) {
      alert(`Erro ao carregar acessos: ${memErr.message}`)
      setProjects([])
      setLoading(false)
      return
    }

    const ids = (mem || []).map((r) => r.project_id).filter(Boolean)
    if (ids.length === 0) {
      setProjects([])
      setLoading(false)
      return
    }

    const { data: data2, error: prjErr } = await supabase
      .from('projects')
      .select(baseSelect)
      .in('id', ids)
      .eq('tenant_id', p.tenant_id)
      .order('created_at', { ascending: true })

    if (prjErr) {
      alert(`Erro ao carregar obras: ${prjErr.message}`)
      setProjects([])
      setLoading(false)
      return
    }

    setNormalizedProjects(data2 || [])
    setLoading(false)
  }

  useEffect(() => {
    loadData()
  }, [])

  const cards = useMemo(() => {
    const base = showArchived ? projects : projects.filter((p) => p.is_active !== false)

    return base.map((p) => {
      const activeUnits = (p.units || []).filter((unit) => unit.is_active !== false)
      const counts = { pending: 0, in_progress: 0, done: 0 }

      for (const unit of activeUnits) {
        const status = safeStr(unit.status).trim() || 'pending'
        if (counts[status] === undefined) counts.pending += 1
        else counts[status] += 1
      }

      return {
        id: p.id,
        name: p.name || '(Sem nome)',
        description: p.description || '',
        client_name: p.client_name || '',
        city: p.city || '',
        address: p.address || '',
        created_at: p.created_at || null,
        totalUnits: activeUnits.length,
        avgProgress: clampPct(p.progress),
        counts,
        status: safeStr(p.status).trim() || 'pending',
        is_active: p.is_active !== false,
      }
    })
  }, [projects, showArchived])

  const filteredCards = useMemo(() => {
    const q = search.trim().toLowerCase()

    let list = !q
      ? [...cards]
      : (cards || []).filter((c) => {
          return (
            includesText(c?.name, q) ||
            includesText(c?.description, q) ||
            includesText(c?.client_name, q) ||
            includesText(c?.city, q) ||
            includesText(c?.address, q)
          )
        })

    list.sort((a, b) => {
      if (sortBy === 'progress_desc') return clampPct(b.avgProgress) - clampPct(a.avgProgress)
      if (sortBy === 'progress_asc') return clampPct(a.avgProgress) - clampPct(b.avgProgress)
      if (sortBy === 'inprogress_desc') return (b.counts?.in_progress || 0) - (a.counts?.in_progress || 0)
      if (sortBy === 'pending_desc') return (b.counts?.pending || 0) - (a.counts?.pending || 0)
      if (sortBy === 'newest') return getTime(b) - getTime(a)
      if (sortBy === 'oldest') return getTime(a) - getTime(b)
      if (sortBy === 'name_asc') return safeStr(a?.name).localeCompare(safeStr(b?.name))
      return 0
    })

    return list
  }, [cards, search, sortBy])

  const isAdmin = profile?.role === 'admin'

  function openCreateModal() {
    setEditProjectId(null)
    setFormName('')
    setFormDescription('')
    setFormClientName('')
    setFormCity('')
    setFormAddress('')
    setModalOpen(true)
    setOpenMenuProjectId(null)
  }

  function openEditModal(card) {
    setEditProjectId(card.id)
    setFormName(card.name === '(Sem nome)' ? '' : safeStr(card.name))
    setFormDescription(safeStr(card.description))
    setFormClientName(safeStr(card.client_name))
    setFormCity(safeStr(card.city))
    setFormAddress(safeStr(card.address))
    setModalOpen(true)
    setOpenMenuProjectId(null)
  }

  function closeModal() {
    if (saving) return
    setModalOpen(false)
  }

  function openImportModal() {
    setImportOpen(true)
    setImportSummary(null)
  }

  function closeImportModal() {
    if (importBusy) return
    setImportOpen(false)
  }

  async function handleImportFileChange(event) {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      setImportCsvText(text)
      setImportFileName(file.name || '')
      setImportSummary(null)
    } catch (error) {
      alert(`Erro ao ler arquivo: ${error.message}`)
    } finally {
      event.target.value = ''
    }
  }

  async function importBulkStageStatusCsv() {
    const rawText = safeStr(importCsvText).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (!rawText.trim()) {
      alert('Cole o CSV ou selecione um arquivo .csv.')
      return
    }

    const allLines = rawText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

    if (allLines.length === 0) {
      alert('CSV vazio.')
      return
    }

    let startIndex = 0
    const firstColumns = parseCsvLine(allLines[0]).map((value) => normalizeLookupKey(value))
    const hasHeader =
      firstColumns.length >= 4 &&
      firstColumns[0] === 'obra' &&
      firstColumns[1] === 'unidade' &&
      firstColumns[2] === 'etapa' &&
      firstColumns[3] === 'status'

    if (hasHeader) startIndex = 1

    const invalidLines = []
    const parsedRows = []

    for (let index = startIndex; index < allLines.length; index += 1) {
      const lineNumber = index + 1
      const columns = parseCsvLine(allLines[index])

      if (columns.length !== 4) {
        invalidLines.push(`Linha ${lineNumber}: formato inválido`)
        continue
      }

      const [projectName, unitIdentifier, stageName, rawStatus] = columns
      const normalizedStatus = normalizeImportedStageStatus(rawStatus)

      if (!projectName || !unitIdentifier || !stageName || !normalizedStatus) {
        invalidLines.push(`Linha ${lineNumber}: dados inválidos`)
        continue
      }

      parsedRows.push({
        lineNumber,
        projectName,
        unitIdentifier,
        stageName,
        status: normalizedStatus,
      })
    }

    if (parsedRows.length === 0) {
      setImportSummary({
        updated: 0,
        unchanged: 0,
        invalid: invalidLines.length,
        errors: invalidLines,
      })
      alert('Nenhuma linha válida encontrada no CSV.')
      return
    }

    const projectBuckets = new Map()
    for (const project of projects || []) {
      const key = normalizeLookupKey(project?.name)
      if (!key) continue
      if (!projectBuckets.has(key)) projectBuckets.set(key, [])
      projectBuckets.get(key).push(project)
    }

    const resolvedRows = []
    const errors = [...invalidLines]

    for (const row of parsedRows) {
      const projectMatches = projectBuckets.get(normalizeLookupKey(row.projectName)) || []

      if (projectMatches.length === 0) {
        errors.push(`Linha ${row.lineNumber}: obra não encontrada (${row.projectName})`)
        continue
      }

      if (projectMatches.length > 1) {
        errors.push(`Linha ${row.lineNumber}: obra duplicada (${row.projectName})`)
        continue
      }

      resolvedRows.push({
        ...row,
        projectId: projectMatches[0].id,
      })
    }

    if (resolvedRows.length === 0) {
      setImportSummary({
        updated: 0,
        unchanged: 0,
        invalid: invalidLines.length,
        errors,
      })
      return
    }

    setImportBusy(true)
    try {
      const projectIds = [...new Set(resolvedRows.map((row) => row.projectId).filter(Boolean))]

      const [{ data: unitsData, error: unitsError }, { data: stagesData, error: stagesError }] = await Promise.all([
        supabase
          .from('units')
          .select('id, project_id, identifier')
          .in('project_id', projectIds)
          .limit(1000000),
        supabase
          .from('stages')
          .select('id, project_id, name')
          .in('project_id', projectIds)
          .limit(1000000),
      ])

      if (unitsError) {
        alert(`Erro ao carregar unidades para importação: ${unitsError.message}`)
        return
      }

      if (stagesError) {
        alert(`Erro ao carregar etapas para importação: ${stagesError.message}`)
        return
      }

      const unitsByProjectAndIdentifier = new Map()
      for (const unit of unitsData || []) {
        const key = `${safeStr(unit.project_id)}::${normalizeLookupKey(unit.identifier)}`
        unitsByProjectAndIdentifier.set(key, unit)
      }

      const stagesByProjectAndName = new Map()
      for (const stage of stagesData || []) {
        const key = `${safeStr(stage.project_id)}::${normalizeLookupKey(stage.name)}`
        stagesByProjectAndName.set(key, stage)
      }

      const rowsWithRefs = []
      for (const row of resolvedRows) {
        const unitKey = `${safeStr(row.projectId)}::${normalizeLookupKey(row.unitIdentifier)}`
        const stageKey = `${safeStr(row.projectId)}::${normalizeLookupKey(row.stageName)}`

        const unit = unitsByProjectAndIdentifier.get(unitKey)
        if (!unit) {
          errors.push(`Linha ${row.lineNumber}: unidade não encontrada (${row.projectName} / ${row.unitIdentifier})`)
          continue
        }

        const stage = stagesByProjectAndName.get(stageKey)
        if (!stage) {
          errors.push(`Linha ${row.lineNumber}: etapa não encontrada (${row.projectName} / ${row.stageName})`)
          continue
        }

        rowsWithRefs.push({
          ...row,
          unitId: unit.id,
          stageId: stage.id,
        })
      }

      if (rowsWithRefs.length === 0) {
        setImportSummary({
          updated: 0,
          unchanged: 0,
          invalid: invalidLines.length,
          errors,
        })
        return
      }

      const unitIds = [...new Set(rowsWithRefs.map((row) => row.unitId).filter(Boolean))]
      const { data: unitStagesData, error: unitStagesError } = await supabase
        .from('unit_stages')
        .select('id, unit_id, stage_id, status')
        .in('unit_id', unitIds)
        .limit(1000000)

      if (unitStagesError) {
        alert(`Erro ao carregar etapas das unidades: ${unitStagesError.message}`)
        return
      }

      const unitStagesByKey = new Map()
      for (const row of unitStagesData || []) {
        const key = `${safeStr(row.unit_id)}::${safeStr(row.stage_id)}`
        unitStagesByKey.set(key, row)
      }

      const updatesByUnitStageId = new Map()
      let unchanged = 0

      for (const row of rowsWithRefs) {
        const unitStageKey = `${safeStr(row.unitId)}::${safeStr(row.stageId)}`
        const unitStage = unitStagesByKey.get(unitStageKey)

        if (!unitStage) {
          errors.push(`Linha ${row.lineNumber}: etapa não encontrada (${row.projectName} / ${row.unitIdentifier} / ${row.stageName})`)
          continue
        }

        const currentStatus = normalizeImportedStageStatus(unitStage.status)
        if (currentStatus === row.status) {
          unchanged += 1
          continue
        }

        updatesByUnitStageId.set(unitStage.id, {
          id: unitStage.id,
          status: row.status,
        })
      }

      let updated = 0
      const touchedUnitIds = new Set()
      for (const update of updatesByUnitStageId.values()) {
        const { error } = await supabase.from('unit_stages').update({ status: update.status }).eq('id', update.id)
        if (error) {
          errors.push(`Erro ao atualizar registro ${update.id}: ${error.message}`)
          continue
        }
        const touchedRow = unitStagesData?.find((row) => safeStr(row.id) === safeStr(update.id))
        if (touchedRow?.unit_id) touchedUnitIds.add(touchedRow.unit_id)
        updated += 1
      }

      if (touchedUnitIds.size > 0) {
        await recalculateUnitsAndProjects([...touchedUnitIds])
      }

      const summary = {
        updated,
        unchanged,
        invalid: invalidLines.length,
        errors,
      }

      setImportSummary(summary)

      if (updated > 0) {
        await loadData()
      }

      alert(
        `Importação concluída.\n` +
          `Atualizados: ${summary.updated}\n` +
          `Sem mudança: ${summary.unchanged}\n` +
          `Linhas inválidas: ${summary.invalid}\n` +
          `Erros: ${summary.errors.length}`
      )
    } finally {
      setImportBusy(false)
    }
  }

  async function saveProject() {
    if (!isAdmin) return

    const name = safeStr(formName).trim()
    const description = safeStr(formDescription).trim()
    const client_name = safeStr(formClientName).trim()
    const city = safeStr(formCity).trim()
    const address = safeStr(formAddress).trim()

    if (!name) return alert('Informe o nome da obra.')
    if (!client_name) return alert('Informe o cliente.')

    try {
      setSaving(true)

      const payload = {
        name,
        description,
        client_name,
        city,
        address,
        tenant_id: profile?.tenant_id || null,
      }

      if (editProjectId) {
        const { error } = await supabase.from('projects').update(payload).eq('id', editProjectId)
        if (error) return alert(`Erro ao editar obra: ${error.message}`)
      } else {
        await runAdminAction('create_project', payload)
      }

      setModalOpen(false)
      await loadData()
    } finally {
      setSaving(false)
    }
  }

  async function archiveProject(card) {
    if (!isAdmin) return

    const actionLabel = card.is_active === false ? 'reativar' : 'arquivar'
    const ok = window.confirm(`Deseja ${actionLabel} a obra "${card.name}"?`)
    if (!ok) return

    try {
      setSaving(true)
      const { error } = await supabase
        .from('projects')
        .update({ is_active: card.is_active === false ? true : false })
        .eq('id', card.id)

      if (error) return alert(`Erro ao atualizar obra: ${error.message}`)

      setOpenMenuProjectId(null)
      await loadData()
    } finally {
      setSaving(false)
    }
  }

  async function deleteProject(card) {
    if (!isAdmin) return

    const ok = window.confirm(
      `Excluir a obra "${card.name}"?\n\nATENÇÃO: se existirem unidades vinculadas, o banco pode bloquear (ou apagar junto, dependendo do seu schema).`
    )
    if (!ok) return

    try {
      setSaving(true)
      await runAdminAction('delete_project', { project_id: card.id })
      setOpenMenuProjectId(null)
      await loadData()
    } finally {
      setSaving(false)
    }
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ marginBottom: 6 }}>Obras</h1>
          <div style={{ color: '#444', marginBottom: 4 }}>
            Usuário logado: <b>{userEmail}</b>
          </div>
          <div style={{ color: '#666', fontSize: 12 }}>
            Perfil: <b>{ROLE_PT[profile?.role] || profile?.role || '—'}</b> • Status: <b>{profile?.status || '—'}</b>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link href="/" style={{ textDecoration: 'none' }}>← Home</Link>

          {isAdmin ? (
            <Link href="/usuarios" style={{ textDecoration: 'none' }}>Gestão de Usuários</Link>
          ) : null}

          <button
            type="button"
            onClick={openImportModal}
            style={{
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid #ddd',
              background: '#fff',
              color: '#111',
              cursor: 'pointer',
              fontWeight: 800,
              height: 'fit-content',
            }}
          >
            Importar CSV
          </button>

          {isAdmin ? (
            <button
              type="button"
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
          ) : null}

        </div>
      </div>

      <hr style={{ margin: '18px 0' }} />

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 18 }}>
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

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#444' }}>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Mostrar arquivadas
        </label>

        {search ? (
          <button
            type="button"
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
        <div style={{ marginTop: 18, color: '#444' }}>
          Nenhuma obra cadastrada (ou sem permissão no tenant).
        </div>
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
                  opacity: c.is_active === false ? 0.72 : 1,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>
                      {c.name}
                      {c.is_active === false ? (
                        <span style={{ marginLeft: 8, fontSize: 12, color: '#b00020', fontWeight: 900 }}>
                          (Arquivada)
                        </span>
                      ) : null}
                    </div>

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

                    {isAdmin ? (
                      <div
                        style={{ position: 'relative' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setOpenMenuProjectId((prev) => (prev === c.id ? null : c.id))
                          }}
                          style={{
                            width: 40,
                            height: 36,
                            borderRadius: 10,
                            border: '1px solid #ddd',
                            background: '#fff',
                            cursor: 'pointer',
                            fontWeight: 900,
                            fontSize: 18,
                            lineHeight: 1,
                          }}
                          title="Ações"
                        >
                          ⋯
                        </button>

                        {openMenuProjectId === c.id ? (
                          <div
                            style={{
                              position: 'absolute',
                              top: 42,
                              right: 0,
                              minWidth: 180,
                              border: '1px solid #e8e8e8',
                              background: '#fff',
                              borderRadius: 12,
                              boxShadow: '0 14px 30px rgba(0,0,0,0.12)',
                              overflow: 'hidden',
                              zIndex: 50,
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => openEditModal(c)}
                              style={{
                                width: '100%',
                                textAlign: 'left',
                                padding: '10px 12px',
                                border: 'none',
                                background: '#fff',
                                cursor: 'pointer',
                                fontWeight: 700,
                                color: '#111',
                              }}
                            >
                              Editar
                            </button>

                            <button
                              type="button"
                              onClick={() => archiveProject(c)}
                              disabled={saving}
                              style={{
                                width: '100%',
                                textAlign: 'left',
                                padding: '10px 12px',
                                border: 'none',
                                borderTop: '1px solid #f1f1f1',
                                background: '#fff',
                                cursor: saving ? 'not-allowed' : 'pointer',
                                fontWeight: 700,
                                color: '#111',
                              }}
                            >
                              {c.is_active === false ? 'Reativar' : 'Arquivar'}
                            </button>

                            <button
                              type="button"
                              onClick={() => deleteProject(c)}
                              disabled={saving}
                              style={{
                                width: '100%',
                                textAlign: 'left',
                                padding: '10px 12px',
                                border: 'none',
                                borderTop: '1px solid #f1f1f1',
                                background: '#fff',
                                cursor: saving ? 'not-allowed' : 'pointer',
                                fontWeight: 700,
                                color: '#b00020',
                              }}
                            >
                              Excluir
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
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
                      type="button"
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

                  <Link href={`/obras/${c.id}/arquivos`} style={{ textDecoration: 'none' }}>
                    <button
                      type="button"
                      style={{
                        padding: '10px 12px',
                        borderRadius: 12,
                        border: '1px solid #ddd',
                        background: '#fff',
                        color: '#111',
                        cursor: 'pointer',
                        fontWeight: 800,
                      }}
                    >
                      Arquivos
                    </button>
                  </Link>

                  <Link href={`/obras/${c.id}/relatorios`} style={{ textDecoration: 'none' }}>
                    <button
                      type="button"
                      style={{
                        padding: '10px 12px',
                        borderRadius: 12,
                        border: '1px solid #ddd',
                        background: '#fff',
                        color: '#111',
                        cursor: 'pointer',
                        fontWeight: 800,
                      }}
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

      <Modal open={modalOpen} title={editProjectId ? 'Editar obra' : 'Nova obra'} onClose={() => !saving && closeModal()}>
        {!isAdmin ? (
          <div style={{ color: '#b00020' }}>Apenas administradores podem criar/editar obras.</div>
        ) : (
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
                  placeholder="Ex: Atmós / Emirates / Cliente XPTO"
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
                type="button"
                onClick={closeModal}
                disabled={saving}
                style={{
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px solid #ddd',
                  background: '#fff',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontWeight: 800,
                }}
              >
                Cancelar
              </button>

              <button
                type="button"
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
        )}
      </Modal>

      <Modal open={importOpen} title="Importar status por CSV" onClose={closeImportModal}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ color: '#444', lineHeight: 1.45 }}>
            Formato: <b>obra,unidade,etapa,status</b>
            <br />
            Status aceitos: <b>done</b>, <b>in_progress</b> ou vazio para <b>pending</b>.
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <label
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#fff',
                cursor: importBusy ? 'not-allowed' : 'pointer',
                fontWeight: 700,
                opacity: importBusy ? 0.6 : 1,
              }}
            >
              Selecionar CSV
              <input type="file" accept=".csv,text/csv" onChange={handleImportFileChange} disabled={importBusy} style={{ display: 'none' }} />
            </label>

            {importFileName ? <div style={{ fontSize: 12, color: '#666' }}>Arquivo: <b>{importFileName}</b></div> : null}
          </div>

          <textarea
            value={importCsvText}
            onChange={(e) => {
              setImportCsvText(e.target.value)
              setImportSummary(null)
            }}
            placeholder={'obra,unidade,etapa,status\nPratz36,401,rufação,done\nPratz36,401,rejunte,\nPratz36,402,rufação,done'}
            style={{
              minHeight: 220,
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid #ddd',
              outline: 'none',
              resize: 'vertical',
              fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
              fontSize: 13,
            }}
            disabled={importBusy}
          />

          {importSummary ? (
            <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 12, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
                <div>Atualizados: <b>{importSummary.updated}</b></div>
                <div>Sem mudança: <b>{importSummary.unchanged}</b></div>
                <div>Linhas inválidas: <b>{importSummary.invalid}</b></div>
                <div>Erros: <b>{importSummary.errors.length}</b></div>
              </div>

              {importSummary.errors.length > 0 ? (
                <div
                  style={{
                    maxHeight: 180,
                    overflowY: 'auto',
                    background: '#fafafa',
                    border: '1px solid #f0f0f0',
                    borderRadius: 10,
                    padding: 10,
                    fontSize: 12,
                    color: '#444',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {importSummary.errors.join('\n')}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#2f6b2f' }}>Nenhum erro encontrado.</div>
              )}
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={closeImportModal}
              disabled={importBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#fff',
                cursor: importBusy ? 'not-allowed' : 'pointer',
                fontWeight: 800,
              }}
            >
              Fechar
            </button>

            <button
              type="button"
              onClick={importBulkStageStatusCsv}
              disabled={importBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#111',
                color: '#fff',
                cursor: importBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              {importBusy ? 'Importando…' : 'Importar e atualizar'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
