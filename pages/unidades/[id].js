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

  const [signedUrlByPhotoId, setSignedUrlByPhotoId] = useState({})
  const [busyStageId, setBusyStageId] = useState(null)
  const [uploadingStageId, setUploadingStageId] = useState(null)

  // ✅ novo: controla qual etapa está com menu “Alterar” aberto
  const [editingStatusStageId, setEditingStatusStageId] = useState(null)

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

  async function loadAll() {
    if (!router.isReady) return
    if (!unitId) return

    setLoading(true)

    const u = await ensureAuth()
    if (!u) return

    // Unidade
    const { data: unitData, error: unitErr } = await supabase
      .from('units')
      .select('id, identifier, project_id, created_at')
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

    // Etapas + fotos
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
        stages ( id, name ),
        unit_stage_photos ( id, path, caption, kind, created_at, user_id )
      `
      )
      .eq('unit_id', unitId)
      .order('created_at', { ascending: true })

    if (stageErr) {
      console.error('Erro ao carregar etapas:', stageErr)
      alert(`Erro ao carregar etapas: ${stageErr.message}`)
      setStages([])
      setLoading(false)
      return
    }

    const normalized = (stageRows || []).map((r) => ({
      ...r,
      stage_name: r.stages?.name || '(Sem nome)',
      photos: Array.isArray(r.unit_stage_photos) ? r.unit_stage_photos : [],
    }))

    setStages(normalized)
    await hydrateSignedUrls(normalized)

    setLoading(false)
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, unitId])

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Unidade</div>
          <h1 style={{ margin: 0 }}>Unidade {unit.identifier || unit.id}</h1>
          <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>project_id: {unit.project_id}</div>
        </div>

        <Link href={`/obras/${unit.project_id}`}>← Voltar</Link>
      </div>

      <hr style={{ margin: '18px 0' }} />

      <h2 style={{ marginTop: 0 }}>Etapas</h2>

      <div style={{ display: 'grid', gap: 14, maxWidth: 980 }}>
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
              {/* ✅ Header: só badge do status + botão Alterar (sem “Status: ...”) */}
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800 }}>{s.stage_name}</div>
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

              {/* ✅ Menu de troca de status (só aparece quando clicar em Alterar) */}
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
                              {p.caption ? <div style={{ marginBottom: 4 }}><b>{p.caption}</b></div> : null}
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
    </div>
  )
}
