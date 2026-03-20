import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { supabase } from '../../lib/supabase'
import { createIssue, deleteIssue, listIssuesByUnit, updateIssue } from '../../lib/issues-service'

const BUCKET = 'unit-stage-photos'

const ISSUE_STATUS_PT = {
  open: 'Aberta',
  in_progress: 'Em andamento',
  resolved: 'Resolvida',
}

const ISSUE_PRIORITY_PT = {
  low: 'Baixa',
  medium: 'Média',
  high: 'Alta',
}

const EMPTY_ISSUE_FORM = {
  unit_stage_id: '',
  title: '',
  description: '',
  priority: 'medium',
  assigned_to: '',
  status: 'open',
}

const STATUS_PT = {
  pending: 'Pendente',
  in_progress: 'Em andamento',
  done: 'Concluído',
}

const STATUS_TONE = {
  pending: {
    background: '#FEE2E2',
    color: '#991B1B',
    hover: '#FECACA',
  },
  in_progress: {
    background: '#FEF3C7',
    color: '#92400E',
    hover: '#FDE68A',
  },
  done: {
    background: '#DCFCE7',
    color: '#166534',
    hover: '#BBF7D0',
  },
}

function safeStr(v) {
  return (v ?? '').toString()
}

function extFromName(name) {
  const n = safeStr(name).toLowerCase()
  const i = n.lastIndexOf('.')
  if (i === -1) return 'jpg'
  const ext = n.slice(i + 1)
  if (!ext) return 'jpg'
  return ext
}

function randomId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16)
}

function clampInt(n, min, max) {
  const v = Number(n)
  if (!Number.isFinite(v)) return min
  return Math.max(min, Math.min(max, Math.floor(v)))
}

function formatDateTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('pt-BR')
}

function formatStatusLabel(status) {
  return STATUS_PT[status] || status || '—'
}

function formatIssueStatusLabel(status) {
  return ISSUE_STATUS_PT[status] || status || 'â€”'
}

function formatIssuePriorityLabel(priority) {
  return ISSUE_PRIORITY_PT[priority] || priority || 'â€”'
}

function normalizeStageStatus(status) {
  if (status === 'pending' || status === 'in_progress' || status === 'done') return status
  return 'pending'
}

function issueStatusToStageStatus(status) {
  if (status === 'resolved') return 'done'
  if (status === 'in_progress') return 'in_progress'
  return 'pending'
}

function getStatusTone(status) {
  return STATUS_TONE[normalizeStageStatus(status)] || STATUS_TONE.pending
}

function getIssueStatusTone(status) {
  return STATUS_TONE[issueStatusToStageStatus(status)] || STATUS_TONE.pending
}

function buildStatusPillStyle(tone, { interactive = false, expanded = false } = {}) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '6px 12px',
    minHeight: 30,
    borderRadius: 999,
    border: '1px solid transparent',
    background: tone.background,
    color: tone.color,
    fontSize: 14,
    fontWeight: 600,
    lineHeight: 1.2,
    whiteSpace: 'nowrap',
    transition: 'background-color 160ms ease, box-shadow 160ms ease, opacity 160ms ease',
    cursor: interactive ? 'pointer' : 'default',
    width: expanded ? '100%' : 'auto',
  }
}

function serializeIssueForLog(issue) {
  if (!issue) return null
  return {
    id: issue.id || null,
    title: safeStr(issue.title).trim(),
    description: safeStr(issue.description).trim(),
    priority: safeStr(issue.priority) || 'medium',
    assigned_to: safeStr(issue.assigned_to) || null,
    status: safeStr(issue.status) || 'open',
  }
}

function buildLogDescription(log) {
  const action = safeStr(log?.action)
  const oldValue = log?.old_value || {}
  const newValue = log?.new_value || {}

  if (action === 'status_changed') {
    const from = formatStatusLabel(oldValue?.status)
    const to = formatStatusLabel(newValue?.status)
    if (oldValue?.status && newValue?.status) {
      return `alterou o status de "${from}" para "${to}"`
    }
    if (newValue?.status) {
      return `alterou o status para "${to}"`
    }
    return 'alterou o status'
  }

  if (action === 'photo_added') {
    const caption = safeStr(newValue?.caption).trim()
    return caption ? `adicionou uma foto (${caption})` : 'adicionou uma foto'
  }

  if (action === 'notes_updated') {
    return 'atualizou as observações'
  }

  if (action === 'photo_deleted') {
    const caption = safeStr(oldValue?.caption).trim()
    return caption ? `removeu uma foto (${caption})` : 'removeu uma foto'
  }

  if (action === 'stage_archived') {
    return 'arquivou a etapa'
  }

  if (action === 'stage_unarchived') {
    return 'desarquivou a etapa'
  }

  if (action === 'stage_renamed') {
    const from = safeStr(oldValue?.name).trim()
    const to = safeStr(newValue?.name).trim()
    if (from && to) return `renomeou a etapa de "${from}" para "${to}"`
    if (to) return `definiu o nome da etapa como "${to}"`
    return 'renomeou a etapa'
  }

  if (action === 'stage_copied') {
    const name = safeStr(newValue?.new_stage_name).trim()
    return name ? `copiou a etapa para "${name}"` : 'copiou a etapa'
  }

  if (action === 'issue_created') {
    const title = safeStr(newValue?.title).trim()
    return title ? `criou a pendência "${title}"` : 'criou uma pendência'
  }

  if (action === 'issue_updated') {
    const from = safeStr(oldValue?.title).trim()
    const to = safeStr(newValue?.title).trim()
    if (from && to && from !== to) return `editou a pendência "${from}" para "${to}"`
    if (to) return `editou a pendência "${to}"`
    return 'editou uma pendência'
  }

  if (action === 'issue_deleted') {
    const title = safeStr(oldValue?.title).trim()
    return title ? `excluiu a pendência "${title}"` : 'excluiu uma pendência'
  }

  if (action === 'issue_status_changed') {
    const title = safeStr(newValue?.title || oldValue?.title).trim()
    const from = formatIssueStatusLabel(oldValue?.status)
    const to = formatIssueStatusLabel(newValue?.status)
    if (title && oldValue?.status && newValue?.status) {
      return `alterou o status da pendência "${title}" de "${from}" para "${to}"`
    }
    if (title && newValue?.status) {
      return `alterou o status da pendência "${title}" para "${to}"`
    }
    return 'alterou o status de uma pendência'
  }

  return action ? action.replaceAll('_', ' ') : 'realizou uma ação'
}

function Modal({ open, title, onClose, children, busy }) {
  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

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
          width: 'min(940px, 100%)',
          background: '#fff',
          borderRadius: 16,
          border: '1px solid #eee',
          boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          padding: 16,
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
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
            marginTop: 12,
            overflowY: 'auto',
            paddingRight: 6,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}

function PhotoViewer({ open, photos, photoId, signedUrlByPhotoId, onClose, onPrev, onNext }) {
  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
      if (e.key === 'ArrowLeft') onPrev?.()
      if (e.key === 'ArrowRight') onNext?.()
    }

    window.addEventListener('keydown', onKey)

    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, onPrev, onNext])

  if (!open) return null

  const currentIndex = photos.findIndex((p) => p.id === photoId)
  const currentPhoto = currentIndex >= 0 ? photos[currentIndex] : null
  const currentUrl = currentPhoto ? signedUrlByPhotoId[currentPhoto.id] : ''

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(0,0,0,0.88)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 18,
      }}
    >
      <div
        style={{
          width: 'min(1200px, 100%)',
          height: 'min(92vh, 100%)',
          display: 'grid',
          gridTemplateRows: 'auto 1fr auto',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', color: '#fff' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 900 }}>
              Visualização da foto
            </div>
            <div style={{ fontSize: 13, opacity: 0.85, marginTop: 4 }}>
              {currentPhoto?.caption ? currentPhoto.caption : 'Sem legenda'}
              {currentPhoto?.created_at ? ` • ${formatDateTime(currentPhoto.created_at)}` : ''}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.25)',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              cursor: 'pointer',
              fontWeight: 900,
            }}
          >
            Fechar ✕
          </button>
        </div>

        <div
          style={{
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            gap: 12,
            alignItems: 'center',
          }}
        >
          <button
            type="button"
            onClick={onPrev}
            disabled={!currentPhoto || photos.length <= 1}
            style={{
              padding: '12px 14px',
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.25)',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              cursor: !currentPhoto || photos.length <= 1 ? 'not-allowed' : 'pointer',
              fontWeight: 900,
              opacity: !currentPhoto || photos.length <= 1 ? 0.5 : 1,
            }}
          >
            ←
          </button>

          <div
            style={{
              minHeight: 0,
              height: '100%',
              borderRadius: 16,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.03)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            {currentPhoto && currentUrl ? (
              <img
                src={currentUrl}
                alt={currentPhoto.caption || 'foto'}
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  display: 'block',
                }}
              />
            ) : (
              <div style={{ color: '#fff', opacity: 0.8 }}>Carregando foto…</div>
            )}
          </div>

          <button
            type="button"
            onClick={onNext}
            disabled={!currentPhoto || photos.length <= 1}
            style={{
              padding: '12px 14px',
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.25)',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              cursor: !currentPhoto || photos.length <= 1 ? 'not-allowed' : 'pointer',
              fontWeight: 900,
              opacity: !currentPhoto || photos.length <= 1 ? 0.5 : 1,
            }}
          >
            →
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', color: '#fff', fontSize: 13, opacity: 0.85 }}>
          {currentIndex >= 0 ? `${currentIndex + 1} de ${photos.length}` : ''}
        </div>
      </div>
    </div>
  )
}

