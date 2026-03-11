import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { supabase } from '../../../lib/supabase'
import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'

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

const PHOTO_BUCKET = 'unit-stage-photos'

// Se depois quiser adicionar logo fixa hospedada no projeto,
// basta colocar a URL aqui, por exemplo:
// const REPORT_LOGO_URL = '/logo.png'
const REPORT_LOGO_URL = ''

function safeStr(v) {
  return (v ?? '').toString()
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

function formatDate(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('pt-BR')
}

function formatTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
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

function oldStatusFromLog(log) {
  const oldValue = parseMaybeJson(log?.old_value)
  return normalizeStatus(oldValue?.status)
}

function newStatusFromLog(log) {
  const newValue = parseMaybeJson(log?.new_value)
  return normalizeStatus(newValue?.status)
}

function getPhotoKindLabel(kind) {
  const k = safeStr(kind).toLowerCase()
  if (k === 'before') return 'Foto antes'
  if (k === 'after') return 'Foto depois'
  if (k === 'progress') return 'Foto de andamento'
  if (k === 'completion') return 'Foto de conclusão'
  if (k === 'issue') return 'Foto de pendência'
  if (k === 'image') return 'Foto'
  return kind || 'Foto'
}

function actionToHuman(log) {
  const action = safeStr(log?.action).toLowerCase()

  if (action === 'status_changed') {
    const fromStatus = oldStatusFromLog(log)
    const toStatus = newStatusFromLog(log)

    if (fromStatus === 'pending' && toStatus === 'in_progress') return 'Etapa iniciada'
    if (fromStatus === 'in_progress' && toStatus === 'done') return 'Etapa concluída'
    if (fromStatus === 'pending' && toStatus === 'done') return 'Etapa concluída'
    return `Status alterado de ${statusLabel(fromStatus)} para ${statusLabel(toStatus)}`
  }

  if (action === 'notes_updated') return 'Observação atualizada'
  if (action === 'photo_added') return 'Foto registrada'
  return ''
}

function durationLabel(startValue, endValue) {
  if (!startValue || !endValue) return ''
  const start = new Date(startValue).getTime()
  const end = new Date(endValue).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return ''

  const diffMs = end - start
  const totalHours = Math.floor(diffMs / (1000 * 60 * 60))
  const totalDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (totalDays >= 1) {
    return `${totalDays} dia${totalDays > 1 ? 's' : ''}`
  }

  if (totalHours >= 1) {
    return `${totalHours} hora${totalHours > 1 ? 's' : ''}`
  }

  const totalMinutes = Math.max(1, Math.floor(diffMs / (1000 * 60)))
  return `${totalMinutes} minuto${totalMinutes > 1 ? 's' : ''}`
}

function loadImageAsDataUrl(url) {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null)
      return
    }

    const img = new Image()
    img.crossOrigin = 'anonymous'

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth || img.width
        canvas.height = img.naturalHeight || img.height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
        resolve(dataUrl)
      } catch {
        resolve(null)
      }
    }

    img.onerror = () => resolve(null)
    img.src = url
  })
}

