import { createClient } from '@supabase/supabase-js'
import { calculateUnitMetrics } from '../../../lib/unit-progress'

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const supabaseAuth = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
})

const PHOTO_BUCKET = 'unit-stage-photos'

function safeStr(value) {
  return (value ?? '').toString()
}

function normalizeStatus(status) {
  const value = safeStr(status).trim()
  if (value === 'done' || value === 'in_progress' || value === 'pending') return value
  return 'pending'
}

function normalizeIssueStatus(status) {
  const value = safeStr(status).trim()
  if (value === 'resolved' || value === 'in_progress' || value === 'open') return value
  return 'open'
}

function normalizeIssuePriority(priority) {
  const value = safeStr(priority).trim()
  if (value === 'low' || value === 'medium' || value === 'high') return value
  return 'medium'
}

function randomId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16)
}

function extFromPath(path) {
  const raw = safeStr(path).trim()
  const index = raw.lastIndexOf('.')
  return index >= 0 ? raw.slice(index + 1) || 'jpg' : 'jpg'
}

function chunk(items, size) {
  const result = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

function readBearerToken(req) {
  const header = safeStr(req.headers.authorization).trim()
  if (!header.toLowerCase().startsWith('bearer ')) return ''
  return header.slice(7).trim()
}

async function requireAdmin(req) {
  const token = readBearerToken(req)
  if (!token) {
    throw Object.assign(new Error('Sessao invalida. Entre novamente.'), { statusCode: 401 })
  }

  const { data: authData, error: authError } = await supabaseAuth.auth.getUser(token)
  if (authError || !authData?.user) {
    throw Object.assign(new Error(authError?.message || 'Usuario nao autenticado.'), { statusCode: 401 })
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, role, status, tenant_id, full_name, email')
    .eq('id', authData.user.id)
    .maybeSingle()

  if (profileError || !profile) {
    throw Object.assign(new Error(profileError?.message || 'Perfil nao encontrado.'), { statusCode: 403 })
  }

  if (profile.status === 'inactive' || profile.status === 'disabled') {
    throw Object.assign(new Error('Seu usuario esta inativo.'), { statusCode: 403 })
  }

  if (profile.role !== 'admin') {
    throw Object.assign(new Error('Apenas administradores podem executar esta acao.'), { statusCode: 403 })
  }

  return { user: authData.user, profile }
}

async function getProjectOrThrow(projectId, tenantId) {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id, tenant_id, name')
    .eq('id', projectId)
    .maybeSingle()

  if (error || !data) {
    throw Object.assign(new Error(error?.message || 'Obra nao encontrada.'), { statusCode: 404 })
  }

  if (safeStr(data.tenant_id) !== safeStr(tenantId)) {
    throw Object.assign(new Error('Obra fora do tenant do administrador.'), { statusCode: 403 })
  }

  return data
}

async function getUnitOrThrow(unitId, tenantId) {
  const { data, error } = await supabaseAdmin
    .from('units')
    .select('id, identifier, project_id')
    .eq('id', unitId)
    .maybeSingle()

  if (error || !data) {
    throw Object.assign(new Error(error?.message || 'Unidade nao encontrada.'), { statusCode: 404 })
  }

  const project = await getProjectOrThrow(data.project_id, tenantId)
  return { unit: data, project }
}

async function getProjectStages(projectId) {
  const { data, error } = await supabaseAdmin
    .from('stages')
    .select('id, name, order_index, is_active, project_id')
    .eq('project_id', projectId)
    .order('order_index', { ascending: true })
    .order('name', { ascending: true })

  if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
  return Array.isArray(data) ? data : []
}

async function getUnitStages(unitId) {
  const { data, error } = await supabaseAdmin
    .from('unit_stages')
    .select('id, unit_id, stage_id, status, notes, started_at, due_date, custom_name, order_index, is_active, unit_stage_photos ( id, path, caption, kind )')
    .eq('unit_id', unitId)
    .order('order_index', { ascending: true })

  if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
  return Array.isArray(data) ? data : []
}

async function recalculateUnitProgress(unitId) {
  const stageRows = await getUnitStages(unitId)
  const metrics = calculateUnitMetrics(stageRows || [])
  const patch = {
    progress: Math.round(metrics.progressPct * 100) / 100,
    status: metrics.generalStatus,
  }

  const { error } = await supabaseAdmin.from('units').update(patch).eq('id', unitId)
  if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
  return patch
}

async function insertUnitStagesAvoidingDuplicates(rows) {
  const candidates = (Array.isArray(rows) ? rows : []).filter(Boolean)
  if (candidates.length === 0) return []

  const unitIds = [...new Set(candidates.map((row) => safeStr(row.unit_id)).filter(Boolean))]
  const { data: existingRows, error: existingError } = await supabaseAdmin
    .from('unit_stages')
    .select('id, unit_id, stage_id')
    .in('unit_id', unitIds)
    .limit(1000000)

  if (existingError) throw Object.assign(new Error(existingError.message), { statusCode: 400 })

  const existingPairs = new Set(
    (existingRows || [])
      .filter((row) => row?.stage_id)
      .map((row) => `${safeStr(row.unit_id)}::${safeStr(row.stage_id)}`)
  )

  const rowsToInsert = candidates.filter((row) => {
    const stageId = safeStr(row.stage_id).trim()
    if (!stageId) return true
    const key = `${safeStr(row.unit_id)}::${stageId}`
    if (existingPairs.has(key)) return false
    existingPairs.add(key)
    return true
  })

  const inserted = []
  for (const currentChunk of chunk(rowsToInsert, 500)) {
    const { data, error } = await supabaseAdmin.from('unit_stages').insert(currentChunk).select('id, unit_id, stage_id')
    if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
    if (Array.isArray(data)) inserted.push(...data)
  }

  return inserted
}

async function duplicatePhotoToStage(sourcePath, targetUnitId, targetUnitStageId) {
  const { data: fileData, error: downloadError } = await supabaseAdmin.storage.from(PHOTO_BUCKET).download(sourcePath)
  if (downloadError || !fileData) {
    throw Object.assign(new Error(downloadError?.message || 'Falha ao baixar foto da etapa.'), { statusCode: 400 })
  }

  const newPath = `units/${targetUnitId}/unit_stages/${targetUnitStageId}/${randomId()}.${extFromPath(sourcePath)}`
  const { error: uploadError } = await supabaseAdmin.storage.from(PHOTO_BUCKET).upload(newPath, fileData, {
    cacheControl: '3600',
    upsert: false,
    contentType: fileData.type || undefined,
  })

  if (uploadError) {
    throw Object.assign(new Error(uploadError.message), { statusCode: 400 })
  }

  return newPath
}

async function createUnitWithStages(projectId, identifier, activeStages) {
  const { data: createdUnit, error: createError } = await supabaseAdmin
    .from('units')
    .insert({
      project_id: projectId,
      identifier,
      status: 'pending',
      progress: 0,
      is_active: true,
    })
    .select('id, identifier')
    .maybeSingle()

  if (createError || !createdUnit?.id) {
    throw Object.assign(new Error(createError?.message || 'Falha ao criar unidade.'), { statusCode: 400 })
  }

  if (activeStages.length > 0) {
    await insertUnitStagesAvoidingDuplicates(
      activeStages.map((stage) => ({
        unit_id: createdUnit.id,
        stage_id: stage.id,
        status: 'pending',
        is_active: true,
        order_index: stage.order_index ?? null,
        custom_name: null,
        notes: null,
      }))
    )
  }

  return createdUnit
}

async function handleCreateProject(body, profile) {
  const name = safeStr(body.name).trim()
  const clientName = safeStr(body.client_name).trim()

  if (!name) throw Object.assign(new Error('Informe o nome da obra.'), { statusCode: 400 })
  if (!clientName) throw Object.assign(new Error('Informe o cliente.'), { statusCode: 400 })

  const payload = {
    name,
    description: safeStr(body.description).trim(),
    client_name: clientName,
    city: safeStr(body.city).trim(),
    address: safeStr(body.address).trim(),
    tenant_id: profile.tenant_id,
    is_active: true,
  }

  const { data, error } = await supabaseAdmin.from('projects').insert(payload).select('id, name').maybeSingle()
  if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
  return { project: data || null }
}

async function handleDeleteProject(body, profile) {
  const project = await getProjectOrThrow(body.project_id, profile.tenant_id)
  const { error } = await supabaseAdmin.from('projects').delete().eq('id', project.id)
  if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
  return { deleted: true, projectId: project.id }
}

async function handleCreateUnit(body, profile) {
  const project = await getProjectOrThrow(body.project_id, profile.tenant_id)
  const activeStages = body.apply_stages ? (await getProjectStages(project.id)).filter((stage) => stage.is_active !== false) : []
  const createdUnit = await createUnitWithStages(project.id, safeStr(body.identifier).trim(), activeStages)
  return { unit: createdUnit }
}

async function handleDeleteUnit(body, profile) {
  const { unit } = await getUnitOrThrow(body.unit_id, profile.tenant_id)
  const { error } = await supabaseAdmin.from('units').delete().eq('id', unit.id)
  if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
  return { deleted: true, unitId: unit.id }
}

async function handleCopyUnit(body, profile) {
  const { unit: sourceUnit, project } = await getUnitOrThrow(body.source_unit_id, profile.tenant_id)
  const newIdentifier = safeStr(body.new_identifier).trim()
  if (!newIdentifier) throw Object.assign(new Error('Informe o identificador da nova unidade.'), { statusCode: 400 })

  const sourceStages = (await getUnitStages(sourceUnit.id)).filter((row) => row.is_active !== false)
  const { data: createdUnit, error: createUnitError } = await supabaseAdmin
    .from('units')
    .insert({
      project_id: project.id,
      identifier: newIdentifier,
      status: 'pending',
      progress: 0,
      is_active: true,
    })
    .select('id, identifier')
    .maybeSingle()

  if (createUnitError || !createdUnit?.id) {
    throw Object.assign(new Error(createUnitError?.message || 'Falha ao criar unidade.'), { statusCode: 400 })
  }

  const stageIdMap = {}
  if (body.copy_structure) {
    const rows = sourceStages.map((stage) => ({
      unit_id: createdUnit.id,
      stage_id: stage.stage_id || null,
      custom_name: stage.custom_name || null,
      order_index: stage.order_index ?? null,
      is_active: stage.is_active !== false,
      status: 'pending',
      notes: body.copy_observations ? safeStr(stage.notes) : null,
    }))

    const insertedStages = await insertUnitStagesAvoidingDuplicates(rows)
    insertedStages.forEach((row, index) => {
      const source = rows[index]
      if (source?.stage_id) stageIdMap[`${safeStr(source.stage_id)}::${index}`] = row.id
    })
  }

  if (body.copy_photos) {
    let duplicateIndex = 0
    for (const sourceStage of sourceStages) {
      const photos = Array.isArray(sourceStage.unit_stage_photos) ? sourceStage.unit_stage_photos : []
      if (photos.length === 0) {
        duplicateIndex += 1
        continue
      }

      const targetStageId = stageIdMap[`${safeStr(sourceStage.stage_id)}::${duplicateIndex}`]
      duplicateIndex += 1
      if (!targetStageId) continue

      const photoRows = []
      for (const photo of photos) {
        if (!photo.path) continue
        const newPath = await duplicatePhotoToStage(photo.path, createdUnit.id, targetStageId)
        photoRows.push({
          unit_stage_id: targetStageId,
          user_id: null,
          kind: photo.kind || 'image',
          path: newPath,
          caption: safeStr(photo.caption),
        })
      }

      if (photoRows.length > 0) {
        const { error } = await supabaseAdmin.from('unit_stage_photos').insert(photoRows)
        if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
      }
    }
  }

  return { unit: createdUnit }
}

async function handleCreateStageTemplate(body, profile) {
  const project = await getProjectOrThrow(body.project_id, profile.tenant_id)
  const name = safeStr(body.name).trim()
  if (!name) throw Object.assign(new Error('Nome da etapa e obrigatorio.'), { statusCode: 400 })

  const stages = await getProjectStages(project.id)
  const maxOrder = stages.reduce((maxValue, row) => Math.max(maxValue, Number(row.order_index || 0)), 0)
  const { data, error } = await supabaseAdmin
    .from('stages')
    .insert({
      project_id: project.id,
      name,
      order_index: maxOrder + 1,
      is_active: true,
    })
    .select('id, name')
    .maybeSingle()

  if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
  return { stage: data || null }
}

async function handleBulkAddStageTemplates(body, profile) {
  const project = await getProjectOrThrow(body.project_id, profile.tenant_id)
  const lines = Array.isArray(body.lines)
    ? body.lines.map((value) => safeStr(value).trim()).filter(Boolean)
    : []

  if (lines.length === 0) {
    throw Object.assign(new Error('Digite pelo menos uma etapa.'), { statusCode: 400 })
  }

  const stages = await getProjectStages(project.id)
  const maxOrder = stages.reduce((maxValue, row) => Math.max(maxValue, Number(row.order_index || 0)), 0)
  const rows = lines.map((name, index) => ({
    project_id: project.id,
    name,
    order_index: maxOrder + index + 1,
    is_active: true,
  }))

  for (const currentChunk of chunk(rows, 200)) {
    const { error } = await supabaseAdmin.from('stages').insert(currentChunk)
    if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
  }

  return { created: rows.length }
}

async function handleApplyStagesToUnitsMissingAny(body, profile) {
  const project = await getProjectOrThrow(body.project_id, profile.tenant_id)
  const unitIds = Array.isArray(body.unit_ids) ? body.unit_ids.map((value) => safeStr(value)).filter(Boolean) : []
  const activeStages = (await getProjectStages(project.id)).filter((stage) => stage.is_active !== false)

  if (unitIds.length === 0 || activeStages.length === 0) {
    return { created: 0, affectedUnits: 0 }
  }

  const { data: existing, error: existingError } = await supabaseAdmin
    .from('unit_stages')
    .select('unit_id')
    .in('unit_id', unitIds)
    .limit(1000000)

  if (existingError) throw Object.assign(new Error(existingError.message), { statusCode: 400 })

  const unitsWithAnyStages = new Set((existing || []).map((row) => safeStr(row.unit_id)))
  const missingUnitIds = unitIds.filter((unitId) => !unitsWithAnyStages.has(safeStr(unitId)))
  const rows = []
  for (const unitId of missingUnitIds) {
    for (const stage of activeStages) {
      rows.push({
        unit_id: unitId,
        stage_id: stage.id,
        status: 'pending',
        is_active: true,
        order_index: stage.order_index ?? null,
      })
    }
  }

  const inserted = await insertUnitStagesAvoidingDuplicates(rows)
  return { created: inserted.length, affectedUnits: missingUnitIds.length }
}

async function handleSyncModelToAllUnits(body, profile) {
  const project = await getProjectOrThrow(body.project_id, profile.tenant_id)
  const unitIds = Array.isArray(body.unit_ids) ? body.unit_ids.map((value) => safeStr(value)).filter(Boolean) : []
  const stages = await getProjectStages(project.id)
  const rows = []

  for (const unitId of unitIds) {
    for (const stage of stages) {
      rows.push({
        unit_id: unitId,
        stage_id: stage.id,
        status: 'pending',
        is_active: stage.is_active !== false,
        order_index: stage.order_index ?? null,
      })
    }
  }

  const inserted = await insertUnitStagesAvoidingDuplicates(rows)

  const archivedIds = stages.filter((stage) => stage.is_active === false).map((stage) => stage.id)
  const activeIds = stages.filter((stage) => stage.is_active !== false).map((stage) => stage.id)

  if (archivedIds.length > 0) {
    const { error } = await supabaseAdmin.from('unit_stages').update({ is_active: false }).in('unit_id', unitIds).in('stage_id', archivedIds)
    if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
  }

  if (activeIds.length > 0) {
    const { error } = await supabaseAdmin.from('unit_stages').update({ is_active: true }).in('unit_id', unitIds).in('stage_id', activeIds)
    if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
  }

  return { created: inserted.length, affectedUnits: unitIds.length }
}

async function handleGenerateUnits(body, profile, mode) {
  const project = await getProjectOrThrow(body.project_id, profile.tenant_id)
  const identifiers = Array.isArray(body.identifiers) ? body.identifiers.map((value) => safeStr(value).trim()).filter(Boolean) : []
  const activeStages = (await getProjectStages(project.id)).filter((stage) => stage.is_active !== false)
  if (identifiers.length === 0) return { created: 0 }

  const existingSet = new Set(
    (
      await supabaseAdmin
        .from('units')
        .select('identifier')
        .eq('project_id', project.id)
        .limit(1000000)
    ).data?.map((row) => safeStr(row.identifier)) || []
  )

  const toCreate = identifiers.filter((identifier) => !existingSet.has(identifier))
  const createdUnits = []
  for (const currentChunk of chunk(
    toCreate.map((identifier) => ({
      project_id: project.id,
      identifier,
      status: 'pending',
      progress: 0,
      is_active: true,
    })),
    200
  )) {
    const { data, error } = await supabaseAdmin.from('units').insert(currentChunk).select('id, identifier')
    if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
    if (Array.isArray(data)) createdUnits.push(...data)
  }

  await insertUnitStagesAvoidingDuplicates(
    createdUnits.flatMap((unit) =>
      activeStages.map((stage) => ({
        unit_id: unit.id,
        stage_id: stage.id,
        status: 'pending',
        is_active: true,
        order_index: stage.order_index ?? null,
      }))
    )
  )

  if (body.apply_existing_missing) {
    await handleApplyStagesToUnitsMissingAny(
      {
        project_id: project.id,
        unit_ids: [...(Array.isArray(body.all_unit_ids) ? body.all_unit_ids : []), ...createdUnits.map((unit) => unit.id)],
      },
      profile
    )
  }

  return { created: createdUnits.length, mode }
}

async function handleAddExistingStageToUnit(body, profile) {
  const { unit } = await getUnitOrThrow(body.unit_id, profile.tenant_id)
  const payload = {
    unit_id: unit.id,
    stage_id: body.stage_id,
    status: 'pending',
    order_index: body.order_index ?? null,
    is_active: true,
  }

  const inserted = await insertUnitStagesAvoidingDuplicates([payload])
  return { created: inserted.length }
}

async function handleCreateStageTemplateAndAddToUnit(body, profile) {
  const { unit, project } = await getUnitOrThrow(body.unit_id, profile.tenant_id)
  const stageResult = await handleCreateStageTemplate(
    {
      project_id: project.id,
      name: body.name,
    },
    profile
  )

  const stageId = stageResult.stage?.id
  if (!stageId) throw Object.assign(new Error('Nao foi possivel criar a etapa.'), { statusCode: 400 })

  await insertUnitStagesAvoidingDuplicates([
    {
      unit_id: unit.id,
      stage_id: stageId,
      status: 'pending',
      order_index: body.order_index ?? null,
      is_active: true,
    },
  ])

  return { stage: stageResult.stage }
}

async function handleDeleteUnitStage(body, profile) {
  const unitStageId = safeStr(body.unit_stage_id).trim()
  const { data: stageRow, error: stageError } = await supabaseAdmin
    .from('unit_stages')
    .select('id, unit_id')
    .eq('id', unitStageId)
    .maybeSingle()

  if (stageError || !stageRow) throw Object.assign(new Error(stageError?.message || 'Etapa nao encontrada.'), { statusCode: 404 })
  await getUnitOrThrow(stageRow.unit_id, profile.tenant_id)

  await supabaseAdmin.from('unit_stage_photos').delete().eq('unit_stage_id', unitStageId)
  await supabaseAdmin.from('unit_stage_logs').delete().eq('unit_stage_id', unitStageId)

  const { error } = await supabaseAdmin.from('unit_stages').delete().eq('id', unitStageId)
  if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
  return { deleted: true }
}

async function handleCopyUnitStage(body, profile) {
  const { unit } = await getUnitOrThrow(body.unit_id, profile.tenant_id)
  const { data: sourceStage, error: sourceError } = await supabaseAdmin
    .from('unit_stages')
    .select('id, unit_id, stage_id, stage_name:custom_name, custom_name, notes, order_index, unit_stage_photos ( id, path, caption, kind )')
    .eq('id', body.source_stage_id)
    .maybeSingle()

  if (sourceError || !sourceStage) throw Object.assign(new Error(sourceError?.message || 'Etapa de origem nao encontrada.'), { statusCode: 404 })

  const targetName = safeStr(body.target_name).trim() || `${safeStr(body.source_stage_name).trim() || 'Etapa'} (copia)`
  const { data: newStage, error: createError } = await supabaseAdmin
    .from('unit_stages')
    .insert({
      unit_id: unit.id,
      stage_id: null,
      status: 'pending',
      order_index: body.order_index ?? null,
      is_active: true,
      custom_name: targetName,
      notes: body.copy_notes ? safeStr(sourceStage.notes) : '',
    })
    .select('id, unit_id, custom_name')
    .maybeSingle()

  if (createError || !newStage?.id) {
    throw Object.assign(new Error(createError?.message || 'Falha ao copiar etapa.'), { statusCode: 400 })
  }

  if (body.copy_photos) {
    const sourcePhotos = Array.isArray(sourceStage.unit_stage_photos) ? sourceStage.unit_stage_photos : []
    const photoRows = []
    for (const photo of sourcePhotos) {
      if (!photo.path) continue
      const newPath = await duplicatePhotoToStage(photo.path, unit.id, newStage.id)
      photoRows.push({
        unit_stage_id: newStage.id,
        user_id: body.actor_id || null,
        kind: photo.kind || 'image',
        path: newPath,
        caption: safeStr(photo.caption),
      })
    }

    if (photoRows.length > 0) {
      const { error } = await supabaseAdmin.from('unit_stage_photos').insert(photoRows)
      if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
    }
  }

  return { stage: newStage }
}

async function handleCreateIssue(body, profile) {
  const { unit, project } = await getUnitOrThrow(body.unit_id, profile.tenant_id)
  const unitStageId = safeStr(body.unit_stage_id).trim()
  const { data: stageRow, error: stageError } = await supabaseAdmin
    .from('unit_stages')
    .select('id, unit_id, status, started_at')
    .eq('id', unitStageId)
    .maybeSingle()

  if (stageError || !stageRow || safeStr(stageRow.unit_id) !== safeStr(unit.id)) {
    throw Object.assign(new Error(stageError?.message || 'Etapa da unidade nao encontrada.'), { statusCode: 404 })
  }

  const { data, error } = await supabaseAdmin
    .from('issues')
    .insert({
      tenant_id: project.tenant_id,
      project_id: project.id,
      unit_id: unit.id,
      unit_stage_id: unitStageId,
      created_by: body.created_by,
      title: safeStr(body.title).trim(),
      description: safeStr(body.description).trim(),
      priority: normalizeIssuePriority(body.priority),
      assigned_to: safeStr(body.assigned_to).trim() || null,
      status: normalizeIssueStatus(body.status),
      started_at: body.started_at || new Date().toISOString(),
      due_date: safeStr(body.due_date).trim() || null,
    })
    .select('id, unit_stage_id, title, description, priority, assigned_to, status, due_date, started_at, created_at, updated_at')
    .maybeSingle()

  if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })

  let stageReopened = false
  if (stageRow.status === 'done' && normalizeIssueStatus(body.status) !== 'resolved') {
    const { error: reopenError } = await supabaseAdmin
      .from('unit_stages')
      .update({
        status: 'in_progress',
        finished_at: null,
        started_at: stageRow.started_at || new Date().toISOString(),
      })
      .eq('id', stageRow.id)

    if (reopenError) throw Object.assign(new Error(reopenError.message), { statusCode: 400 })
    stageReopened = true
  }

  const unitPatch = await recalculateUnitProgress(unit.id)
  return { issue: data || null, stageReopened, unit: unitPatch }
}

