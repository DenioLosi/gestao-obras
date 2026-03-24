import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { supabase } from '../../lib/supabase'
import { runAdminAction } from '../../lib/admin-api'
import { calculateUnitMetrics } from '../../lib/unit-progress'

const BUCKET = 'unit-stage-photos'

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

function normalizeUnitMapKey(value) {
  return safeStr(value).trim().toLowerCase()
}

function clampPct(n) {
  const v = Number(n || 0)
  if (Number.isNaN(v)) return 0
  return Math.max(0, Math.min(100, v))
}

function normalizeUnitStatus(status) {
  const value = safeStr(status).trim()
  if (value === 'pending' || value === 'in_progress' || value === 'done') return value
  return 'pending'
}

function buildUnitStageCounters(stageRows) {
  if (!Array.isArray(stageRows)) {
    return {
      totalActiveStages: null,
      pendingCount: null,
      inProgressCount: null,
      doneCount: null,
      notesCount: null
    }
  }

  const activeRows = stageRows.filter((row) => row?.is_active !== false)
  const normalizeStageStatus = (status) => safeStr(status).trim().toLowerCase()

  return {
    totalActiveStages: activeRows.length,
    pendingCount: activeRows.filter((row) => normalizeStageStatus(row?.status) === 'pending').length,
    inProgressCount: activeRows.filter((row) => normalizeStageStatus(row?.status) === 'in_progress').length,
    doneCount: activeRows.filter((row) => normalizeStageStatus(row?.status) === 'done').length,
    notesCount: activeRows.filter((row) => safeStr(row?.notes).trim()).length,
  }
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

function makeBuildingIdentifier(floor, unitIndex, pad2) {
  const suffix = pad2 ? String(unitIndex).padStart(2, '0') : String(unitIndex)
  return `${floor}${suffix}`
}

function randomId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16)
}

function extFromPath(path) {
  const p = safeStr(path).toLowerCase()
  const i = p.lastIndexOf('.')
  if (i === -1) return 'jpg'
  const ext = p.slice(i + 1)
  return ext || 'jpg'
}

function normalizeAlpha(v) {
  return safeStr(v).trim().toUpperCase()
}

function alphaToCode(letter) {
  const s = normalizeAlpha(letter)
  if (!/^[A-Z]$/.test(s)) return null
  return s.charCodeAt(0)
}

function buildAlphaRange(start, end) {
  const a = alphaToCode(start)
  const b = alphaToCode(end)
  if (a === null || b === null) return null
  if (b < a) return null

  const out = []
  for (let code = a; code <= b; code++) {
    out.push(String.fromCharCode(code))
  }
  return out
}

function buildNumericRange(start, end) {
  const a = Number(start)
  const b = Number(end)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  if (b < a) return null

  const out = []
  for (let i = a; i <= b; i++) {
    out.push(String(i))
  }
  return out
}

function buildLotIdentifier(quadraLabel, loteLabel) {
  return `Q${quadraLabel} L${loteLabel}`
}