export default function UnidadePage() {
  const router = useRouter()
  const { id } = router.query

  const unitId = useMemo(() => {
    if (!id) return null
    if (Array.isArray(id)) return id[0] || null
    return String(id)
  }, [id])

  const [loading, setLoading] = useState(true)
  const [user, setUser] = useState(null)

  const [unit, setUnit] = useState(null)
  const [stages, setStages] = useState([])
  const [stageCatalog, setStageCatalog] = useState([])
  const [stageLogsByStageId, setStageLogsByStageId] = useState({})
  const [issues, setIssues] = useState([])
  const [issueAssignees, setIssueAssignees] = useState([])
  const [issueModalOpen, setIssueModalOpen] = useState(false)
  const [issueModalStageId, setIssueModalStageId] = useState('')
  const [issueModalBusy, setIssueModalBusy] = useState(false)
  const [issueForm, setIssueForm] = useState(EMPTY_ISSUE_FORM)
  const [editingIssueId, setEditingIssueId] = useState('')
  const [issueSavingId, setIssueSavingId] = useState('')

  const [signedUrlByPhotoId, setSignedUrlByPhotoId] = useState({})
  const [busyStageId, setBusyStageId] = useState(null)
  const [uploadingStageId, setUploadingStageId] = useState(null)
  const [deletingPhotoId, setDeletingPhotoId] = useState(null)

  const [openStatusMenuStageId, setOpenStatusMenuStageId] = useState(null)
  const [showArchived, setShowArchived] = useState(false)

  const [manageOpen, setManageOpen] = useState(false)
  const [manageBusy, setManageBusy] = useState(false)
  const [addStageId, setAddStageId] = useState('')
  const [createStageName, setCreateStageName] = useState('')

  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerPhotos, setViewerPhotos] = useState([])
  const [viewerPhotoId, setViewerPhotoId] = useState(null)

  const [openActionMenuStageId, setOpenActionMenuStageId] = useState(null)

  const [renameOpen, setRenameOpen] = useState(false)
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameStageId, setRenameStageId] = useState('')
  const [renameStageCurrentName, setRenameStageCurrentName] = useState('')
  const [renameStageValue, setRenameStageValue] = useState('')

  const [copyOpen, setCopyOpen] = useState(false)
  const [copyBusy, setCopyBusy] = useState(false)
  const [copySourceStage, setCopySourceStage] = useState(null)
  const [copyName, setCopyName] = useState('')
  const [copyStructure, setCopyStructure] = useState(true)
  const [copyNotes, setCopyNotes] = useState(false)
  const [copyPhotos, setCopyPhotos] = useState(false)

  useEffect(() => {
    if (!openActionMenuStageId) return
    const close = () => setOpenActionMenuStageId(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [openActionMenuStageId])

  useEffect(() => {
    if (!openStatusMenuStageId) return
    const close = () => setOpenStatusMenuStageId(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [openStatusMenuStageId])

  const issueAssigneeNameById = useMemo(
    () =>
      Object.fromEntries(
        (issueAssignees || []).map((profile) => [profile.id, safeStr(profile.full_name).trim() || 'Usuário'])
      ),
    [issueAssignees]
  )

  const issuesByStageId = useMemo(() => {
    const grouped = {}
    for (const issue of issues || []) {
      const key = safeStr(issue?.unit_stage_id)
      if (!key) continue
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(issue)
    }

    for (const key of Object.keys(grouped)) {
      grouped[key].sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))
    }

    return grouped
  }, [issues])

  const openIssueCountByStageId = useMemo(() => {
    const counts = {}
    for (const issue of issues || []) {
      const key = safeStr(issue?.unit_stage_id)
      if (!key) continue
      if (safeStr(issue?.status) !== 'open') continue
      counts[key] = (counts[key] || 0) + 1
    }
    return counts
  }, [issues])

  const selectedIssueStage = useMemo(
    () => stages.find((stage) => stage.id === issueModalStageId) || null,
    [stages, issueModalStageId]
  )

  const selectedStageIssues = useMemo(
    () => issuesByStageId[issueModalStageId] || [],
    [issuesByStageId, issueModalStageId]
  )

  function resetIssueForm() {
    setIssueForm(EMPTY_ISSUE_FORM)
    setEditingIssueId('')
  }

  function openStageIssuesModal(stageRow) {
    setIssueModalStageId(stageRow.id)
    setIssueModalOpen(true)
    resetIssueForm()
  }

  function openEditIssueModal(issue) {
    setIssueModalStageId(safeStr(issue?.unit_stage_id))
    setEditingIssueId(issue.id)
    setIssueForm({
      unit_stage_id: safeStr(issue?.unit_stage_id),
      title: safeStr(issue?.title),
      description: safeStr(issue?.description),
      priority: safeStr(issue?.priority) || 'medium',
      assigned_to: safeStr(issue?.assigned_to),
      status: safeStr(issue?.status) || 'open',
    })
    setIssueModalOpen(true)
  }

  function startCreateIssueForStage(stageId) {
    setEditingIssueId('')
    setIssueForm({
      ...EMPTY_ISSUE_FORM,
      unit_stage_id: stageId,
    })
  }

  async function createStageLog(unitStageId, action, oldValue, newValue, actorId) {
    const userId = actorId || user?.id
    if (!unitStageId || !userId) return

    await supabase.from('unit_stage_logs').insert({
      unit_stage_id: unitStageId,
      user_id: userId,
      action,
      old_value: oldValue,
      new_value: newValue,
    })
  }

  async function ensureAuth() {
    const { data, error } = await supabase.auth.getUser()
    if (error || !data?.user) {
      window.location.href = '/login'
      return null
    }
    setUser(data.user)
    return data.user
  }

  async function hydrateSignedUrls(stageList) {
    const photos = []
    for (const s of stageList) {
      for (const p of s.photos || []) photos.push(p)
    }

    const missing = photos.filter((p) => p?.id && p?.path && !signedUrlByPhotoId[p.id])
    if (missing.length === 0) return

    const updates = {}
    for (const p of missing) {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(p.path, 60 * 60)
      if (!error && data?.signedUrl) updates[p.id] = data.signedUrl
    }

    if (Object.keys(updates).length > 0) {
      setSignedUrlByPhotoId((prev) => ({ ...prev, ...updates }))
    }
  }

  function normalizeStages(stageRows) {
    const normalized = (stageRows || []).map((r) => ({
      ...r,
      is_active: r.is_active !== false,
      stage_name: r.custom_name || r.stages?.name || '(Sem nome)',
      stage_template_name: r.stages?.name || '(Sem nome)',
      photos: Array.isArray(r.unit_stage_photos) ? r.unit_stage_photos : [],
      order_index: Number.isFinite(Number(r.order_index)) ? Number(r.order_index) : 1,
    }))

    normalized.sort((a, b) => {
      const ao = Number(a.order_index || 0)
      const bo = Number(b.order_index || 0)
      if (ao !== bo) return ao - bo
      return safeStr(a.stage_name).localeCompare(safeStr(b.stage_name), 'pt-BR', { numeric: true })
    })

    return normalized
  }

  async function loadLogsForStages(stageList, currentUser) {
    const stageIds = (stageList || []).map((s) => s.id).filter(Boolean)

    if (stageIds.length === 0) {
      setStageLogsByStageId({})
      return
    }

    const { data: logs, error: logsErr } = await supabase
      .from('unit_stage_logs')
      .select('id, unit_stage_id, user_id, action, old_value, new_value, created_at')
      .in('unit_stage_id', stageIds)
      .order('created_at', { ascending: false })

    if (logsErr) {
      console.error('Erro ao carregar histórico das etapas:', logsErr)
      setStageLogsByStageId({})
      return
    }

    const userIds = [...new Set((logs || []).map((l) => l.user_id).filter(Boolean))]

    let profilesById = {}
    if (userIds.length > 0) {
      const { data: profiles, error: pErr } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', userIds)

      if (pErr) {
        console.error('Erro ao carregar nomes dos usuários do histórico:', pErr)
      } else {
        profilesById = Object.fromEntries((profiles || []).map((p) => [p.id, p]))
      }
    }

    const grouped = {}
    for (const log of logs || []) {
      const unitStageId = log.unit_stage_id
      if (!grouped[unitStageId]) grouped[unitStageId] = []

      grouped[unitStageId].push({
        ...log,
        user_name:
          profilesById[log.user_id]?.full_name ||
          (log.user_id === currentUser?.id ? currentUser?.email : '') ||
          'Usuário',
      })
    }

    setStageLogsByStageId(grouped)
  }

  async function loadAll() {
    if (!router.isReady) return
    if (!unitId) return

    setLoading(true)

    const currentUser = await ensureAuth()
    if (!currentUser) return

    const { data: unitData, error: unitErr } = await supabase
      .from('units')
      .select('id, identifier, project_id')
      .eq('id', unitId)
      .maybeSingle()

    if (unitErr) {
      console.error('Erro ao carregar unidade:', unitErr)
      alert(`Erro ao carregar unidade: ${unitErr.message}`)
      setUnit(null)
      setStages([])
      setIssues([])
      setStageLogsByStageId({})
      setLoading(false)
      return
    }

    if (!unitData) {
      setUnit(null)
      setStages([])
      setIssues([])
      setStageLogsByStageId({})
      setLoading(false)
      return
    }

    const { data: projectData, error: projectErr } = await supabase
      .from('projects')
      .select('id, tenant_id')
      .eq('id', unitData.project_id)
      .maybeSingle()

    if (projectErr) {
      console.error('Erro ao carregar projeto da unidade:', projectErr)
      alert(`Erro ao carregar unidade: ${projectErr.message}`)
      setUnit(null)
      setStages([])
      setIssues([])
      setStageLogsByStageId({})
      setLoading(false)
      return
    }

    const resolvedUnit = {
      ...unitData,
      tenant_id: projectData?.tenant_id || null,
    }

    setUnit(resolvedUnit)

    const [
      { data: catalog, error: cErr },
      { data: stageRows, error: stageErr },
      { data: issuesRows, error: issuesErr },
      { data: assigneeRows, error: assigneesErr },
    ] = await Promise.all([
      supabase
        .from('stages')
        .select('id, name, order_index, is_active, project_id')
        .eq('project_id', resolvedUnit.project_id)
        .order('order_index', { ascending: true })
        .order('name', { ascending: true }),
      supabase
        .from('unit_stages')
        .select(
          `
          id,
          unit_id,
          stage_id,
          status,
          started_at,
          finished_at,
          notes,
          custom_name,
          order_index,
          is_active,
          stages ( id, name ),
          unit_stage_photos ( id, path, caption, kind, created_at, user_id )
        `
        )
        .eq('unit_id', unitId),
      listIssuesByUnit(unitId),
      supabase.from('profiles').select('id, full_name').order('full_name', { ascending: true }),
    ])

    if (!cErr) {
      setStageCatalog(Array.isArray(catalog) ? catalog.filter((s) => s.is_active !== false) : [])
    } else {
      console.error('Erro ao carregar catálogo de etapas:', cErr)
      setStageCatalog([])
    }

    if (stageErr) {
      console.error('Erro ao carregar etapas:', stageErr)
      alert(`Erro ao carregar etapas: ${stageErr.message}`)
      setStages([])
      setIssues([])
      setStageLogsByStageId({})
      setLoading(false)
      return
    }

    if (issuesErr) {
      console.error('Erro ao carregar issues da unidade:', issuesErr)
      setIssues([])
    } else {
      setIssues(Array.isArray(issuesRows) ? issuesRows : [])
    }

    if (assigneesErr) {
      console.error('Erro ao carregar responsáveis das issues:', assigneesErr)
      setIssueAssignees([])
    } else {
      setIssueAssignees(Array.isArray(assigneeRows) ? assigneeRows : [])
    }

    const normalized = normalizeStages(stageRows || [])
    setStages(normalized)

    const visible = showArchived ? normalized : normalized.filter((s) => s.is_active !== false)
    await hydrateSignedUrls(visible)
    await loadLogsForStages(normalized, currentUser)

    setLoading(false)
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, unitId])

  useEffect(() => {
    if (!router.isReady || !unitId) return
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived])

  function nextOrderIndex() {
    const max = (stages || []).reduce((m, s) => Math.max(m, Number(s.order_index || 0)), 0)
    return max + 1
  }

  function openPhotoViewer(stagePhotos, photoId) {
    const sorted = [...(stagePhotos || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    setViewerPhotos(sorted)
    setViewerPhotoId(photoId)
    setViewerOpen(true)
  }

  function closePhotoViewer() {
    setViewerOpen(false)
    setViewerPhotos([])
    setViewerPhotoId(null)
  }

  function showPrevPhoto() {
    if (!viewerPhotos.length || !viewerPhotoId) return
    const idx = viewerPhotos.findIndex((p) => p.id === viewerPhotoId)
    if (idx === -1) return
    const prevIdx = idx === 0 ? viewerPhotos.length - 1 : idx - 1
    setViewerPhotoId(viewerPhotos[prevIdx].id)
  }

  function showNextPhoto() {
    if (!viewerPhotos.length || !viewerPhotoId) return
    const idx = viewerPhotos.findIndex((p) => p.id === viewerPhotoId)
    if (idx === -1) return
    const nextIdx = idx === viewerPhotos.length - 1 ? 0 : idx + 1
    setViewerPhotoId(viewerPhotos[nextIdx].id)
  }

  function openRenameModal(stageRow) {
    setOpenActionMenuStageId(null)
    setRenameStageId(stageRow.id)
    setRenameStageCurrentName(stageRow.stage_name || '')
    setRenameStageValue(stageRow.custom_name || stageRow.stage_name || '')
    setRenameOpen(true)
  }

  function openCopyModal(stageRow) {
    setOpenActionMenuStageId(null)
    setCopySourceStage(stageRow)
    setCopyName(`${stageRow.stage_name} (cópia)`)
    setCopyStructure(true)
    setCopyNotes(false)
    setCopyPhotos(false)
    setCopyOpen(true)
  }

  async function saveIssue() {
    const currentStageId = safeStr(issueForm.unit_stage_id || issueModalStageId)
    const trimmedTitle = safeStr(issueForm.title).trim()
    const currentUser = user || (await ensureAuth())
    const existingIssue = editingIssueId ? issues.find((issue) => issue.id === editingIssueId) || null : null
    if (!currentStageId) {
      alert('Selecione uma etapa para a pendência.')
      return
    }
    if (!trimmedTitle) {
      alert('Informe o título da pendência.')
      return
    }
    if (!editingIssueId && (!unit?.project_id || !unit?.tenant_id)) {
      alert('Não foi possível identificar a obra da unidade para criar a pendência.')
      return
    }

    if (!editingIssueId && !currentUser?.id) {
      alert('Não foi possível identificar o usuário para criar a pendência.')
      return
    }

    try {
      setIssueModalBusy(true)

      const payload = {
        unit_stage_id: currentStageId,
        title: trimmedTitle,
        description: safeStr(issueForm.description),
        priority: safeStr(issueForm.priority) || 'medium',
        assigned_to: safeStr(issueForm.assigned_to),
        status: safeStr(issueForm.status) || 'open',
      }

      const result = editingIssueId
        ? await updateIssue(editingIssueId, payload)
        : await createIssue({
            tenant_id: unit?.tenant_id,
            project_id: unit?.project_id,
            unit_id: unitId,
            created_by: currentUser.id,
            ...payload,
          })

      if (result.error) {
        alert(`Erro ao salvar pendência: ${result.error.message}`)
        return
      }

      const savedIssue = result.data || { id: editingIssueId, ...payload }

      if (editingIssueId) {
        await createStageLog(
          currentStageId,
          'issue_updated',
          serializeIssueForLog(existingIssue),
          serializeIssueForLog(savedIssue),
          currentUser?.id
        )
      } else {
        await createStageLog(
          currentStageId,
          'issue_created',
          null,
          serializeIssueForLog(savedIssue),
          currentUser?.id
        )
      }

      setIssueModalOpen(false)
      setIssueModalStageId('')
      resetIssueForm()
      await loadAll()
    } finally {
      setIssueModalBusy(false)
    }
  }

  async function changeIssueStatus(issueId, nextStatus) {
    try {
      setIssueSavingId(issueId)

      const currentUser = user || (await ensureAuth())
      const currentIssue = issues.find((issue) => issue.id === issueId)
      if (!currentIssue || !currentUser?.id) return

      const { data, error } = await updateIssue(issueId, { status: nextStatus })
      if (error) {
        alert(`Erro ao atualizar pendência: ${error.message}`)
        return
      }

      await createStageLog(
        currentIssue.unit_stage_id,
        'issue_status_changed',
        serializeIssueForLog(currentIssue),
        serializeIssueForLog(data || { ...currentIssue, status: nextStatus }),
        currentUser.id
      )

      await loadAll()
    } finally {
      setIssueSavingId('')
    }
  }

  async function deleteIssueRecord(issue) {
    if (!issue?.id) return

    const currentUser = user || (await ensureAuth())
    if (!currentUser?.id) {
      alert('Não foi possível identificar o usuário para excluir a pendência.')
      return
    }

    const ok = window.confirm(`Excluir a pendência "${safeStr(issue.title).trim() || 'Sem título'}"?`)
    if (!ok) return

    try {
      setIssueSavingId(issue.id)

      const { error } = await deleteIssue(issue.id)
      if (error) {
        alert(`Erro ao excluir pendência: ${error.message}`)
        return
      }

      setIssues((prev) => prev.filter((row) => row.id !== issue.id))

      await createStageLog(
        issue.unit_stage_id,
        'issue_deleted',
        serializeIssueForLog(issue),
        null,
        currentUser.id
      )

      await loadAll()
    } finally {
      setIssueSavingId('')
    }
  }

  async function updateStageStatus(unitStageId, newStatus) {
    try {
      setBusyStageId(unitStageId)

      const current = stages.find((s) => s.id === unitStageId)
      const oldStatus = current?.status || null
      const patch = { status: newStatus }

      if (newStatus === 'in_progress' && !current?.started_at) {
        patch.started_at = new Date().toISOString()
      }
      if (newStatus === 'done') {
        patch.finished_at = new Date().toISOString()
      }

      const { error: upErr } = await supabase.from('unit_stages').update(patch).eq('id', unitStageId)
      if (upErr) {
        alert(`Erro ao salvar status: ${upErr.message}`)
        return
      }

      if (user?.id) {
        await supabase.from('unit_stage_logs').insert({
          unit_stage_id: unitStageId,
          user_id: user.id,
          action: 'status_changed',
          old_value: { status: oldStatus },
          new_value: { status: newStatus },
        })
      }

      await loadAll()
    } finally {
      setBusyStageId(null)
    }
  }

  async function saveNotes(unitStageId, value) {
    try {
      setBusyStageId(unitStageId)

      const current = stages.find((s) => s.id === unitStageId)
      const oldNotes = safeStr(current?.notes)
      const newNotes = safeStr(value)

      if (oldNotes === newNotes) return

      const { error } = await supabase.from('unit_stages').update({ notes: newNotes }).eq('id', unitStageId)
      if (error) {
        alert(`Erro ao salvar notas: ${error.message}`)
        return
      }

      if (user?.id) {
        await supabase.from('unit_stage_logs').insert({
          unit_stage_id: unitStageId,
          user_id: user.id,
          action: 'notes_updated',
          old_value: { notes: oldNotes },
          new_value: { notes: newNotes },
        })
      }

      await loadAll()
    } finally {
      setBusyStageId(null)
    }
  }

  async function onUploadPhoto(unitStageId, file, caption) {
    if (!file) return
    if (!user?.id) {
      alert('Usuário não autenticado.')
      return
    }

    try {
      setUploadingStageId(unitStageId)

      const ext = extFromName(file.name)
      const path = `units/${unitId}/unit_stages/${unitStageId}/${randomId()}.${ext}`

      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || undefined,
      })

      if (upErr) {
        alert(`Erro no upload: ${upErr.message}`)
        return
      }

      const { data: photoRow, error: insErr } = await supabase
        .from('unit_stage_photos')
        .insert({
          unit_stage_id: unitStageId,
          user_id: user.id,
          kind: 'image',
          path,
          caption: safeStr(caption || ''),
        })
        .select('id, path, caption, kind, created_at, user_id')
        .maybeSingle()

      if (insErr) {
        alert(`Upload ok, mas erro ao salvar no banco: ${insErr.message}`)
        return
      }

      await supabase.from('unit_stage_logs').insert({
        unit_stage_id: unitStageId,
        user_id: user.id,
        action: 'photo_added',
        old_value: null,
        new_value: {
          photo_id: photoRow?.id || null,
          path,
          kind: 'image',
          caption: safeStr(caption || ''),
        },
      })

      if (photoRow?.id && path) {
        const { data: signed, error: sErr } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60)
        if (!sErr && signed?.signedUrl) {
          setSignedUrlByPhotoId((prev) => ({ ...prev, [photoRow.id]: signed.signedUrl }))
        }
      }

      await loadAll()
    } finally {
      setUploadingStageId(null)
    }
  }

  async function deletePhoto(stageRow, photoRow) {
    if (!photoRow?.id) return
    if (!user?.id) {
      alert('Usuário não autenticado.')
      return
    }

    const ok = window.confirm('Excluir esta foto?')
    if (!ok) return

    try {
      setDeletingPhotoId(photoRow.id)

      const oldValue = {
        photo_id: photoRow.id,
        path: photoRow.path || null,
        kind: photoRow.kind || null,
        caption: safeStr(photoRow.caption || ''),
      }

      if (photoRow.path) {
        const { error: storageErr } = await supabase.storage.from(BUCKET).remove([photoRow.path])
        if (storageErr) {
          alert(`Erro ao excluir arquivo da foto: ${storageErr.message}`)
          return
        }
      }

      const { error: deleteDbErr } = await supabase
        .from('unit_stage_photos')
        .delete()
        .eq('id', photoRow.id)

      if (deleteDbErr) {
        alert(`Erro ao excluir foto do banco: ${deleteDbErr.message}`)
        return
      }

      await supabase.from('unit_stage_logs').insert({
        unit_stage_id: stageRow.id,
        user_id: user.id,
        action: 'photo_deleted',
        old_value: oldValue,
        new_value: null,
      })

      setSignedUrlByPhotoId((prev) => {
        const next = { ...prev }
        delete next[photoRow.id]
        return next
      })

      if (viewerOpen && viewerPhotoId === photoRow.id) {
        closePhotoViewer()
      }

      await loadAll()
    } finally {
      setDeletingPhotoId(null)
    }
  }

  async function setStageArchivedState(stageRow, nextIsActive) {
    if (!user?.id) {
      alert('Usuário não autenticado.')
      return
    }

    const confirmMsg = nextIsActive
      ? `Desarquivar a etapa "${stageRow.stage_name}"?`
      : `Arquivar a etapa "${stageRow.stage_name}"?`

    const ok = window.confirm(confirmMsg)
    if (!ok) return

    try {
      setBusyStageId(stageRow.id)
      setOpenActionMenuStageId(null)

      const { error } = await supabase
        .from('unit_stages')
        .update({ is_active: nextIsActive })
        .eq('id', stageRow.id)

      if (error) {
        alert(`Erro ao ${nextIsActive ? 'desarquivar' : 'arquivar'} etapa: ${error.message}`)
        return
      }

      await supabase.from('unit_stage_logs').insert({
        unit_stage_id: stageRow.id,
        user_id: user.id,
        action: nextIsActive ? 'stage_unarchived' : 'stage_archived',
        old_value: { is_active: stageRow.is_active !== false },
        new_value: { is_active: nextIsActive },
      })

      await loadAll()
    } finally {
      setBusyStageId(null)
    }
  }

  async function saveRenameStage() {
    if (!renameStageId) return
    if (!user?.id) {
      alert('Usuário não autenticado.')
      return
    }

    const stageRow = stages.find((s) => s.id === renameStageId)
    if (!stageRow) return

    const newName = safeStr(renameStageValue).trim()
    const currentCustomName = safeStr(stageRow.custom_name).trim()
    const currentLabel = safeStr(stageRow.stage_name).trim()

    const nextCustomName = newName || null
    const nextDisplayName = newName || safeStr(stageRow.stage_template_name).trim()

    if (currentCustomName === safeStr(nextCustomName).trim()) {
      setRenameOpen(false)
      return
    }

    try {
      setRenameBusy(true)

      const { error } = await supabase
        .from('unit_stages')
        .update({ custom_name: nextCustomName })
        .eq('id', renameStageId)

      if (error) {
        alert(`Erro ao renomear etapa: ${error.message}`)
        return
      }

      await supabase.from('unit_stage_logs').insert({
        unit_stage_id: renameStageId,
        user_id: user.id,
        action: 'stage_renamed',
        old_value: { name: currentLabel },
        new_value: { name: nextDisplayName },
      })

      setRenameOpen(false)
      await loadAll()
    } finally {
      setRenameBusy(false)
    }
  }

  async function copyStage() {
    if (!copySourceStage?.id) return
    if (!copyStructure && !copyNotes && !copyPhotos) {
      alert('Selecione ao menos um conteúdo para copiar.')
      return
    }
    if (!user?.id) {
      alert('Usuário não autenticado.')
      return
    }

    const targetName = safeStr(copyName).trim() || `${copySourceStage.stage_name} (cópia)`

    try {
      setCopyBusy(true)

      const payload = {
        unit_id: copySourceStage.unit_id,
        stage_id: copySourceStage.stage_id,
        status: 'pending',
        order_index: nextOrderIndex(),
        is_active: true,
        custom_name: targetName,
        notes: copyNotes ? safeStr(copySourceStage.notes || '') : '',
      }

      const { data: newStage, error: newStageErr } = await supabase
        .from('unit_stages')
        .insert(payload)
        .select('id, unit_id, stage_id, custom_name')
        .maybeSingle()

      if (newStageErr) {
        alert(`Erro ao copiar etapa: ${newStageErr.message}`)
        return
      }

      if (!newStage?.id) {
        alert('Não foi possível obter a nova etapa copiada.')
        return
      }

      if (copyPhotos) {
        const sourcePhotos = Array.isArray(copySourceStage.photos) ? copySourceStage.photos : []

        if (sourcePhotos.length > 0) {
          const rows = sourcePhotos.map((p) => ({
            unit_stage_id: newStage.id,
            user_id: user.id,
            kind: p.kind || 'image',
            path: p.path,
            caption: safeStr(p.caption || ''),
          }))

          const { error: photosErr } = await supabase
            .from('unit_stage_photos')
            .insert(rows)

          if (photosErr) {
            alert(`A etapa foi copiada, mas houve erro ao copiar as fotos: ${photosErr.message}`)
            return
          }
        }
      }

      await supabase.from('unit_stage_logs').insert({
        unit_stage_id: copySourceStage.id,
        user_id: user.id,
        action: 'stage_copied',
        old_value: {
          source_stage_id: copySourceStage.id,
          source_stage_name: copySourceStage.stage_name,
        },
        new_value: {
          new_stage_id: newStage.id,
          new_stage_name: targetName,
          copied_structure: !!copyStructure,
          copied_notes: !!copyNotes,
          copied_photos: !!copyPhotos,
        },
      })

      setCopyOpen(false)
      await loadAll()
    } finally {
      setCopyBusy(false)
    }
  }

  async function addExistingStageToUnit() {
    if (!addStageId) return
    if (!unit?.id) return

    const already = stages.some((s) => safeStr(s.stage_id) === safeStr(addStageId))
    if (already) {
      alert('Essa etapa já existe nesta unidade.')
      return
    }

    setManageBusy(true)
    try {
      const payload = {
        unit_id: unit.id,
        stage_id: addStageId,
        status: 'pending',
        order_index: nextOrderIndex(),
        is_active: true,
      }

      const { error } = await supabase.from('unit_stages').insert(payload)
      if (error) {
        alert(`Erro ao adicionar etapa: ${error.message}`)
        return
      }

      await loadAll()
      setAddStageId('')
    } finally {
      setManageBusy(false)
    }
  }

  async function createStageTemplateAndAddToUnit() {
    if (!unit?.project_id) return
    const name = safeStr(createStageName).trim()
    if (!name) return

    setManageBusy(true)
    try {
      const maxOrder = (stageCatalog || []).reduce((m, s) => Math.max(m, Number(s.order_index || 0)), 0)
      const { data: stageRow, error: sErr } = await supabase
        .from('stages')
        .insert({
          project_id: unit.project_id,
          name,
          order_index: maxOrder + 1,
          is_active: true,
        })
        .select('id')
        .maybeSingle()

      if (sErr) {
        alert(`Erro ao criar etapa no modelo: ${sErr.message}`)
        return
      }

      const stageId = stageRow?.id
      if (!stageId) {
        alert('Etapa criada, mas não retornou id.')
        return
      }

      const { error: usErr } = await supabase.from('unit_stages').insert({
        unit_id: unit.id,
        stage_id: stageId,
        status: 'pending',
        order_index: nextOrderIndex(),
        is_active: true,
      })

      if (usErr) {
        alert(`Erro ao adicionar etapa na unidade: ${usErr.message}`)
        return
      }

      setCreateStageName('')
      await loadAll()
    } finally {
      setManageBusy(false)
    }
  }

  async function renameUnitStage(unitStageId, customName) {
    const stageRow = stages.find((s) => s.id === unitStageId)
    const n = safeStr(customName).trim()

    setManageBusy(true)
    try {
      const { error } = await supabase.from('unit_stages').update({ custom_name: n || null }).eq('id', unitStageId)
      if (error) {
        alert(`Erro ao renomear etapa: ${error.message}`)
        return
      }

      if (user?.id && stageRow) {
        await supabase.from('unit_stage_logs').insert({
          unit_stage_id: unitStageId,
          user_id: user.id,
          action: 'stage_renamed',
          old_value: { name: stageRow.stage_name },
          new_value: { name: n || stageRow.stage_template_name },
        })
      }

      await loadAll()
    } finally {
      setManageBusy(false)
    }
  }

  async function moveUnitStage(unitStageId, dir) {
    const list = [...stages].sort((a, b) => Number(a.order_index || 0) - Number(b.order_index || 0))
    const idx = list.findIndex((s) => s.id === unitStageId)
    if (idx === -1) return
    const j = idx + dir
    if (j < 0 || j >= list.length) return

    const a = list[idx]
    const b = list[j]
    const oa = clampInt(a.order_index, 1, 1000000)
    const ob = clampInt(b.order_index, 1, 1000000)

    setManageBusy(true)
    try {
      const { error: e1 } = await supabase.from('unit_stages').update({ order_index: ob }).eq('id', a.id)
      if (e1) {
        alert(`Erro ao reordenar: ${e1.message}`)
        return
      }
      const { error: e2 } = await supabase.from('unit_stages').update({ order_index: oa }).eq('id', b.id)
      if (e2) {
        alert(`Erro ao reordenar: ${e2.message}`)
        return
      }
      await loadAll()
    } finally {
      setManageBusy(false)
    }
  }

  async function deleteUnitStage(unitStageId, stageName) {
    const ok = window.confirm(
      `Excluir a etapa "${stageName}" desta unidade?\n\nObs: as fotos/notas dessa etapa podem ser removidas junto dependendo do seu banco.`
    )
    if (!ok) return

    setManageBusy(true)
    try {
      await supabase.from('unit_stage_photos').delete().eq('unit_stage_id', unitStageId)
      await supabase.from('unit_stage_logs').delete().eq('unit_stage_id', unitStageId)

      const { error } = await supabase.from('unit_stages').delete().eq('id', unitStageId)
      if (error) {
        alert(`Erro ao excluir etapa: ${error.message}`)
        return
      }

      await loadAll()
    } finally {
      setManageBusy(false)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        <div>Carregando…</div>
      </div>
    )
  }

  if (!unit) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        <div style={{ marginBottom: 12 }}>Unidade não encontrada.</div>
        <Link href="/obras">Voltar</Link>
      </div>
    )
  }

  const visibleStages = showArchived ? stages : stages.filter((s) => s.is_active !== false)
  const visibleIssues = []

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Unidade</div>
          <h1 style={{ margin: 0 }}>Unidade {unit.identifier || unit.id}</h1>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#444' }}>
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Mostrar arquivadas
          </label>

          <button
            type="button"
            onClick={() => setManageOpen(true)}
            style={{
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid #ddd',
              background: '#fff',
              cursor: 'pointer',
              fontWeight: 900,
            }}
          >
            Gerenciar etapas
          </button>

          <Link href={`/obras/${unit.project_id}`}>← Voltar</Link>
        </div>
      </div>

      <hr style={{ margin: '18px 0' }} />

      {false ? (
        <div style={{ display: 'grid', gap: 14, maxWidth: 1180, marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0 }}>Issues da unidade</h2>
            <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
              {visibleIssues.length === 1 ? '1 issue cadastrada' : `${visibleIssues.length} issues cadastradas`}
            </div>
          </div>

          <button
            type="button"
            onClick={() => {}}
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
            Nova issue
          </button>
        </div>

        {visibleIssues.length === 0 ? (
          <div
            style={{
              border: '1px solid #eee',
              borderRadius: 14,
              padding: 16,
              background: '#fafafa',
              color: '#666',
            }}
          >
            Nenhuma issue cadastrada para esta unidade ainda.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {visibleIssues.map((issue) => {
              const savingStatus = issueSavingId === issue.id
              const assigneeName = issue.assigned_to ? issueAssigneeNameById[issue.assigned_to] || 'Usuário' : 'Não atribuído'

              return (
                <div
                  key={issue.id}
                  style={{
                    border: '1px solid #eee',
                    borderRadius: 14,
                    padding: 16,
                    background: '#fff',
                    boxShadow: '0 6px 20px rgba(0,0,0,0.04)',
                    display: 'grid',
                    gap: 12,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ display: 'grid', gap: 8 }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <div style={{ fontSize: 18, fontWeight: 800 }}>{issue.title || 'Sem título'}</div>
                        <span
                          style={{
                            fontSize: 12,
                            padding: '5px 9px',
                            borderRadius: 999,
                            border: '1px solid #ddd',
                            background: '#fff',
                            fontWeight: 800,
                          }}
                        >
                          {formatIssueStatusLabel(issue.status)}
                        </span>
                        <span
                          style={{
                            fontSize: 12,
                            padding: '5px 9px',
                            borderRadius: 999,
                            border: '1px solid #ddd',
                            background: '#f7f7f7',
                            fontWeight: 800,
                          }}
                        >
                          Prioridade {formatIssuePriorityLabel(issue.priority)}
                        </span>
                      </div>

                      <div style={{ fontSize: 13, color: '#555', lineHeight: 1.5 }}>
                        {safeStr(issue.description).trim() || 'Sem descrição.'}
                      </div>

                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, color: '#666' }}>
                        <span>Responsável: <b>{assigneeName}</b></span>
                        <span>Criada em: <b>{formatDateTime(issue.created_at) || '—'}</b></span>
                        <span>Atualizada em: <b>{formatDateTime(issue.updated_at) || '—'}</b></span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => openEditIssueModal(issue)}
                      disabled={savingStatus}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 10,
                        border: '1px solid #ddd',
                        background: '#fff',
                        cursor: savingStatus ? 'not-allowed' : 'pointer',
                        fontWeight: 700,
                      }}
                    >
                      Editar
                    </button>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {['open', 'in_progress', 'resolved'].map((status) => {
                      const active = issue.status === status
                      return (
                        <button
                          key={status}
                          type="button"
                          disabled={savingStatus || active}
                          onClick={() => changeIssueStatus(issue.id, status)}
                          style={{
                            padding: '8px 10px',
                            borderRadius: 10,
                            border: '1px solid #ddd',
                            background: active ? '#111' : '#fff',
                            color: active ? '#fff' : '#111',
                            cursor: savingStatus || active ? 'not-allowed' : 'pointer',
                            fontWeight: 700,
                            opacity: savingStatus && !active ? 0.7 : 1,
                          }}
                        >
                          {formatIssueStatusLabel(status)}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        </div>
      ) : null}

      <h2 style={{ marginTop: 0 }}>Etapas</h2>

      {visibleStages.length === 0 ? (
        <div style={{ color: '#666' }}>
          Nenhuma etapa {showArchived ? 'encontrada' : 'ativa'} nesta unidade. Clique em <b>Gerenciar etapas</b> para adicionar.
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: 14, maxWidth: 1180, marginTop: 12 }}>
        {visibleStages.map((s) => {
          const isBusy = busyStageId === s.id
          const isUploading = uploadingStageId === s.id
          const stageLogs = stageLogsByStageId[s.id] || []
          const sortedPhotos = [...(s.photos || [])].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
          const stageOpenIssueCount = openIssueCountByStageId[s.id] || 0

          return (
            <div
              key={s.id}
              style={{
                background: '#fff',
                border: '1px solid #eee',
                borderRadius: 14,
                padding: 16,
                boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
                opacity: s.is_active === false ? 0.7 : 1,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800 }}>
                    {s.stage_name}{' '}
                    {s.is_active === false ? (
                      <span style={{ fontSize: 12, color: '#b00020', fontWeight: 900 }}>(Arquivada)</span>
                    ) : null}
                  </div>
                  {s.custom_name ? (
                    <div style={{ marginTop: 4, fontSize: 12, color: '#666' }}>Modelo: {s.stage_template_name}</div>
                  ) : null}
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontSize: 12,
                      padding: '6px 10px',
                      borderRadius: 999,
                      border: '1px solid #ddd',
                      background: '#fff',
                      fontWeight: 800,
                      whiteSpace: 'nowrap',
                      display: 'none',
                    }}
                    title="Status atual"
                  >
                    {STATUS_PT[s.status] || '—'}
                  </span>

                  <button
                    type="button"
                    disabled={isBusy || isUploading}
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenStatusMenuStageId((prev) => (prev === s.id ? null : s.id))
                    }}
                    style={{
                      ...buildStatusPillStyle(getStatusTone(s.status), { interactive: true }),
                      cursor: isBusy || isUploading ? 'not-allowed' : 'pointer',
                      whiteSpace: 'nowrap',
                      opacity: isBusy || isUploading ? 0.65 : 1,
                    }}
                  >
                    <span>{STATUS_PT[s.status] || 'â€”'}</span>
                    <span style={{ fontSize: 11 }}>{openStatusMenuStageId === s.id ? '▲' : '▼'}</span>
                  </button>

                  <button
                    type="button"
                    disabled={isBusy || isUploading}
                    onClick={() => openStageIssuesModal(s)}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 10,
                      border: '1px solid #ddd',
                      background: '#fff',
                      cursor: isBusy || isUploading ? 'not-allowed' : 'pointer',
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Pendências{stageOpenIssueCount > 0 ? ` (${stageOpenIssueCount})` : ''}
                  </button>

                  <div
                    style={{ position: 'relative' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      disabled={isBusy || isUploading}
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpenActionMenuStageId((prev) => (prev === s.id ? null : s.id))
                      }}
                      style={{
                        width: 40,
                        height: 36,
                        borderRadius: 10,
                        border: '1px solid #ddd',
                        background: '#fff',
                        cursor: isBusy || isUploading ? 'not-allowed' : 'pointer',
                        fontWeight: 900,
                        fontSize: 18,
                        lineHeight: 1,
                      }}
                      title="Ações"
                    >
                      ⋯
                    </button>

                    {openActionMenuStageId === s.id ? (
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
                          onClick={() => openRenameModal(s)}
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            padding: '10px 12px',
                            border: 'none',
                            background: '#fff',
                            cursor: 'pointer',
                            fontWeight: 700,
                          }}
                        >
                          Editar
                        </button>

                        <button
                          type="button"
                          onClick={() => setStageArchivedState(s, s.is_active === false)}
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            padding: '10px 12px',
                            border: 'none',
                            borderTop: '1px solid #f1f1f1',
                            background: '#fff',
                            cursor: 'pointer',
                            fontWeight: 700,
                          }}
                        >
                          {s.is_active === false ? 'Desarquivar' : 'Arquivar'}
                        </button>

                        <button
                          type="button"
                          onClick={() => openCopyModal(s)}
                          style={{
                            width: '100%',
                            textAlign: 'left',
                            padding: '10px 12px',
                            border: 'none',
                            borderTop: '1px solid #f1f1f1',
                            background: '#fff',
                            cursor: 'pointer',
                            fontWeight: 700,
                          }}
                        >
                          Copiar
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setOpenActionMenuStageId(null)
                            deleteUnitStage(s.id, s.stage_name)
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

              {openStatusMenuStageId === s.id ? (
                <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    disabled={isBusy || isUploading}
                    onClick={async () => {
                      await updateStageStatus(s.id, 'pending')
                      setOpenStatusMenuStageId(null)
                    }}
                    style={{
                      ...buildStatusPillStyle(getStatusTone('pending'), { interactive: true }),
                      cursor: isBusy || isUploading ? 'not-allowed' : 'pointer',
                      background: s.status === 'pending' ? getStatusTone('pending').hover : getStatusTone('pending').background,
                      opacity: isBusy || isUploading ? 0.65 : 1,
                    }}
                  >
                    Pendente
                  </button>

                  <button
                    type="button"
                    disabled={isBusy || isUploading}
                    onClick={async () => {
                      await updateStageStatus(s.id, 'in_progress')
                      setOpenStatusMenuStageId(null)
                    }}
                    style={{
                      ...buildStatusPillStyle(getStatusTone('in_progress'), { interactive: true }),
                      cursor: isBusy || isUploading ? 'not-allowed' : 'pointer',
                      background: s.status === 'in_progress' ? getStatusTone('in_progress').hover : getStatusTone('in_progress').background,
                      opacity: isBusy || isUploading ? 0.65 : 1,
                    }}
                  >
                    Em andamento
                  </button>

                  <button
                    type="button"
                    disabled={isBusy || isUploading}
                    onClick={async () => {
                      await updateStageStatus(s.id, 'done')
                      setOpenStatusMenuStageId(null)
                    }}
                    style={{
                      ...buildStatusPillStyle(getStatusTone('done'), { interactive: true }),
                      cursor: isBusy || isUploading ? 'not-allowed' : 'pointer',
                      background: s.status === 'done' ? getStatusTone('done').hover : getStatusTone('done').background,
                      opacity: isBusy || isUploading ? 0.65 : 1,
                    }}
                  >
                    Concluído
                  </button>
                </div>
              ) : null}

              <div
                style={{
                  marginTop: 14,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                  gap: 14,
                  alignItems: 'start',
                }}
              >
                <div
                  style={{
                    border: '1px solid #eee',
                    borderRadius: 12,
                    padding: 14,
                    background: '#fafafa',
                  }}
                >
                  <div style={{ fontSize: 12, color: '#444', marginBottom: 6, fontWeight: 900 }}>Observações / notas</div>
                  <textarea
                    defaultValue={s.notes || ''}
                    placeholder="Escreva observações desta etapa..."
                    onBlur={(e) => saveNotes(s.id, e.target.value)}
                    disabled={isBusy || isUploading}
                    style={{
                      width: '100%',
                      minHeight: 180,
                      padding: 12,
                      borderRadius: 12,
                      border: '1px solid #ddd',
                      outline: 'none',
                      resize: 'vertical',
                      background: '#fff',
                    }}
                  />
                  <div style={{ fontSize: 12, color: '#777', marginTop: 6 }}>(Salva ao sair do campo)</div>
                </div>

                <div
                  style={{
                    border: '1px solid #eee',
                    borderRadius: 12,
                    padding: 14,
                    background: '#fafafa',
                    minHeight: 270,
                    display: 'grid',
                    gridTemplateRows: 'auto 1fr',
                    gap: 10,
                  }}
                >
                  <div style={{ fontSize: 12, color: '#444', fontWeight: 900 }}>Histórico automático</div>

                  {stageLogs.length === 0 ? (
                    <div style={{ fontSize: 13, color: '#666' }}>Nenhum evento registrado ainda.</div>
                  ) : (
                    <div
                      style={{
                        display: 'grid',
                        gap: 10,
                        maxHeight: 260,
                        overflowY: 'auto',
                        paddingRight: 4,
                      }}
                    >
                      {stageLogs.map((log) => (
                        <div
                          key={log.id}
                          style={{
                            border: '1px solid #e8e8e8',
                            borderRadius: 12,
                            padding: 10,
                            background: '#fff',
                          }}
                        >
                          <div style={{ fontSize: 13, color: '#111', lineHeight: 1.45 }}>
                            <b>{log.user_name || 'Usuário'}</b> {buildLogDescription(log)}
                          </div>
                          <div style={{ fontSize: 12, color: '#777', marginTop: 4 }}>
                            {formatDateTime(log.created_at)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                  <label
                    style={{
                      display: 'inline-flex',
                      gap: 10,
                      alignItems: 'center',
                      padding: '10px 12px',
                      borderRadius: 12,
                      border: '1px solid #ddd',
                      background: '#fff',
                      cursor: isUploading ? 'not-allowed' : 'pointer',
                      fontWeight: 700,
                    }}
                  >
                    {isUploading ? 'Enviando…' : 'Adicionar foto'}
                    <input
                      type="file"
                      accept="image/*"
                      disabled={isUploading}
                      style={{ display: 'none' }}
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        const caption = window.prompt('Legenda (opcional):', '') || ''
                        await onUploadPhoto(s.id, file, caption)
                        e.target.value = ''
                      }}
                    />
                  </label>

                  <div style={{ fontSize: 12, color: '#666' }}>
                    Fotos: <b>{sortedPhotos.length}</b>
                  </div>
                </div>

                {sortedPhotos.length > 0 ? (
                  <div
                    style={{
                      display: 'flex',
                      gap: 10,
                      flexWrap: 'wrap',
                      alignItems: 'flex-start',
                    }}
                  >
                    {sortedPhotos.map((p) => {
                      const url = signedUrlByPhotoId[p.id]
                      const isDeletingThisPhoto = deletingPhotoId === p.id

                      return (
                        <div
                          key={p.id}
                          style={{
                            position: 'relative',
                            width: 88,
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => openPhotoViewer(sortedPhotos, p.id)}
                            disabled={isDeletingThisPhoto}
                            style={{
                              width: 88,
                              border: '1px solid #eee',
                              borderRadius: 12,
                              padding: 0,
                              background: '#fff',
                              cursor: isDeletingThisPhoto ? 'not-allowed' : 'pointer',
                              overflow: 'hidden',
                              opacity: isDeletingThisPhoto ? 0.6 : 1,
                            }}
                            title={p.caption || 'Abrir foto'}
                          >
                            {url ? (
                              <img
                                src={url}
                                alt={p.caption || 'foto'}
                                style={{
                                  width: '100%',
                                  height: 88,
                                  objectFit: 'cover',
                                  display: 'block',
                                }}
                              />
                            ) : (
                              <div
                                style={{
                                  width: '100%',
                                  height: 88,
                                  background: '#eee',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  color: '#666',
                                  fontSize: 11,
                                  padding: 6,
                                  textAlign: 'center',
                                }}
                              >
                                Carregando…
                              </div>
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              deletePhoto(s, p)
                            }}
                            disabled={isDeletingThisPhoto}
                            title="Excluir foto"
                            style={{
                              position: 'absolute',
                              top: -6,
                              right: -6,
                              width: 26,
                              height: 26,
                              borderRadius: 999,
                              border: '1px solid #ddd',
                              background: '#fff',
                              color: '#b00020',
                              cursor: isDeletingThisPhoto ? 'not-allowed' : 'pointer',
                              fontWeight: 900,
                              boxShadow: '0 4px 10px rgba(0,0,0,0.15)',
                              opacity: isDeletingThisPhoto ? 0.6 : 1,
                            }}
                          >
                            {isDeletingThisPhoto ? '…' : '✕'}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      <Modal
        open={issueModalOpen}
        title={`Pendências da etapa ${selectedIssueStage?.stage_name || ''}`}
        onClose={() => {
          if (issueModalBusy) return
          setIssueModalOpen(false)
          setIssueModalStageId('')
          resetIssueForm()
        }}
        busy={issueModalBusy}
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, color: '#666' }}>
              {selectedStageIssues.length === 1 ? '1 pendência nesta etapa' : `${selectedStageIssues.length} pendências nesta etapa`}
            </div>

            <button
              type="button"
              onClick={() => startCreateIssueForStage(issueModalStageId)}
              disabled={issueModalBusy || !issueModalStageId}
              style={{
                padding: '8px 10px',
                borderRadius: 10,
                border: '1px solid #ddd',
                background: '#fff',
                cursor: issueModalBusy || !issueModalStageId ? 'not-allowed' : 'pointer',
                fontWeight: 700,
              }}
            >
              Nova pendência
            </button>
          </div>

          {selectedStageIssues.length === 0 ? (
            <div
              style={{
                border: '1px solid #eee',
                borderRadius: 12,
                padding: 14,
                background: '#fafafa',
                color: '#666',
              }}
            >
              Nenhuma pendência cadastrada para esta etapa.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {selectedStageIssues.map((issue) => {
                const savingStatus = issueSavingId === issue.id
                const assigneeName = issue.assigned_to ? issueAssigneeNameById[issue.assigned_to] || 'Usuário' : 'Não atribuído'

                return (
                  <div
                    key={issue.id}
                    style={{
                      border: '1px solid #eee',
                      borderRadius: 12,
                      padding: 12,
                      background: '#fff',
                      display: 'grid',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                      <div style={{ display: 'grid', gap: 6 }}>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                          <div style={{ fontSize: 15, fontWeight: 800 }}>{issue.title || 'Sem título'}</div>
                          <span style={{ ...buildStatusPillStyle(getIssueStatusTone(issue.status)), fontSize: 12, minHeight: 26, padding: '4px 8px' }}>
                            {formatIssueStatusLabel(issue.status)}
                          </span>
                          <span style={{ fontSize: 12, padding: '4px 8px', borderRadius: 999, border: '1px solid #ddd', background: '#f7f7f7', fontWeight: 800 }}>
                            {formatIssuePriorityLabel(issue.priority)}
                          </span>
                        </div>
                        <div style={{ fontSize: 13, color: '#555', lineHeight: 1.5 }}>
                          {safeStr(issue.description).trim() || 'Sem descrição.'}
                        </div>
                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, color: '#666' }}>
                          <span>Responsável: <b>{assigneeName}</b></span>
                          <span>Atualizada em: <b>{formatDateTime(issue.updated_at) || '—'}</b></span>
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          onClick={() => openEditIssueModal(issue)}
                          disabled={savingStatus || issueModalBusy}
                          style={{
                            padding: '8px 10px',
                            borderRadius: 10,
                            border: '1px solid #ddd',
                            background: '#fff',
                            cursor: savingStatus || issueModalBusy ? 'not-allowed' : 'pointer',
                            fontWeight: 700,
                          }}
                        >
                          Editar
                        </button>

                        <button
                          type="button"
                          onClick={() => deleteIssueRecord(issue)}
                          disabled={savingStatus || issueModalBusy}
                          style={{
                            padding: '8px 10px',
                            borderRadius: 10,
                            border: '1px solid #f3d0d0',
                            background: '#fff5f5',
                            color: '#991B1B',
                            cursor: savingStatus || issueModalBusy ? 'not-allowed' : 'pointer',
                            fontWeight: 700,
                          }}
                        >
                          Excluir pendência
                        </button>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {['open', 'in_progress', 'resolved'].map((status) => {
                        const active = issue.status === status
                        const tone = getIssueStatusTone(status)
                        return (
                          <button
                            key={status}
                            type="button"
                            disabled={savingStatus || issueModalBusy || active}
                            onClick={() => changeIssueStatus(issue.id, status)}
                            style={{
                              ...buildStatusPillStyle(tone, { interactive: true }),
                              background: active ? tone.hover : tone.background,
                              cursor: savingStatus || issueModalBusy || active ? 'not-allowed' : 'pointer',
                              opacity: savingStatus || issueModalBusy ? 0.65 : 1,
                            }}
                          >
                            {formatIssueStatusLabel(status)}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          <div style={{ fontSize: 13, fontWeight: 900, color: '#444' }}>
            {editingIssueId ? 'Editar pendência' : 'Nova pendência'}
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Título</div>
            <input
              value={issueForm.title}
              onChange={(e) => setIssueForm((prev) => ({ ...prev, title: e.target.value }))}
              disabled={issueModalBusy}
              placeholder="Resumo da pendência"
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Descrição</div>
            <textarea
              value={issueForm.description}
              onChange={(e) => setIssueForm((prev) => ({ ...prev, description: e.target.value }))}
              disabled={issueModalBusy}
              placeholder="Detalhes da pendência"
              style={{
                width: '100%',
                minHeight: 140,
                padding: 12,
                borderRadius: 12,
                border: '1px solid #ddd',
                outline: 'none',
                resize: 'vertical',
              }}
            />
          </div>

          <div
            style={{
              display: 'grid',
              gap: 12,
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            }}
          >
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Prioridade</div>
              <select
                value={issueForm.priority}
                onChange={(e) => setIssueForm((prev) => ({ ...prev, priority: e.target.value }))}
                disabled={issueModalBusy}
                style={{
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px solid #ddd',
                  background: '#fff',
                }}
              >
                <option value="low">Baixa</option>
                <option value="medium">Média</option>
                <option value="high">Alta</option>
              </select>
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Status</div>
              <select
                value={issueForm.status}
                onChange={(e) => setIssueForm((prev) => ({ ...prev, status: e.target.value }))}
                disabled={issueModalBusy}
                style={{
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px solid #ddd',
                  background: '#fff',
                }}
              >
                <option value="open">Aberta</option>
                <option value="in_progress">Em andamento</option>
                <option value="resolved">Resolvida</option>
              </select>
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Responsável</div>
              <select
                value={issueForm.assigned_to}
                onChange={(e) => setIssueForm((prev) => ({ ...prev, assigned_to: e.target.value }))}
                disabled={issueModalBusy}
                style={{
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px solid #ddd',
                  background: '#fff',
                }}
              >
                <option value="">Não atribuído</option>
                {issueAssignees.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {safeStr(profile.full_name).trim() || 'Usuário'}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => {
                setIssueModalOpen(false)
                setIssueModalStageId('')
                resetIssueForm()
              }}
              disabled={issueModalBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#fff',
                cursor: issueModalBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              Cancelar
            </button>

            <button
              type="button"
              onClick={saveIssue}
              disabled={issueModalBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#111',
                color: '#fff',
                cursor: issueModalBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              {issueModalBusy ? 'Salvandoâ€¦' : 'Salvar pendência'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={renameOpen} title="Editar etapa" onClose={() => setRenameOpen(false)} busy={renameBusy}>
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 13, color: '#666' }}>
            Nome atual: <b>{renameStageCurrentName || '—'}</b>
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Nome da etapa</div>
            <input
              value={renameStageValue}
              onChange={(e) => setRenameStageValue(e.target.value)}
              disabled={renameBusy}
              placeholder="Digite o novo nome da etapa"
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ fontSize: 12, color: '#777' }}>
            Se deixar vazio, a etapa volta a usar o nome do modelo.
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setRenameOpen(false)}
              disabled={renameBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#fff',
                cursor: renameBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              Cancelar
            </button>

            <button
              type="button"
              onClick={saveRenameStage}
              disabled={renameBusy}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                background: '#111',
                color: '#fff',
                cursor: renameBusy ? 'not-allowed' : 'pointer',
                fontWeight: 900,
              }}
            >
              {renameBusy ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={copyOpen} title="Copiar etapa" onClose={() => setCopyOpen(false)} busy={copyBusy}>
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 13, color: '#666' }}>
            Etapa de origem: <b>{copySourceStage?.stage_name || '—'}</b>
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Nome da nova etapa</div>
            <input
              value={copyName}
              onChange={(e) => setCopyName(e.target.value)}
              disabled={copyBusy}
              placeholder="Nome da nova etapa"
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid #ddd',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 900, color: '#444' }}>Conteúdo a copiar</div>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={copyStructure}
                onChange={(e) => setCopyStructure(e.target.checked)}
                disabled={copyBusy}
              />
              <span>Estrutura</span>
            </label>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={copyNotes}
                onChange={(e) => setCopyNotes(e.target.checked)}
                disabled={copyBusy}
              />
              <span>Observações</span>
            </label>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={copyPhotos}
                onChange={(e) => setCopyPhotos(e.target.checked)}
                disabled={copyBusy}
              />
              <span>Fotos</span>
            </label>
          </div>

          <div style={{ fontSize: 12, color: '#777' }}>
            A nova etapa será criada como <b>Pendente</b> e o histórico antigo não será copiado.
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
              onClick={copyStage}
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
              {copyBusy ? 'Copiando…' : 'Copiar etapa'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={manageOpen} title="Gerenciar etapas da unidade" onClose={() => setManageOpen(false)} busy={manageBusy}>
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 13, color: '#444', fontWeight: 900 }}>Adicionar etapa existente (modelo da obra)</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                value={addStageId}
                onChange={(e) => setAddStageId(e.target.value)}
                disabled={manageBusy}
                style={{
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px solid #ddd',
                  background: '#fff',
                  cursor: 'pointer',
                  fontWeight: 800,
                  minWidth: 320,
                }}
              >
                <option value="">Selecione uma etapa…</option>
                {stageCatalog.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={addExistingStageToUnit}
                disabled={manageBusy || !addStageId}
                style={{
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px solid #ddd',
                  background: '#111',
                  color: '#fff',
                  cursor: manageBusy || !addStageId ? 'not-allowed' : 'pointer',
                  fontWeight: 900,
                }}
              >
                Adicionar na unidade
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 13, color: '#444', fontWeight: 900 }}>Criar nova etapa (no modelo) e adicionar</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                value={createStageName}
                onChange={(e) => setCreateStageName(e.target.value)}
                disabled={manageBusy}
                placeholder="Nome da nova etapa…"
                style={{
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px solid #ddd',
                  outline: 'none',
                  minWidth: 320,
                }}
              />

              <button
                type="button"
                onClick={createStageTemplateAndAddToUnit}
                disabled={manageBusy || !safeStr(createStageName).trim()}
                style={{
                  padding: '10px 12px',
                  borderRadius: 12,
                  border: '1px solid #ddd',
                  background: '#fff',
                  cursor: manageBusy || !safeStr(createStageName).trim() ? 'not-allowed' : 'pointer',
                  fontWeight: 900,
                }}
              >
                Criar + adicionar
              </button>
            </div>
          </div>

          <hr style={{ margin: '6px 0' }} />

          <div style={{ fontSize: 13, color: '#444', fontWeight: 900 }}>Etapas desta unidade</div>

          {stages.length === 0 ? (
            <div style={{ color: '#666' }}>Nenhuma etapa ainda.</div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {stages.map((s, idx) => (
                <div
                  key={s.id}
                  style={{
                    border: '1px solid #eee',
                    borderRadius: 12,
                    padding: 12,
                    display: 'grid',
                    gap: 8,
                    background: '#fff',
                    opacity: s.is_active === false ? 0.7 : 1,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div style={{ fontSize: 12, color: '#666' }}>#{idx + 1}</div>

                      <input
                        defaultValue={s.custom_name || ''}
                        placeholder={s.stage_template_name || s.stage_name}
                        onBlur={(e) => renameUnitStage(s.id, e.target.value)}
                        disabled={manageBusy}
                        style={{
                          padding: '10px 12px',
                          borderRadius: 12,
                          border: '1px solid #ddd',
                          outline: 'none',
                          minWidth: 360,
                          maxWidth: '100%',
                        }}
                        title="Nome personalizado da etapa (só nesta unidade). Deixe vazio para usar o nome do modelo."
                      />

                      <span style={{ fontSize: 12, color: '#666' }}>
                        (Modelo: <b>{s.stage_template_name}</b>)
                        {s.is_active === false ? (
                          <span style={{ marginLeft: 8, color: '#b00020', fontWeight: 900 }}>(Arquivada)</span>
                        ) : null}
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => moveUnitStage(s.id, -1)}
                        disabled={manageBusy}
                        style={{
                          padding: '8px 10px',
                          borderRadius: 12,
                          border: '1px solid #ddd',
                          background: '#fff',
                          cursor: manageBusy ? 'not-allowed' : 'pointer',
                          fontWeight: 900,
                        }}
                        title="Subir"
                      >
                        ↑
                      </button>

                      <button
                        type="button"
                        onClick={() => moveUnitStage(s.id, +1)}
                        disabled={manageBusy}
                        style={{
                          padding: '8px 10px',
                          borderRadius: 12,
                          border: '1px solid #ddd',
                          background: '#fff',
                          cursor: manageBusy ? 'not-allowed' : 'pointer',
                          fontWeight: 900,
                        }}
                        title="Descer"
                      >
                        ↓
                      </button>

                      <button
                        type="button"
                        onClick={() => deleteUnitStage(s.id, s.stage_name)}
                        disabled={manageBusy}
                        style={{
                          padding: '8px 10px',
                          borderRadius: 12,
                          border: '1px solid #ddd',
                          background: '#fff',
                          cursor: manageBusy ? 'not-allowed' : 'pointer',
                          fontWeight: 900,
                          color: '#b00020',
                        }}
                        title="Excluir etapa desta unidade"
                      >
                        Excluir
                      </button>
                    </div>
                  </div>

                  <div style={{ fontSize: 12, color: '#777' }}>
                    Dica: o nome salva ao sair do campo. Se deixar vazio, volta a usar o nome do modelo.
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      <PhotoViewer
        open={viewerOpen}
        photos={viewerPhotos}
        photoId={viewerPhotoId}
        signedUrlByPhotoId={signedUrlByPhotoId}
        onClose={closePhotoViewer}
        onPrev={showPrevPhoto}
        onNext={showNextPhoto}
      />
    </div>
  )
}
