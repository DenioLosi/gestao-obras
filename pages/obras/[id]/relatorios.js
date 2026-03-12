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

const PHOTO_BUCKET = 'unit-stage-photos'
const REPORT_LOGO_URL = '/logo-relatorio.png'

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

function reportFileName(projectName, reportName) {
  const safeProject = safeStr(projectName)
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .toLowerCase()

  const safeReport = safeStr(reportName)
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .toLowerCase()

  const date = new Date().toISOString().slice(0, 10)
  return `${safeProject}_${safeReport}_${date}.pdf`
}

function clampPercent(value) {
  const n = Number(value || 0)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
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

function calcFitSize(originalWidth, originalHeight, maxWidth, maxHeight) {
  if (!originalWidth || !originalHeight) {
    return { width: maxWidth, height: maxHeight }
  }

  const widthRatio = maxWidth / originalWidth
  const heightRatio = maxHeight / originalHeight
  const ratio = Math.min(widthRatio, heightRatio)

  return {
    width: originalWidth * ratio,
    height: originalHeight * ratio,
  }
}
async function createPdfEngine(title, subtitle) {
  const pdf = new jsPDF('p', 'mm', 'a4')
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()

  const margin = 12
  const contentWidth = pageWidth - margin * 2
  const bottomLimit = pageHeight - margin
  const valueX = margin + 55
  const valueWidth = pageWidth - margin - valueX

  let y = margin
  let logoDataUrl = null

  if (REPORT_LOGO_URL) {
    logoDataUrl = await loadImageAsDataUrl(REPORT_LOGO_URL)
  }

  function addPageIfNeeded(requiredHeight = 10) {
    if (y + requiredHeight > bottomLimit) {
      pdf.addPage()
      y = margin
    }
  }

  function setBaseFont() {
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(9)
  }

  function setBoldFont(size = 10) {
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(size)
  }

  function drawWrappedText(text, x, topY, maxWidth, lineHeight = 11) {
    const lines = pdf.splitTextToSize(safeStr(text), maxWidth)
    pdf.text(lines, x, topY, { baseline: 'top' })
    return lines.length * lineHeight
  }

  function writeParagraph(text, options = {}) {
    const {
      x = margin,
      width = contentWidth,
      lineHeight = 11,
      fontSize = 9,
      bold = false,
      topGap = 0,
      bottomGap = 2,
    } = options

    addPageIfNeeded(topGap + lineHeight + bottomGap)
    y += topGap

    if (bold) {
      setBoldFont(fontSize)
    } else {
      setBaseFont()
      pdf.setFontSize(fontSize)
    }

    const used = drawWrappedText(text, x, y, width, lineHeight)
    y += used + bottomGap
    return used
  }

  function drawSectionTitle(text) {
    addPageIfNeeded(16)
    setBoldFont(12)
    pdf.text(text, margin, y)
    y += 6
    pdf.setDrawColor(190)
    pdf.line(margin, y, pageWidth - margin, y)
    y += 6
  }

  function drawLabelValue(label, value) {
    addPageIfNeeded(14)
    setBoldFont(10)
    pdf.text(`${label}:`, margin, y)

    setBaseFont()
    const used = drawWrappedText(safeStr(value) || '-', valueX, y - 1, valueWidth, 11)
    y += Math.max(10, used + 4)
  }

  function drawDivider() {
    addPageIfNeeded(8)
    pdf.setDrawColor(215)
    pdf.line(margin, y, pageWidth - margin, y)
    y += 8
  }

  let summaryCardIndex = 0
  const summaryCardHeight = 22
  const summaryCardGapX = 6
  const summaryCardGapY = 6
  const summaryCardWidth = (contentWidth - summaryCardGapX) / 2

  function resetSummaryCards() {
    summaryCardIndex = 0
  }

  function drawSummaryCard(label, value) {
    const col = summaryCardIndex % 2
    const x = margin + col * (summaryCardWidth + summaryCardGapX)
    const cardY = y

    addPageIfNeeded(summaryCardHeight + summaryCardGapY)

    pdf.setDrawColor(220)
    pdf.rect(x, cardY, summaryCardWidth, summaryCardHeight)

    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(8)
    const labelLines = pdf.splitTextToSize(safeStr(label), summaryCardWidth - 6)
    pdf.text(labelLines, x + 3, cardY + 3, { baseline: 'top' })

    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(11)
    pdf.text(safeStr(value), x + 3, cardY + 15)

    summaryCardIndex += 1
    if (summaryCardIndex % 2 === 0) {
      y += summaryCardHeight + summaryCardGapY
    }
  }

  function finishSummaryCards() {
    if (summaryCardIndex % 2 !== 0) {
      y += summaryCardHeight + summaryCardGapY
    }
  }

  function drawBarChart(titleText, percent) {
    addPageIfNeeded(18)
    setBoldFont(9.5)
    pdf.text(titleText, margin, y)
    y += 5

    pdf.setDrawColor(180)
    pdf.rect(margin, y, contentWidth, 4.5)
    pdf.setFillColor(90, 90, 90)
    pdf.rect(margin, y, (contentWidth * clampPercent(percent)) / 100, 4.5, 'F')
    y += 8

    setBaseFont()
    pdf.text(`${clampPercent(percent).toFixed(1)}%`, margin, y)
    y += 5
  }

  async function drawPhotoBlock(photo) {
    addPageIfNeeded(76)

    setBoldFont(9.5)
    pdf.text(getPhotoKindLabel(photo.kind), margin, y)
    y += 5

    let imageDataUrl = null
    if (photo.path) {
      const { data } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(photo.path, 60 * 30)
      if (data?.signedUrl) {
        imageDataUrl = await loadImageAsDataUrl(data.signedUrl)
      }
    }

    if (imageDataUrl) {
      try {
        const img = new Image()
        img.src = imageDataUrl

        await new Promise((resolve) => {
          img.onload = resolve
          img.onerror = resolve
        })

        const fit = calcFitSize(img.naturalWidth || 1, img.naturalHeight || 1, 70, 50)
        pdf.addImage(imageDataUrl, 'JPEG', margin, y, fit.width, fit.height)
        y += fit.height + 4
      } catch {
        writeParagraph('Imagem não pôde ser renderizada.', { fontSize: 9, lineHeight: 10, bottomGap: 2 })
      }
    } else {
      writeParagraph('Imagem não disponível para este registro.', { fontSize: 9, lineHeight: 10, bottomGap: 2 })
    }

    writeParagraph(
      `${formatDate(photo.created_at)} ${formatTime(photo.created_at)}${photo.user_name ? ` - ${photo.user_name}` : ''}${safeStr(photo.caption).trim() ? ` - ${photo.caption}` : ''}`,
      { fontSize: 8.5, lineHeight: 9.5, bottomGap: 3 }
    )
  }

  if (logoDataUrl) {
    try {
      pdf.addImage(logoDataUrl, 'PNG', margin, y, 24, 24)
    } catch {}
  }

  setBoldFont(16)
  pdf.text(title, logoDataUrl ? margin + 30 : margin, y + 8)

  setBaseFont()
  pdf.setFontSize(10)
  pdf.text(subtitle, logoDataUrl ? margin + 30 : margin, y + 15)

  y += 28
  pdf.setDrawColor(180)
  pdf.line(margin, y, pageWidth - margin, y)
  y += 8

  return {
    pdf,
    margin,
    contentWidth,
    getY: () => y,
    setY: (v) => {
      y = v
    },
    addPageIfNeeded,
    writeParagraph,
    drawSectionTitle,
    drawLabelValue,
    drawDivider,
    resetSummaryCards,
    drawSummaryCard,
    finishSummaryCards,
    drawBarChart,
    drawPhotoBlock,
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

    const unitStagesRows = unitStagesRowsRaw.filter((row) => unitIds.has(row.unit_id) && stageIds.has(row.stage_id))
    const unitStageIds = new Set(unitStagesRows.map((row) => row.id))

    const logsRows = logsRowsRaw.filter((row) => row?.unit_stage_id && unitStageIds.has(row.unit_stage_id))
    const photosRows = photosRowsRaw.filter((row) => row?.unit_stage_id && unitStageIds.has(row.unit_stage_id))

    const userIds = Array.from(new Set([...logsRows.map((x) => x.user_id), ...photosRows.map((x) => x.user_id)].filter(Boolean)))
    let nextProfilesMap = {}

    if (userIds.length > 0) {
      const { data: profileRows } = await supabase.from('profiles').select('id, full_name, email').in('id', userIds)
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
        map[unitStageId] = { started_at: null, finished_at: null }
      }

      if (log.action === 'status_changed') {
        const fromStatus = oldStatusFromLog(log)
        const toStatus = newStatusFromLog(log)

        if (!map[unitStageId].started_at) {
          if ((fromStatus === 'pending' && toStatus === 'in_progress') || (fromStatus === 'pending' && toStatus === 'done')) {
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
      block.photos.push({ ...photo, user_name: userName })
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
        if (fromStatus === 'pending' && toStatus === 'in_progress') stageCounters[key].started += 1
        if (toStatus === 'done') stageCounters[key].finished += 1
      }

      if (log.action === 'notes_updated') stageCounters[key].observations += 1
    })

    return {
      moved_units: unitIds.size,
      total_logs: periodLogs.length,
      total_photos: periodPhotos.length,
      stages: Object.values(stageCounters).sort((a, b) => safeStr(a.stage_name).localeCompare(safeStr(b.stage_name), 'pt-BR')),
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
          const joined = [safeStr(row.unit?.identifier), safeStr(row.stage_display_name), safeStr(row.notes), safeStr(row.status)]
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

    const {
      pdf,
      margin,
      contentWidth,
      drawSectionTitle,
      drawLabelValue,
      drawDivider,
      resetSummaryCards,
      drawSummaryCard,
      finishSummaryCards,
      drawBarChart,
      drawPhotoBlock,
      writeParagraph,
      addPageIfNeeded,
      getY,
      setY,
    } = await createPdfEngine('DIÁRIO DE OBRA', 'Relatório automático de acompanhamento da obra')

    drawLabelValue('Obra', project.name || '-')
    drawLabelValue('Cliente', project.client_name || '-')
    drawLabelValue('Cidade', project.city || '-')
    drawLabelValue('Data do diário', formatDate(`${diaryDate}T12:00:00`))
    drawLabelValue('Responsável pela emissão', 'Denio Losi')

    setY(getY() + 3)

    drawSectionTitle('Resumo do dia')
    resetSummaryCards()
    drawSummaryCard('Unidades com atividade', diarySummary.moved_units)
    drawSummaryCard('Etapas iniciadas', diarySummary.started)
    drawSummaryCard('Etapas concluídas', diarySummary.finished)
    drawSummaryCard('Fotos registradas', diarySummary.total_photos)
    drawSummaryCard('Observações registradas', diarySummary.observations)
    drawSummaryCard('Registros do histórico', diarySummary.total_logs)
    finishSummaryCards()
    setY(getY() + 4)

    drawSectionTitle(`Atividades da data ${formatDate(`${diaryDate}T12:00:00`)}`)

    if (diaryBlocks.length === 0) {
      writeParagraph('Nenhuma movimentação encontrada para a data selecionada.', { fontSize: 10, lineHeight: 10.5, bottomGap: 2 })
    } else {
      for (const block of diaryBlocks) {
        addPageIfNeeded(42)

        pdf.setFillColor(245, 245, 245)
        pdf.rect(margin, getY(), contentWidth, 9, 'F')
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(11.5)
        pdf.text(`Unidade ${safeStr(block.unit?.identifier) || '-'}`, margin + 3, getY() + 6)
        setY(getY() + 14)

        drawLabelValue('Etapa', block.stage_name)
        drawLabelValue('Status atual', statusLabel(block.status))
        if (block.started_at) drawLabelValue('Início', formatDateTime(block.started_at))
        if (block.finished_at) drawLabelValue('Conclusão', formatDateTime(block.finished_at))
        if (block.started_at && block.finished_at) drawLabelValue('Duração', durationLabel(block.started_at, block.finished_at))

        if (block.events.length > 0) {
          drawSectionTitle('Atividades registradas no dia')
          block.events.forEach((event) => {
            writeParagraph(
              `• ${formatDate(event.created_at)} ${formatTime(event.created_at)} - ${event.text}${event.user_name ? ` (${event.user_name})` : ''}`,
              { fontSize: 9, lineHeight: 11, bottomGap: 1 }
            )
          })
        }

        if (safeStr(block.notes).trim()) {
          drawSectionTitle('Observação da etapa')
          writeParagraph(block.notes, { fontSize: 9, lineHeight: 11, bottomGap: 2 })
        }

        if (block.photos.length > 0) {
          drawSectionTitle('Fotos registradas na data')
          for (const photo of block.photos) {
            await drawPhotoBlock(photo)
          }
        }

        drawDivider()
      }
    }

    drawSectionTitle('Resumo atualizado da obra')
    drawLabelValue('Total de unidades', projectSummary.total_units)
    drawLabelValue('Unidades pendentes', projectSummary.pending)
    drawLabelValue('Unidades em andamento', projectSummary.in_progress)
    drawLabelValue('Unidades concluídas', projectSummary.done)
    drawLabelValue('Progresso médio', `${projectSummary.avg_progress.toFixed(2)}%`)

    const totalUnits = Math.max(1, projectSummary.total_units)
    drawBarChart('Progresso Geral da Obra', projectSummary.avg_progress)
    drawBarChart('Unidades concluídas', (projectSummary.done / totalUnits) * 100)
    drawBarChart('Unidades em andamento', (projectSummary.in_progress / totalUnits) * 100)
    drawBarChart('Unidades pendentes', (projectSummary.pending / totalUnits) * 100)

    pdf.save(reportFileName(project.name, `diario_de_obra_${safeStr(diaryDate)}`))
  }

  async function generatePeriodPdf() {
    if (!project) return

    const {
      pdf,
      drawSectionTitle,
      drawLabelValue,
      drawDivider,
      resetSummaryCards,
      drawSummaryCard,
      finishSummaryCards,
      writeParagraph,
      addPageIfNeeded,
      margin,
      contentWidth,
      getY,
      setY,
    } = await createPdfEngine('RESUMO POR PERÍODO', 'Relatório cronológico de movimentações da obra')

    drawLabelValue('Obra', project.name || '-')
    drawLabelValue('Cliente', project.client_name || '-')
    drawLabelValue('Cidade', project.city || '-')
    drawLabelValue('Data inicial', formatDate(`${startDate}T12:00:00`))
    drawLabelValue('Data final', formatDate(`${endDate}T12:00:00`))
    drawLabelValue('Responsável pela emissão', 'Denio Losi')

    setY(getY() + 3)

    drawSectionTitle('Resumo do período')
    resetSummaryCards()
    drawSummaryCard('Unidades com movimentação', periodSummary.moved_units)
    drawSummaryCard('Registros no período', periodSummary.total_logs)
    drawSummaryCard('Fotos no período', periodSummary.total_photos)
    drawSummaryCard('Total de unidades', units.length)
    finishSummaryCards()
    setY(getY() + 4)

    drawSectionTitle(`Atividades do período ${formatDate(`${startDate}T12:00:00`)} até ${formatDate(`${endDate}T12:00:00`)}`)

    if (periodBlocks.length === 0) {
      writeParagraph('Nenhuma movimentação encontrada no período selecionado.', { fontSize: 10, lineHeight: 10.5, bottomGap: 2 })
    } else {
      for (const block of periodBlocks) {
        addPageIfNeeded(42)

        pdf.setFillColor(245, 245, 245)
        pdf.rect(margin, getY(), contentWidth, 9, 'F')
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(11.5)
        pdf.text(`Unidade ${safeStr(block.unit?.identifier) || '-'}`, margin + 3, getY() + 6)
        setY(getY() + 14)

        drawLabelValue('Etapa', block.stage_name)
        drawLabelValue('Status atual', statusLabel(block.status))
        if (block.started_at) drawLabelValue('Início', formatDateTime(block.started_at))
        if (block.finished_at) drawLabelValue('Conclusão', formatDateTime(block.finished_at))
        if (block.started_at && block.finished_at) drawLabelValue('Duração', durationLabel(block.started_at, block.finished_at))

        if (block.events.length > 0) {
          drawSectionTitle('Atividades registradas no período')
          block.events.forEach((event) => {
            writeParagraph(
              `• ${formatDate(event.created_at)} ${formatTime(event.created_at)} - ${event.text}${event.user_name ? ` (${event.user_name})` : ''}`,
              { fontSize: 9, lineHeight: 11, bottomGap: 1 }
            )
          })
        }

        if (safeStr(block.notes).trim()) {
          drawSectionTitle('Observação da etapa')
          writeParagraph(block.notes, { fontSize: 9, lineHeight: 11, bottomGap: 2 })
        }

        drawDivider()
      }
    }

    drawSectionTitle('Consolidado por etapa')
    if (periodSummary.stages.length === 0) {
      writeParagraph('Nenhum consolidado disponível para o período.', { fontSize: 10, lineHeight: 10.5, bottomGap: 2 })
    } else {
      periodSummary.stages.forEach((row) => {
        drawLabelValue(
          row.stage_name,
          `Iniciadas: ${row.started} | Concluídas: ${row.finished} | Observações: ${row.observations}`
        )
      })
    }

    pdf.save(reportFileName(project.name, `resumo_por_periodo_${safeStr(startDate)}_a_${safeStr(endDate)}`))
  }

  async function generateObservationsPdf() {
    if (!project) return

    const {
      pdf,
      drawSectionTitle,
      drawLabelValue,
      drawDivider,
      resetSummaryCards,
      drawSummaryCard,
      finishSummaryCards,
      writeParagraph,
      addPageIfNeeded,
      margin,
      contentWidth,
      getY,
      setY,
    } = await createPdfEngine('OBSERVAÇÕES E PENDÊNCIAS', 'Relatório filtrado por status, unidade e etapa')

    drawLabelValue('Obra', project.name || '-')
    drawLabelValue('Cliente', project.client_name || '-')
    drawLabelValue('Cidade', project.city || '-')
    drawLabelValue('Status filtrado', statusFilter ? statusLabel(statusFilter) : 'Todos')
    drawLabelValue(
      'Etapas filtradas',
      stageFilter.length > 0
        ? stages.filter((s) => stageFilter.includes(s.id)).map((s) => s.name).join(', ')
        : 'Todas'
    )
    drawLabelValue('Texto pesquisado', textFilter || '-')
    drawLabelValue('Somente com observação', onlyWithObservation ? 'Sim' : 'Não')

    setY(getY() + 3)

    drawSectionTitle('Resumo do relatório')
    resetSummaryCards()
    drawSummaryCard('Total filtrado', observationSummary.total)
    drawSummaryCard('Pendentes', observationSummary.pending)
    drawSummaryCard('Em andamento', observationSummary.in_progress)
    drawSummaryCard('Concluídas', observationSummary.done)
    drawSummaryCard('Com observação', observationSummary.with_notes)
    finishSummaryCards()
    setY(getY() + 4)

    drawSectionTitle('Itens encontrados')

    if (filteredObservationRows.length === 0) {
      writeParagraph('Nenhum registro encontrado com os filtros selecionados.', { fontSize: 10, lineHeight: 10.5, bottomGap: 2 })
    } else {
      filteredObservationRows.forEach((row) => {
        addPageIfNeeded(34)

        pdf.setFillColor(245, 245, 245)
        pdf.rect(margin, getY(), contentWidth, 9, 'F')
        pdf.setFont('helvetica', 'bold')
        pdf.setFontSize(11.5)
        pdf.text(`Unidade ${safeStr(row.unit?.identifier) || '-'}`, margin + 3, getY() + 6)
        setY(getY() + 14)

        drawLabelValue('Etapa', row.stage_display_name)
        drawLabelValue('Status', statusLabel(row.status))

        const relatedLogs = logs
          .filter((log) => log.unit_stage_id === row.id)
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        const latestLog = relatedLogs[0] || null

        drawLabelValue('Última atualização', latestLog?.created_at ? formatDateTime(latestLog.created_at) : '-')

        drawSectionTitle('Observação')
        writeParagraph(safeStr(row.notes).trim() || 'Sem observação', { fontSize: 9, lineHeight: 11, bottomGap: 2 })

        drawDivider()
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
      } else {
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
    if (currentValues.includes(value)) setter(currentValues.filter((v) => v !== value))
    else setter([...currentValues, value])
  }

  if (loading) {
    return <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>Carregando...</div>
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
          style={{ ...softButtonStyle, background: mode === REPORT_MODE.diary ? '#111' : '#fff', color: mode === REPORT_MODE.diary ? '#fff' : '#111' }}
        >
          Diário de obra
        </button>
        <button
          type="button"
          onClick={() => setMode(REPORT_MODE.period)}
          style={{ ...softButtonStyle, background: mode === REPORT_MODE.period ? '#111' : '#fff', color: mode === REPORT_MODE.period ? '#fff' : '#111' }}
        >
          Resumo por período
        </button>
        <button
          type="button"
          onClick={() => setMode(REPORT_MODE.observations)}
          style={{ ...softButtonStyle, background: mode === REPORT_MODE.observations ? '#111' : '#fff', color: mode === REPORT_MODE.observations ? '#fff' : '#111' }}
        >
          Observações e pendências
        </button>
      </div>

      {mode === REPORT_MODE.diary && (
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
            <div style={cardStyle}><div style={{ fontSize: 12, color: '#666' }}>Unidades com movimentação</div><div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.moved_units}</div></div>
            <div style={cardStyle}><div style={{ fontSize: 12, color: '#666' }}>Registros do dia</div><div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.total_logs}</div></div>
            <div style={cardStyle}><div style={{ fontSize: 12, color: '#666' }}>Fotos do dia</div><div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.total_photos}</div></div>
            <div style={cardStyle}><div style={{ fontSize: 12, color: '#666' }}>Etapas iniciadas</div><div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.started}</div></div>
            <div style={cardStyle}><div style={{ fontSize: 12, color: '#666' }}>Etapas concluídas</div><div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.finished}</div></div>
            <div style={cardStyle}><div style={{ fontSize: 12, color: '#666' }}>Observações registradas</div><div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.observations}</div></div>
          </div>
        </>
      )}

      {mode === REPORT_MODE.period && (
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
        </>
      )}

      {mode === REPORT_MODE.observations && (
        <>
          <div style={{ ...cardStyle, marginBottom: 18 }}>
            <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 12 }}>Filtros de observações e pendências</div>
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
                <input type="text" value={textFilter} onChange={(e) => setTextFilter(e.target.value)} placeholder="Buscar por unidade, etapa, observação..." style={inputStyle} />
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                <input type="checkbox" checked={onlyWithObservation} onChange={(e) => setOnlyWithObservation(e.target.checked)} />
                Mostrar somente etapas com observação
              </label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Filtrar por unidades</div>
                <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10, background: '#fafafa', maxHeight: 220, overflowY: 'auto', display: 'grid', gap: 8 }}>
                  {units.map((unit) => (
                    <label key={unit.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                      <input type="checkbox" checked={unitFilter.includes(unit.id)} onChange={() => toggleMultiValue(setUnitFilter, unitFilter, unit.id)} />
                      Unidade {unit.identifier || '-'}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 12, color: '#666' }}>Filtrar por etapas</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" onClick={() => setStageFilter(stages.map((s) => s.id))} style={{ ...softButtonStyle, padding: '6px 10px', fontSize: 12 }}>
                      Marcar todas
                    </button>
                    <button type="button" onClick={() => setStageFilter([])} style={{ ...softButtonStyle, padding: '6px 10px', fontSize: 12 }}>
                      Limpar
                    </button>
                  </div>
                </div>
                <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10, background: '#fafafa', maxHeight: 220, overflowY: 'auto', display: 'grid', gap: 8 }}>
                  {stages.map((stage) => (
                    <label key={stage.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                      <input type="checkbox" checked={stageFilter.includes(stage.id)} onChange={() => toggleMultiValue(setStageFilter, stageFilter, stage.id)} />
                      {stage.name || '-'}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

  async function exportCurrentReportToPdf() {
    if (!project) return

    setExportingPdf(true)
    try {
      if (mode === REPORT_MODE.diary) {
        await generateDiaryPdf()
      } else if (mode === REPORT_MODE.period) {
        await generatePeriodPdf()
      } else {
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
    if (currentValues.includes(value)) setter(currentValues.filter((v) => v !== value))
    else setter([...currentValues, value])
  }

  if (loading) {
    return <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>Carregando...</div>
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
          style={{ ...softButtonStyle, background: mode === REPORT_MODE.diary ? '#111' : '#fff', color: mode === REPORT_MODE.diary ? '#fff' : '#111' }}
        >
          Diário de obra
        </button>
        <button
          type="button"
          onClick={() => setMode(REPORT_MODE.period)}
          style={{ ...softButtonStyle, background: mode === REPORT_MODE.period ? '#111' : '#fff', color: mode === REPORT_MODE.period ? '#fff' : '#111' }}
        >
          Resumo por período
        </button>
        <button
          type="button"
          onClick={() => setMode(REPORT_MODE.observations)}
          style={{ ...softButtonStyle, background: mode === REPORT_MODE.observations ? '#111' : '#fff', color: mode === REPORT_MODE.observations ? '#fff' : '#111' }}
        >
          Observações e pendências
        </button>
      </div>

      {mode === REPORT_MODE.diary && (
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
            <div style={cardStyle}><div style={{ fontSize: 12, color: '#666' }}>Unidades com movimentação</div><div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.moved_units}</div></div>
            <div style={cardStyle}><div style={{ fontSize: 12, color: '#666' }}>Registros do dia</div><div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.total_logs}</div></div>
            <div style={cardStyle}><div style={{ fontSize: 12, color: '#666' }}>Fotos do dia</div><div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.total_photos}</div></div>
            <div style={cardStyle}><div style={{ fontSize: 12, color: '#666' }}>Etapas iniciadas</div><div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.started}</div></div>
            <div style={cardStyle}><div style={{ fontSize: 12, color: '#666' }}>Etapas concluídas</div><div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.finished}</div></div>
            <div style={cardStyle}><div style={{ fontSize: 12, color: '#666' }}>Observações registradas</div><div style={{ fontSize: 28, fontWeight: 900, marginTop: 8 }}>{diarySummary.observations}</div></div>
          </div>
        </>
      )}

      {mode === REPORT_MODE.period && (
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
        </>
      )}

      {mode === REPORT_MODE.observations && (
        <>
          <div style={{ ...cardStyle, marginBottom: 18 }}>
            <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 12 }}>Filtros de observações e pendências</div>
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
                <input type="text" value={textFilter} onChange={(e) => setTextFilter(e.target.value)} placeholder="Buscar por unidade, etapa, observação..." style={inputStyle} />
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                <input type="checkbox" checked={onlyWithObservation} onChange={(e) => setOnlyWithObservation(e.target.checked)} />
                Mostrar somente etapas com observação
              </label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>Filtrar por unidades</div>
                <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10, background: '#fafafa', maxHeight: 220, overflowY: 'auto', display: 'grid', gap: 8 }}>
                  {units.map((unit) => (
                    <label key={unit.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                      <input type="checkbox" checked={unitFilter.includes(unit.id)} onChange={() => toggleMultiValue(setUnitFilter, unitFilter, unit.id)} />
                      Unidade {unit.identifier || '-'}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 12, color: '#666' }}>Filtrar por etapas</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" onClick={() => setStageFilter(stages.map((s) => s.id))} style={{ ...softButtonStyle, padding: '6px 10px', fontSize: 12 }}>
                      Marcar todas
                    </button>
                    <button type="button" onClick={() => setStageFilter([])} style={{ ...softButtonStyle, padding: '6px 10px', fontSize: 12 }}>
                      Limpar
                    </button>
                  </div>
                </div>
                <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 10, background: '#fafafa', maxHeight: 220, overflowY: 'auto', display: 'grid', gap: 8 }}>
                  {stages.map((stage) => (
                    <label key={stage.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                      <input type="checkbox" checked={stageFilter.includes(stage.id)} onChange={() => toggleMultiValue(setStageFilter, stageFilter, stage.id)} />
                      {stage.name || '-'}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
