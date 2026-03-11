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

export default function ObraRelatoriosPage() {

  const router = useRouter()
  const { id } = router.query

  const [project, setProject] = useState(null)
  const [units, setUnits] = useState([])
  const [stages, setStages] = useState([])
  const [unitStages, setUnitStages] = useState([])
  const [photos, setPhotos] = useState([])
  const [logs, setLogs] = useState([])

  const [mode, setMode] = useState(REPORT_MODE.diary)

  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const [statusFilter, setStatusFilter] = useState('')
  const [stageFilter, setStageFilter] = useState([])

  async function loadData() {

    const { data: projectRow } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .single()

    setProject(projectRow)

    const { data: unitsRows } = await supabase
      .from('units')
      .select('*')
      .eq('project_id', id)

    setUnits(unitsRows || [])

    const { data: stagesRows } = await supabase
      .from('stages')
      .select('*')
      .eq('project_id', id)

    setStages(stagesRows || [])

    const { data: unitStagesRows } = await supabase
      .from('unit_stages')
      .select('*')

    setUnitStages(unitStagesRows || [])

    const { data: photosRows } = await supabase
      .from('unit_stage_photos')
      .select('*')

    setPhotos(photosRows || [])

    const { data: logsRows } = await supabase
      .from('unit_stage_logs')
      .select('*')

    setLogs(logsRows || [])
  }

  useEffect(() => {
    if (id) loadData()
  }, [id])
    async function generateDiaryPdf() {

    const pdf = new jsPDF('p','mm','a4')

    let y = 20

    pdf.setFontSize(18)
    pdf.text("DIÁRIO DE OBRA", 20, y)

    y += 10

    pdf.setFontSize(11)
    pdf.text(`Obra: ${project?.name}`,20,y)

    y+=8

    pdf.text(`Data emissão: ${new Date().toLocaleDateString('pt-BR')}`,20,y)

    y+=15

    logs
      .sort((a,b)=> new Date(a.created_at)-new Date(b.created_at))
      .forEach(log=>{

        const action = actionToHuman(log)

        if(!action) return

        pdf.setFontSize(11)

        pdf.text(`${formatDate(log.created_at)} ${formatTime(log.created_at)} - ${action}`,20,y)

        y+=7

        if(y>270){
          pdf.addPage()
          y=20
        }

      })

    pdf.save("diario_de_obra.pdf")
  }

  async function generatePeriodPdf() {

    const pdf = new jsPDF()

    let y = 20

    pdf.setFontSize(18)
    pdf.text("RELATÓRIO DE ATIVIDADES POR PERÍODO",20,y)

    y+=15

    const filtered = logs.filter(log=>{

      const d = new Date(log.created_at)

      return d>= new Date(startDate) && d<= new Date(endDate)

    })

    filtered
      .sort((a,b)=> new Date(a.created_at)-new Date(b.created_at))
      .forEach(log=>{

        const action = actionToHuman(log)

        if(!action) return

        pdf.setFontSize(11)

        pdf.text(`${formatDate(log.created_at)} ${formatTime(log.created_at)} - ${action}`,20,y)

        y+=7

        if(y>270){
          pdf.addPage()
          y=20
        }

      })

    pdf.save("relatorio_periodo.pdf")

  }

  const filteredObservations = unitStages.filter(us=>{

    if(statusFilter && us.status!==statusFilter) return false

    if(stageFilter.length>0 && !stageFilter.includes(us.stage_id)) return false

    if(!us.notes) return false

    return true

  })

  async function generateObservationsPdf(){

    const pdf = new jsPDF()

    let y=20

    pdf.setFontSize(18)
    pdf.text("OBSERVAÇÕES E PENDÊNCIAS",20,y)

    y+=15

    filteredObservations.forEach(row=>{

      const unit = units.find(u=>u.id===row.unit_id)

      const stage = stages.find(s=>s.id===row.stage_id)

      pdf.setFontSize(11)

      pdf.text(`Unidade ${unit?.identifier} - ${stage?.name}`,20,y)

      y+=6

      pdf.text(row.notes,25,y)

      y+=10

      if(y>270){

        pdf.addPage()
        y=20

      }

    })

    pdf.save("observacoes_pendencias.pdf")

  }

  if(!project){

    return <div style={{padding:40}}>Carregando...</div>

  }

  return (

    <div style={{padding:40,fontFamily:'system-ui'}}>

      <h1>Relatórios da obra</h1>

      <div style={{marginTop:20,display:'flex',gap:10}}>

        <button onClick={()=>setMode(REPORT_MODE.diary)}>Diário de obra</button>

        <button onClick={()=>setMode(REPORT_MODE.period)}>Resumo por período</button>

        <button onClick={()=>setMode(REPORT_MODE.observations)}>Observações e pendências</button>

      </div>

      {mode===REPORT_MODE.diary && (

        <div style={{marginTop:30}}>

          <button onClick={generateDiaryPdf}>Gerar PDF diário</button>

        </div>

      )}

      {mode===REPORT_MODE.period && (

        <div style={{marginTop:30}}>

          <input type=\"date\" value={startDate} onChange={e=>setStartDate(e.target.value)} />

          <input type=\"date\" value={endDate} onChange={e=>setEndDate(e.target.value)} />

          <button onClick={generatePeriodPdf}>Gerar relatório</button>

        </div>

      )}

      {mode===REPORT_MODE.observations && (

        <div style={{marginTop:30}}>

          <select onChange={e=>setStatusFilter(e.target.value)}>

            <option value=\"\">Todos status</option>

            <option value=\"pending\">Pendentes</option>

            <option value=\"in_progress\">Em andamento</option>

            <option value=\"done\">Concluídas</option>

          </select>

          <button onClick={generateObservationsPdf}>Gerar PDF</button>

        </div>

      )}

      <div style={{marginTop:40}}>

        <Link href={`/obras/${project.id}`}>Voltar</Link>

      </div>

    </div>

  )

}
