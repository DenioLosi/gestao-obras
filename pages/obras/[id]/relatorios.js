import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { supabase } from '../../../lib/supabase'

const REPORT_MODE = {
  diary: 'diary',
  period: 'period',
  observations: 'observations',
}

const STATUS_LABEL = {
  pending: 'Pendente',
  in_progress: 'Em andamento',
  done: 'Concluída',
}

function safeStr(v) {
  return (v ?? '').toString()
}

function formatDate(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('pt-BR')
}

function formatDateTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('pt-BR')
}

function toInputDate(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const year = d.getFullYear()
  const month = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function startOfDayIso(dateStr) {
  if (!dateStr) return null
  return `${dateStr}T00:00:00`
}

function endOfDayIso(dateStr) {
  if (!dateStr) return null
  return `${dateStr}T23:59:59.999`
}

function normalizeStatus(status) {
  const s = safeStr(status).trim().toLowerCase()
  if (s === 'pending') return 'pending'
  if (s === 'in_progress') return 'in_progress'
  if (s === 'done') return 'done'
  return s
}

function statusLabel(status) {
  return STATUS_LABEL[normalizeStatus(status)] || safeStr(status) || '-'
}

function parseMaybeJson(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function getPhotoKindLabel(kind) {
  const k = safeStr(kind).toLowerCase()
  if (k === 'before') return 'Foto antes'
  if (k === 'after') return 'Foto depois'
  if (k === 'progress') return 'Foto de andamento'
  if (k === 'completion') return 'Foto de conclusão'
  if (k === 'issue') return 'Foto de pendência'
  return kind || 'Foto'
}

function getLogTitle(log) {
  const action = safeStr(log?.action).toLowerCase()
  const kind = safeStr(log?.kind).toLowerCase()
  const description = safeStr(log?.description).trim()
  const metadata = parseMaybeJson(log?.metadata)

  if (description) return description
  if (metadata?.description) return safeStr(metadata.description)

  if (action.includes('start')) return 'Etapa iniciada'
  if (action.includes('done') || action.includes('complete') || action.includes('finish')) return 'Etapa concluída'
  if (action.includes('photo')) return 'Foto adicionada'
  if (action.includes('note') || action.includes('obs')) return 'Observação atualizada'
  if (action.includes('create')) return 'Etapa criada'
  if (action.includes('delete')) return 'Registro removido'
  if (kind) return kind
  if (action) return action
  return 'Movimentação registrada'
}

function getLogExtra(log) {
  const metadata = parseMaybeJson(log?.metadata)
  const parts = []

  if (metadata?.from_status || metadata?.to_status) {
    const fromLabel = metadata?.from_status ? statusLabel(metadata.from_status) : ''
    const toLabel = metadata?.to_status ? statusLabel(metadata.to_status) : ''
    if (fromLabel || toLabel) {
      parts.push(`Status: ${fromLabel || '-'} → ${toLabel || '-'}`)
    }
  }

  if (metadata?.notes) parts.push(`Obs: ${metadata.notes}`)
  if (metadata?.caption) parts.push(`Legenda: ${metadata.caption}`)
  if (metadata?.file_name) parts.push(`Arquivo: ${metadata.file_name}`)

  return parts.join(' • ')
}

export default function ObraRelatoriosPage() {
  const router = useRouter()
  const { id } = router.query

  const projectId = useMemo(() => {
    if (!id) return null
    if (Array.isArray(id)) return id[0] || null
    return String(id)
  }, [id])

  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)

  const [project, setProject] = useState(null)
  const [units, setUnits] = useState([])
  const [stages, setStages] = useState([])
  const [unitStages, setUnitStages] = useState([])
  const [photos, setPhotos] = useState([])
  const [logs, setLogs] = useState([])

  const [mode, setMode] = useState(REPORT_MODE.diary)

  const today = useMemo(() => toInputDate(new Date()), [])
  const [diaryDate, setDiaryDate] = useState(today)
  const [startDate, setStartDate] = useState(today)
  const [endDate, setEndDate] = useState(today)

  const [statusFilter, setStatusFilter] = useState('')
  const [unitFilter, setUnitFilter] = useState([])
  const [stageFilter, setStageFilter] = useState([])
  const [textFilter, setTextFilter] = useState('')
  const [onlyWithObservation, setOnlyWithObservation] = useState(true)

  async function ensureAuth() {
    const { data, error } = await supabase.auth.getUser()
    if (error || !data?.user) {
      window.location.href = '/login'
      return null
    }
    return data.user
  }

  async function loadBaseData() {
    if (!projectId) return

    setLoading(true)

    const currentUser = await ensureAuth()
    if (!currentUser) return

    const { data: projectRow, error: projectErr } = await supabase
      .from('projects')
      .select('id, name, client_name, city, address')
      .eq('id', projectId)
      .maybeSingle()

    if (projectErr) {
      alert(`Erro ao carregar obra: ${projectErr.message}`)
      setLoading(false)
      return
    }

    if (!projectRow) {
      setProject(null)
      setUnits([])
      setStages([])
      setUnitStages([])
      setPhotos([])
      setLogs([])
      setLoading(false)
      return
    }

    setProject(projectRow)

    const [
      unitsRes,
      stagesRes,
      unitStagesRes,
      photosRes,
      logsRes,
    ] = await Promise.all([
      supabase
        .from('units')
        .select('id, project_id, identifier, status, progress, is_active')
        .eq('project_id', projectId)
        .order('identifier', { ascending: true }),

      supabase
        .from('stages')
        .select('id, project_id, name, order_index, is_active')
        .eq('project_id', projectId)
        .order('order_index', { ascending: true }),

      supabase
        .from('unit_stages')
        .select('id, unit_id, stage_id, status, notes, custom_name, order_index, is_active')
        .order('order_index', { ascending: true }),

      supabase
        .from('unit_stage_photos')
        .select('id, unit_stage_id, user_id, kind, path, caption, created_at')
        .order('created_at', { ascending: false }),

      supabase
        .from('unit_stage_logs')
        .select('*')
        .order('created_at', { ascending: false }),
    ])

    if (unitsRes.error) {
      alert(`Erro ao carregar unidades: ${unitsRes.error.message}`)
      setLoading(false)
      return
    }

    if (stagesRes.error) {
      alert(`Erro ao carregar etapas: ${stagesRes.error.message}`)
      setLoading(false)
      return
    }

    if (unitStagesRes.error) {
      alert(`Erro ao carregar etapas das unidades: ${unitStagesRes.error.message}`)
      setLoading(false)
      return
    }

    if (photosRes.error) {
      alert(`Erro ao carregar fotos: ${photosRes.error.message}`)
      setLoading(false)
      return
    }

    if (logsRes.error) {
      alert(`Erro ao carregar histórico: ${logsRes.error.message}`)
      setLoading(false)
      return
    }

    const unitsRows = Array.isArray(unitsRes.data) ? unitsRes.data : []
    const stagesRows = Array.isArray(stagesRes.data) ? stagesRes.data : []

    const unitIds = new Set(unitsRows.map((u) => u.id))
    const stageIds = new Set(stagesRows.map((s) => s.id))

    const unitStagesRows = (Array.isArray(unitStagesRes.data) ? unitStagesRes.data : []).filter(
      (row) => unitIds.has(row.unit_id) && stageIds.has(row.stage_id)
    )

    const unitStageIds = new Set(unitStagesRows.map((row) => row.id))

    const photosRows = (Array.isArray(photosRes.data) ? photosRes.data : []).filter((row) =>
      unitStageIds.has(row.unit_stage_id)
    )

    const logsRows = (Array.isArray(logsRes.data) ? logsRes.data : []).filter((row) => {
      const direct = row?.unit_stage_id && unitStageIds.has(row.unit_stage_id)
      const meta = parseMaybeJson(row?.metadata)
      const metaUnitStageId = meta?.unit_stage_id
      return direct || (metaUnitStageId && unitStageIds.has(metaUnitStageId))
    })

    setUnits(unitsRows)
    setStages(stagesRows)
    setUnitStages(unitStagesRows)
    setPhotos(photosRows)
    setLogs(logsRows)
    setLoading(false)
  }

  useEffect(() => {
    loadBaseData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const unitsById = useMemo(() => {
    const map = {}
    units.forEach((u) => {
      map[u.id] = u
    })
    return map
  }, [units])

  const stagesById = useMemo(() => {
    const map = {}
    stages.forEach((s) => {
      map[s.id] = s
    })
    return map
  }, [stages])

  const unitStagesById = useMemo(() => {
    const map = {}
    unitStages.forEach((row) => {
      map[row.id] = row
    })
    return map
  }, [unitStages])

  const enrichedUnitStages = useMemo(() => {
    return unitStages.map((row) => {
      const unit = unitsById[row.unit_id] || null
      const stage = stagesById[row.stage_id] || null
      return {
        ...row,
        unit,
        stage,
        stage_display_name: safeStr(row.custom_name).trim() || safeStr(stage?.name).trim() || 'Etapa',
      }
    })
  }, [unitStages, unitsById, stagesById])

  const diaryRange = useMemo(() => {
    return {
      from: startOfDayIso(diaryDate),
      to: endOfDayIso(diaryDate),
    }
  }, [diaryDate])

  const periodRange = useMemo(() => {
    const from = startOfDayIso(startDate)
    const to = endOfDayIso(endDate)
    return { from, to }
  }, [startDate, endDate])

  function inRange(dateValue, from, to) {
    if (!dateValue || !from || !to) return false
    const d = new Date(dateValue).getTime()
    const a = new Date(from).getTime()
    const b = new Date(to).getTime()
    if ([d, a, b].some(Number.isNaN)) return false
    return d >= a && d <= b
  }

  const diaryLogs = useMemo(() => {
    return logs.filter((row) => inRange(row.created_at, diaryRange.from, diaryRange.to))
  }, [logs, diaryRange])

  const diaryPhotos = useMemo(() => {
    return photos.filter((row) => inRange(row.created_at, diaryRange.from, diaryRange.to))
  }, [photos, diaryRange])

  const periodLogs = useMemo(() => {
    return logs.filter((row) => inRange(row.created_at, periodRange.from, periodRange.to))
  }, [logs, periodRange])

  const periodPhotos = useMemo(() => {
    return photos.filter((row) => inRange(row.created_at, periodRange.from, periodRange.to))
  }, [photos, periodRange])

  const diaryEventsByUnit = useMemo(() => {
    const map = {}

    diaryLogs.forEach((log) => {
      const metadata = parseMaybeJson(log?.metadata)
      const unitStageId = log?.unit_stage_id || metadata?.unit_stage_id
      const us = unitStagesById[unitStageId]
      if (!us) return

      const unit = unitsById[us.unit_id]
      const stage = stagesById[us.stage_id]
      const unitKey = unit?.id || 'unknown'

      if (!map[unitKey]) {
        map[unitKey] = {
          unit,
          events: [],
        }
      }

      map[unitKey].events.push({
        type: 'log',
        created_at: log.created_at,
        stage_name: safeStr(us.custom_name).trim() || safeStr(stage?.name).trim() || 'Etapa',
        title: getLogTitle(log),
        extra: getLogExtra(log),
      })
    })

    diaryPhotos.forEach((photo) => {
      const us = unitStagesById[photo.unit_stage_id]
      if (!us) return

      const unit = unitsById[us.unit_id]
      const stage = stagesById[us.stage_id]
      const unitKey = unit?.id || 'unknown'

      if (!map[unitKey]) {
        map[unitKey] = {
          unit,
          events: [],
        }
      }

      map[unitKey].events.push({
        type: 'photo',
        created_at: photo.created_at,
        stage_name: safeStr(us.custom_name).trim() || safeStr(stage?.name).trim() || 'Etapa',
        title: getPhotoKindLabel(photo.kind),
        extra: safeStr(photo.caption).trim(),
      })
    })

    return Object.values(map)
      .map((item) => ({
        ...item,
        events: item.events.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
      }))
      .sort((a, b) => safeStr(a.unit?.identifier).localeCompare(safeStr(b.unit?.identifier), 'pt-BR'))
  }, [diaryLogs, diaryPhotos, unitStagesById, unitsById, stagesById])

  const diarySummary = useMemo(() => {
    const unitIds = new Set()
    let started = 0
    let finished = 0
    let observations = 0

    diaryLogs.forEach((log) => {
      const metadata = parseMaybeJson(log?.metadata)
      const unitStageId = log?.unit_stage_id || metadata?.unit_stage_id
      const us = unitStagesById[unitStageId]
      if (us?.unit_id) unitIds.add(us.unit_id)

      const action = safeStr(log?.action).toLowerCase()
      const title = getLogTitle(log).toLowerCase()

      if (action.includes('start') || title.includes('inici')) started += 1
      if (action.includes('done') || action.includes('complete') || action.includes('finish') || title.includes('conclu')) finished += 1
      if (action.includes('note') || action.includes('obs') || title.includes('observa')) observations += 1
    })

    diaryPhotos.forEach((photo) => {
      const us = unitStagesById[photo.unit_stage_id]
      if (us?.unit_id) unitIds.add(us.unit_id)
    })

    return {
      moved_units: unitIds.size,
      total_logs: diaryLogs.length,
      total_photos: diaryPhotos.length,
      started,
      finished,
      observations,
    }
  }, [diaryLogs, diaryPhotos, unitStagesById])

  const periodSummary = useMemo(() => {
    const unitIds = new Set()
    const stageCounters = {}

    periodLogs.forEach((log) => {
      const metadata = parseMaybeJson(log?.metadata)
      const unitStageId = log?.unit_stage_id || metadata?.unit_stage_id
      const us = unitStagesById[unitStageId]
      if (!us) return

      if (us.unit_id) unitIds.add(us.unit_id)

      const stage = stagesById[us.stage_id]
      const stageName = safeStr(us.custom_name).trim() || safeStr(stage?.name).trim() || 'Etapa'
      const key = `${us.stage_id}__${stageName}`

      if (!stageCounters[key]) {
        stageCounters[key] = {
          stage_name: stageName,
          started: 0,
          finished: 0,
          observations: 0,
        }
      }

      const action = safeStr(log?.action).toLowerCase()
      const title = getLogTitle(log).toLowerCase()

      if (action.includes('start') || title.includes('inici')) stageCounters[key].started += 1
      if (action.includes('done') || action.includes('complete') || action.includes('finish') || title.includes('conclu')) stageCounters[key].finished += 1
      if (action.includes('note') || action.includes('obs') || title.includes('observa')) stageCounters[key].observations += 1
    })

    periodPhotos.forEach((photo) => {
      const us = unitStagesById[photo.unit_stage_id]
      if (us?.unit_id) unitIds.add(us.unit_id)
    })

    return {
      moved_units: unitIds.size,
      total_logs: periodLogs.length,
      total_photos: periodPhotos.length,
      stages: Object.values(stageCounters).sort((a, b) =>
        safeStr(a.stage_name).localeCompare(safeStr(b.stage_name), 'pt-BR')
      ),
    }
  }, [periodLogs, periodPhotos, unitStagesById, stagesById])

  const lowestProgressUnits = useMemo(() => {
    return [...units]
      .sort((a, b) => Number(a.progress || 0) - Number(b.progress || 0))
      .slice(0, 10)
  }, [units])

  const filteredObservationRows = useMemo(() => {
    const unitFilterSet = new Set(unitFilter)
    const stageFilterSet = new Set(stageFilter)
    const text = safeStr(textFilter).trim().toLowerCase()

    return enrichedUnitStages
      .filter((row) => {
        if (statusFilter && normalizeStatus(row.status) !== normalizeStatus(statusFilter)) return false
        if (unitFilterSet.size > 0 && !unitFilterSet.has(row.unit_id)) return false
        if (stageFilterSet.size > 0 && !stageFilterSet.has(row.stage_id)) return false

        const note = safeStr(row.notes).trim()
        if (onlyWithObservation && !note) return false

        if (startDate || endDate) {
          const relatedLogs = logs.filter((log) => {
            const metadata = parseMaybeJson(log?.metadata)
            const unitStageId = log?.unit_stage_id || metadata?.unit_stage_id
            return unitStageId === row.id && inRange(log.created_at, periodRange.from, periodRange.to)
          })

          const relatedPhotos = photos.filter((photo) => {
            return photo.unit_stage_id === row.id && inRange(photo.created_at, periodRange.from, periodRange.to)
          })

          if (startDate && endDate && relatedLogs.length === 0 && relatedPhotos.length === 0) {
            return false
          }
        }

        if (text) {
          const joined = [
            safeStr(row.unit?.identifier),
            safeStr(row.stage_display_name),
            safeStr(row.notes),
            safeStr(row.status),
          ]
            .join(' ')
            .toLowerCase()

          if (!joined.includes(text)) return false
        }

        return true
      })
      .sort((a, b) => {
        const unitCmp = safeStr(a.unit?.identifier).localeCompare(safeStr(b.unit?.identifier), 'pt-BR')
        if (unitCmp !== 0) return unitCmp
        return Number(a.order_index || 0) - Number(b.order_index || 0)
      })
  }, [
    enrichedUnitStages,
    statusFilter,
    unitFilter,
    stageFilter,
    textFilter,
    onlyWithObservation,
    logs,
    photos,
    periodRange,
    startDate,
    endDate,
  ])

  const observationSummary = useMemo(() => {
    const counts = {
      total: filteredObservationRows.length,
      pending: 0,
      in_progress: 0,
      done: 0,
      with_notes: 0,
    }

    filteredObservationRows.forEach((row) => {
      const s = normalizeStatus(row.status)
      if (s === 'pending') counts.pending += 1
      if (s === 'in_progress') counts.in_progress += 1
      if (s === 'done') counts.done += 1
      if (safeStr(row.notes).trim()) counts.with_notes += 1
    })

    return counts
  }, [filteredObservationRows])

  function toggleMultiValue(setter, currentValues, value) {
    if (!value) return
    if (currentValues.includes(value)) {
      setter(currentValues.filter((v) => v !== value))
    } else {
      setter([...currentValues, value])
    }
  }

  async function rerun() {
    setRunning(true)
    try {
      await loadBaseData()
    } finally {
      setRunning(false)
    }
  }

  if (loading) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        Carregando...
      </div>
    )
  }

  if (!project) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        <div style={{ marginBottom: 12 }}>Obra não encontrada.</div>
        <Link href="/obras">← Voltar</Link>
      </div>
    )
  }

  const cardStyle = {
    border: '1px solid #eee',
    borderRadius: 16,
    padding: 16,
    background: '#fff',
    boxShadow: '0 6px 18px rgba(0,0,0,0.05)',
  }

  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid #ddd',
    outline: 'none',
    background: '#fff',
  }

  const buttonStyle = {
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid #ddd',
    background: '#111',
    color: '#fff',
    cursor: 'pointer',
    fontWeight: 800,
  }

  const softButtonStyle = {
    padding: '10px 12px',
    borderRadius: 12,
    border: '1px solid #ddd',
    background: '#fff',
    color: '#111',
    cursor: 'pointer',
    fontWeight: 800,
  }

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Relatórios da obra</div>
          <h1 style={{ margin: 0 }}>{project.name || '(Sem nome)'}</h1>
          <div style={{ marginTop: 8, fontSize: 13, color: '#555' }}>
            {project.client_name ? <b>{project.client_name}</b> : null}
            {project.client_name && project.city ? ' • ' : null}
            {project.city || ''}
            {project.address ? ` • ${project.address}` : ''}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={rerun} disabled={running} style={buttonStyle}>
            {running ? 'Atualizando...' : 'Atualizar relatório'}
          </button>
          <Link href={`/obras/${project.id}`} style={{ textDecoration: 'none' }}>
            ← Voltar para obra
          </Link>
        </div>
      </div>

      <hr style={{ margin: '18px 0' }} />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
        <button
          type="button"
          onClick={() => setMode(REPORT_MODE.diary)}
          style={{
            ...softButtonStyle,
            background: mode === REPORT_MODE.diary ? '#111' : '#fff',
            color: mode === REPORT_MODE.diary ? '#fff' : '#111',
          }}
        >
          Diário de obra
        </button>

        <button
          type="button"
          onClick={() => setMode(REPORT_MODE.period)}
          style={{
            ...softButtonStyle,
            background: mode === REPORT_MODE.period ? '#111' : '#fff',
            color: mode === REPORT_MODE.period ? '#fff' : '#111',
          }}
        >
          Resumo por período
        </button>

        <button
          type="button"
          onClick={() => setMode(REPORT_MODE.observations)}
          style={{
            ...softButtonStyle,
            background: mode === REPORT_MODE.observations ? '#111' : '#fff',
            color: mode === REPORT_MODE.observations ? '#fff' : '#111',
          }}
        >
          Observações e pendências
        </button>
      </div>

      {mode === REPORT_MODE.diary ? (
        <>
          <div style={{ ...cardStyle, marginBottom: 18 }}>
            <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 12 }}>Filtro do diário</div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Data</div>
                <input
                  type="date"
                  value={diaryDate}
                  onChange={(e) => setDiaryDate(e.target.value)}
                  style={inputStyle}
                />
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 18 }}>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Unidades com movimentação</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.moved_units}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Registros do dia</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.total_logs}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Fotos do dia</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.total_photos}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Etapas iniciadas</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.started}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Etapas concluídas</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.finished}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Observações registradas</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.observations}</div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 6 }}>
              Diário de obra — {formatDate(diaryDate)}
            </div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
              Relatório automático com base no histórico e nas fotos lançadas no dia.
            </div>

            {diaryEventsByUnit.length === 0 ? (
              <div style={{ color: '#666' }}>Nenhuma movimentação encontrada nesta data.</div>
            ) : (
              <div style={{ display: 'grid', gap: 14 }}>
                {diaryEventsByUnit.map((block) => (
                  <div
                    key={block.unit?.id || Math.random()}
                    style={{
                      border: '1px solid #eee',
                      borderRadius: 14,
                      padding: 14,
                      background: '#fafafa',
                    }}
                  >
                    <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 10 }}>
                      Unidade {safeStr(block.unit?.identifier) || '-'}
                    </div>

                    <div style={{ display: 'grid', gap: 10 }}>
                      {block.events.map((event, index) => (
                        <div
                          key={`${event.type}_${event.created_at}_${index}`}
                          style={{
                            border: '1px solid #eee',
                            borderRadius: 12,
                            padding: 12,
                            background: '#fff',
                          }}
                        >
                          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
                            {formatDateTime(event.created_at)}
                          </div>
                          <div style={{ fontSize: 15, fontWeight: 800 }}>
                            {event.stage_name} — {event.title}
                          </div>
                          {event.extra ? (
                            <div style={{ fontSize: 13, color: '#444', marginTop: 6 }}>
                              {event.extra}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}

      {mode === REPORT_MODE.period ? (
        <>
          <div style={{ ...cardStyle, marginBottom: 18 }}>
            <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 12 }}>Filtro do período</div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Data inicial</div>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Data final</div>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  style={inputStyle}
                />
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 18 }}>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Unidades com movimentação</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{periodSummary.moved_units}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Registros no período</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{periodSummary.total_logs}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Fotos no período</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{periodSummary.total_photos}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Total de unidades</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{units.length}</div>
            </div>
          </div>

          <div style={{ ...cardStyle, marginBottom: 18 }}>
            <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 6 }}>
              Resumo do período — {formatDate(startDate)} até {formatDate(endDate)}
            </div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
              Consolidado automático de atividades, movimentações e produção por etapa.
            </div>

            {periodSummary.stages.length === 0 ? (
              <div style={{ color: '#666' }}>Nenhuma movimentação encontrada no período selecionado.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                      <th style={{ padding: '10px 8px' }}>Etapa</th>
                      <th style={{ padding: '10px 8px' }}>Iniciadas</th>
                      <th style={{ padding: '10px 8px' }}>Concluídas</th>
                      <th style={{ padding: '10px 8px' }}>Observações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {periodSummary.stages.map((row, index) => (
                      <tr key={`${row.stage_name}_${index}`} style={{ borderBottom: '1px solid #f1f1f1' }}>
                        <td style={{ padding: '10px 8px', fontWeight: 700 }}>{row.stage_name}</td>
                        <td style={{ padding: '10px 8px' }}>{row.started}</td>
                        <td style={{ padding: '10px 8px' }}>{row.finished}</td>
                        <td style={{ padding: '10px 8px' }}>{row.observations}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 6 }}>
              Unidades com menor progresso
            </div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
              Apoio rápido para identificar gargalos e frentes atrasadas.
            </div>

            {lowestProgressUnits.length === 0 ? (
              <div style={{ color: '#666' }}>Nenhuma unidade encontrada.</div>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                {lowestProgressUnits.map((unit) => (
                  <div
                    key={unit.id}
                    style={{
                      border: '1px solid #eee',
                      borderRadius: 12,
                      padding: 12,
                      background: '#fafafa',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 900 }}>Unidade {unit.identifier || '-'}</div>
                      <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
                        Status da unidade: <b>{statusLabel(unit.status)}</b>
                      </div>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 12, color: '#666' }}>Progresso</div>
                      <div style={{ fontSize: 24, fontWeight: 900 }}>{Number(unit.progress || 0).toFixed(2)}%</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}

      {mode === REPORT_MODE.observations ? (
        <>
          <div style={{ ...cardStyle, marginBottom: 18 }}>
            <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 12 }}>
              Filtros de observações e pendências
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Data inicial</div>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Data final</div>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  style={inputStyle}
                />
              </div>

              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Status</div>
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={inputStyle}>
                  <option value="">Todos</option>
                  <option value="pending">Pendente</option>
                  <option value="in_progress">Em andamento</option>
                  <option value="done">Concluída</option>
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Texto</div>
                <input
                  type="text"
                  value={textFilter}
                  onChange={(e) => setTextFilter(e.target.value)}
                  placeholder="Buscar por unidade, etapa, observação..."
                  style={inputStyle}
                />
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={onlyWithObservation}
                  onChange={(e) => setOnlyWithObservation(e.target.checked)}
                />
                Mostrar somente etapas com observação
              </label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Filtrar por unidades</div>
                <div
                  style={{
                    border: '1px solid #eee',
                    borderRadius: 12,
                    padding: 10,
                    background: '#fafafa',
                    maxHeight: 220,
                    overflowY: 'auto',
                    display: 'grid',
                    gap: 8,
                  }}
                >
                  {units.length === 0 ? (
                    <div style={{ color: '#666', fontSize: 13 }}>Nenhuma unidade.</div>
                  ) : (
                    units.map((unit) => (
                      <label key={unit.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                        <input
                          type="checkbox"
                          checked={unitFilter.includes(unit.id)}
                          onChange={() => toggleMultiValue(setUnitFilter, unitFilter, unit.id)}
                        />
                        Unidade {unit.identifier || '-'}
                      </label>
                    ))
                  )}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Filtrar por etapas</div>
                <div
                  style={{
                    border: '1px solid #eee',
                    borderRadius: 12,
                    padding: 10,
                    background: '#fafafa',
                    maxHeight: 220,
                    overflowY: 'auto',
                    display: 'grid',
                    gap: 8,
                  }}
                >
                  {stages.length === 0 ? (
                    <div style={{ color: '#666', fontSize: 13 }}>Nenhuma etapa.</div>
                  ) : (
                    stages.map((stage) => (
                      <label key={stage.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                        <input
                          type="checkbox"
                          checked={stageFilter.includes(stage.id)}
                          onChange={() => toggleMultiValue(setStageFilter, stageFilter, stage.id)}
                        />
                        {stage.name || '-'}
                      </label>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
              <button
                type="button"
                onClick={() => {
                  setStatusFilter('')
                  setUnitFilter([])
                  setStageFilter([])
                  setTextFilter('')
                  setOnlyWithObservation(true)
                  setStartDate(today)
                  setEndDate(today)
                }}
                style={softButtonStyle}
              >
                Limpar filtros
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 18 }}>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Total filtrado</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{observationSummary.total}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Pendentes</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{observationSummary.pending}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Em andamento</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{observationSummary.in_progress}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Concluídas</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{observationSummary.done}</div>
            </div>
            <div style={cardStyle}>
              <div style={{ fontSize: 12, color: '#666' }}>Com observação</div>
              <div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{observationSummary.with_notes}</div>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 6 }}>
              Observações e pendências
            </div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
              Relatório filtrável por status, unidade, etapa, período e texto.
            </div>

            {filteredObservationRows.length === 0 ? (
              <div style={{ color: '#666' }}>Nenhum registro encontrado com os filtros selecionados.</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                      <th style={{ padding: '10px 8px' }}>Unidade</th>
                      <th style={{ padding: '10px 8px' }}>Etapa</th>
                      <th style={{ padding: '10px 8px' }}>Status</th>
                      <th style={{ padding: '10px 8px' }}>Observação</th>
                      <th style={{ padding: '10px 8px' }}>Última atualização</th>
                      <th style={{ padding: '10px 8px' }}>Abrir</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredObservationRows.map((row) => {
                      const relatedLogs = logs
                        .filter((log) => {
                          const metadata = parseMaybeJson(log?.metadata)
                          const unitStageId = log?.unit_stage_id || metadata?.unit_stage_id
                          return unitStageId === row.id
                        })
                        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

                      const latestLog = relatedLogs[0] || null

                      return (
                        <tr key={row.id} style={{ borderBottom: '1px solid #f1f1f1', verticalAlign: 'top' }}>
                          <td style={{ padding: '10px 8px', fontWeight: 700 }}>
                            {row.unit?.identifier || '-'}
                          </td>
                          <td style={{ padding: '10px 8px' }}>{row.stage_display_name}</td>
                          <td style={{ padding: '10px 8px' }}>{statusLabel(row.status)}</td>
                          <td style={{ padding: '10px 8px', maxWidth: 420 }}>
                            {safeStr(row.notes).trim() || <span style={{ color: '#999' }}>Sem observação</span>}
                          </td>
                          <td style={{ padding: '10px 8px' }}>
                            {latestLog?.created_at ? formatDateTime(latestLog.created_at) : '-'}
                          </td>
                          <td style={{ padding: '10px 8px' }}>
                            <Link href={`/unidades/${row.unit_id}`} style={{ textDecoration: 'none' }}>
                              Abrir unidade
                            </Link>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}
