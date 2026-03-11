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

  if (totalDays >= 1) return `${totalDays} dia${totalDays > 1 ? 's' : ''}`
  if (totalHours >= 1) return `${totalHours} hora${totalHours > 1 ? 's' : ''}`

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
        resolve(canvas.toDataURL('image/jpeg', 0.92))
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

    const [unitsRes, stagesRes, unitStagesRes, photosRes, logsRes] = await Promise.all([
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
      new Set([...photosRows.map((x) => x.user_id), ...logsRows.map((x) => x.user_id)].filter(Boolean))
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
    return {
      from: startOfDayIso(startDate),
      to: endOfDayIso(endDate),
    }
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

  function buildBlocks(logRows, photoRows) {
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

    logRows.forEach((log) => {
      if (!relevantActions.has(log.action)) return
      const block = ensureBlock(log.unit_stage_id)
      if (!block) return

      let description = actionToHuman(log)
      if (!description) return

      if (log.action === 'notes_updated') {
        const newValue = parseMaybeJson(log?.new_value)
        const noteText = safeStr(newValue?.notes).trim()
        description = noteText ? `Observação atualizada: ${noteText}` : 'Observação removida'
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

    photoRows.forEach((photo) => {
      const block = ensureBlock(photo.unit_stage_id)
      if (!block) return
      const userName =
        safeStr(profilesMap[photo.user_id]?.full_name).trim() ||
        safeStr(profilesMap[photo.user_id]?.email).trim() ||
        ''

      block.photos.push({
        ...photo,
        user_name: userName,
      })

      block.events.push({
        type: 'photo',
        created_at: photo.created_at,
        text: getPhotoKindLabel(photo.kind),
        user_name: userName,
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
  }

  const diaryBlocks = useMemo(() => buildBlocks(diaryLogs, diaryPhotos), [diaryLogs, diaryPhotos, profilesMap, unitsById, stagesById, unitStagesById, stageTimelineByUnitStageId])
  const periodBlocks = useMemo(() => buildBlocks(periodLogs, periodPhotos), [periodLogs, periodPhotos, profilesMap, unitsById, stagesById, unitStagesById, stageTimelineByUnitStageId])

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
    let started = 0
    let finished = 0
    let observations = 0

    periodBlocks.forEach((block) => {
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
      total_logs: periodLogs.length,
      total_photos: periodPhotos.length,
      started,
      finished,
      observations,
    }
  }, [periodBlocks, periodLogs.length, periodPhotos.length])

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

  async function createPdfHelper() {
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

    function drawWrappedText(text, x, topY, maxWidth, lineHeight = 7) {
      const lines = pdf.splitTextToSize(safeStr(text), maxWidth)
      pdf.text(lines, x, topY, { baseline: 'top' })
      return lines.length * lineHeight
    }

    function sectionTitle(text) {
      addPageIfNeeded(18)
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(13)
      pdf.text(text, margin, y)
      y += 7
      pdf.setDrawColor(190)
      pdf.line(margin, y, pageWidth - margin, y)
      y += 7
    }

    function labelValue(label, value) {
      addPageIfNeeded(11)
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(10.5)
      pdf.text(`${label}:`, margin, y)

      pdf.setFont('helvetica', 'normal')
      const used = drawWrappedText(safeStr(value) || '-', margin + 32, y - 1, contentWidth - 32, 7)
      y += Math.max(8, used + 1.5)
    }

    let summaryCardIndex = 0

    function resetSummaryCardIndex() {
      summaryCardIndex = 0
    }

    function addSummaryCard(label, value) {
      const cardWidth = (contentWidth - 6) / 2
      const x = ((summaryCardIndex % 2) * (cardWidth + 6)) + margin
      const cardY = y
      const cardHeight = 30

      pdf.setDrawColor(220)
      pdf.rect(x, cardY, cardWidth, cardHeight)

      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(9)
      const labelLines = pdf.splitTextToSize(safeStr(label), cardWidth - 6)
      pdf.text(labelLines, x + 3, cardY + 5, { baseline: 'top' })

      const labelHeight = labelLines.length * 5

      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(13)
      pdf.text(safeStr(value), x + 3, cardY + 10 + labelHeight)

      summaryCardIndex += 1
      if (summaryCardIndex % 2 === 0) {
        y += cardHeight + 8
      }
    }

    async function addPhotoBlock(photo) {
      addPageIfNeeded(76)

      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(10.5)
      pdf.text(getPhotoKindLabel(photo.kind), margin, y)
      y += 7

      let signedUrl = null
      if (photo.path) {
        const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(photo.path, 60 * 30)
        if (!error && data?.signedUrl) signedUrl = data.signedUrl
      }

      const imageDataUrl = signedUrl ? await loadImageAsDataUrl(signedUrl) : null

      if (imageDataUrl) {
        addPageIfNeeded(70)

        const imgX = margin
        const imgY = y
        const imgWidth = Math.min(95, contentWidth)
        const imgHeight = 62

        try {
          pdf.addImage(imageDataUrl, 'JPEG', imgX, imgY, imgWidth, imgHeight)
          y += imgHeight + 6
        } catch {
          pdf.setFont('helvetica', 'italic')
          pdf.setFontSize(10)
          pdf.text('Não foi possível carregar a imagem no PDF.', margin, y)
          y += 7
        }
      } else {
        pdf.setFont('helvetica', 'italic')
        pdf.setFontSize(10)
        pdf.text('Imagem não disponível para este registro.', margin, y)
        y += 7
      }

      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(10)

      y += drawWrappedText(
        `Postado por: ${safeStr(photo.user_name).trim() || 'Usuário não identificado'}`,
        margin,
        y,
        contentWidth,
        7
      ) + 1.5

      y += drawWrappedText(`Data/hora: ${formatDateTime(photo.created_at)}`, margin, y, contentWidth, 7) + 1.5

      if (safeStr(photo.caption).trim()) {
        y += drawWrappedText(`Legenda: ${safeStr(photo.caption).trim()}`, margin, y, contentWidth, 7) + 1.5
      }

      y += 5
    }

    async function addBlock(block) {
      addPageIfNeeded(38)

      pdf.setFillColor(245, 245, 245)
      pdf.rect(margin, y, contentWidth, 10, 'F')
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(12)
      pdf.text(`Unidade ${safeStr(block.unit?.identifier) || '-'}`, margin + 3, y + 6.5)
      y += 15

      labelValue('Etapa', block.stage_name)
      labelValue('Status atual', statusLabel(block.status))

      if (block.started_at) labelValue('Início', formatDateTime(block.started_at))
      if (block.finished_at) labelValue('Conclusão', formatDateTime(block.finished_at))
      if (block.started_at && block.finished_at) {
        labelValue('Duração', durationLabel(block.started_at, block.finished_at))
      }

      const relevantEvents = block.events.filter((event) => safeStr(event.text).trim())

      if (relevantEvents.length > 0) {
        addPageIfNeeded(13)
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(10.5)
        pdf.text('Atividades registradas', margin, y)
        y += 8

        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(10)

        relevantEvents.forEach((event) => {
          addPageIfNeeded(10)
          const txt = `${formatDate(event.created_at)} ${formatTime(event.created_at)} - ${event.text}${event.user_name ? ` (${event.user_name})` : ''}`
          y += drawWrappedText(`• ${txt}`, margin + 2, y, contentWidth - 2, 7) + 1.5
        })

        y += 2
      }

      if (safeStr(block.notes).trim()) {
        addPageIfNeeded(15)
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(10.5)
        pdf.text('Observação da etapa', margin, y)
        y += 8

        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(10)
        y += drawWrappedText(block.notes, margin, y, contentWidth, 7) + 1.5
        y += 2
      }

      if (block.photos.length > 0) {
        addPageIfNeeded(14)
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(10.5)
        pdf.text('Fotos registradas', margin, y)
        y += 9

        for (const photo of block.photos) {
          await addPhotoBlock(photo)
        }
      }

      y += 4
      pdf.setDrawColor(215)
      pdf.line(margin, y, pageWidth - margin, y)
      y += 9
    }

    function drawBarChart(title, percent) {
      addPageIfNeeded(28)
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(10.5)
      pdf.text(title, margin, y)
      y += 7

      pdf.setDrawColor(180)
      pdf.rect(margin, y, contentWidth, 7)
      pdf.setFillColor(90, 90, 90)
      pdf.rect(margin, y, (contentWidth * percent) / 100, 7, 'F')
      y += 12

      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(10)
      pdf.text(`${percent.toFixed(1)}%`, margin, y)
      y += 8
    }

    function addHeader(title, subtitle) {
      if (logoDataUrl) {
        try {
          pdf.addImage(logoDataUrl, 'PNG', margin, y, 24, 24)
        } catch {}
      }

      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(17)
      pdf.text(title, logoDataUrl ? margin + 30 : margin, y + 8)

      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(10.5)
      pdf.text(subtitle, logoDataUrl ? margin + 30 : margin, y + 15)

      y += 30
      pdf.setDrawColor(180)
      pdf.line(margin, y, pageWidth - margin, y)
      y += 8
    }

    return {
      pdf,
      pageWidth,
      pageHeight,
      margin,
      contentWidth,
      getY: () => y,
      setY: (v) => {
        y = v
      },
      addPageIfNeeded,
      drawWrappedText,
      sectionTitle,
      labelValue,
      addSummaryCard,
      resetSummaryCardIndex,
      addPhotoBlock,
      addBlock,
      drawBarChart,
      addHeader,
    }
  }

  async function generateDiaryPdf() {
    if (!project) return

    const helper = await createPdfHelper()
    const {
      pdf,
      sectionTitle,
      labelValue,
      addSummaryCard,
      resetSummaryCardIndex,
      addBlock,
      drawBarChart,
      addHeader,
      getY,
      setY,
    } = helper

    addHeader('DIÁRIO DE OBRA', 'Relatório automático de acompanhamento da obra')

    labelValue('Obra', project.name || '-')
    labelValue('Cliente', project.client_name || '-')
    labelValue('Cidade', project.city || '-')
    labelValue('Data do diário', formatDate(diaryDate))
    labelValue('Responsável pela emissão', 'Denio Losi')

    setY(getY() + 3)

    sectionTitle('Resumo do dia')

    resetSummaryCardIndex()
    addSummaryCard('Unidades com atividade', diarySummary.moved_units)
    addSummaryCard('Etapas iniciadas', diarySummary.started)
    addSummaryCard('Etapas concluídas', diarySummary.finished)
    addSummaryCard('Fotos registradas', diarySummary.total_photos)

    if (getY() % 1 !== 0) setY(getY())
    setY(getY() + 0)

    addSummaryCard('Observações registradas', diarySummary.observations)
    addSummaryCard('Registros do histórico', diarySummary.total_logs)

    setY(getY() + 4)

    sectionTitle(`Atividades da data ${formatDate(diaryDate)}`)

    if (diaryBlocks.length === 0) {
      pdf.setFont('helvetica', 'italic')
      pdf.setFontSize(11)
      pdf.text('Nenhuma movimentação encontrada para a data selecionada.', helper.margin, getY())
      setY(getY() + 8)
    } else {
      for (const block of diaryBlocks) {
        await addBlock(block)
      }
    }

    sectionTitle('Resumo atualizado da obra')

    labelValue('Total de unidades', projectSummary.total_units)
    labelValue('Unidades pendentes', projectSummary.pending)
    labelValue('Unidades em andamento', projectSummary.in_progress)
    labelValue('Unidades concluídas', projectSummary.done)
    labelValue('Progresso médio', `${projectSummary.avg_progress.toFixed(2)}%`)

    setY(getY() + 4)

    const statusTotal = Math.max(1, projectSummary.total_units)
    const avgPct = Math.max(0, Math.min(100, Number(projectSummary.avg_progress || 0)))
    const donePct = (projectSummary.done / statusTotal) * 100
    const inProgressPct = (projectSummary.in_progress / statusTotal) * 100
    const pendingPct = (projectSummary.pending / statusTotal) * 100

    drawBarChart('Progresso Geral da Obra', avgPct)
    drawBarChart('Unidades concluídas', donePct)
    drawBarChart('Unidades em andamento', inProgressPct)
    drawBarChart('Unidades pendentes', pendingPct)

    const fileName = `${safeStr(project.name || 'obra').replace(/[^\w\-]+/g, '_').replace(/_+/g, '_')}_diario_de_obra_${safeStr(diaryDate)}.pdf`
    pdf.save(fileName)
  }

  async function generatePeriodPdf() {
    if (!project) return

    const helper = await createPdfHelper()
    const {
      pdf,
      sectionTitle,
      labelValue,
      addSummaryCard,
      resetSummaryCardIndex,
      addBlock,
      addHeader,
      getY,
      setY,
    } = helper

    addHeader('RESUMO POR PERÍODO', 'Relatório cronológico consolidado por unidade')

    labelValue('Obra', project.name || '-')
    labelValue('Cliente', project.client_name || '-')
    labelValue('Cidade', project.city || '-')
    labelValue('Data inicial', formatDate(startDate))
    labelValue('Data final', formatDate(endDate))
    labelValue('Responsável pela emissão', 'Denio Losi')

    setY(getY() + 3)

    sectionTitle('Resumo do período')

    resetSummaryCardIndex()
    addSummaryCard('Unidades com movimentação', periodSummary.moved_units)
    addSummaryCard('Etapas iniciadas', periodSummary.started)
    addSummaryCard('Etapas concluídas', periodSummary.finished)
    addSummaryCard('Fotos registradas', periodSummary.total_photos)
    addSummaryCard('Observações registradas', periodSummary.observations)
    addSummaryCard('Registros do histórico', periodSummary.total_logs)

    setY(getY() + 4)

    sectionTitle(`Movimentações entre ${formatDate(startDate)} e ${formatDate(endDate)}`)

    if (periodBlocks.length === 0) {
      pdf.setFont('helvetica', 'italic')
      pdf.setFontSize(11)
      pdf.text('Nenhuma movimentação encontrada no período selecionado.', helper.margin, getY())
      setY(getY() + 8)
    } else {
      for (const block of periodBlocks) {
        await addBlock(block)
      }
    }

    const fileName = `${safeStr(project.name || 'obra').replace(/[^\w\-]+/g, '_').replace(/_+/g, '_')}_resumo_periodo_${safeStr(startDate)}_a_${safeStr(endDate)}.pdf`
    pdf.save(fileName)
  }

  async function generateObservationsPdf() {
    if (!project) return

    const helper = await createPdfHelper()
    const {
      pdf,
      sectionTitle,
      labelValue,
      addSummaryCard,
      resetSummaryCardIndex,
      addPageIfNeeded,
      drawWrappedText,
      addHeader,
      getY,
      setY,
      margin,
      contentWidth,
      pageWidth,
    } = helper

    addHeader('OBSERVAÇÕES E PENDÊNCIAS', 'Relatório filtrado por status, etapa, unidade e período')

    labelValue('Obra', project.name || '-')
    labelValue('Cliente', project.client_name || '-')
    labelValue('Cidade', project.city || '-')
    labelValue('Período inicial', formatDate(startDate))
    labelValue('Período final', formatDate(endDate))
    labelValue('Status filtrado', statusFilter ? statusLabel(statusFilter) : 'Todos')
    labelValue(
      'Etapas filtradas',
      stageFilter.length > 0
        ? stages
            .filter((s) => stageFilter.includes(s.id))
            .map((s) => s.name)
            .join(', ')
        : 'Todas'
    )
    labelValue(
      'Unidades filtradas',
      unitFilter.length > 0
        ? units
            .filter((u) => unitFilter.includes(u.id))
            .map((u) => u.identifier)
            .join(', ')
        : 'Todas'
    )

    if (safeStr(textFilter).trim()) {
      labelValue('Busca textual', textFilter)
    }

    setY(getY() + 3)

    sectionTitle('Resumo do relatório')

    resetSummaryCardIndex()
    addSummaryCard('Total filtrado', observationSummary.total)
    addSummaryCard('Pendentes', observationSummary.pending)
    addSummaryCard('Em andamento', observationSummary.in_progress)
    addSummaryCard('Concluídas', observationSummary.done)
    addSummaryCard('Com observação', observationSummary.with_notes)
    addSummaryCard('Etapas selecionadas', stageFilter.length > 0 ? stageFilter.length : stages.length)

    setY(getY() + 4)

    sectionTitle('Itens encontrados')

    if (filteredObservationRows.length === 0) {
      pdf.setFont('helvetica', 'italic')
      pdf.setFontSize(11)
      pdf.text('Nenhum registro encontrado com os filtros selecionados.', margin, getY())
      setY(getY() + 8)
    } else {
      filteredObservationRows.forEach((row) => {
        addPageIfNeeded(28)

        pdf.setFillColor(245, 245, 245)
        pdf.rect(margin, getY(), contentWidth, 9, 'F')
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(12)
        pdf.text(`Unidade ${safeStr(row.unit?.identifier) || '-'}`, margin + 3, getY() + 6.5)
        setY(getY() + 14)

        labelValue('Etapa', row.stage_display_name)
        labelValue('Status', statusLabel(row.status))

        const relatedLogs = logs
          .filter((log) => log.unit_stage_id === row.id)
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

        const latestLog = relatedLogs[0] || null
        labelValue('Última atualização', latestLog?.created_at ? formatDateTime(latestLog.created_at) : '-')

        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(10.5)
        pdf.text('Observação', margin, getY())
        setY(getY() + 8)

        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(10)
        setY(
          getY() +
            drawWrappedText(
              safeStr(row.notes).trim() || 'Sem observação',
              margin,
              getY(),
              contentWidth,
              7
            ) +
            2
        )

        pdf.setDrawColor(215)
        pdf.line(margin, getY(), pageWidth - margin, getY())
        setY(getY() + 9)
      })
    }

    const fileName = `${safeStr(project.name || 'obra').replace(/[^\w\-]+/g, '_').replace(/_+/g, '_')}_observacoes_pendencias_${safeStr(startDate)}_a_${safeStr(endDate)}.pdf`
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
      } else if (mode === REPORT_MODE.period) {
        await generatePeriodPdf()
      } else if (mode === REPORT_MODE.observations) {
        await generateObservationsPdf()
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
         
