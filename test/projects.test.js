import assert from 'node:assert/strict'
import test from 'node:test'
import { bindSession, configure, delegationIdentity, exposedProject, finishDelegation, projectBusyError } from '../projects.js'

function fixture() {
  return { version: 2, activeProject: 'one', lastDelegatedProject: 'one',
    projects: {
      one: { roots: [{ alias: 'repo', path: '/repo' }], workspace: '/repo', conversationUrl: 'https://chatgpt.com/c/old' },
      two: { roots: [], workspace: null, conversationUrl: null },
    },
    bindings: { session: 'one', other: 'two' },
  }
}
const change = (state, body, pending = [], prepared) => {
  const result = configure(state, body, pending, prepared)
  assert.equal(result.error, undefined)
  return result.state
}

test('creation, workspace, roots and switches are pure project transitions', () => {
  const state = fixture()
  const original = structuredClone(state)
  const roots = [{ alias: 'tmp', path: '/tmp', readonly: true }]
  let next = change(state, { createProject: ' three ', workspace: '/tmp' }, [], { createdRoots: roots })
  assert.equal(next.activeProject, 'three')
  assert.deepEqual(next.projects.three, { roots, workspace: '/tmp', conversationUrl: null })
  next = change(next, { setWorkspace: { project: 'three', workspace: null } })
  assert.equal(next.projects.three.workspace, null)
  assert.deepEqual(next.projects.three.roots, roots)
  next = change(next, { switchTo: 'two', roots: [] }, [], { roots: [] })
  assert.equal(next.activeProject, 'two')
  assert.equal(next.version, 2)
  assert.deepEqual(state, original)
  assert.ok(configure(state, { createProject: 'one' }, []).error)
  assert.ok(configure(state, { createProject: ' ' }, []).error)
  assert.ok(configure(state, { createProject: 'x'.repeat(61) }, []).error)
  assert.ok(configure(state, { setWorkspace: { project: 'one', workspace: 'relative' } }, []).error)
  assert.ok(configure(state, { resetConversation: 'unknown' }, []).error)
})

test('rename and delete update every project reference without mutating the input', () => {
  const state = fixture()
  const renamed = change(state, { renameProject: { from: 'one', to: 'renamed' } })
  assert.equal(renamed.projects.renamed, state.projects.one)
  assert.equal(renamed.projects.one, undefined)
  assert.equal(renamed.activeProject, 'renamed')
  assert.equal(renamed.lastDelegatedProject, 'renamed')
  assert.equal(renamed.bindings.session, 'renamed')
  const deleted = change(renamed, { deleteProject: 'renamed' })
  assert.equal(deleted.activeProject, 'two')
  assert.equal(deleted.lastDelegatedProject, null)
  assert.deepEqual(deleted.bindings, { other: 'two' })
  assert.ok(configure(deleted, { deleteProject: 'two' }, []).error)
  assert.equal(state.bindings.session, 'one')
  assert.equal(state.activeProject, 'one')
})

test('running and queued identities block only their own rename/delete and allow conversation reset', () => {
  const state = fixture()
  const pending = new Set([delegationIdentity(state, 'two')])
  assert.match(projectBusyError('two', pending), /委托/)
  for (const body of [{ deleteProject: 'two' }, { renameProject: { from: 'two', to: 'renamed' } }]) {
    assert.match(configure(state, body, pending).error, /委托/)
  }
  assert.equal(change(state, { renameProject: { from: 'one', to: 'free' } }, pending).activeProject, 'free')
  assert.equal(change(state, { resetConversation: 'two' }, pending).projects.two.conversationUrl, null)
  pending.clear()
  assert.equal(change(state, { renameProject: { from: 'two', to: 'renamed' } }, pending).projects.two, undefined)
})

test('bindings validate, bind and unbind without changing other sessions', () => {
  const state = fixture()
  const bound = bindSession(state, 'new', 'two').state
  assert.equal(bound.bindings.new, 'two')
  assert.equal(bindSession(bound, 'new', null).state.bindings.new, undefined)
  assert.ok(bindSession(state, '', 'one').error)
  assert.ok(bindSession(state, 'new', 'unknown').error)
  assert.ok(bindSession(state, 'new', 'toString').error)
  assert.equal(state.bindings.new, undefined)
})

test('exposure uses the running identity even if its project disappears, never another project', () => {
  const state = fixture()
  const identity = delegationIdentity(state, 'two')
  assert.equal(exposedProject(state, identity), 'two')
  assert.equal(exposedProject(state, null), 'one')
  const removed = change(state, { deleteProject: 'two' })
  assert.equal(exposedProject(removed, identity), 'two')
  assert.equal(exposedProject({ ...state, lastDelegatedProject: 'missing' }, null), 'one')
})

test('conversation CAS preserves resets, changed URLs, deleted projects and unrelated config', () => {
  const state = fixture()
  const identity = delegationIdentity(state, 'one')
  const url = 'https://chatgpt.com/c/new'
  const result = { url, ok: true }
  assert.equal(finishDelegation(state, identity, result).projects.one.conversationUrl, url)
  assert.equal(finishDelegation(state, identity, { url: 'https://chatgpt.com/g/project/c/new', ok: true }).projects.one.conversationUrl, 'https://chatgpt.com/g/project/c/new')
  assert.equal(finishDelegation(change(state, { resetConversation: 'one' }), identity, result).projects.one.conversationUrl, null)
  const changed = { ...state, projects: { ...state.projects, one: { ...state.projects.one, conversationUrl: 'changed' } } }
  assert.equal(finishDelegation(changed, identity, result).projects.one.conversationUrl, 'changed')
  const workspace = change(state, { setWorkspace: { project: 'one', workspace: '/new' } })
  assert.equal(finishDelegation(workspace, identity, result).projects.one.conversationUrl, url)
  const deleted = change(state, { deleteProject: 'one' })
  assert.equal(finishDelegation(deleted, identity, result), deleted)
  assert.equal(finishDelegation(state, identity, { url: 'https://example.com/c/new', ok: true }).projects.one.conversationUrl, identity.conversationUrl)
  assert.equal(state.projects.one.conversationUrl, 'https://chatgpt.com/c/old')
})

test('failed delegations preserve conversation URLs and update the last delegated project', () => {
  const state = fixture()
  const original = structuredClone(state)
  for (const name of ['one', 'two']) {
    for (const ok of [false, undefined, 'true']) {
      const next = finishDelegation(state, delegationIdentity(state, name), { url: 'https://chatgpt.com/c/failed', ok })
      assert.equal(next.projects[name].conversationUrl, state.projects[name].conversationUrl)
      assert.equal(next.lastDelegatedProject, name)
    }
  }
  assert.deepEqual(state, original)
})

test('reset from null wins over a first delegation and adds no persisted fields', () => {
  const state = fixture()
  const identity = delegationIdentity(state, 'two')
  const reset = change(state, { resetConversation: 'two' })
  assert.equal(finishDelegation(reset, identity, { url: 'https://chatgpt.com/c/new', ok: true }).projects.two.conversationUrl, null)
  assert.deepEqual(JSON.parse(JSON.stringify(reset)), state)
})

test('an invalid combined config request cannot partially switch or reset state', () => {
  const state = fixture()
  const original = structuredClone(state)
  const result = configure(state, { switchTo: 'two', resetConversation: 'one', renameProject: { from: 'one', to: 'two' } }, [])
  assert.ok(result.error)
  assert.deepEqual(state, original)
})
