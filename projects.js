/** Pure project transitions. Filesystem validation belongs to the caller. */
import { isAbsolute } from 'node:path'

// Runtime-only reset generation: JSON persistence ignores symbol keys.
const RESET = Symbol('conversationReset')

export const projectOf = (state, name = state.activeProject) => Object.hasOwn(state.projects, name) ? state.projects[name] : undefined

export function projectBusyError(name, pending) {
  if ([...pending].some((identity) => identity.name === name)) return `项目 ${name} 有运行中或排队中的委托，暂时不能改名或删除`
}

export function exposedProject(state, identity) {
  // Never fall through to another project while a delegation owns the MCP scope.
  if (identity) return identity.name
  if (projectOf(state, state.lastDelegatedProject)) return state.lastDelegatedProject
  return state.activeProject
}

export function bindSession(state, session, project) {
  if (typeof session !== 'string' || !session.trim()) return { error: '会话不能为空' }
  if (project !== null && (typeof project !== 'string' || !projectOf(state, project))) return { error: `未知项目：${project}` }
  const bindings = { ...state.bindings }
  if (project === null) delete bindings[session]
  else return { state: { ...state, bindings: { ...bindings, [session]: project } } }
  return { state: { ...state, bindings } }
}

export function configure(state, body, pending, { createdRoots = [], roots } = {}) {
  const next = { ...state, projects: { ...state.projects }, bindings: { ...state.bindings } }
  const set = (name, value) => { next.projects = { ...next.projects, [name]: value } }
  if (typeof body.switchTo === 'string') {
    if (!projectOf(next, body.switchTo)) return { error: `未知项目：${body.switchTo}` }
    next.activeProject = body.switchTo
  }
  if (typeof body.createProject === 'string') {
    const name = body.createProject.trim()
    const error = nameError(name)
    if (error) return { error }
    if (projectOf(next, name)) return { error: `项目已存在：${name}` }
    const workspace = body.workspace ?? null
    const issue = workspaceError(workspace)
    if (issue) return { error: issue }
    set(name, { roots: createdRoots, workspace, conversationUrl: null })
    next.activeProject = name
  }
  if (body.setWorkspace) {
    const { project, workspace } = body.setWorkspace
    if (typeof project !== 'string' || !projectOf(next, project)) return { error: `未知项目：${project}` }
    const error = workspaceError(workspace)
    if (error) return { error }
    set(project, { ...projectOf(next, project), workspace })
  }
  if (typeof body.resetConversation === 'string') {
    const name = body.resetConversation
    const selected = projectOf(next, name)
    if (!selected) return { error: `未知项目：${name}` }
    set(name, { ...selected, conversationUrl: null, [RESET]: (selected[RESET] || 0) + 1 })
  }
  if (typeof body.deleteProject === 'string') {
    const name = body.deleteProject
    if (!projectOf(next, name)) return { error: `未知项目：${name}` }
    const error = projectBusyError(name, pending)
    if (error) return { error }
    if (Object.keys(next.projects).length <= 1) return { error: '至少保留一个项目' }
    delete next.projects[name]
    if (next.lastDelegatedProject === name) next.lastDelegatedProject = null
    for (const session of Object.keys(next.bindings)) {
      if (next.bindings[session] === name) delete next.bindings[session]
    }
    if (next.activeProject === name) next.activeProject = Object.keys(next.projects)[0]
  }
  if (body.renameProject || typeof body.project === 'string') {
    const from = body.renameProject?.from ?? next.activeProject
    const to = body.renameProject ? body.renameProject.to : body.project
    if (typeof from !== 'string' || !projectOf(next, from)) return { error: `未知项目：${from}` }
    if (typeof to !== 'string') return { error: '项目名必须是字符串' }
    const name = to.trim()
    const error = nameError(name) || projectBusyError(from, pending)
    if (error) return { error }
    if (name !== from) {
      if (projectOf(next, name)) return { error: `项目已存在：${name}` }
      set(name, projectOf(next, from))
      delete next.projects[from]
      if (next.activeProject === from) next.activeProject = name
      if (next.lastDelegatedProject === from) next.lastDelegatedProject = name
      for (const session of Object.keys(next.bindings)) {
        if (next.bindings[session] === from) next.bindings[session] = name
      }
    }
  }
  if (roots) set(next.activeProject, { ...projectOf(next), roots })
  return { state: next }
}

function nameError(name) {
  if (!name) return '项目名不能为空'
  if (name.length > 60) return '项目名不能超过 60 个字符'
}

function workspaceError(workspace) {
  if (workspace !== null && (typeof workspace !== 'string' || !isAbsolute(workspace))) return '工作区必须是绝对路径'
}

export function delegationIdentity(state, name) {
  const project = projectOf(state, name)
  if (!project) throw new Error(`未知项目：${name}`)
  return { name, project, conversationUrl: project.conversationUrl, reset: project[RESET] || 0 }
}

export function finishDelegation(state, identity, { url, ok }) {
  const current = projectOf(state, identity.name)
  if (!current) return state
  const next = { ...state, lastDelegatedProject: identity.name }
  if (ok === true && current.conversationUrl === identity.conversationUrl && (current[RESET] || 0) === identity.reset && /^https:\/\/chatgpt\.com\/(?:g\/[^/]+\/)?c\//.test(url)) {
    next.projects = { ...state.projects, [identity.name]: { ...current, conversationUrl: url } }
  }
  return next
}