function Modal({ open, title, onClose, children, busy }) {
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
          width: 'min(860px, 100%)',
          maxHeight: 'calc(100vh - 32px)',
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
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 900 }}>{title}</div>

          <button
            type="button"
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
  const [profile, setProfile] = useState(null)

  const [project, setProject] = useState(null)
  const [units, setUnits] = useState([])
  const [unitStagesByUnitId, setUnitStagesByUnitId] = useState({})
  const [unitStagesLoaded, setUnitStagesLoaded] = useState(false)
  const [duplicateStageWarnings, setDuplicateStageWarnings] = useState([])

  const [stageTemplates, setStageTemplates] = useState([])
  const [stagesOpen, setStagesOpen] = useState(false)
  const [stagesBusy, setStagesBusy] = useState(false)
  const [showArchivedStages, setShowArchivedStages] = useState(false)
  const [newStageName, setNewStageName] = useState('')
  const [bulkStageLines, setBulkStageLines] = useState('')

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sortBy, setSortBy] = useState('identifier_asc')
  const [showArchivedUnits, setShowArchivedUnits] = useState(false)

  const [openTopMenu, setOpenTopMenu] = useState(false)
  const [openUnitMenuId, setOpenUnitMenuId] = useState(null)

  const [createUnitOpen, setCreateUnitOpen] = useState(false)
  const [createUnitBusy, setCreateUnitBusy] = useState(false)
  const [createUnitIdentifier, setCreateUnitIdentifier] = useState('')
  const [createUnitApplyStages, setCreateUnitApplyStages] = useState(true)

  const [editUnitOpen, setEditUnitOpen] = useState(false)
  const [editUnitBusy, setEditUnitBusy] = useState(false)
  const [editUnitId, setEditUnitId] = useState('')
  const [editUnitIdentifier, setEditUnitIdentifier] = useState('')

  const [copyOpen, setCopyOpen] = useState(false)
  const [copyBusy, setCopyBusy] = useState(false)
  const [copySourceUnitId, setCopySourceUnitId] = useState('')
  const [copySourceUnitLabel, setCopySourceUnitLabel] = useState('')
  const [copyNewIdentifier, setCopyNewIdentifier] = useState('')
  const [copyStructure, setCopyStructure] = useState(true)
  const [copyObservations, setCopyObservations] = useState(false)
  const [copyPhotos, setCopyPhotos] = useState(false)

  const [buildingOpen, setBuildingOpen] = useState(false)
  const [buildingBusy, setBuildingBusy] = useState(false)
  const [buildingFloorStart, setBuildingFloorStart] = useState(3)
  const [buildingFloorEnd, setBuildingFloorEnd] = useState(30)
  const [buildingUnitsPerFloor, setBuildingUnitsPerFloor] = useState(4)
  const [buildingPad2Digits, setBuildingPad2Digits] = useState(true)
  const [buildingApplyStagesToExistingMissing, setBuildingApplyStagesToExistingMissing] = useState(true)

  const [horizontalOpen, setHorizontalOpen] = useState(false)
  const [horizontalBusy, setHorizontalBusy] = useState(false)
  const [horizontalQuadraMode, setHorizontalQuadraMode] = useState('letter')
  const [horizontalQuadraStart, setHorizontalQuadraStart] = useState('A')
  const [horizontalQuadraEnd, setHorizontalQuadraEnd] = useState('D')
  const [horizontalLoteMode, setHorizontalLoteMode] = useState('number')
  const [horizontalLoteStart, setHorizontalLoteStart] = useState('1')
  const [horizontalLoteEnd, setHorizontalLoteEnd] = useState('20')
  const [horizontalApplyStagesToExistingMissing, setHorizontalApplyStagesToExistingMissing] = useState(true)

  useEffect(() => {
    const closeMenus = () => {
      setOpenTopMenu(false)
      setOpenUnitMenuId(null)
    }
    window.addEventListener('click', closeMenus)
    return () => window.removeEventListener('click', closeMenus)
  }, [])

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

    const { data: currentProfile, error: profileError } = await supabase
      .from('profiles')
      .select('id, role, status, tenant_id')
      .eq('id', u.id)
      .maybeSingle()

    if (profileError || !currentProfile) {
      alert(`Erro ao carregar perfil: ${profileError?.message || 'perfil nao encontrado'}`)
      setProfile(null)
      setProject(null)
      setUnits([])
      setStageTemplates([])
      setUnitStagesByUnitId({})
      setDuplicateStageWarnings([])
      setLoading(false)
      return
    }

    setProfile(currentProfile)

    const { data: p, error: pErr } = await supabase
      .from('projects')
      .select('id, name, description, client_name, city, address, progress, status')
      .eq('id', projectId)
      .maybeSingle()

    if (pErr) {
      alert(`Erro ao carregar obra: ${pErr.message}`)
      setProject(null)
      setUnits([])
      setStageTemplates([])
      setUnitStagesByUnitId({})
      setDuplicateStageWarnings([])
      setLoading(false)
      return
    }

    setProject(p || null)

    const { data: st, error: stErr } = await supabase
      .from('stages')
      .select('id, name, order_index, is_active, project_id')
      .eq('project_id', projectId)
      .order('order_index', { ascending: true })
      .order('name', { ascending: true })

    if (stErr) {
      console.error('Erro ao carregar etapas da obra:', stErr)
      alert(`Erro ao carregar etapas da obra: ${stErr.message}`)
      setStageTemplates([])
    } else {
      setStageTemplates(Array.isArray(st) ? st : [])
    }

    const { data: uRows, error: uErr } = await supabase
      .from('units')
      .select('id, project_id, identifier, status, progress, is_active')
      .eq('project_id', projectId)
      .order('identifier', { ascending: true })

    if (uErr) {
      alert(`Erro ao carregar unidades: ${uErr.message}`)
      setUnits([])
      setUnitStagesByUnitId({})
      setUnitStagesLoaded(false)
      setDuplicateStageWarnings([])
      setLoading(false)
      return
    }

    const unitList = Array.isArray(uRows) ? uRows : []
    setUnits(unitList)

    const unitIds = unitList.map((x) => x.id).filter(Boolean)
    if (unitIds.length > 0) {
      const grouped = Object.fromEntries(unitIds.map((currentUnitId) => [normalizeUnitMapKey(currentUnitId), []]))
      const { data: unitStages, error: usErr } = await supabase
        .from('unit_stages')
        .select(`
          id,
          unit_id,
          stage_id,
          status,
          is_active,
          notes,
          custom_name,
          order_index,
          unit_stage_photos ( id, path, caption, kind, created_at, user_id )
        `)
        .or('is_active.is.null,is_active.eq.true')
        .in('unit_id', unitIds)
        .limit(1000000)

      if (usErr) {
        console.error('Erro ao carregar etapas das unidades:', usErr)
        alert(`Erro ao carregar etapas das unidades: ${usErr.message}`)
        setUnitStagesByUnitId({})
        setUnitStagesLoaded(false)
        setDuplicateStageWarnings([])
      } else {
        const warnings = []
        for (const row of unitStages || []) {
          const key = normalizeUnitMapKey(row.unit_id)
          if (!grouped[key]) grouped[key] = []
          grouped[key].push({
            ...row,
            is_active: row?.is_active !== false,
            unit_stage_photos: Array.isArray(row.unit_stage_photos) ? row.unit_stage_photos : [],
          })
        }
        const normalizedGrouped = {}
        for (const [unitId, rows] of Object.entries(grouped)) {
          const metrics = calculateUnitMetrics(rows)
          normalizedGrouped[unitId] = metrics.rows
          if (metrics.reviewGroups.length > 0) {
            warnings.push({
              unitId,
              groups: metrics.reviewGroups,
            })
          }
        }
        setUnitStagesByUnitId(normalizedGrouped)
        setUnitStagesLoaded(true)
        setDuplicateStageWarnings(warnings)
      }
    } else {
      setUnitStagesByUnitId(Object.fromEntries(unitList.map((currentUnit) => [normalizeUnitMapKey(currentUnit.id), []])))
      setUnitStagesLoaded(true)
      setDuplicateStageWarnings([])
    }

    setLoading(false)
  }

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, projectId])

  const activeStages = useMemo(
    () => (stageTemplates || []).filter((s) => s.is_active !== false),
    [stageTemplates]
  )
  const isAdmin = profile?.role === 'admin'

  const stagesForList = useMemo(() => {
    if (showArchivedStages) return stageTemplates
    return stageTemplates.filter((s) => s.is_active !== false)
  }, [stageTemplates, showArchivedStages])

  const unitsWithMetrics = useMemo(() => {
    return units.map((unit) => ({
      ...unit,
      progress: clampPct(unit.progress),
      status: normalizeUnitStatus(unit.status),
    }))
  }, [units])

  const visibleUnits = useMemo(() => {
    return showArchivedUnits ? unitsWithMetrics : unitsWithMetrics.filter((u) => u.is_active !== false)
  }, [unitsWithMetrics, showArchivedUnits])

  const stats = useMemo(() => {
    const counts = { pending: 0, in_progress: 0, done: 0 }
    for (const unit of visibleUnits) {
      counts[unit.status] += 1
    }

    return {
      counts,
      total: visibleUnits.length,
      avg: clampPct(project?.progress),
      status: normalizeUnitStatus(project?.status),
    }
  }, [project, visibleUnits])

  const filteredUnits = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = [...visibleUnits]

    if (statusFilter !== 'all') {
      list = list.filter((u) => (u.status || 'pending') === statusFilter)
    }

    if (q) {
      list = list.filter((u) => includesText(u.identifier, q))
    }

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
  }, [visibleUnits, search, statusFilter, sortBy])

  function identifierAlreadyExists(identifier) {
    const id = safeStr(identifier).trim().toLowerCase()
    return units.some((u) => safeStr(u.identifier).trim().toLowerCase() === id)
  }

  async function createStageRowsForUnit(unitId) {
    if (!unitId) return
    if (activeStages.length === 0) return

    const rows = activeStages.map((s) => ({
      unit_id: unitId,
      stage_id: s.id,
      status: 'pending',
      is_active: true,
      order_index: s.order_index ?? null,
      custom_name: null,
      notes: null,
    }))

    const B = 500
    for (let i = 0; i < rows.length; i += B) {
      const chunk = rows.slice(i, i + B)
      const { error } = await supabase.from('unit_stages').insert(chunk)
      if (error) throw error
    }
  }

  function openCreateUnitModal() {
    if (!isAdmin) return
    setCreateUnitIdentifier('')
    setCreateUnitApplyStages(true)
    setCreateUnitOpen(true)
    setOpenTopMenu(false)
  }

  async function saveCreateUnit() {
    if (!isAdmin) return
    const identifier = safeStr(createUnitIdentifier).trim()

    if (!identifier) {
      alert('Informe o identificador da unidade.')
      return
    }

    if (identifierAlreadyExists(identifier)) {
      alert('Já existe uma unidade com esse identificador.')
      return
    }

    setCreateUnitBusy(true)
    try {
      await runAdminAction('create_unit', {
        project_id: projectId,
        identifier,
        apply_stages: createUnitApplyStages,
      })
      setCreateUnitOpen(false)
      await loadData()
    } finally {
      setCreateUnitBusy(false)
    }
  }

  function openEditUnitModal(unitRow) {
    setEditUnitId(unitRow.id)
    setEditUnitIdentifier(unitRow.identifier || '')
    setEditUnitOpen(true)
    setOpenUnitMenuId(null)
  }

  async function saveUnitEdit() {
    const identifier = safeStr(editUnitIdentifier).trim()

    if (!editUnitId) return
    if (!identifier) {
      alert('Informe o identificador da unidade.')
      return
    }

    const existsAnother = units.some(
      (u) =>
        normalizeUnitMapKey(u.id) !== normalizeUnitMapKey(editUnitId) &&
        safeStr(u.identifier).trim().toLowerCase() === identifier.toLowerCase()
    )

    if (existsAnother) {
      alert('Já existe outra unidade com esse identificador.')
      return
    }

    setEditUnitBusy(true)
    try {
      const { error } = await supabase
        .from('units')
        .update({ identifier })
        .eq('id', editUnitId)

      if (error) {
        alert(`Erro ao editar unidade: ${error.message}`)
        return
      }

      setEditUnitOpen(false)
      await loadData()
    } finally {
      setEditUnitBusy(false)
    }
  }

  async function deleteUnit(unitId, identifier) {
    if (!isAdmin) return
    const ok = window.confirm(`Excluir unidade ${identifier || ''}?`)
    if (!ok) return

    await runAdminAction('delete_unit', { unit_id: unitId })

    await loadData()
  }

  async function archiveUnit(unitRow) {
    const label = unitRow.is_active === false ? 'reativar' : 'arquivar'
    const ok = window.confirm(`Deseja ${label} a unidade ${unitRow.identifier || ''}?`)
    if (!ok) return

    const { error } = await supabase
      .from('units')
      .update({ is_active: unitRow.is_active === false ? true : false })
      .eq('id', unitRow.id)

    if (error) {
      alert(`Erro ao atualizar unidade: ${error.message}`)
      return
    }

    setOpenUnitMenuId(null)
    await loadData()
  }

  function openCopyModal(unitRow = null) {
    if (!isAdmin) return
    setCopySourceUnitId(unitRow?.id ? safeStr(unitRow.id) : '')
    setCopySourceUnitLabel(unitRow?.identifier || '')
    setCopyNewIdentifier('')
    setCopyStructure(true)
    setCopyObservations(false)
    setCopyPhotos(false)
    setCopyOpen(true)
    setOpenTopMenu(false)
    setOpenUnitMenuId(null)
  }

  async function copyUnitContent() {
    if (!isAdmin) return
    const sourceUnitId = safeStr(copySourceUnitId)
    const newIdentifier = safeStr(copyNewIdentifier).trim()

    if (!sourceUnitId) {
      alert('Selecione a unidade de origem.')
      return
    }

    if (!newIdentifier) {
      alert('Informe o identificador da nova unidade.')
      return
    }

    if (!copyStructure && !copyObservations && !copyPhotos) {
      alert('Selecione pelo menos 1 item para copiar.')
      return
    }

    if (!copyStructure && (copyObservations || copyPhotos)) {
      alert('Para copiar observações ou fotos, marque também Estrutura.')
      return
    }

    if (identifierAlreadyExists(newIdentifier)) {
      alert('Já existe uma unidade com esse identificador.')
      return
    }

    const sourceUnit = units.find((u) => normalizeUnitMapKey(u.id) === normalizeUnitMapKey(sourceUnitId))
    if (!sourceUnit) {
      alert('Unidade de origem não encontrada.')
      return
    }

    const sourceStages = (unitStagesByUnitId[normalizeUnitMapKey(sourceUnitId)] || [])
      .filter((r) => r.is_active !== false)
      .slice()
      .sort((a, b) => Number(a.order_index || 0) - Number(b.order_index || 0))

    if (copyStructure && sourceStages.length === 0) {
      alert('A unidade de origem não possui etapas ativas para copiar.')
      return
    }

    setCopyBusy(true)
    try {
      await runAdminAction('copy_unit', {
        source_unit_id: sourceUnitId,
        new_identifier: newIdentifier,
        copy_structure: copyStructure,
        copy_observations: copyObservations,
        copy_photos: copyPhotos,
      })
      setCopyOpen(false)
      await loadData()
      alert(`Unidade ${newIdentifier} criada com sucesso.`)
    } finally {
      setCopyBusy(false)
    }
  }

  function getMaxOrderIndex() {
    return (stageTemplates || []).reduce((m, s) => {
      const v = Number(s.order_index)
      if (!Number.isFinite(v)) return m
      return Math.max(m, v)
    }, 0)
  }

  async function createStageTemplate(name) {
    if (!isAdmin) return
    const n = safeStr(name).trim()
    if (!n) return
    await runAdminAction('create_stage_template', { project_id: projectId, name: n })

    setNewStageName('')
    await loadData()
  }

  async function bulkAddStagesFromLines() {
    if (!isAdmin) return
    const lines = safeStr(bulkStageLines)
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)

    if (lines.length === 0) {
      alert('Digite pelo menos 1 etapa (uma por linha).')
      return
    }

    setStagesBusy(true)
    try {
      await runAdminAction('bulk_add_stage_templates', { project_id: projectId, lines })
      setBulkStageLines('')
      await loadData()
    } finally {
      setStagesBusy(false)
    }
  }

  async function updateStageName(stageId, newName) {
    const n = safeStr(newName).trim()
    if (!n) {
      alert('Nome da etapa não pode ficar vazio.')
      return
    }

    const { error } = await supabase.from('stages').update({ name: n }).eq('id', stageId)
    if (error) {
      alert(`Erro ao salvar nome: ${error.message}`)
      return
    }

    await loadData()
  }

  async function moveStage(stageId, dir) {
    const list = [...stageTemplates].sort((a, b) => Number(a.order_index || 0) - Number(b.order_index || 0))
    const idx = list.findIndex((s) => s.id === stageId)
    if (idx === -1) return

    const j = idx + dir
    if (j < 0 || j >= list.length) return

    const a = list[idx]
    const b = list[j]

    const oa = Number(a.order_index || idx + 1)
    const ob = Number(b.order_index || j + 1)

    setStagesBusy(true)
    try {
      const { error: e1 } = await supabase.from('stages').update({ order_index: ob }).eq('id', a.id)
      if (e1) {
        alert(`Erro ao reordenar: ${e1.message}`)
        return
      }

      const { error: e2 } = await supabase.from('stages').update({ order_index: oa }).eq('id', b.id)
      if (e2) {
        alert(`Erro ao reordenar: ${e2.message}`)
        return
      }

      await loadData()
    } finally {
      setStagesBusy(false)
    }
  }

  async function archiveStage(stageId, isActiveNow) {
    const next = !isActiveNow ? true : false
    const label = next ? 'reativar' : 'arquivar'
    const ok = window.confirm(`Confirmar ${label} esta etapa?`)
    if (!ok) return

    const { error } = await supabase.from('stages').update({ is_active: next }).eq('id', stageId)
    if (error) {
      alert(`Erro ao atualizar etapa: ${error.message}`)
      return
    }

    await loadData()
  }

  async function applyStagesToUnitsMissingAny(unitIds) {
    const ids = unitIds.filter(Boolean)
    if (ids.length === 0) return { created: 0, affectedUnits: 0 }

    const stageIds = activeStages.map((s) => s.id)
    if (stageIds.length === 0) {
      alert('Cadastre as etapas desta obra primeiro (Etapas da obra).')
      return { created: 0, affectedUnits: 0 }
    }

    const { data: existing, error } = await supabase
      .from('unit_stages')
      .select('unit_id')
      .in('unit_id', ids)
      .limit(1000000)

    if (error) {
      alert(`Erro ao verificar etapas existentes: ${error.message}`)
      return { created: 0, affectedUnits: 0 }
    }

    const has = new Set((existing || []).map((r) => safeStr(r.unit_id)))
    const missing = ids.filter((uid) => !has.has(safeStr(uid)))
    if (missing.length === 0) return { created: 0, affectedUnits: 0 }

    const rows = []
    for (const uid of missing) {
      for (const s of activeStages) {
        rows.push({
          unit_id: uid,
          stage_id: s.id,
          status: 'pending',
          is_active: true,
          order_index: s.order_index ?? null,
        })
      }
    }

    let inserted = 0
    const B = 500
    for (let i = 0; i < rows.length; i += B) {
      const chunk = rows.slice(i, i + B)
      const { error: insErr } = await supabase.from('unit_stages').insert(chunk)
      if (insErr) {
        alert(`Erro ao criar etapas nas unidades: ${insErr.message}`)
        break
      }
      inserted += chunk.length
    }

    return { created: inserted, affectedUnits: missing.length }
  }

  async function applyStagesToAllExistingMissing() {
    if (!isAdmin) return
    const ok = window.confirm(
      `Aplicar o modelo de etapas para TODAS as unidades desta obra que ainda não têm etapas?\n\nIsso não mexe nas unidades que já têm etapas.`
    )
    if (!ok) return

    setStagesBusy(true)
    try {
      const unitIds = (units || []).map((u) => u.id)
      const res = await runAdminAction('apply_stages_to_units_missing_any', {
        project_id: projectId,
        unit_ids: unitIds,
      })
      alert(`Aplicação concluída.\nUnidades afetadas: ${res.affectedUnits}\nRegistros criados: ${res.created}`)
      await loadData()
    } finally {
      setStagesBusy(false)
    }
  }

  async function syncModelToAllUnits() {
    if (!isAdmin) return
    const ok = window.confirm(
      `ATUALIZAR MODELO EM TODAS AS UNIDADES?\n\n` +
      `• Cria etapas faltantes em cada unidade (sem duplicar)\n` +
      `• Arquiva/reativa etapas nas unidades conforme o modelo\n` +
      `• Não apaga fotos/notas/histórico`
    )
    if (!ok) return

    const unitIds = (units || []).map((u) => u.id).filter(Boolean)
    if (unitIds.length === 0) {
      alert('Esta obra não tem unidades.')
      return
    }

    if (!Array.isArray(stageTemplates) || stageTemplates.length === 0) {
      alert('Cadastre as etapas do modelo primeiro.')
      return
    }

    setStagesBusy(true)
    try {
      const res = await runAdminAction('sync_model_to_all_units', {
        project_id: projectId,
        unit_ids: unitIds,
      })
      alert(
        `Modelo atualizado!\n` +
        `Etapas criadas (faltantes): ${res.created}\n` +
        `Unidades afetadas: ${res.affectedUnits}`
      )

      await loadData()
    } finally {
      setStagesBusy(false)
    }
  }

  async function generateUnitsByBuilding() {
    if (!isAdmin) return
    if (!projectId) {
      alert('Projeto não encontrado.')
      return
    }

    const start = Number(buildingFloorStart)
    const end = Number(buildingFloorEnd)
    const perFloor = Number(buildingUnitsPerFloor)

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

    if (activeStages.length === 0) {
      alert('Antes de gerar unidades, cadastre as etapas da obra (Etapas da obra).')
      return
    }

    const identifiers = []
    for (let f = start; f <= end; f++) {
      for (let i = 1; i <= perFloor; i++) {
        identifiers.push(makeBuildingIdentifier(f, i, buildingPad2Digits))
      }
    }

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
      setBuildingBusy(true)
      const res = await runAdminAction('generate_units_building', {
        project_id: projectId,
        identifiers: toCreate,
        apply_existing_missing: buildingApplyStagesToExistingMissing,
        all_unit_ids: (units || []).map((u) => u.id),
      })
      alert(`Criadas ${res.created} unidades com etapas.`)
      setBuildingOpen(false)
      await loadData()
    } finally {
      setBuildingBusy(false)
    }
  }

  async function generateUnitsHorizontal() {
    if (!isAdmin) return
    if (!projectId) {
      alert('Projeto não encontrado.')
      return
    }

    if (activeStages.length === 0) {
      alert('Antes de gerar unidades, cadastre as etapas da obra (Etapas da obra).')
      return
    }

    const quadras =
      horizontalQuadraMode === 'letter'
        ? buildAlphaRange(horizontalQuadraStart, horizontalQuadraEnd)
        : buildNumericRange(horizontalQuadraStart, horizontalQuadraEnd)

    if (!quadras || quadras.length === 0) {
      alert('Faixa de quadras inválida.')
      return
    }

    const lotes =
      horizontalLoteMode === 'letter'
        ? buildAlphaRange(horizontalLoteStart, horizontalLoteEnd)
        : buildNumericRange(horizontalLoteStart, horizontalLoteEnd)

    if (!lotes || lotes.length === 0) {
      alert('Faixa de lotes inválida.')
      return
    }

    const identifiers = []
    for (const quadra of quadras) {
      for (const lote of lotes) {
        identifiers.push(buildLotIdentifier(quadra, lote))
      }
    }

    const existing = new Set((units || []).map((u) => safeStr(u?.identifier)))
    const toCreate = identifiers.filter((x) => !existing.has(x))

    if (toCreate.length === 0) {
      alert('Todas as unidades desse padrão já existem.')
      return
    }

    const ok = window.confirm(
      `Gerar ${toCreate.length} unidades horizontais?\n\nExemplo: ${toCreate.slice(0, 12).join(', ')}${toCreate.length > 12 ? '...' : ''}`
    )
    if (!ok) return

    try {
      setHorizontalBusy(true)
      const res = await runAdminAction('generate_units_horizontal', {
        project_id: projectId,
        identifiers: toCreate,
        apply_existing_missing: horizontalApplyStagesToExistingMissing,
        all_unit_ids: (units || []).map((u) => u.id),
      })
      alert(`Criadas ${res.created} unidades horizontais com etapas.`)
      setHorizontalOpen(false)
      await loadData()
    } finally {
      setHorizontalBusy(false)
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Obra</div>
          <h1 style={{ margin: 0 }}>{project.name || '(Sem nome)'}</h1>

          <div style={{ color: '#444', marginTop: 6 }}>
            Usuário logado: <b>{userEmail}</b>
          </div>

          {(project.client_name || project.city) ? (
            <div style={{ marginTop: 10, color: '#444' }}>
              {project.client_name ? <b>{project.client_name}</b> : null}
              {project.client_name && project.city ? ' • ' : null}
              {project.city ? project.city : null}
            </div>
          ) : null}

          {project.address ? <div style={{ marginTop: 4, color: '#666' }}>{project.address}</div> : null}
          {project.description ? <div style={{ marginTop: 8, color: '#777' }}>{project.description}</div> : null}

          <div style={{ color: '#444', marginTop: 10 }}>
            Etapas da obra (modelo): <b>{activeStages.length}</b>
            {activeStages.length === 0 ? (
              <span style={{ color: '#b00020' }}> (cadastre antes de gerar unidades)</span>
            ) : null}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#444' }}>
            <input
              type="checkbox"
              checked={showArchivedUnits}
              onChange={(e) => setShowArchivedUnits(e.target.checked)}
            />
            Mostrar arquivadas
          </label>

          {isAdmin ? (
            <button
              type="button"
              onClick={() => setStagesOpen(true)}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#fff',
                cursor: 'pointer',
                fontWeight: 900,
              }}
            >
              Etapas da obra
            </button>
          ) : null}

          <div
            style={{ position: 'relative' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => isAdmin && setOpenTopMenu((prev) => !prev)}
              disabled={!isAdmin}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: isAdmin ? '#111' : '#f3f4f6',
                color: isAdmin ? '#fff' : '#9ca3af',
                cursor: isAdmin ? 'pointer' : 'not-allowed',
                fontWeight: 900,
              }}
            >
              + Unidades
            </button>

            {isAdmin && openTopMenu ? (
              <div
                style={{
                  position: 'absolute',
                  top: 46,
                  right: 0,
                  minWidth: 260,
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
                  onClick={openCreateUnitModal}
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
                  Criar unidade
                </button>

                <button
                  type="button"
                  onClick={() => openCopyModal()}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 12px',
                    border: 'none',
                    borderTop: '1px solid #f1f1f1',
                    background: '#fff',
                    cursor: 'pointer',
                    fontWeight: 700,
                    color: '#111',
                  }}
                >
                  Duplicar unidade
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setBuildingOpen(true)
                    setOpenTopMenu(false)
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 12px',
                    border: 'none',
                    borderTop: '1px solid #f1f1f1',
                    background: '#fff',
                    cursor: 'pointer',
                    fontWeight: 700,
                    color: '#111',
                  }}
                >
                  Gerar múltiplas unidades (edifício)
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setHorizontalOpen(true)
                    setOpenTopMenu(false)
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 12px',
                    border: 'none',
                    borderTop: '1px solid #f1f1f1',
                    background: '#fff',
                    cursor: 'pointer',
                    fontWeight: 700,
                    color: '#111',
                  }}
                >
                  Gerar múltiplas unidades horizontais (loteamento)
                </button>
              </div>
            ) : null}
          </div>

          <Link href="/obras">← Voltar</Link>
        </div>
      </div>

      <hr style={{ margin: '18px 0' }} />

      {!isAdmin ? (
        <div style={{ marginBottom: 16, color: '#b00020' }}>
          Apenas administradores podem criar, copiar ou excluir obra, unidade e etapa.
        </div>
      ) : null}

      {duplicateStageWarnings.length > 0 ? (
        <div
          style={{
            marginBottom: 16,
            color: '#92400e',
            background: '#fffbeb',
            border: '1px solid #fcd34d',
            borderRadius: 12,
            padding: 12,
          }}
        >
          Foram encontradas {duplicateStageWarnings.length} unidade(s) com etapas duplicadas e dados conflitantes.
          A lista mostra apenas a etapa mais completa; a limpeza dessas duplicatas deve ser supervisionada.
        </div>
      ) : null}

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

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, minWidth: 0 }}>
          <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: '#666' }}>{STATUS_LABEL.pending}</div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>{stats.counts.pending || 0}/{stats.total}</div>
          </div>
          <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: '#666' }}>{STATUS_LABEL.in_progress}</div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>{stats.counts.in_progress || 0}/{stats.total}</div>
          </div>
          <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: '#666' }}>{STATUS_LABEL.done}</div>
            <div style={{ fontSize: 18, fontWeight: 900 }}>{stats.counts.done || 0}/{stats.total}</div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar unidade (ex: 401, QA L1, Q1 LA...)"
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
            fontWeight: 800,
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
            fontWeight: 800,
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
            type="button"
            onClick={() => setSearch('')}
            style={{
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid #ddd',
              background: '#fff',
              cursor: 'pointer',
              fontWeight: 800,
            }}
          >
            Limpar
          </button>
        ) : null}

        <div style={{ fontSize: 12, color: '#666' }}>
          Mostrando <b>{filteredUnits.length}</b> de <b>{visibleUnits.length}</b>
        </div>
      </div>

      <div
        style={{
          marginTop: 14,
          maxWidth: 1100,
          border: '1px solid #dbeafe',
          background: '#eff6ff',
          color: '#1d4ed8',
          borderRadius: 12,
          padding: '10px 12px',
          fontSize: 13,
          fontWeight: 900,
        }}
      >
        DEBUG_CARD_VERSION: a2c883b
      </div>

      <div style={{ marginTop: 14, maxWidth: 1100, display: 'grid', gap: 10 }}>
        {filteredUnits.length === 0 ? (
          <div style={{ color: '#666', marginTop: 8 }}>Nenhuma unidade encontrada.</div>
        ) : (
          filteredUnits.map((u) => {
            const unitKey = normalizeUnitMapKey(u.id)
            const hasStageRows = Object.prototype.hasOwnProperty.call(unitStagesByUnitId, unitKey)
            const stageRows = unitStagesLoaded && hasStageRows ? unitStagesByUnitId[unitKey] : null
            const stageCounters = buildUnitStageCounters(stageRows)
            const activeStageRows = Array.isArray(stageRows) ? stageRows.filter((row) => row?.is_active !== false) : []
            const sampleActiveStatuses = activeStageRows
              .slice(0, 3)
              .map((row) => safeStr(row?.status).trim().toLowerCase() || '∅')
              .join(', ')
            const pctUnit = Math.round(clampPct(u.progress))

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
                  gap: 12,
                  opacity: u.is_active === false ? 0.7 : 1,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 20, fontWeight: 900 }}>
                      Unidade {u.identifier || u.id}
                    </div>

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
                      {STATUS_PT[normalizeUnitStatus(u.status)] || '—'}
                    </span>

                    {u.is_active === false ? (
                      <span style={{ fontSize: 12, color: '#b00020', fontWeight: 900 }}>
                        (Arquivada)
                      </span>
                    ) : null}
                  </div>

                  <div
                    style={{
                      width: '100%',
                      fontSize: 11,
                      color: '#92400e',
                      background: '#fffbeb',
                      border: '1px solid #fcd34d',
                      borderRadius: 10,
                      padding: '8px 10px',
                      lineHeight: 1.45,
                    }}
                  >
                    DEBUG_UNIT: id={safeStr(u.id) || '—'} | identifier={safeStr(u.identifier) || '—'} | status={safeStr(u.status) || '—'} | progress={clampPct(u.progress)} | mapped_active={Array.isArray(stageRows) ? activeStageRows.length : 'null'} | done={stageCounters.doneCount ?? '--'} | pending={stageCounters.pendingCount ?? '--'} | in_progress={stageCounters.inProgressCount ?? '--'} | total={stageCounters.totalActiveStages ?? '--'} | sample_active_statuses=[{sampleActiveStatuses}]
                  </div>

                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Link href={`/unidades/${u.id}`} style={{ textDecoration: 'none' }}>
                      <button
                        type="button"
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
                        Abrir →
                      </button>
                    </Link>

                    <div
                      style={{ position: 'relative' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (!isAdmin) return
                          setOpenUnitMenuId((prev) => (prev === u.id ? null : u.id))
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
                        disabled={!isAdmin}
                      >
                        ⋯
                      </button>

                      {isAdmin && openUnitMenuId === u.id ? (
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
                            onClick={() => openEditUnitModal(u)}
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
                            onClick={() => openCopyModal(u)}
                            style={{
                              width: '100%',
                              textAlign: 'left',
                              padding: '10px 12px',
                              border: 'none',
                              borderTop: '1px solid #f1f1f1',
                              background: '#fff',
                              cursor: 'pointer',
                              fontWeight: 700,
                              color: '#111',
                            }}
                          >
                            Copiar
                          </button>

                          <button
                            type="button"
                            onClick={() => archiveUnit(u)}
                            style={{
                              width: '100%',
                              textAlign: 'left',
                              padding: '10px 12px',
                              border: 'none',
                              borderTop: '1px solid #f1f1f1',
                              background: '#fff',
                              cursor: 'pointer',
                              fontWeight: 700,
                              color: '#111',
                            }}
                          >
                            {u.is_active === false ? 'Reativar' : 'Arquivar'}
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setOpenUnitMenuId(null)
                              deleteUnit(u.id, u.identifier)
                            }}
                            style={{
                              width: '100%',
                              textAlign: 'left',
                              padding: '10px 12px',
                              border: 'none',
                              borderTop: '1px solid #f1f1f1',
                              background: '#fff',
                              cursor: 'pointer',
                              fontWeight: 700,
                              color: '#b00020',
                            }}
                          >
                            Excluir
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', fontSize: 13, color: '#444' }}>
                    <span>
                      Etapas:{' '}
                      <b>
                        {stageCounters.doneCount === null || stageCounters.totalActiveStages === null
                          ? '--/--'
                          : `${stageCounters.doneCount}/${stageCounters.totalActiveStages}`}
                      </b>
                    </span>

                    <span>
                      Observações: <b>{stageCounters.notesCount ?? '--'}</b>
                    </span>
                  </div>

                  <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: '#444' }}>
                      <span>Progresso</span>
                      <b>{formatPct(u.progress)}</b>
                    </div>

                    <div style={{ height: 10, background: '#f0f0f0', borderRadius: 999, overflow: 'hidden' }}>
                      <div style={{ width: `${pctUnit}%`, height: '100%', background: '#111', opacity: 0.18 }} />
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(100px, 1fr))', gap: 10 }}>
                    <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10 }}>
                      <div style={{ fontSize: 12, color: '#666' }}>pendentes</div>
                      <div style={{ fontSize: 18, fontWeight: 900 }}>{stageCounters.pendingCount ?? '--'}</div>
                    </div>

                    <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10 }}>
                      <div style={{ fontSize: 12, color: '#666' }}>em andamento</div>
                      <div style={{ fontSize: 18, fontWeight: 900 }}>{stageCounters.inProgressCount ?? '--'}</div>
                    </div>

                    <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10 }}>
                      <div style={{ fontSize: 12, color: '#666' }}>concluídas</div>
                      <div style={{ fontSize: 18, fontWeight: 900 }}>{stageCounters.doneCount ?? '--'}</div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      <Modal open={createUnitOpen} title="Criar unidade" onClose={() => setCreateUnitOpen(false)} busy={createUnitBusy}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Identificador da unidade *</div>
            <input
              value={createUnitIdentifier}
              onChange={(e) => setCreateUnitIdentifier(e.target.value)}
              placeholder="Ex: 401, QA L1, Q1 LA"
              disabled={createUnitBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                outline: 'none',
              }}
            />
          </div>

          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: createUnitBusy ? 'not-allowed' : 'pointer' }}>
            <input
              type="checkbox"
              checked={createUnitApplyStages}
              onChange={(e) => setCreateUnitApplyStages(e.target.checked)}
              disabled={createUnitBusy}
            />
            <span style={{ fontSize: 13, color: '#444' }}>
              Aplicar estrutura padrão de etapas da obra
            </span>
          </label>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setCreateUnitOpen(false)}
              disabled={createUnitBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#fff',
                cursor: createUnitBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              Cancelar
            </button>

            <button
              type="button"
              onClick={saveCreateUnit}
              disabled={createUnitBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#111',
                color: '#fff',
                cursor: createUnitBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              {createUnitBusy ? 'Criando…' : 'Criar unidade'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={editUnitOpen} title="Editar unidade" onClose={() => setEditUnitOpen(false)} busy={editUnitBusy}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Identificador da unidade *</div>
            <input
              value={editUnitIdentifier}
              onChange={(e) => setEditUnitIdentifier(e.target.value)}
              placeholder="Ex: 401"
              disabled={editUnitBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setEditUnitOpen(false)}
              disabled={editUnitBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#fff',
                cursor: editUnitBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              Cancelar
            </button>

            <button
              type="button"
              onClick={saveUnitEdit}
              disabled={editUnitBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#111',
                color: '#fff',
                cursor: editUnitBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              {editUnitBusy ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={copyOpen} title="Duplicar unidade" onClose={() => setCopyOpen(false)} busy={copyBusy}>
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 13, color: '#444', fontWeight: 900 }}>Unidade de origem</div>
            <select
              value={copySourceUnitId}
              onChange={(e) => {
                const unitId = e.target.value
                setCopySourceUnitId(unitId)
                const unitRow = units.find((u) => normalizeUnitMapKey(u.id) === normalizeUnitMapKey(unitId))
                setCopySourceUnitLabel(unitRow?.identifier || '')
              }}
              disabled={copyBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#fff',
                fontWeight: 800,
              }}
            >
              <option value="">Selecione uma unidade…</option>
              {units
                .filter((u) => u.is_active !== false)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.identifier || u.id}
                  </option>
                ))}
            </select>
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 13, color: '#444', fontWeight: 900 }}>Novo identificador da unidade</div>
            <input
              value={copyNewIdentifier}
              onChange={(e) => setCopyNewIdentifier(e.target.value)}
              placeholder="Ex: 402"
              disabled={copyBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                outline: 'none',
                width: 'min(320px, 100%)',
              }}
            />
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 13, color: '#444', fontWeight: 900 }}>O que copiar</div>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: copyBusy ? 'not-allowed' : 'pointer' }}>
              <input
                type="checkbox"
                checked={copyStructure}
                onChange={(e) => setCopyStructure(e.target.checked)}
                disabled={copyBusy}
              />
              <span style={{ fontSize: 13, color: '#444' }}>Estrutura</span>
            </label>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: copyBusy ? 'not-allowed' : 'pointer' }}>
              <input
                type="checkbox"
                checked={copyObservations}
                onChange={(e) => setCopyObservations(e.target.checked)}
                disabled={copyBusy}
              />
              <span style={{ fontSize: 13, color: '#444' }}>Observações</span>
            </label>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: copyBusy ? 'not-allowed' : 'pointer' }}>
              <input
                type="checkbox"
                checked={copyPhotos}
                onChange={(e) => setCopyPhotos(e.target.checked)}
                disabled={copyBusy}
              />
              <span style={{ fontSize: 13, color: '#444' }}>Fotos</span>
            </label>

            <div style={{ fontSize: 12, color: '#777' }}>
              Dica: se marcar apenas <b>Estrutura</b>, serão copiadas somente as etapas, sem observações e sem fotos.
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setCopyOpen(false)}
              disabled={copyBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#fff',
                cursor: copyBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              Cancelar
            </button>

            <button
              type="button"
              onClick={copyUnitContent}
              disabled={copyBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#111',
                color: '#fff',
                cursor: copyBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              {copyBusy ? 'Duplicando…' : 'Criar cópia'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={stagesOpen} title="Etapas da obra (modelo)" onClose={() => setStagesOpen(false)} busy={stagesBusy}>
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              value={newStageName}
              onChange={(e) => setNewStageName(e.target.value)}
              placeholder="Nova etapa (ex: Preparação, Impermeabilização...)"
              style={{
                width: 'min(520px, 100%)',
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                outline: 'none',
              }}
              disabled={stagesBusy}
            />

            <button
              type="button"
              onClick={() => createStageTemplate(newStageName)}
              disabled={stagesBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#111',
                color: '#fff',
                cursor: stagesBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              Adicionar
            </button>

            <button
              type="button"
              onClick={applyStagesToAllExistingMissing}
              disabled={stagesBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#fff',
                cursor: stagesBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
              title="Cria etapas para as unidades que estão sem etapas"
            >
              Aplicar nas unidades sem etapas
            </button>

            <button
              type="button"
              onClick={syncModelToAllUnits}
              disabled={stagesBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#111',
                color: '#fff',
                cursor: stagesBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
              title="Sincroniza o modelo para todas as unidades"
            >
              Atualizar modelo (todas as unidades)
            </button>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showArchivedStages}
                onChange={(e) => setShowArchivedStages(e.target.checked)}
                disabled={stagesBusy}
              />
              <span style={{ fontSize: 13, color: '#444' }}>Mostrar arquivadas</span>
            </label>
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 13, color: '#444', fontWeight: 900 }}>Adicionar várias etapas (1 por linha)</div>
            <textarea
              value={bulkStageLines}
              onChange={(e) => setBulkStageLines(e.target.value)}
              placeholder={`Ex:\nPreparação\nImpermeabilização\nAssentamento\nRejunte\nTeste\nEntrega`}
              style={{
                width: '100%',
                minHeight: 120,
                padding: 12,
                borderRadius: 12,
                border: '1px solid #ddd',
                outline: 'none',
                resize: 'vertical',
              }}
              disabled={stagesBusy}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={bulkAddStagesFromLines}
                disabled={stagesBusy}
                style={{
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px solid #ddd',
                  background: '#111',
                  color: '#fff',
                  cursor: stagesBusy ? 'not-allowed' : 'pointer',
                  fontWeight: 900,
                }}
              >
                Adicionar lista
              </button>
            </div>
          </div>

          <div style={{ fontSize: 13, color: '#666' }}>
            Total de etapas ativas: <b>{activeStages.length}</b>
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            {stagesForList.length === 0 ? (
              <div style={{ color: '#666' }}>Nenhuma etapa cadastrada.</div>
            ) : (
              stagesForList.map((s, idx) => (
                <div
                  key={s.id}
                  style={{
                    border: '1px solid #eee',
                    borderRadius: 12,
                    padding: 12,
                    display: 'grid',
                    gap: 8,
                    background: s.is_active === false ? '#fafafa' : '#fff',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 12, color: '#666' }}>#{idx + 1}</div>

                      <input
                        defaultValue={s.name || ''}
                        onBlur={(e) => updateStageName(s.id, e.target.value)}
                        disabled={stagesBusy}
                        style={{
                          padding: '10px 12px',
                          borderRadius: 12,
                          border: '1px solid #ddd',
                          outline: 'none',
                          minWidth: 320,
                          maxWidth: '100%',
                        }}
                      />

                      {s.is_active === false ? (
                        <span style={{ fontSize: 12, color: '#b00020', fontWeight: 900 }}>ARQUIVADA</span>
                      ) : null}
                    </div>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => moveStage(s.id, -1)}
                        disabled={stagesBusy}
                        style={{
                          padding: '8px 10px',
                          borderRadius: 12,
                          border: '1px solid #ddd',
                          background: '#fff',
                          cursor: stagesBusy ? 'not-allowed' : 'pointer',
                          fontWeight: 900,
                        }}
                        title="Subir"
                      >
                        ↑
                      </button>

                      <button
                        type="button"
                        onClick={() => moveStage(s.id, +1)}
                        disabled={stagesBusy}
                        style={{
                          padding: '8px 10px',
                          borderRadius: 12,
                          border: '1px solid #ddd',
                          background: '#fff',
                          cursor: stagesBusy ? 'not-allowed' : 'pointer',
                          fontWeight: 900,
                        }}
                        title="Descer"
                      >
                        ↓
                      </button>

                      <button
                        type="button"
                        onClick={() => archiveStage(s.id, s.is_active !== false)}
                        disabled={stagesBusy}
                        style={{
                          padding: '8px 10px',
                          borderRadius: 12,
                          border: '1px solid #ddd',
                          background: '#fff',
                          cursor: stagesBusy ? 'not-allowed' : 'pointer',
                          fontWeight: 900,
                        }}
                      >
                        {s.is_active === false ? 'Reativar' : 'Arquivar'}
                      </button>
                    </div>
                  </div>

                  <div style={{ fontSize: 12, color: '#777' }}>
                    Dica: o nome salva ao sair do campo. A ordem (order_index) define a ordem na unidade.
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </Modal>

      <Modal open={buildingOpen} title="Gerar múltiplas unidades (edifício)" onClose={() => setBuildingOpen(false)} busy={buildingBusy}>
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ fontSize: 13, color: '#444' }}>
            Etapas do modelo ativas: <b>{activeStages.length}</b>{' '}
            {activeStages.length === 0 ? <span style={{ color: '#b00020', fontWeight: 900 }}>(cadastre antes)</span> : null}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Pavimento inicial</div>
              <input
                type="number"
                value={buildingFloorStart}
                onChange={(e) => setBuildingFloorStart(e.target.value)}
                style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd' }}
                disabled={buildingBusy}
              />
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Pavimento final</div>
              <input
                type="number"
                value={buildingFloorEnd}
                onChange={(e) => setBuildingFloorEnd(e.target.value)}
                style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd' }}
                disabled={buildingBusy}
              />
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Unidades por pavimento</div>
              <input
                type="number"
                value={buildingUnitsPerFloor}
                onChange={(e) => setBuildingUnitsPerFloor(e.target.value)}
                style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd' }}
                disabled={buildingBusy}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: buildingBusy ? 'not-allowed' : 'pointer' }}>
              <input
                type="checkbox"
                checked={buildingPad2Digits}
                onChange={(e) => setBuildingPad2Digits(e.target.checked)}
                disabled={buildingBusy}
              />
              <span style={{ fontSize: 13, color: '#444' }}>
                Usar 2 dígitos (01, 02...) → Ex: 3 + 01 = <b>301</b>
              </span>
            </label>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: buildingBusy ? 'not-allowed' : 'pointer' }}>
              <input
                type="checkbox"
                checked={buildingApplyStagesToExistingMissing}
                onChange={(e) => setBuildingApplyStagesToExistingMissing(e.target.checked)}
                disabled={buildingBusy}
              />
              <span style={{ fontSize: 13, color: '#444' }}>Também aplicar etapas em unidades antigas sem etapas</span>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setBuildingOpen(false)}
              disabled={buildingBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#fff',
                cursor: buildingBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              Cancelar
            </button>

            <button
              type="button"
              onClick={generateUnitsByBuilding}
              disabled={buildingBusy || activeStages.length === 0}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: activeStages.length === 0 ? '#777' : '#111',
                color: '#fff',
                cursor: buildingBusy || activeStages.length === 0 ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              {buildingBusy ? 'Gerando…' : 'Gerar unidades + etapas'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={horizontalOpen} title="Gerar múltiplas unidades horizontais (loteamento)" onClose={() => setHorizontalOpen(false)} busy={horizontalBusy}>
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 13, color: '#444' }}>
            Exemplo de resultado: <b>QA L1</b>, <b>QA LA</b>, <b>Q1 L1</b>, <b>Q1 LA</b>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div style={{ display: 'grid', gap: 10 }}>
              <div style={{ fontSize: 13, color: '#444', fontWeight: 900 }}>Quadra</div>

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="radio"
                    checked={horizontalQuadraMode === 'letter'}
                    onChange={() => setHorizontalQuadraMode('letter')}
                    disabled={horizontalBusy}
                  />
                  <span>Letra</span>
                </label>

                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="radio"
                    checked={horizontalQuadraMode === 'number'}
                    onChange={() => setHorizontalQuadraMode('number')}
                    disabled={horizontalBusy}
                  />
                  <span>Número</span>
                </label>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Inicial</div>
                  <input
                    value={horizontalQuadraStart}
                    onChange={(e) => setHorizontalQuadraStart(e.target.value)}
                    placeholder={horizontalQuadraMode === 'letter' ? 'A' : '1'}
                    disabled={horizontalBusy}
                    style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', outline: 'none' }}
                  />
                </div>

                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Final</div>
                  <input
                    value={horizontalQuadraEnd}
                    onChange={(e) => setHorizontalQuadraEnd(e.target.value)}
                    placeholder={horizontalQuadraMode === 'letter' ? 'D' : '10'}
                    disabled={horizontalBusy}
                    style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', outline: 'none' }}
                  />
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 10 }}>
              <div style={{ fontSize: 13, color: '#444', fontWeight: 900 }}>Lote</div>

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="radio"
                    checked={horizontalLoteMode === 'letter'}
                    onChange={() => setHorizontalLoteMode('letter')}
                    disabled={horizontalBusy}
                  />
                  <span>Letra</span>
                </label>

                <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="radio"
                    checked={horizontalLoteMode === 'number'}
                    onChange={() => setHorizontalLoteMode('number')}
                    disabled={horizontalBusy}
                  />
                  <span>Número</span>
                </label>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Inicial</div>
                  <input
                    value={horizontalLoteStart}
                    onChange={(e) => setHorizontalLoteStart(e.target.value)}
                    placeholder={horizontalLoteMode === 'letter' ? 'A' : '1'}
                    disabled={horizontalBusy}
                    style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', outline: 'none' }}
                  />
                </div>

                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Final</div>
                  <input
                    value={horizontalLoteEnd}
                    onChange={(e) => setHorizontalLoteEnd(e.target.value)}
                    placeholder={horizontalLoteMode === 'letter' ? 'H' : '20'}
                    disabled={horizontalBusy}
                    style={{ padding: '10px 12px', borderRadius: 12, border: '1px solid #ddd', outline: 'none' }}
                  />
                </div>
              </div>
            </div>
          </div>

          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: horizontalBusy ? 'not-allowed' : 'pointer' }}>
            <input
              type="checkbox"
              checked={horizontalApplyStagesToExistingMissing}
              onChange={(e) => setHorizontalApplyStagesToExistingMissing(e.target.checked)}
              disabled={horizontalBusy}
            />
            <span style={{ fontSize: 13, color: '#444' }}>Também aplicar etapas em unidades antigas sem etapas</span>
          </label>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setHorizontalOpen(false)}
              disabled={horizontalBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#fff',
                cursor: horizontalBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              Cancelar
            </button>

            <button
              type="button"
              onClick={generateUnitsHorizontal}
              disabled={horizontalBusy || activeStages.length === 0}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: activeStages.length === 0 ? '#777' : '#111',
                color: '#fff',
                cursor: horizontalBusy || activeStages.length === 0 ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              {horizontalBusy ? 'Gerando…' : 'Gerar unidades horizontais'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
