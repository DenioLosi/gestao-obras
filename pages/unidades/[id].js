import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { supabase } from '../../lib/supabase'

const BUCKET = 'unit-stage-photos'

const STATUS_PT = {
  pending: 'Pendente',
  in_progress: 'Em andamento',
  done: 'Concluído',
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
          width: 'min(940px, 100%)',
          background: '#fff',
          borderRadius: 16,
          border: '1px solid #eee',
          boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          padding: 16,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 18, fontWeight: 900 }}>{title}</div>
          <button
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
        <div style={{ marginTop: 12 }}>{children}</div>
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
  const [stages, setStages] = useState([]) // unit_stages + stages
  const [stageCatalog, setStageCatalog] = useState([]) // stages (modelo da obra)

  const [signedUrlByPhotoId, setSignedUrlByPhotoId] = useState({})
  const [busyStageId, setBusyStageId] = useState(null)
  const [uploadingStageId, setUploadingStageId] = useState(null)

  // UI do status
  const [editingStatusStageId, setEditingStatusStageId] = useState(null)

  // ✅ NOVO: modal gerenciar etapas da unidade
  const [manageOpen, setManageOpen] = useState(false)
  const [manageBusy, setManageBusy] = useState(false)
  const [addStageId, setAddStageId] = useState('') // stage_id para adicionar
  const [createStageName, setCreateStageName] = useState('') // criar novo "stage" (modelo) e adicionar

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

  async function loadAll() {
    if (!router.isReady) return
    if (!unitId) return

    setLoading(true)

    const u = await ensureAuth()
    if (!u) return

    // Unidade
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
      setLoading(false)
      return
    }

    if (!unitData) {
      setUnit(null)
      setStages([])
      setLoading(false)
      return
    }

    setUnit(unitData)

    // Catálogo de etapas (modelo da obra)
    const { data: catalog, error: cErr } = await supabase
      .from('stages')
      .select('id, name, order_index, is_active, project_id')
      .eq('project_id', unitData.project_id)
      .order('order_index', { ascending: true })
      .order('name', { ascending: true })

    if (!cErr) {
      setStageCatalog(Array.isArray(catalog) ? catalog.filter((s) => s.is_active !== false) : [])
    } else {
      console.error('Erro ao carregar catálogo de etapas:', cErr)
      setStageCatalog([])
    }

    // Etapas da unidade + fotos
    const { data: stageRows, error: stageErr } = await supabase
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
        stages ( id, name ),
        unit_stage_photos ( id, path, caption, kind, created_at, user_id )
      `
      )
      .eq('unit_id', unitId)

    if (stageErr) {
      console.error('Erro ao carregar etapas:', stageErr)
      alert(`Erro ao carregar etapas: ${stageErr.message}`)
      setStages([])
      setLoading(false)
      return
    }

    const normalized = normalizeStages(stageRows || [])
    setStages(normalized)
    await hydrateSignedUrls(normalized)

    setLoading(false)
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, unitId])

  function nextOrderIndex() {
    const max = (stages || []).reduce((m, s) => Math.max(m, Number(s.order_index || 0)), 0)
    return max + 1
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

  // ============================
  // ✅ CRUD ETAPAS NA UNIDADE
  // ============================

  async function addExistingStageToUnit() {
    if (!addStageId) return
    if (!unit?.id) return

    // Evita duplicar a mesma stage_id na unidade
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
      // cria em stages (modelo da obra)
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
    const n = safeStr(customName).trim()
    setManageBusy(true)
    try {
      const { error } = await supabase.from('unit_stages').update({ custom_name: n || null }).eq('id', unitStageId)
      if (error) {
        alert(`Erro ao renomear etapa: ${error.message}`)
        return
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
      // ✅ remove fotos e logs primeiro (evita erro de FK, se existir)
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

  // ============================
  // RENDER
  // ============================

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

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Unidade</div>
          <h1 style={{ margin: 0 }}>Unidade {unit.identifier || unit.id}</h1>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
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

      <h2 style={{ marginTop: 0 }}>Etapas</h2>

      {stages.length === 0 ? (
        <div style={{ color: '#666' }}>
          Nenhuma etapa nesta unidade. Clique em <b>Gerenciar etapas</b> para adicionar.
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: 14, maxWidth: 980, marginTop: 12 }}>
        {stages.map((s) => {
          const isBusy = busyStageId === s.id
          const isUploading = uploadingStageId === s.id

          return (
            <div
              key={s.id}
              style={{
                background: '#fff',
                border: '1px solid #eee',
                borderRadius: 14,
                padding: 16,
                boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
              }}
            >
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800 }}>{s.stage_name}</div>
                  {s.custom_name ? (
                    <div style={{ marginTop: 4, fontSize: 12, color: '#666' }}>
                      Modelo: {s.stage_template_name}
                    </div>
                  ) : null}
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end' }}>
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
                    title="Status atual"
                  >
                    {STATUS_PT[s.status] || '—'}
                  </span>

                  <button
                    disabled={isBusy || isUploading}
                    onClick={() => setEditingStatusStageId((prev) => (prev === s.id ? null : s.id))}
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
                    Alterar
                  </button>
                </div>
              </div>

              {/* Menu troca status */}
              {editingStatusStageId === s.id ? (
                <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button
                    disabled={isBusy || isUploading}
                    onClick={async () => {
                      await updateStageStatus(s.id, 'pending')
                      setEditingStatusStageId(null)
                    }}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 10,
                      border: '1px solid #ddd',
                      background: '#fff',
                      cursor: isBusy || isUploading ? 'not-allowed' : 'pointer',
                      fontWeight: 700,
                    }}
                  >
                    Pendente
                  </button>

                  <button
                    disabled={isBusy || isUploading}
                    onClick={async () => {
                      await updateStageStatus(s.id, 'in_progress')
                      setEditingStatusStageId(null)
                    }}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 10,
                      border: '1px solid #ddd',
                      background: '#fff',
                      cursor: isBusy || isUploading ? 'not-allowed' : 'pointer',
                      fontWeight: 700,
                    }}
                  >
                    Em andamento
                  </button>

                  <button
                    disabled={isBusy || isUploading}
                    onClick={async () => {
                      await updateStageStatus(s.id, 'done')
                      setEditingStatusStageId(null)
                    }}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 10,
                      border: '1px solid #ddd',
                      background: '#fff',
                      cursor: isBusy || isUploading ? 'not-allowed' : 'pointer',
                      fontWeight: 700,
                    }}
                  >
                    Concluído
                  </button>
                </div>
              ) : null}

              {/* Notas */}
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: '#444', marginBottom: 6 }}>Observações / notas</div>
                <textarea
                  defaultValue={s.notes || ''}
                  placeholder="Escreva observações desta etapa..."
                  onBlur={(e) => saveNotes(s.id, e.target.value)}
                  disabled={isBusy || isUploading}
                  style={{
                    width: '100%',
                    minHeight: 84,
                    padding: 12,
                    borderRadius: 12,
                    border: '1px solid #ddd',
                    outline: 'none',
                    resize: 'vertical',
                  }}
                />
                <div style={{ fontSize: 12, color: '#777', marginTop: 6 }}>(Salva ao sair do campo)</div>
              </div>

              {/* Upload */}
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
                    Fotos: <b>{(s.photos || []).length}</b>
                  </div>
                </div>

                {(s.photos || []).length > 0 ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
                    {(s.photos || [])
                      .slice()
                      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
                      .map((p) => {
                        const url = signedUrlByPhotoId[p.id]
                        return (
                          <div
                            key={p.id}
                            style={{
                              border: '1px solid #eee',
                              borderRadius: 12,
                              padding: 10,
                              background: '#fafafa',
                            }}
                          >
                            {url ? (
                              <a href={url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                                <img
                                  src={url}
                                  alt={p.caption || 'foto'}
                                  style={{
                                    width: '100%',
                                    height: 140,
                                    objectFit: 'cover',
                                    borderRadius: 10,
                                    display: 'block',
                                  }}
                                />
                              </a>
                            ) : (
                              <div
                                style={{
                                  width: '100%',
                                  height: 140,
                                  borderRadius: 10,
                                  background: '#eee',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  color: '#666',
                                  fontSize: 12,
                                }}
                              >
                                Carregando foto…
                              </div>
                            )}

                            <div style={{ fontSize: 12, color: '#444', marginTop: 8 }}>
                              {p.caption ? (
                                <div style={{ marginBottom: 4 }}>
                                  <b>{p.caption}</b>
                                </div>
                              ) : null}
                              <div style={{ color: '#777' }}>
                                {p.created_at ? new Date(p.created_at).toLocaleString() : ''}
                              </div>
                            </div>
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

      {/* ✅ MODAL GERENCIAR ETAPAS */}
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
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button
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
    </div>
  )
}
