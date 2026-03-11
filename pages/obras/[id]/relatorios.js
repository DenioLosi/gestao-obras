import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { supabase } from '../../../lib/supabase'
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
  return d.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  })
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

function inRange(dateValue, from, to) {
  if (!dateValue || !from || !to) return false
  const d = new Date(dateValue).getTime()
  const a = new Date(from).getTime()
  const b = new Date(to).getTime()
  if ([d, a, b].some(Number.isNaN)) return false
  return d >= a && d <= b
}

function oldStatusFromLog(log) {
  const oldValue = parseMaybeJson(log?.old_value)
  return normalizeStatus(oldValue?.status)
}

function newStatusFromLog(log) {
  const newValue = parseMaybeJson(log?.new_value)
  return normalizeStatus(newValue?.status)
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

  if (action === 'notes_updated') {
    const newValue = parseMaybeJson(log?.new_value)
    const noteText = safeStr(newValue?.notes).trim()
    return noteText ? `Observação atualizada: ${noteText}` : 'Observação removida'
  }

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

function buildMap(rows) {
  const out = {}
  ;(rows || []).forEach((row) => {
    out[row.id] = row
  })
  return out
}

function collectUserName(profilesMap, userId) {
  return (
    safeStr(profilesMap?.[userId]?.full_name).trim() ||
    safeStr(profilesMap?.[userId]?.email).trim() ||
    ''
  )
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

function reportFileName(projectName, reportName) {
  const safeProject = safeStr(projectName)
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .toLowerCase()

  const safeReport = safeStr(reportName)
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .toLowerCase()

  const date = new Date().toISOString().slice(0,10)

  return `${safeProject}_${safeReport}_${date}.pdf`
}

function buildPdf(title, subtitle) {
  const pdf = new jsPDF('p', 'mm', 'a4')
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 12
  const contentWidth = pageWidth - margin * 2
  let y = margin

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
    addPageIfNeeded(12)
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(10.5)
    pdf.text(`${label}:`, margin, y)

    pdf.setFont('helvetica', 'normal')
    const used = drawWrappedText(safeStr(value) || '-', margin + 34, y - 1, contentWidth - 34, 7)
    y += Math.max(8, used + 2)
  }

  let summaryCardIndex = 0

  function resetSummaryCards() {
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

    const labelHeight = labelLines.length * 5.2

    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(13)
    pdf.text(safeStr(value), x + 3, cardY + 10 + labelHeight)

    summaryCardIndex += 1
    if (summaryCardIndex % 2 === 0) {
      y += cardHeight + 8
    }
  }

  function addDivider() {
    addPageIfNeeded(8)
    pdf.setDrawColor(215)
    pdf.line(margin, y, pageWidth - margin, y)
    y += 9
  }

  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(17)
  pdf.text(title, margin, y + 8)

  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(10.5)
  pdf.text(subtitle, margin, y + 15)

  y += 30
  pdf.setDrawColor(180)
  pdf.line(margin, y, pageWidth - margin, y)
  y += 9

  return {
    pdf,
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
    resetSummaryCards,
    addSummaryCard,
    addDivider,
  }
}

export default function ObraRelatoriosPage() {
  const router = useRouter()
  const { id } = router.query

  const projectId = useMemo(() => {
    if (!id) return null
    if (Array.isArray(id)) return id[0] || null
    return String(id)
  }, [id])

  const today = useMemo(() => toInputDate(new Date()), [])

  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [exportingPdf, setExportingPdf] = useState(false)

  const [project, setProject] = useState(null)
  const [units, setUnits] = useState([])
  const [stages, setStages] = useState([])
  const [unitStages, setUnitStages] = useState([])
  const [logs, setLogs] = useState([])
  const [photos, setPhotos] = useState([])
  const [profilesMap, setProfilesMap] = useState({})

  const [mode, setMode] = useState(REPORT_MODE.diary)

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
      setLogs([])
      setPhotos([])
      setProfilesMap({})
      setLoading(false)
      return
    }

    setProject(projectRow)

    const [unitsRes, stagesRes, unitStagesRes, logsRes, photosRes] = await Promise.all([
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
        .from('unit_stage_logs')
        .select('id, unit_stage_id, user_id, action, old_value, new_value, created_at')
        .order('created_at', { ascending: false }),

      supabase
        .from('unit_stage_photos')
        .select('id, unit_stage_id, user_id, kind, path, caption, created_at')
        .order('created_at', { ascending: false }),
    ])

    if (unitsRes.error || stagesRes.error || unitStagesRes.error || logsRes.error || photosRes.error) {
      alert(
        unitsRes.error?.message ||
          stagesRes.error?.message ||
          unitStagesRes.error?.message ||
          logsRes.error?.message ||
          photosRes.error?.message ||
          'Erro ao carregar dados'
      )
      setLoading(false)
      return
    }

    const unitsRows = Array.isArray(unitsRes.data) ? unitsRes.data : []
    const stagesRows = Array.isArray(stagesRes.data) ? stagesRes.data : []
    const unitStagesRowsRaw = Array.isArray(unitStagesRes.data) ? unitStagesRes.data : []
    const logsRowsRaw = Array.isArray(logsRes.data) ? logsRes.data : []
    const photosRowsRaw = Array.isArray(photosRes.data) ? photosRes.data : []

    const unitIds = new Set(unitsRows.map((u) => u.id))
    const stageIds = new Set(stagesRows.map((s) => s.id))

    const unitStagesRows = unitStagesRowsRaw.filter(
      (row) => unitIds.has(row.unit_id) && stageIds.has(row.stage_id)
    )
    const unitStageIds = new Set(unitStagesRows.map((row) => row.id))

    const logsRows = logsRowsRaw.filter((row) => row?.unit_stage_id && unitStageIds.has(row.unit_stage_id))
    const photosRows = photosRowsRaw.filter((row) => row?.unit_stage_id && unitStageIds.has(row.unit_stage_id))

    const userIds = Array.from(
      new Set([...logsRows.map((x) => x.user_id), ...photosRows.map((x) => x.user_id)].filter(Boolean))
    )

    let nextProfilesMap = {}
    if (userIds.length > 0) {
      const { data: profileRows } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', userIds)

      nextProfilesMap = buildMap(profileRows || [])
    }

    setUnits(unitsRows)
    setStages(stagesRows)
    setUnitStages(unitStagesRows)
    setLogs(logsRows)
    setPhotos(photosRows)
    setProfilesMap(nextProfilesMap)
    setLoading(false)
  }

  useEffect(() => {
    loadBaseData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const unitsById = useMemo(() => buildMap(units), [units])
  const stagesById = useMemo(() => buildMap(stages), [stages])
  const unitStagesById = useMemo(() => buildMap(unitStages), [unitStages])

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

        if (!map[unitStageId].finished_at && toStatus === 'done') {
          map[unitStageId].finished_at = log.created_at
        }
      }
    })

    return map
  }, [logs])

  function buildBlocks(logRows, photoRows) {
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
          stage_name: safeStr(us.custom_name).trim() || safeStr(stage?.name).trim() || 'Etapa',
          status: us.status,
          notes: safeStr(us.notes).trim(),
          started_at: timeline.started_at || null,
          finished_at: timeline.finished_at || null,
          events: [],
          photos: [],
        }
      }

      return blockMap[unitStageId]
    }

    logRows.forEach((log) => {
      const block = ensureBlock(log.unit_stage_id)
      if (!block) return

      const human = actionToHuman(log)
      if (!human) return

      block.events.push({
        created_at: log.created_at,
        text: human,
        user_name: collectUserName(profilesMap, log.user_id),
      })
    })

    photoRows.forEach((photo) => {
      const block = ensureBlock(photo.unit_stage_id)
      if (!block) return

      const userName = collectUserName(profilesMap, photo.user_id)

      block.photos.push({
        ...photo,
        user_name: userName,
      })

      block.events.push({
        created_at: photo.created_at,
        text: getPhotoKindLabel(photo.kind),
        user_name: userName,
      })
    })

    return Object.values(blockMap).map((block) => ({
      ...block,
      events: [...block.events].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
      photos: [...block.photos].sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    }))
  }

  const diaryLogs = useMemo(() => {
    const from = startOfDayIso(diaryDate)
    const to = endOfDayIso(diaryDate)
    return logs.filter((row) => inRange(row.created_at, from, to))
  }, [logs, diaryDate])

  const diaryPhotos = useMemo(() => {
    const from = startOfDayIso(diaryDate)
    const to = endOfDayIso(diaryDate)
    return photos.filter((row) => inRange(row.created_at, from, to))
  }, [photos, diaryDate])

  const diaryBlocks = useMemo(() => {
    return buildBlocks(diaryLogs, diaryPhotos).sort((a, b) => {
      const unitCmp = safeStr(a.unit?.identifier).localeCompare(safeStr(b.unit?.identifier), 'pt-BR')
      if (unitCmp !== 0) return unitCmp
      return safeStr(a.stage_name).localeCompare(safeStr(b.stage_name), 'pt-BR')
    })
  }, [diaryLogs, diaryPhotos, unitStagesById, unitsById, stagesById, stageTimelineByUnitStageId, profilesMap])

  const periodLogs = useMemo(() => {
    const from = startOfDayIso(startDate)
    const to = endOfDayIso(endDate)
    return logs.filter((row) => inRange(row.created_at, from, to))
  }, [logs, startDate, endDate])

  const periodPhotos = useMemo(() => {
    const from = startOfDayIso(startDate)
    const to = endOfDayIso(endDate)
    return photos.filter((row) => inRange(row.created_at, from, to))
  }, [photos, startDate, endDate])

  const periodBlocks = useMemo(() => {
    return buildBlocks(periodLogs, periodPhotos).sort((a, b) => {
      const firstA = a.events[0]?.created_at || ''
      const firstB = b.events[0]?.created_at || ''
      return new Date(firstA) - new Date(firstB)
    })
  }, [periodLogs, periodPhotos, unitStagesById, unitsById, stagesById, stageTimelineByUnitStageId, profilesMap])

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

        if (fromStatus === 'pending' && toStatus === 'in_progress') {
          stageCounters[key].started += 1
        }

        if (toStatus === 'done') {
          stageCounters[key].finished += 1
        }
      }

      if (log.action === 'notes_updated') {
        stageCounters[key].observations += 1
      }
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

  const filteredObservationRows = useMemo(() => {
    const unitFilterSet = new Set(unitFilter)
    const stageFilterSet = new Set(stageFilter)
    const text = safeStr(textFilter).trim().toLowerCase()

    return enrichedUnitStages
      .filter((row) => {
        if (statusFilter && normalizeStatus(row.status) !== normalizeStatus(statusFilter)) return false
        if (unitFilterSet.size > 0 && !unitFilterSet.has(row.unit_id)) return false
        if (stageFilterSet.size > 0 && !stageFilterSet.has(row.stage_id)) return false
        if (onlyWithObservation && !safeStr(row.notes).trim()) return false

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
  }, [enrichedUnitStages, statusFilter, unitFilter, stageFilter, textFilter, onlyWithObservation])

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

  async function generateDiaryPdf() {
    if (!project) return

    const ctx = buildPdf('DIÁRIO DE OBRA', 'Relatório automático de acompanhamento da obra')
    const {
      pdf,
      sectionTitle,
      labelValue,
      resetSummaryCards,
      addSummaryCard,
      addDivider,
      drawWrappedText,
      getY,
      setY,
      addPageIfNeeded,
      margin,
      contentWidth,
    } = ctx

    labelValue('Obra', project.name || '-')
    labelValue('Cliente', project.client_name || '-')
    labelValue('Cidade', project.city || '-')
    labelValue('Data do diário', formatDate(diaryDate))
    labelValue('Responsável pela emissão', 'Denio Losi')

    setY(getY() + 3)

    sectionTitle('Resumo do dia')
    resetSummaryCards()
    addSummaryCard('Unidades com atividade', diarySummary.moved_units)
    addSummaryCard('Etapas iniciadas', diarySummary.started)
    addSummaryCard('Etapas concluídas', diarySummary.finished)
    addSummaryCard('Fotos registradas', diarySummary.total_photos)
    setY(getY() + 38)
    addSummaryCard('Observações registradas', diarySummary.observations)
    addSummaryCard('Registros do histórico', diarySummary.total_logs)
    setY(getY() + 38)

    sectionTitle(`Atividades da data ${formatDate(diaryDate)}`)

    if (diaryBlocks.length === 0) {
      pdf.setFont('helvetica', 'italic')
      pdf.setFontSize(11)
      pdf.text('Nenhuma movimentação encontrada para a data selecionada.', margin, getY())
      setY(getY() + 8)
    } else {
      for (const block of diaryBlocks) {
        addPageIfNeeded(34)

        pdf.setFillColor(245, 245, 245)
        pdf.rect(margin, getY(), contentWidth, 9, 'F')
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(12)
        pdf.text(`Unidade ${safeStr(block.unit?.identifier) || '-'}`, margin + 3, getY() + 6)
        setY(getY() + 14)

        labelValue('Etapa', block.stage_name)
        labelValue('Status atual', statusLabel(block.status))
        if (block.started_at) labelValue('Início', formatDateTime(block.started_at))
        if (block.finished_at) labelValue('Conclusão', formatDateTime(block.finished_at))
        if (block.started_at && block.finished_at) {
          labelValue('Duração', durationLabel(block.started_at, block.finished_at))
        }

        if (block.events.length > 0) {
          addPageIfNeeded(14)
          pdf.setFont('helvetica', 'bold')
          pdf.setFontSize(10.5)
          pdf.text('Atividades registradas no dia', margin, getY())
          setY(getY() + 8)

          pdf.setFont('helvetica', 'normal')
          pdf.setFontSize(10)

          block.events.forEach((event) => {
            addPageIfNeeded(10)
            const txt = `${formatDate(event.created_at)} ${formatTime(event.created_at)} - ${event.text}${event.user_name ? ` (${event.user_name})` : ''}`
            setY(getY() + drawWrappedText(`• ${txt}`, margin + 2, getY(), contentWidth - 2, 7) + 1)
          })

          setY(getY() + 2)
        }

        if (safeStr(block.notes).trim()) {
          addPageIfNeeded(14)
          pdf.setFont('helvetica', 'bold')
          pdf.setFontSize(10.5)
          pdf.text('Observação da etapa', margin, getY())
          setY(getY() + 8)

          pdf.setFont('helvetica', 'normal')
          pdf.setFontSize(10)
          setY(getY() + drawWrappedText(block.notes, margin, getY(), contentWidth, 7) + 2)
        }

        if (block.photos.length > 0) {
          addPageIfNeeded(14)
          pdf.setFont('helvetica', 'bold')
          pdf.setFontSize(10.5)
          pdf.text('Fotos registradas na data', margin, getY())
          setY(getY() + 8)

          pdf.setFont('helvetica', 'normal')
          pdf.setFontSize(10)

          block.photos.forEach((photo) => {
            const txt = `${formatDate(photo.created_at)} ${formatTime(photo.created_at)} - ${safeStr(photo.caption).trim() || 'Foto sem legenda'}${photo.user_name ? ` (${photo.user_name})` : ''}`
            setY(getY() + drawWrappedText(`• ${txt}`, margin + 2, getY(), contentWidth - 2, 7) + 1)
          })
        }

        setY(getY() + 3)
        addDivider()
      }
    }

    sectionTitle('Resumo atualizado da obra')

    labelValue('Total de unidades', projectSummary.total_units)
    labelValue('Unidades pendentes', projectSummary.pending)
    labelValue('Unidades em andamento', projectSummary.in_progress)
    labelValue('Unidades concluídas', projectSummary.done)
    labelValue('Progresso médio', `${projectSummary.avg_progress.toFixed(2)}%`)

    pdf.save(reportFileName(project.name, `diario_de_obra_${safeStr(diaryDate)}`))
  }

  async function generatePeriodPdf() {
    if (!project) return

    const ctx = buildPdf('RESUMO POR PERÍODO', 'Relatório cronológico de movimentações da obra')
    const {
      pdf,
      sectionTitle,
      labelValue,
      resetSummaryCards,
      addSummaryCard,
      addDivider,
      drawWrappedText,
      getY,
      setY,
      addPageIfNeeded,
      margin,
      contentWidth,
    } = ctx

    labelValue('Obra', project.name || '-')
    labelValue('Cliente', project.client_name || '-')
    labelValue('Cidade', project.city || '-')
    labelValue('Data inicial', formatDate(startDate))
    labelValue('Data final', formatDate(endDate))
    labelValue('Responsável pela emissão', 'Denio Losi')

    setY(getY() + 3)

    sectionTitle('Resumo do período')
    resetSummaryCards()
    addSummaryCard('Unidades com movimentação', periodSummary.moved_units)
    addSummaryCard('Registros no período', periodSummary.total_logs)
    addSummaryCard('Fotos no período', periodSummary.total_photos)
    addSummaryCard('Total de unidades', units.length)
    setY(getY() + 38)

    sectionTitle(`Atividades do período ${formatDate(startDate)} até ${formatDate(endDate)}`)

    if (periodBlocks.length === 0) {
      pdf.setFont('helvetica', 'italic')
      pdf.setFontSize(11)
      pdf.text('Nenhuma movimentação encontrada no período selecionado.', margin, getY())
      setY(getY() + 8)
    } else {
      for (const block of periodBlocks) {
        addPageIfNeeded(34)

        pdf.setFillColor(245, 245, 245)
        pdf.rect(margin, getY(), contentWidth, 9, 'F')
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(12)
        pdf.text(`Unidade ${safeStr(block.unit?.identifier) || '-'}`, margin + 3, getY() + 6)
        setY(getY() + 14)

        labelValue('Etapa', block.stage_name)
        labelValue('Status atual', statusLabel(block.status))
        if (block.started_at) labelValue('Início', formatDateTime(block.started_at))
        if (block.finished_at) labelValue('Conclusão', formatDateTime(block.finished_at))
        if (block.started_at && block.finished_at) {
          labelValue('Duração', durationLabel(block.started_at, block.finished_at))
        }

        if (block.events.length > 0) {
          addPageIfNeeded(14)
          pdf.setFont('helvetica', 'bold')
          pdf.setFontSize(10.5)
          pdf.text('Atividades registradas no período', margin, getY())
          setY(getY() + 8)

          pdf.setFont('helvetica', 'normal')
          pdf.setFontSize(10)

          block.events.forEach((event) => {
            addPageIfNeeded(10)
            const txt = `${formatDate(event.created_at)} ${formatTime(event.created_at)} - ${event.text}${event.user_name ? ` (${event.user_name})` : ''}`
            setY(getY() + drawWrappedText(`• ${txt}`, margin + 2, getY(), contentWidth - 2, 7) + 1)
          })

          setY(getY() + 2)
        }

        if (safeStr(block.notes).trim()) {
          addPageIfNeeded(14)
          pdf.setFont('helvetica', 'bold')
          pdf.setFontSize(10.5)
          pdf.text('Observação da etapa', margin, getY())
          setY(getY() + 8)

          pdf.setFont('helvetica', 'normal')
          pdf.setFontSize(10)
          setY(getY() + drawWrappedText(block.notes, margin, getY(), contentWidth, 7) + 2)
        }

        if (block.photos.length > 0) {
          addPageIfNeeded(14)
          pdf.setFont('helvetica', 'bold')
          pdf.setFontSize(10.5)
          pdf.text('Fotos registradas no período', margin, getY())
          setY(getY() + 8)

          pdf.setFont('helvetica', 'normal')
          pdf.setFontSize(10)

          block.photos.forEach((photo) => {
            const txt = `${formatDate(photo.created_at)} ${formatTime(photo.created_at)} - ${safeStr(photo.caption).trim() || 'Foto sem legenda'}${photo.user_name ? ` (${photo.user_name})` : ''}`
            setY(getY() + drawWrappedText(`• ${txt}`, margin + 2, getY(), contentWidth - 2, 7) + 1)
          })
        }

        setY(getY() + 3)
        addDivider()
      }
    }

    sectionTitle('Consolidado por etapa')

    if (periodSummary.stages.length === 0) {
      pdf.setFont('helvetica', 'italic')
      pdf.setFontSize(11)
      pdf.text('Nenhum consolidado disponível para o período.', margin, getY())
      setY(getY() + 8)
    } else {
      periodSummary.stages.forEach((row) => {
        labelValue(
          row.stage_name,
          `Iniciadas: ${row.started} | Concluídas: ${row.finished} | Observações: ${row.observations}`
        )
      })
    }

    pdf.save(reportFileName(project.name, `resumo_por_periodo_${safeStr(startDate)}_a_${safeStr(endDate)}`))
  }

  async function generateObservationsPdf() {
    if (!project) return

    const ctx = buildPdf('OBSERVAÇÕES E PENDÊNCIAS', 'Relatório filtrado por status, unidade e etapa')
    const {
      pdf,
      sectionTitle,
      labelValue,
      resetSummaryCards,
      addSummaryCard,
      addDivider,
      drawWrappedText,
      getY,
      setY,
      addPageIfNeeded,
      margin,
      contentWidth,
    } = ctx

    labelValue('Obra', project.name || '-')
    labelValue('Cliente', project.client_name || '-')
    labelValue('Cidade', project.city || '-')
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
    labelValue('Texto pesquisado', textFilter || '-')
    labelValue('Somente com observação', onlyWithObservation ? 'Sim' : 'Não')

    setY(getY() + 3)

    sectionTitle('Resumo do relatório')
    resetSummaryCards()
    addSummaryCard('Total filtrado', observationSummary.total)
    addSummaryCard('Pendentes', observationSummary.pending)
    addSummaryCard('Em andamento', observationSummary.in_progress)
    addSummaryCard('Concluídas', observationSummary.done)
    setY(getY() + 38)
    addSummaryCard('Com observação', observationSummary.with_notes)
    setY(getY() + 38)

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
        pdf.text(`Unidade ${safeStr(row.unit?.identifier) || '-'}`, margin + 3, getY() + 6)
        setY(getY() + 14)

        labelValue('Etapa', row.stage_display_name)
        labelValue('Status', statusLabel(row.status))

        const relatedLogs = logs
          .filter((log) => log.unit_stage_id === row.id)
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        const latestLog = relatedLogs[0] || null

        labelValue('Última atualização', latestLog?.created_at ? formatDateTime(latestLog.created_at) : '-')

        addPageIfNeeded(16)
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(10.5)
        pdf.text('Observação', margin, getY())
        setY(getY() + 8)

        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(10)
        setY(getY() + drawWrappedText(safeStr(row.notes).trim() || 'Sem observação', margin, getY(), contentWidth, 7) + 2)

        setY(getY() + 3)
        addDivider()
      })
    }

    pdf.save(reportFileName(project.name, 'observacoes_e_pendencias'))
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
      }
    } catch (error) {
      console.error(error)
      alert(`Erro ao gerar PDF: ${error?.message || error}`)
    } finally {
      setExportingPdf(false)
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

  function toggleMultiValue(setter, currentValues, value) {
    if (!value) return
    if (currentValues.includes(value)) {
      setter(currentValues.filter((v) => v !== value))
    } else {
      setter([...currentValues, value])
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

          <button type="button" onClick={exportCurrentReportToPdf} disabled={exportingPdf} style={buttonStyle}>
            {exportingPdf ? 'Gerando PDF...' : 'Gerar PDF'}
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
                <input type="date" value={diaryDate} onChange={(e) => setDiaryDate(e.target.value)} style={inputStyle} />
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
                              • {formatDate(event.created_at)} {formatTime(event.created_at)} — {event.text}
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
                        <div style={{ fontSize: 13, color: '#444' }}>{block.notes}</div>
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
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
              </div>

              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>Data final</div>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
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

          <div style={cardStyle}>
            <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 6 }}>
              Resumo do período — {formatDate(startDate)} até {formatDate(endDate)}
            </div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
              Relatório cronológico das atividades registradas no período.
            </div>

            {periodBlocks.length === 0 ? (
              <div style={{ color: '#666' }}>Nenhuma movimentação encontrada no período selecionado.</div>
            ) : (
              <div style={{ display: 'grid', gap: 14 }}>
                {periodBlocks.map((block) => (
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

                    {block.events.length > 0 ? (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 6 }}>
                          Atividades do período
                        </div>
                        <div style={{ display: 'grid', gap: 6 }}>
                          {block.events.map((event, index) => (
                            <div key={`${block.unit_stage_id}_${index}`} style={{ fontSize: 13, color: '#444' }}>
                              • {formatDate(event.created_at)} {formatTime(event.created_at)} — {event.text}
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
                        <div style={{ fontSize: 13, color: '#444' }}>{block.notes}</div>
                      </div>
                    ) : null}
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
                  {units.map((unit) => (
                    <label key={unit.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                      <input
                        type="checkbox"
                        checked={unitFilter.includes(unit.id)}
                        onChange={() => toggleMultiValue(setUnitFilter, unitFilter, unit.id)}
                      />
                      Unidade {unit.identifier || '-'}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 12, color: '#666' }}>Filtrar por etapas</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => setStageFilter(stages.map((s) => s.id))}
                      style={{ ...softButtonStyle, padding: '6px 10px', fontSize: 12 }}
                    >
                      Marcar todas
                    </button>
                    <button
                      type="button"
                      onClick={() => setStageFilter([])}
                      style={{ ...softButtonStyle, padding: '6px 10px', fontSize: 12 }}
                    >
                      Limpar
                    </button>
                  </div>
                </div>

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
                  {stages.map((stage) => (
                    <label key={stage.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                      <input
                        type="checkbox"
                        checked={stageFilter.includes(stage.id)}
                        onChange={() => toggleMultiValue(setStageFilter, stageFilter, stage.id)}
                      />
                      {stage.name || '-'}
                    </label>
                  ))}
                </div>
              </div>
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
            <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 6 }}>Observações e pendências</div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
              Relatório filtrável por status, unidade, etapa e texto.
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
                      <th style={{ padding: '10px 8px' }}>Abrir</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredObservationRows.map((row) => (
                      <tr key={row.id} style={{ borderBottom: '1px solid #f1f1f1', verticalAlign: 'top' }}>
                        <td style={{ padding: '10px 8px', fontWeight: 700 }}>{row.unit?.identifier || '-'}</td>
                        <td style={{ padding: '10px 8px' }}>{row.stage_display_name}</td>
                        <td style={{ padding: '10px 8px' }}>{statusLabel(row.status)}</td>
                        <td style={{ padding: '10px 8px', maxWidth: 420 }}>
                          {safeStr(row.notes).trim() || <span style={{ color: '#999' }}>Sem observação</span>}
                        </td>
                        <td style={{ padding: '10px 8px' }}>
                          <Link href={`/unidades/${row.unit_id}`} style={{ textDecoration: 'none' }}>
                            Abrir unidade
                          </Link>
                        </td>
                      </tr>
                    ))}
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