async function handleDeleteIssue(body, profile) {
  const issueId = safeStr(body.issue_id).trim()
  const { data: issue, error: issueError } = await supabaseAdmin
    .from('issues')
    .select('id, unit_id')
    .eq('id', issueId)
    .maybeSingle()

  if (issueError || !issue) throw Object.assign(new Error(issueError?.message || 'Pendencia nao encontrada.'), { statusCode: 404 })
  await getUnitOrThrow(issue.unit_id, profile.tenant_id)

  const { error } = await supabaseAdmin.from('issues').delete().eq('id', issueId)
  if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
  return { deleted: true }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo nao permitido' })
  }

  try {
    const { profile, user } = await requireAdmin(req)
    const action = safeStr(req.body?.action).trim()

    let payload = null
    switch (action) {
      case 'create_project':
        payload = await handleCreateProject(req.body, profile)
        break
      case 'delete_project':
        payload = await handleDeleteProject(req.body, profile)
        break
      case 'create_unit':
        payload = await handleCreateUnit(req.body, profile)
        break
      case 'delete_unit':
        payload = await handleDeleteUnit(req.body, profile)
        break
      case 'copy_unit':
        payload = await handleCopyUnit(req.body, profile)
        break
      case 'create_stage_template':
        payload = await handleCreateStageTemplate(req.body, profile)
        break
      case 'bulk_add_stage_templates':
        payload = await handleBulkAddStageTemplates(req.body, profile)
        break
      case 'apply_stages_to_units_missing_any':
        payload = await handleApplyStagesToUnitsMissingAny(req.body, profile)
        break
      case 'sync_model_to_all_units':
        payload = await handleSyncModelToAllUnits(req.body, profile)
        break
      case 'generate_units_building':
        payload = await handleGenerateUnits(req.body, profile, 'building')
        break
      case 'generate_units_horizontal':
        payload = await handleGenerateUnits(req.body, profile, 'horizontal')
        break
      case 'add_existing_stage_to_unit':
        payload = await handleAddExistingStageToUnit(req.body, profile)
        break
      case 'create_stage_template_and_add_to_unit':
        payload = await handleCreateStageTemplateAndAddToUnit(req.body, profile)
        break
      case 'delete_unit_stage':
        payload = await handleDeleteUnitStage(req.body, profile)
        break
      case 'copy_unit_stage':
        payload = await handleCopyUnitStage({ ...req.body, actor_id: user.id }, profile)
        break
      case 'create_issue':
        payload = await handleCreateIssue({ ...req.body, created_by: user.id }, profile)
        break
      case 'delete_issue':
        payload = await handleDeleteIssue(req.body, profile)
        break
      default:
        throw Object.assign(new Error('Acao administrativa desconhecida.'), { statusCode: 400 })
    }

    return res.status(200).json({ success: true, ...payload })
  } catch (error) {
    return res.status(error?.statusCode || 500).json({
      error: error?.message || 'Erro interno no servidor',
    })
  }
}
