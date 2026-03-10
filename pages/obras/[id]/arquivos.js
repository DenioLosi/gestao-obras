import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { supabase } from '../../../lib/supabase'

const BUCKET = 'project-files'

function safeStr(v) {
  return (v ?? '').toString()
}

function randomId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16)
}

function formatBytes(bytes) {
  const n = Number(bytes || 0)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatDateTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('pt-BR')
}

function fileExt(name) {
  const s = safeStr(name)
  const i = s.lastIndexOf('.')
  if (i === -1) return ''
  return s.slice(i + 1).toLowerCase()
}

function fileEmoji(name, mime) {
  const ext = fileExt(name)
  const m = safeStr(mime).toLowerCase()

  if (m.includes('pdf') || ext === 'pdf') return '📄'
  if (m.includes('sheet') || ['xls', 'xlsx', 'csv'].includes(ext)) return '📊'
  if (m.includes('word') || ['doc', 'docx'].includes(ext)) return '📝'
  if (m.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return '🖼️'
  if (['dwg', 'dxf'].includes(ext)) return '📐'
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️'
  return '📁'
}

export default function ObraArquivosPage() {
  const router = useRouter()
  const { id } = router.query

  const projectId = useMemo(() => {
    if (!id) return null
    if (Array.isArray(id)) return id[0] || null
    return String(id)
  }, [id])

  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [deletingId, setDeletingId] = useState('')
  const [user, setUser] = useState(null)
  const [project, setProject] = useState(null)
  const [files, setFiles] = useState([])
  const [signedUrls, setSignedUrls] = useState({})
  const [search, setSearch] = useState('')

  async function ensureAuth() {
    const { data, error } = await supabase.auth.getUser()
    if (error || !data?.user) {
      window.location.href = '/login'
      return null
    }
    setUser(data.user)
    return data.user
  }

  async function hydrateSignedUrls(rows) {
    const missing = (rows || []).filter((r) => r?.id && r?.storage_path && !signedUrls[r.id])
    if (missing.length === 0) return

    const updates = {}
    for (const row of missing) {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(row.storage_path, 60 * 60)
      if (!error && data?.signedUrl) {
        updates[row.id] = data.signedUrl
      }
    }

    if (Object.keys(updates).length > 0) {
      setSignedUrls((prev) => ({ ...prev, ...updates }))
    }
  }

  async function loadData() {
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
      setProject(null)
      setFiles([])
      setLoading(false)
      return
    }

    if (!projectRow) {
      setProject(null)
      setFiles([])
      setLoading(false)
      return
    }

    setProject(projectRow)

    const { data: fileRows, error: filesErr } = await supabase
      .from('project_files')
      .select('id, project_id, user_id, file_name, storage_path, mime_type, size_bytes, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })

    if (filesErr) {
      alert(`Erro ao carregar arquivos: ${filesErr.message}`)
      setFiles([])
      setLoading(false)
      return
    }

    const rows = Array.isArray(fileRows) ? fileRows : []
    setFiles(rows)
    await hydrateSignedUrls(rows)

    setLoading(false)
  }

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  async function uploadFiles(fileList) {
    if (!projectId) return
    if (!user?.id) {
      alert('Usuário não autenticado.')
      return
    }

    const filesToUpload = Array.from(fileList || [])
    if (filesToUpload.length === 0) return

    setUploading(true)
    try {
      for (const file of filesToUpload) {
        const originalName = safeStr(file.name).trim()
        if (!originalName) continue

        const path = `projects/${projectId}/${randomId()}_${originalName}`

        const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(path, file, {
          cacheControl: '3600',
          upsert: false,
          contentType: file.type || undefined,
        })

        if (uploadErr) {
          alert(`Erro ao subir "${originalName}": ${uploadErr.message}`)
          continue
        }

        const { error: insertErr } = await supabase
          .from('project_files')
          .insert({
            project_id: projectId,
            user_id: user.id,
            file_name: originalName,
            storage_path: path,
            mime_type: file.type || null,
            size_bytes: Number(file.size || 0),
          })

        if (insertErr) {
          alert(`Upload ok, mas erro ao registrar "${originalName}" no banco: ${insertErr.message}`)
        }
      }

      await loadData()
    } finally {
      setUploading(false)
    }
  }

  async function deleteFile(row) {
    const ok = window.confirm(`Excluir o arquivo "${row.file_name}"?`)
    if (!ok) return

    setDeletingId(row.id)
    try {
      if (row.storage_path) {
        const { error: storageErr } = await supabase.storage.from(BUCKET).remove([row.storage_path])
        if (storageErr) {
          alert(`Erro ao excluir arquivo do storage: ${storageErr.message}`)
          return
        }
      }

      const { error: dbErr } = await supabase.from('project_files').delete().eq('id', row.id)
      if (dbErr) {
        alert(`Erro ao excluir registro do arquivo: ${dbErr.message}`)
        return
      }

      setSignedUrls((prev) => {
        const next = { ...prev }
        delete next[row.id]
        return next
      })

      await loadData()
    } finally {
      setDeletingId('')
    }
  }

  const filteredFiles = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return files
    return files.filter((f) => {
      return (
        safeStr(f.file_name).toLowerCase().includes(q) ||
        safeStr(f.mime_type).toLowerCase().includes(q)
      )
    })
  }, [files, search])

  if (loading) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
        <div>Carregando…</div>
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

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Arquivos da obra</div>
          <h1 style={{ margin: 0 }}>{project.name || '(Sem nome)'}</h1>
          <div style={{ marginTop: 8, fontSize: 13, color: '#555' }}>
            {project.client_name ? <b>{project.client_name}</b> : null}
            {project.client_name && project.city ? ' • ' : null}
            {project.city || ''}
            {project.address ? ` • ${project.address}` : ''}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label
            style={{
              display: 'inline-flex',
              gap: 10,
              alignItems: 'center',
              padding: '10px 12px',
              borderRadius: 12,
              border: '1px solid #ddd',
              background: '#111',
              color: '#fff',
              cursor: uploading ? 'not-allowed' : 'pointer',
              fontWeight: 800,
            }}
          >
            {uploading ? 'Enviando…' : '+ Enviar arquivos'}
            <input
              type="file"
              multiple
              disabled={uploading}
              style={{ display: 'none' }}
              onChange={async (e) => {
                const selected = e.target.files
                if (!selected || selected.length === 0) return
                await uploadFiles(selected)
                e.target.value = ''
              }}
            />
          </label>

          <Link href={`/obras/${project.id}`} style={{ textDecoration: 'none' }}>
            ← Voltar para obra
          </Link>
        </div>
      </div>

      <hr style={{ margin: '18px 0' }} />

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 18 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nome do arquivo ou tipo..."
          style={{
            width: 'min(520px, 100%)',
            padding: '10px 12px',
            borderRadius: 12,
            border: '1px solid #ddd',
            outline: 'none',
          }}
        />

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
              fontWeight: 700,
            }}
          >
            Limpar
          </button>
        ) : null}

        <div style={{ fontSize: 12, color: '#666' }}>
          Total: <b>{filteredFiles.length}</b>
        </div>
      </div>

      {filteredFiles.length === 0 ? (
        <div style={{ color: '#666' }}>
          Nenhum arquivo encontrado para esta obra.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10, maxWidth: 1100 }}>
          {filteredFiles.map((row) => {
            const signedUrl = signedUrls[row.id]
            const busyDeleting = deletingId === row.id

            return (
              <div
                key={row.id}
                style={{
                  border: '1px solid #eee',
                  borderRadius: 14,
                  padding: 14,
                  background: '#fff',
                  boxShadow: '0 6px 20px rgba(0,0,0,0.06)',
                  display: 'grid',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 900, wordBreak: 'break-word' }}>
                      {fileEmoji(row.file_name, row.mime_type)} {row.file_name}
                    </div>

                    <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>
                      Tipo: <b>{row.mime_type || 'não informado'}</b>
                    </div>

                    <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                      Tamanho: <b>{formatBytes(row.size_bytes)}</b>
                      {row.created_at ? <> • Enviado em <b>{formatDateTime(row.created_at)}</b></> : null}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {signedUrl ? (
                      <a href={signedUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                        <button
                          type="button"
                          style={{
                            padding: '10px 12px',
                            borderRadius: 12,
                            border: '1px solid #ddd',
                            background: '#111',
                            color: '#fff',
                            cursor: 'pointer',
                            fontWeight: 800,
                          }}
                        >
                          Abrir / Baixar
                        </button>
                      </a>
                    ) : (
                      <button
                        type="button"
                        disabled
                        style={{
                          padding: '10px 12px',
                          borderRadius: 12,
                          border: '1px solid #ddd',
                          background: '#777',
                          color: '#fff',
                          cursor: 'not-allowed',
                          fontWeight: 800,
                        }}
                      >
                        Preparando link…
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => deleteFile(row)}
                      disabled={busyDeleting}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 12,
                        border: '1px solid #ddd',
                        background: '#fff',
                        color: '#b00020',
                        cursor: busyDeleting ? 'not-allowed' : 'pointer',
                        fontWeight: 800,
                      }}
                    >
                      {busyDeleting ? 'Excluindo…' : 'Excluir'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