export default function ObraRelatoriosPage() {
  const router = useRouter()
  const { id } = router.query
  const reportRef = useRef(null)

  const projectId = useMemo(() => {
    if (!id) return null
    if (Array.isArray(id)) return id[0] || null
    return String(id)
  }, [id])

  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [exportingPdf, setExportingPdf] = useState(false)

  const [project, setProject] = useState(null)
  const [units, setUnits] = useState([])
  const [stages, setStages] = useState([])
  const [unitStages, setUnitStages] = useState([])
  const [photos, setPhotos] = useState([])
  const [logs, setLogs] = useState([])
  const [profilesMap, setProfilesMap] = useState({})

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
      setProfilesMap({})
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
        .select('id, unit_stage_id, user_id, action, old_value, new_value, created_at')
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
    const unitStagesRowsRaw = Array.isArray(unitStagesRes.data) ? unitStagesRes.data : []
    const photosRowsRaw = Array.isArray(photosRes.data) ? photosRes.data : []
    const logsRowsRaw = Array.isArray(logsRes.data) ? logsRes.data : []

    const unitIds = new Set(unitsRows.map((u) => u.id))
    const stageIds = new Set(stagesRows.map((s) => s.id))

    const unitStagesRows = unitStagesRowsRaw.filter(
      (row) => unitIds.has(row.unit_id) && stageIds.has(row.stage_id)
    )

    const unitStageIds = new Set(unitStagesRows.map((row) => row.id))

    const photosRows = photosRowsRaw.filter((row) => unitStageIds.has(row.unit_stage_id))
    const logsRows = logsRowsRaw.filter((row) => row?.unit_stage_id && unitStageIds.has(row.unit_stage_id))

    const userIds = Array.from(
      new Set(
        [...photosRows.map((x) => x.user_id), ...logsRows.map((x) => x.user_id)]
          .filter(Boolean)
      )
    )

    let nextProfilesMap = {}
    if (userIds.length > 0) {
      const { data: profileRows, error: profilesErr } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', userIds)

      if (!profilesErr && Array.isArray(profileRows)) {
        nextProfilesMap = profileRows.reduce((acc, row) => {
          acc[row.id] = row
          return acc
        }, {})
      }
    }

    setUnits(unitsRows)
    setStages(stagesRows)
    setUnitStages(unitStagesRows)
    setPhotos(photosRows)
    setLogs(logsRows)
    setProfilesMap(nextProfilesMap)
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

  const stageTimelineByUnitStageId = useMemo(() => {
    const map = {}
    const sortedLogs = [...logs].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))

    sortedLogs.forEach((log) => {
      const unitStageId = log.unit_stage_id
      if (!unitStageId) return

      if (!map[unitStageId]) {
        map[unitStageId] = {
          started_at: null,
          finished_at: null,
        }
      }

      if (log.action === 'status_changed') {
        const fromStatus = oldStatusFromLog(log)
        const toStatus = newStatusFromLog(log)

        if (!map[unitStageId].started_at) {
          if (
            (fromStatus === 'pending' && toStatus === 'in_progress') ||
            (fromStatus === 'pending' && toStatus === 'done')
          ) {
            map[unitStageId].started_at = log.created_at
          }
        }

        if (!map[unitStageId].finished_at) {
          if (toStatus === 'done') {
            map[unitStageId].finished_at = log.created_at
          }
        }
      }
    })

    return map
  }, [logs])

  const diaryBlocks = useMemo(() => {
    const relevantActions = new Set(['status_changed', 'notes_updated'])
    const blockMap = {}

    function ensureBlock(unitStageId) {
      if (!unitStageId) return null
      const us = unitStagesById[unitStageId]
      if (!us) return null
      const unit = unitsById[us.unit_id]
      const stage = stagesById[us.stage_id]
      if (!unit) return null

      if (!blockMap[unitStageId]) {
        const timeline = stageTimelineByUnitStageId[unitStageId] || {}
        blockMap[unitStageId] = {
          unit_stage_id: unitStageId,
          unit,
          stage,
          unitStage: us,
          stage_name: safeStr(us.custom_name).trim() || safeStr(stage?.name).trim() || 'Etapa',
          status: us.status,
          notes: safeStr(us.notes).trim(),
          started_at: timeline.started_at || null,
          finished_at: timeline.finished_at || null,
          photos: [],
          events: [],
        }
      }

      return blockMap[unitStageId]
    }

    diaryLogs.forEach((log) => {
      if (!relevantActions.has(log.action)) return
      const block = ensureBlock(log.unit_stage_id)
      if (!block) return

      let description = actionToHuman(log)
      if (!description) return

      if (log.action === 'notes_updated') {
        const newValue = parseMaybeJson(log?.new_value)
        const noteText = safeStr(newValue?.notes).trim()
        if (noteText) {
          description = `Observação atualizada: ${noteText}`
        } else {
          description = 'Observação removida'
        }
      }

      block.events.push({
        type: 'log',
        created_at: log.created_at,
        text: description,
        user_name:
          safeStr(profilesMap[log.user_id]?.full_name).trim() ||
          safeStr(profilesMap[log.user_id]?.email).trim() ||
          '',
      })
    })

    diaryPhotos.forEach((photo) => {
      const block = ensureBlock(photo.unit_stage_id)
      if (!block) return
      block.photos.push({
        ...photo,
        user_name:
          safeStr(profilesMap[photo.user_id]?.full_name).trim() ||
          safeStr(profilesMap[photo.user_id]?.email).trim() ||
          '',
      })
      block.events.push({
        type: 'photo',
        created_at: photo.created_at,
        text: getPhotoKindLabel(photo.kind),
        user_name:
          safeStr(profilesMap[photo.user_id]?.full_name).trim() ||
          safeStr(profilesMap[photo.user_id]?.email).trim() ||
          '',
      })
    })

    return Object.values(blockMap)
      .map((block) => ({
        ...block,
        events: block.events.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
        photos: block.photos.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
      }))
      .sort((a, b) => {
        const unitCmp = safeStr(a.unit?.identifier).localeCompare(safeStr(b.unit?.identifier), 'pt-BR')
        if (unitCmp !== 0) return unitCmp
        return safeStr(a.stage_name).localeCompare(safeStr(b.stage_name), 'pt-BR')
      })
  }, [diaryLogs, diaryPhotos, unitStagesById, unitsById, stagesById, stageTimelineByUnitStageId, profilesMap])

  const diarySummary = useMemo(() => {
    const unitIds = new Set()
    let started = 0
    let finished = 0
    let observations = 0

    diaryBlocks.forEach((block) => {
      if (block.unit?.id) unitIds.add(block.unit.id)

      block.events.forEach((event) => {
        const text = safeStr(event.text).toLowerCase()
        if (text.includes('etapa iniciada')) started += 1
        if (text.includes('etapa concluída')) finished += 1
        if (text.includes('observação')) observations += 1
      })
    })

    return {
      moved_units: unitIds.size,
      total_logs: diaryLogs.length,
      total_photos: diaryPhotos.length,
      started,
      finished,
      observations,
    }
  }, [diaryBlocks, diaryLogs.length, diaryPhotos.length])

  const periodSummary = useMemo(() => {
    const unitIds = new Set()
    const stageCounters = {}

    periodLogs.forEach((log) => {
      const us = unitStagesById[log.unit_stage_id]
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

      if (log.action === 'status_changed') {
        const fromStatus = oldStatusFromLog(log)
        const toStatus = newStatusFromLog(log)
        if (fromStatus === 'pending' && toStatus === 'in_progress') stageCounters[key].started += 1
        if (toStatus === 'done') stageCounters[key].finished += 1
      }

      if (log.action === 'notes_updated') {
        stageCounters[key].observations += 1
      }
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
            return log.unit_stage_id === row.id && inRange(log.created_at, periodRange.from, periodRange.to)
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

  const projectSummary = useMemo(() => {
    const counts = {
      total_units: units.length,
      pending: 0,
      in_progress: 0,
      done: 0,
      avg_progress: 0,
    }

    let progressSum = 0
    units.forEach((unit) => {
      const status = normalizeStatus(unit.status)
      if (status === 'pending') counts.pending += 1
      if (status === 'in_progress') counts.in_progress += 1
      if (status === 'done') counts.done += 1
      progressSum += Number(unit.progress || 0)
    })

    counts.avg_progress = units.length > 0 ? progressSum / units.length : 0
    return counts
  }, [units])

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

  async function generateDiaryPdf() {
    if (!project) return

    const pdf = new jsPDF('p', 'mm', 'a4')
    const pageWidth = pdf.internal.pageSize.getWidth()
    const pageHeight = pdf.internal.pageSize.getHeight()

    const margin = 12
    const contentWidth = pageWidth - margin * 2
    let y = margin

    let logoDataUrl = null
    if (REPORT_LOGO_URL) {
      logoDataUrl = await loadImageAsDataUrl(REPORT_LOGO_URL)
    }

    function addPageIfNeeded(extra = 10) {
      if (y + extra > pageHeight - margin) {
        pdf.addPage()
        y = margin
      }
    }

    function drawWrappedText(text, x, topY, maxWidth, lineHeight = 5) {
      const lines = pdf.splitTextToSize(safeStr(text), maxWidth)
      pdf.text(lines, x, topY)
      return lines.length * lineHeight
    }

    function sectionTitle(text) {
      addPageIfNeeded(16)
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(13)
      pdf.text(text, margin, y)
      y += 6
      pdf.setDrawColor(190)
      pdf.line(margin, y, pageWidth - margin, y)
      y += 6
    }

    function labelValue(label, value) {
      addPageIfNeeded(8)
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(10.5)
      pdf.text(`${label}:`, margin, y)
      pdf.setFont('helvetica', 'normal')
      const used = drawWrappedText(safeStr(value) || '-', margin + 32, y, contentWidth - 32, 5)
      y += Math.max(6, used)
    }

    function addSummaryCard(label, value) {
      const cardWidth = (contentWidth - 6) / 2
      const x = ((summaryCardIndex % 2) * (cardWidth + 6)) + margin
      const cardY = y
      const cardHeight = 22

      pdf.setDrawColor(220)
      pdf.rect(x, cardY, cardWidth, cardHeight)

      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(9)
      const labelLines = pdf.splitTextToSize(safeStr(label), cardWidth - 6)
      pdf.text(labelLines, x + 3, cardY + 6)

      const labelHeight = labelLines.length * 4

      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(13)
      pdf.text(safeStr(value), x + 3, cardY + 8 + labelHeight)

      summaryCardIndex += 1
      if (summaryCardIndex % 2 === 0) {
        y += cardHeight + 6
      }
    }

    async function addPhotoBlock(photo) {
      addPageIfNeeded(72)

      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(10.5)
      pdf.text(getPhotoKindLabel(photo.kind), margin, y)
      y += 6

      let signedUrl = null
      if (photo.path) {
        const { data, error } = await supabase.storage
          .from(PHOTO_BUCKET)
          .createSignedUrl(photo.path, 60 * 30)

        if (!error && data?.signedUrl) {
          signedUrl = data.signedUrl
        }
      }

      const imageDataUrl = signedUrl ? await loadImageAsDataUrl(signedUrl) : null

      if (imageDataUrl) {
        addPageIfNeeded(68)

        const imgX = margin
        const imgY = y
        const imgWidth = Math.min(95, contentWidth)
        const imgHeight = 62

        try {
          pdf.addImage(imageDataUrl, 'JPEG', imgX, imgY, imgWidth, imgHeight)
          y += imgHeight + 5
        } catch {
          pdf.setFont('helvetica', 'italic')
          pdf.setFontSize(10)
          pdf.text('Não foi possível carregar a imagem no PDF.', margin, y)
          y += 6
        }
      } else {
        pdf.setFont('helvetica', 'italic')
        pdf.setFontSize(10)
        pdf.text('Imagem não disponível para este registro.', margin, y)
        y += 6
      }

      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(10)

      y += drawWrappedText(
        `Postado por: ${safeStr(photo.user_name).trim() || 'Usuário não identificado'}`,
        margin,
        y,
        contentWidth,
        5
      )

      y += drawWrappedText(`Data/hora: ${formatDateTime(photo.created_at)}`, margin, y, contentWidth, 5)

      if (safeStr(photo.caption).trim()) {
        y += drawWrappedText(`Legenda: ${safeStr(photo.caption).trim()}`, margin, y, contentWidth, 5)
      }

      y += 4
    }

    async function addDiaryBlock(block) {
      addPageIfNeeded(34)

      pdf.setFillColor(245, 245, 245)
      pdf.rect(margin, y, contentWidth, 9, 'F')
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(12)
      pdf.text(`Unidade ${safeStr(block.unit?.identifier) || '-'}`, margin + 3, y + 6)
      y += 14

      labelValue('Etapa', block.stage_name)
      labelValue('Status atual', statusLabel(block.status))

      if (block.started_at) {
        labelValue('Início', formatDateTime(block.started_at))
      }

      if (block.finished_at) {
        labelValue('Conclusão', formatDateTime(block.finished_at))
      }

      if (block.started_at && block.finished_at) {
        labelValue('Duração', durationLabel(block.started_at, block.finished_at))
      }

      const relevantEvents = block.events.filter((event) => safeStr(event.text).trim())

      if (relevantEvents.length > 0) {
        addPageIfNeeded(12)
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(10.5)
        pdf.text('Atividades registradas no dia', margin, y)
        y += 7

        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(10)

        relevantEvents.forEach((event) => {
          addPageIfNeeded(8)
          const txt = `${formatTime(event.created_at)} - ${event.text}${event.user_name ? ` (${event.user_name})` : ''}`
          y += drawWrappedText(`• ${txt}`, margin + 2, y, contentWidth - 2, 5)
        })

        y += 2
      }

      if (safeStr(block.notes).trim()) {
        addPageIfNeeded(14)
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(10.5)
        pdf.text('Observação da etapa', margin, y)
        y += 7

        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(10)
        y += drawWrappedText(block.notes, margin, y, contentWidth, 5)
        y += 2
      }

      if (block.photos.length > 0) {
        addPageIfNeeded(12)
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(10.5)
        pdf.text('Fotos registradas no dia', margin, y)
        y += 8

        for (const photo of block.photos) {
          await addPhotoBlock(photo)
        }
      }

      y += 3
      pdf.setDrawColor(215)
      pdf.line(margin, y, pageWidth - margin, y)
      y += 8
    }

    function drawBarChart(title, percent) {
      addPageIfNeeded(22)
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(10.5)
      pdf.text(title, margin, y)
      y += 6

      pdf.setDrawColor(180)
      pdf.rect(margin, y, contentWidth, 7)
      pdf.setFillColor(90, 90, 90)
      pdf.rect(margin, y, (contentWidth * percent) / 100, 7, 'F')
      y += 11

      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(10)
      pdf.text(`${percent.toFixed(1)}%`, margin, y)
      y += 8
    }

    if (logoDataUrl) {
      try {
        pdf.addImage(logoDataUrl, 'PNG', margin, y, 24, 24)
      } catch {}
    }

    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(17)
    pdf.text('DIÁRIO DE OBRA', logoDataUrl ? margin + 30 : margin, y + 8)

    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(10.5)
    pdf.text('Relatório automático de acompanhamento da obra', logoDataUrl ? margin + 30 : margin, y + 15)

    y += 30

    pdf.setDrawColor(180)
    pdf.line(margin, y, pageWidth - margin, y)
    y += 8

    labelValue('Obra', project.name || '-')
    labelValue('Cliente', project.client_name || '-')
    labelValue('Cidade', project.city || '-')
    labelValue('Data do diário', formatDate(diaryDate))
    labelValue('Responsável pela emissão', 'Denio Losi')

    y += 3

    sectionTitle('Resumo do dia')

    let summaryCardIndex = 0
    addSummaryCard('Unidades com atividade', diarySummary.moved_units)
    addSummaryCard('Etapas iniciadas', diarySummary.started)
    addSummaryCard('Etapas concluídas', diarySummary.finished)
    addSummaryCard('Fotos registradas', diarySummary.total_photos)

    if (summaryCardIndex % 2 !== 0) {
      y += 28
    }

    addSummaryCard('Observações registradas', diarySummary.observations)
    addSummaryCard('Registros do histórico', diarySummary.total_logs)

    if (summaryCardIndex % 2 !== 0) {
      y += 28
    }

    y += 4

    sectionTitle(`Atividades da data ${formatDate(diaryDate)}`)

    if (diaryBlocks.length === 0) {
      pdf.setFont('helvetica', 'italic')
      pdf.setFontSize(11)
      pdf.text('Nenhuma movimentação encontrada para a data selecionada.', margin, y)
      y += 8
    } else {
      for (const block of diaryBlocks) {
        await addDiaryBlock(block)
      }
    }

    sectionTitle('Resumo atualizado da obra')

    labelValue('Total de unidades', projectSummary.total_units)
    labelValue('Unidades pendentes', projectSummary.pending)
    labelValue('Unidades em andamento', projectSummary.in_progress)
    labelValue('Unidades concluídas', projectSummary.done)
    labelValue('Progresso médio', `${projectSummary.avg_progress.toFixed(2)}%`)

    y += 4

    const statusTotal = Math.max(1, projectSummary.total_units)
    const avgPct = Math.max(0, Math.min(100, Number(projectSummary.avg_progress || 0)))
    const donePct = (projectSummary.done / statusTotal) * 100
    const inProgressPct = (projectSummary.in_progress / statusTotal) * 100
    const pendingPct = (projectSummary.pending / statusTotal) * 100

    drawBarChart('Progresso Geral da Obra', avgPct)
    drawBarChart('Unidades concluídas', donePct)
    drawBarChart('Unidades em andamento', inProgressPct)
    drawBarChart('Unidades pendentes', pendingPct)

    const fileName = `${safeStr(project.name || 'obra')
      .replace(/[^\w\-]+/g, '_')
      .replace(/_+/g, '_')}_diario_de_obra_${safeStr(diaryDate)}.pdf`

    pdf.save(fileName)
  }

  async function generateScreenshotPdf() {
    if (!reportRef.current || !project) return

    const modeLabel =
      mode === REPORT_MODE.diary
        ? 'diario-de-obra'
        : mode === REPORT_MODE.period
        ? 'resumo-por-periodo'
        : 'observacoes-e-pendencias'

    const dateLabel =
      mode === REPORT_MODE.diary
        ? safeStr(diaryDate)
        : `${safeStr(startDate)}_a_${safeStr(endDate)}`

    const fileName = `${safeStr(project.name || 'obra')
      .replace(/[^\w\-]+/g, '_')
      .replace(/_+/g, '_')}_${modeLabel}_${dateLabel}.pdf`

    const canvas = await html2canvas(reportRef.current, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
      windowWidth: reportRef.current.scrollWidth,
    })

    const imgData = canvas.toDataURL('image/jpeg', 0.95)

    const pdf = new jsPDF('p', 'mm', 'a4')
    const pageWidth = pdf.internal.pageSize.getWidth()
    const pageHeight = pdf.internal.pageSize.getHeight()

    const margin = 8
    const usableWidth = pageWidth - margin * 2
    const usableHeight = pageHeight - margin * 2

    const imgWidth = usableWidth
    const imgHeight = (canvas.height * imgWidth) / canvas.width

    let heightLeft = imgHeight
    let position = margin

    pdf.addImage(imgData, 'JPEG', margin, position, imgWidth, imgHeight)
    heightLeft -= usableHeight

    while (heightLeft > 0) {
      position = heightLeft - imgHeight + margin
      pdf.addPage()
      pdf.addImage(imgData, 'JPEG', margin, position, imgWidth, imgHeight)
      heightLeft -= usableHeight
    }

    pdf.save(fileName)
  }

  async function exportCurrentReportToPdf() {
    if (!project) return

    setExportingPdf(true)
    try {
      if (mode === REPORT_MODE.diary) {
        await generateDiaryPdf()
      } else {
        await generateScreenshotPdf()
      }
    } catch (error) {
      console.error(error)
      alert(`Erro ao gerar PDF: ${error?.message || error}`)
    } finally {
      setExportingPdf(false)
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
          <button
            type="button"
            onClick={rerun}
            disabled={running}
            style={buttonStyle}
            data-html2canvas-ignore="true"
          >
            {running ? 'Atualizando...' : 'Atualizar relatório'}
          </button>

          <button
            type="button"
            onClick={exportCurrentReportToPdf}
            disabled={exportingPdf}
            style={buttonStyle}
            data-html2canvas-ignore="true"
          >
            {exportingPdf ? 'Gerando PDF...' : 'Gerar PDF'}
          </button>

          <Link
            href={`/obras/${project.id}`}
            style={{ textDecoration: 'none' }}
            data-html2canvas-ignore="true"
          >
            ← Voltar para obra
          </Link>
        </div>
      </div>

      <hr style={{ margin: '18px 0' }} />

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }} data-html2canvas-ignore="true">
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

      <div ref={reportRef} style={{ background: '#fff', padding: 4 }}>
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
                Relatório automático com base nas movimentações, observações e fotos lançadas na data selecionada.
              </div>

              {diaryBlocks.length === 0 ? (
                <div style={{ color: '#666' }}>Nenhuma movimentação encontrada nesta data.</div>
              ) : (
                <div style={{ display: 'grid', gap: 14 }}>
                  {diaryBlocks.map((block) => (
                    <div
                      key={block.unit_stage_id}
                      style={{
                        border: '1px solid #eee',
                        borderRadius: 14,
                        padding: 14,
                        background: '#fafafa',
                      }}
                    >
                      <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 8 }}>
                        Unidade {safeStr(block.unit?.identifier) || '-'}
                      </div>

                      <div style={{ fontSize: 14, marginBottom: 6 }}>
                        <b>Etapa:</b> {block.stage_name}
                      </div>

                      <div style={{ fontSize: 14, marginBottom: 6 }}>
                        <b>Status atual:</b> {statusLabel(block.status)}
                      </div>

                      {block.started_at ? (
                        <div style={{ fontSize: 13, color: '#444', marginBottom: 4 }}>
                          <b>Início:</b> {formatDateTime(block.started_at)}
                        </div>
                      ) : null}

                      {block.finished_at ? (
                        <div style={{ fontSize: 13, color: '#444', marginBottom: 4 }}>
                          <b>Conclusão:</b> {formatDateTime(block.finished_at)}
                        </div>
                      ) : null}

                      {block.started_at && block.finished_at ? (
                        <div style={{ fontSize: 13, color: '#444', marginBottom: 8 }}>
                          <b>Duração:</b> {durationLabel(block.started_at, block.finished_at)}
                        </div>
                      ) : null}

                      {block.events.length > 0 ? (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>
                            Atividades registradas no dia
                          </div>
                          <div style={{ display: 'grid', gap: 6 }}>
                            {block.events.map((event, index) => (
                              <div key={`${block.unit_stage_id}_${index}`} style={{ fontSize: 13, color: '#444' }}>
                                • {formatTime(event.created_at)} — {event.text}
                                {event.user_name ? ` (${event.user_name})` : ''}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {safeStr(block.notes).trim() ? (
                        <div style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>
                            Observação da etapa
                          </div>
                          <div style={{ fontSize: 13, color: '#444' }}>
                            {block.notes}
                          </div>
                        </div>
                      ) : null}

                      {block.photos.length > 0 ? (
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>
                            Fotos registradas no dia
                          </div>
                          <div style={{ display: 'grid', gap: 10 }}>
                            {block.photos.map((photo) => (
                              <div
                                key={photo.id}
                                style={{
                                  border: '1px solid #eee',
                                  borderRadius: 12,
                                  padding: 10,
                                  background: '#fff',
                                }}
                              >
                                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
                                  {getPhotoKindLabel(photo.kind)}
                                </div>
                                <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>
                                  Postado por: <b>{photo.user_name || 'Usuário não identificado'}</b>
                                </div>
                                <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>
                                  Data/hora: <b>{formatDateTime(photo.created_at)}</b>
                                </div>
                                {safeStr(photo.caption).trim() ? (
                                  <div style={{ fontSize: 12, color: '#555' }}>
                                    Legenda: <b>{photo.caption}</b>
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
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
                          .filter((log) => log.unit_stage_id === row.id)
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
    </div>
  )
}
