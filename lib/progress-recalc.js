function safeStr(value) {
  return (value ?? '').toString()
}

async function callRpc(client, fn, args) {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw Object.assign(new Error(error.message), { statusCode: 400 })
  return data || null
}

export async function recalculateProjectProgress(client, projectId) {
  const id = safeStr(projectId).trim()
  if (!id) return null
  return callRpc(client, 'recalculate_project_progress', { p_project_id: id })
}

export async function recalculateUnitAndProjectProgress(client, unitId) {
  const id = safeStr(unitId).trim()
  if (!id) return null
  return callRpc(client, 'recalculate_unit_and_project_progress', { p_unit_id: id })
}

export async function recalculateUnitsAndProjects(client, unitIds) {
  const uniqueUnitIds = [...new Set((Array.isArray(unitIds) ? unitIds : []).map((value) => safeStr(value).trim()).filter(Boolean))]
  const unitResults = []
  const projectById = new Map()

  for (const unitId of uniqueUnitIds) {
    const result = await recalculateUnitAndProjectProgress(client, unitId)
    if (!result) continue
    unitResults.push(result.unit || null)

    const project = result.project || null
    const projectId = safeStr(project?.project_id).trim()
    if (projectId) projectById.set(projectId, project)
  }

  return {
    units: unitResults.filter(Boolean),
    projects: [...projectById.values()],
  }
}
