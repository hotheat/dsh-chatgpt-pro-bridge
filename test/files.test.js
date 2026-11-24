import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  addRoot,
  describeRoots,
  normalizeRoots,
  readFile,
  registerRoot,
  registerRoots,
  removeRoot,
  resolveRoot,
  search,
} from '../files.js'

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-files-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const base = await realpath(temporary)
  const rootPath = join(base, 'root')
  const outside = join(base, 'root-sibling')
  await mkdir(rootPath)
  await mkdir(outside)
  const registered = registerRoot({ alias: 'workspace', path: rootPath })
  assert.equal(registered.error, undefined)
  return { base, rootPath, outside, roots: [registered.root] }
}

function denied(result, code) {
  assert.equal(result.code, code)
  assert.equal(typeof result.error, 'string')
  assert.equal(Object.hasOwn(result, 'text'), false)
}

test('registration validates directories, aliases and canonical readonly roots', async (t) => {
  const { rootPath, outside } = await fixture(t)
  const inputs = [{ alias: 'first', path: rootPath }, { alias: 'second', path: outside }]
  const original = structuredClone(inputs)
  assert.deepEqual(registerRoots(inputs), {
    roots: inputs.map((root) => ({ ...root, readonly: true })),
  })
  assert.ok(registerRoots([...inputs, inputs[0]]).error)
  assert.ok(registerRoots([...inputs, { alias: 'missing', path: join(rootPath, 'missing') }]).error)
  assert.ok(registerRoot({ alias: '', path: rootPath }).error)
  assert.ok(registerRoot({ alias: 'empty', path: '   ' }).error)
  assert.ok(registerRoot({ alias: 'missing' }).error)
  await writeFile(join(rootPath, 'file.txt'), 'file')
  assert.ok(registerRoot({ alias: 'file', path: join(rootPath, 'file.txt') }).error)
  assert.deepEqual(inputs, original)
})

test('registration expands home shorthand without writing to the home directory', async () => {
  const expected = { root: { alias: 'home', path: await realpath(homedir()), readonly: true } }
  assert.deepEqual(registerRoot({ alias: 'home', path: '~' }), expected)
  assert.deepEqual(registerRoot({ alias: 'home', path: '~/.' }), expected)
})

test('restoring unavailable roots preserves them without granting reads', async (t) => {
  const { rootPath } = await fixture(t)
  const missing = join(rootPath, 'missing')
  const roots = normalizeRoots([{ alias: 'offline', path: missing, readonly: true }])
  assert.deepEqual(roots, [{ alias: 'offline', path: missing, readonly: true }])
  assert.deepEqual(describeRoots(roots), [{ alias: 'offline', path: missing, readonly: true, exists: false }])
  denied(readFile(roots, { path: 'notes.txt' }), 'ENOENT')
  assert.deepEqual(search(roots, { pattern: 'needle' }), {
    pattern: 'needle', scannedFiles: 0, count: 0, truncated: false, matches: [],
  })
})

test('addRoot replaces an alias at the end and removal preserves other roots', async (t) => {
  const { rootPath, outside } = await fixture(t)
  const initial = registerRoots([
    { alias: 'first', path: rootPath },
    { alias: 'second', path: outside },
  ]).roots
  const original = structuredClone(initial)
  const added = addRoot(initial, { alias: 'first', path: outside })
  assert.equal(added.error, undefined)
  assert.deepEqual(added.roots.map((root) => root.alias), ['second', 'first'])
  assert.equal(added.roots[1].path, await realpath(outside))
  assert.deepEqual(initial, original)
  assert.deepEqual(removeRoot(added.roots, 'second').roots, [added.roots[1]])
  assert.equal(added.roots.length, 2)
  assert.ok(removeRoot(initial, 'missing').error)
  assert.ok(addRoot(initial, { alias: 'first', path: join(rootPath, 'missing') }).error)
  assert.deepEqual(initial, original)
})

test('readFile returns numbered UTF-8 lines and an inclusive requested range', async (t) => {
  const { rootPath, roots } = await fixture(t)
  await writeFile(join(rootPath, 'notes.txt'), '第一行\r\n第二行\r\n第三行')
  assert.deepEqual(readFile(roots, { root: 'workspace', path: 'notes.txt', start: 2, end: 3 }), {
    root: 'workspace',
    path: 'notes.txt',
    start: 2,
    end: 3,
    totalLines: 3,
    text: '2\t第二行\n3\t第三行',
  })
  assert.ok(readFile(roots, { root: 'unknown', path: 'notes.txt' }).error)
  assert.deepEqual(readFile(roots, { path: '.' }), { error: '不是文件' })
})

test('readFile rejects sibling paths and file or directory symlink escapes', async (t) => {
  const { rootPath, outside, roots } = await fixture(t)
  await writeFile(join(outside, 'plain.txt'), 'outside content')
  await symlink(join(outside, 'plain.txt'), join(rootPath, 'file-link.txt'), 'file')
  await symlink(outside, join(rootPath, 'directory-link'), 'dir')
  for (const path of [
    '../root-sibling/plain.txt',
    join(outside, 'plain.txt'),
    'file-link.txt',
    'directory-link/plain.txt',
  ]) {
    denied(readFile(roots, { path }), 'OUTSIDE_ROOT')
  }
})

test('readFile reports ENOENT for a missing file inside an authorized root', async (t) => {
  const { roots } = await fixture(t)
  assert.deepEqual(readFile(roots, { path: 'missing.txt' }), { error: 'missing.txt 不存在', code: 'ENOENT' })
})

test('readFile rejects sensitive original filenames, even when missing', async (t) => {
  const { rootPath, roots } = await fixture(t)
  denied(readFile(roots, { path: '.env.missing' }), 'DENIED_SENSITIVE')
  for (const name of [
    '.env', '.env.local', 'id_rsa', 'certificate.pem',
    'secret.key', '.netrc', '.npmrc', 'credentials.json',
  ]) {
    await writeFile(join(rootPath, name), 'sensitive content')
    denied(readFile(roots, { path: name }), 'DENIED_SENSITIVE')
  }
})

test('readFile checks a symlink name before resolving and gives outside-root targets priority', async (t) => {
  const { rootPath, outside, roots } = await fixture(t)
  await writeFile(join(rootPath, 'public.txt'), 'public content')
  await writeFile(join(rootPath, '.env'), 'inside secret')
  await writeFile(join(outside, '.env'), 'outside secret')
  await symlink(join(rootPath, 'public.txt'), join(rootPath, '.env.public'), 'file')
  await symlink(join(rootPath, '.env'), join(rootPath, 'inside-alias.txt'), 'file')
  await symlink(join(outside, '.env'), join(rootPath, 'outside-alias.txt'), 'file')
  denied(readFile(roots, { path: '.env.public' }), 'DENIED_SENSITIVE')
  denied(readFile(roots, { path: 'inside-alias.txt' }), 'DENIED_SENSITIVE')
  denied(readFile(roots, { path: 'outside-alias.txt' }), 'OUTSIDE_ROOT')
})

test('readFile rejects sensitive directory components and symlinks to their files', async (t) => {
  const { rootPath, roots } = await fixture(t)
  for (const [directory, name] of [['credentials', 'token.txt'], ['.env.backup', 'config.txt']]) {
    await mkdir(join(rootPath, directory))
    await writeFile(join(rootPath, directory, name), 'SECRET')
    await symlink(join(rootPath, directory, name), join(rootPath, name + '.link'), 'file')
    await symlink(join(rootPath, directory), join(rootPath, name + '.directory'), 'dir')
    for (const path of [join(directory, name), name + '.link', join(name + '.directory', name)]) {
      denied(readFile(roots, { path }), 'DENIED_SENSITIVE')
    }
  }
  await mkdir(join(rootPath, 'normal'))
  await writeFile(join(rootPath, 'normal', 'notes.txt'), 'public note')
  assert.equal(readFile(roots, { path: 'normal/notes.txt' }).text, '1\tpublic note')
})

test('search skips sensitive directories and keeps ordinary directory matches', async (t) => {
  const { rootPath, roots } = await fixture(t)
  for (const [directory, name] of [['credentials', 'token.txt'], ['.env.backup', 'config.txt']]) {
    await mkdir(join(rootPath, directory))
    await writeFile(join(rootPath, directory, name), 'SECRET')
  }
  await mkdir(join(rootPath, 'normal'))
  await writeFile(join(rootPath, 'normal', 'notes.txt'), 'public note')
  const secret = search(roots, { pattern: 'SECRET' })
  assert.equal(secret.count, 0)
  assert.equal(secret.scannedFiles, 1)
  assert.deepEqual(secret.matches, [])
  assert.deepEqual(search(roots, { pattern: 'public note' }).matches, [
    { root: 'workspace', path: 'normal/notes.txt', line: 1, text: 'public note' },
  ])
})

test('readFile and search ignore sensitive names in the root and its ancestors', async (t) => {
  const { base } = await fixture(t)
  const rootPath = join(base, 'credentials-parent', '.env.backup')
  await mkdir(join(rootPath, 'normal'), { recursive: true })
  await writeFile(join(rootPath, 'normal', 'notes.txt'), 'public note')
  const roots = [registerRoot({ alias: 'workspace', path: rootPath }).root]
  assert.equal(readFile(roots, { path: 'normal/notes.txt' }).text, '1\tpublic note')
  assert.equal(readFile(roots, { path: join(rootPath, 'normal', 'notes.txt') }).text, '1\tpublic note')
  assert.deepEqual(search(roots, { pattern: 'public note' }).matches, [
    { root: 'workspace', path: 'normal/notes.txt', line: 1, text: 'public note' },
  ])
})

test('canonical and legacy symlink roots read and resolve files correctly', async (t) => {
  const { base, rootPath } = await fixture(t)
  const linkedPath = join(base, 'linked-root')
  await writeFile(join(rootPath, 'notes.txt'), 'hello')
  await symlink(rootPath, linkedPath, 'dir')
  const canonical = registerRoot({ alias: 'linked', path: linkedPath }).root
  assert.deepEqual(canonical, { alias: 'linked', path: await realpath(rootPath), readonly: true })
  const legacy = { alias: 'linked', path: linkedPath, readonly: true }
  assert.deepEqual(normalizeRoots([legacy]), [canonical])
  for (const root of [canonical, legacy]) {
    assert.deepEqual(readFile([root], { path: 'notes.txt' }), {
      root: 'linked', path: 'notes.txt', start: 1, end: 1, totalLines: 1, text: '1\thello',
    })
    assert.deepEqual(describeRoots([root]), [{ ...canonical, exists: true }])
    for (const path of [join(linkedPath, 'notes.txt'), join(rootPath, 'notes.txt')]) {
      assert.equal(readFile([root], { path }).text, '1\thello')
      const resolved = resolveRoot([root], { path })
      assert.equal(resolved.found, true)
      assert.equal(resolved.root, 'linked')
      assert.equal(resolved.relative, 'notes.txt')
    }
  }
})

test('resolveRoot preserves longest-root selection and the existing result shape', async (t) => {
  const { rootPath, outside, roots } = await fixture(t)
  const nestedPath = join(rootPath, 'nested')
  await mkdir(nestedPath)
  await writeFile(join(nestedPath, 'item.txt'), 'item')
  const nested = registerRoot({ alias: 'nested', path: nestedPath }).root
  const registered = [...roots, nested]
  const expected = { found: true, root: 'nested', path: nestedPath, relative: 'item.txt' }
  assert.deepEqual(resolveRoot(registered, { path: join(nestedPath, 'item.txt') }), expected)
  assert.deepEqual(resolveRoot(registered, { path: 'item.txt' }), expected)
  const unowned = join(outside, 'missing.txt')
  assert.deepEqual(resolveRoot(registered, { path: unowned }), { found: false, path: unowned })
})

test('search skips sensitive files and every symlink, including harmless aliases', async (t) => {
  const { rootPath, outside, roots } = await fixture(t)
  for (const name of ['public.txt', '.env', 'credentials.json', 'id_rsa']) {
    await writeFile(join(rootPath, name), 'needle')
  }
  await writeFile(join(outside, 'outside.txt'), 'needle')
  await symlink(join(rootPath, 'public.txt'), join(rootPath, 'public-alias.txt'), 'file')
  await symlink(join(rootPath, '.env'), join(rootPath, 'private-alias.txt'), 'file')
  await symlink(outside, join(rootPath, 'directory-link'), 'dir')
  assert.equal(readFile(roots, { path: 'public-alias.txt' }).text, '1\tneedle')
  assert.deepEqual(search(roots, { pattern: 'needle' }), {
    pattern: 'needle',
    scannedFiles: 1,
    count: 1,
    truncated: false,
    matches: [{ root: 'workspace', path: 'public.txt', line: 1, text: 'needle' }],
  })
})

test('search accepts legacy symlink roots and skips sensitive files', async (t) => {
  const { base, rootPath } = await fixture(t)
  const linkedPath = join(base, 'legacy-root')
  await writeFile(join(rootPath, 'visible.txt'), 'needle')
  await writeFile(join(rootPath, 'credentials.json'), 'needle')
  await symlink(rootPath, linkedPath, 'dir')
  const result = search([{ alias: 'legacy', path: linkedPath, readonly: true }], { pattern: 'needle' })
  assert.equal(result.count, 1)
  assert.deepEqual(result.matches, [{ root: 'legacy', path: 'visible.txt', line: 1, text: 'needle' }])
})

test('readFile accepts 512 KiB and preserves the oversize error', async (t) => {
  const { rootPath, roots } = await fixture(t)
  await writeFile(join(rootPath, 'limit.txt'), 'x'.repeat(512 * 1024))
  await writeFile(join(rootPath, 'large.txt'), 'x'.repeat(512 * 1024 + 1))
  const accepted = readFile(roots, { path: 'limit.txt' })
  assert.equal(accepted.error, undefined)
  assert.equal(accepted.text.length, 512 * 1024 + 2)
  assert.deepEqual(readFile(roots, { path: 'large.txt' }), { error: '文件过大（524289 字节），上限 512 KiB' })
})

test('search accepts 256 KiB, skips larger files and caps matching text', async (t) => {
  const { rootPath, roots } = await fixture(t)
  await writeFile(join(rootPath, 'limit.txt'), 'needle' + 'x'.repeat(256 * 1024 - 6))
  await writeFile(join(rootPath, 'large.txt'), 'needle' + 'x'.repeat(256 * 1024 - 5))
  const result = search(roots, { pattern: 'needle' })
  assert.equal(result.scannedFiles, 1)
  assert.equal(result.count, 1)
  assert.equal(result.matches[0].path, 'limit.txt')
  assert.equal(result.matches[0].text.length, 240)
})

test('search preserves result limits and rejects invalid patterns or unknown roots', async (t) => {
  const { rootPath, roots } = await fixture(t)
  await writeFile(join(rootPath, 'matches.txt'), Array.from({ length: 120 }, () => 'needle').join('\n'))
  const first = search(roots, { pattern: 'needle' })
  assert.deepEqual([first.count, first.truncated], [40, true])
  assert.equal(search(roots, { pattern: 'needle', maxResults: 200 }).count, 100)
  assert.ok(search(roots, { pattern: '[' }).error)
  assert.ok(search(roots, { pattern: 'needle', root: 'unknown' }).error)
})

test('readFile preserves default pagination, the 400-line cap and EOF semantics', async (t) => {
  const { rootPath, roots } = await fixture(t)
  await writeFile(join(rootPath, 'lines.txt'), Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n'))
  const read = (args = {}) => readFile(roots, { path: 'lines.txt', ...args })
  const first = read()
  assert.deepEqual([first.start, first.end, first.totalLines], [1, 200, 450])
  assert.equal(first.text.split('\n').length, 200)
  assert.equal(first.text.split('\n').at(-1), '200\tline 200')
  const capped = read({ start: 2, end: 999 })
  assert.deepEqual([capped.start, capped.end, capped.totalLines], [2, 401, 450])
  assert.equal(capped.text.split('\n').length, 400)
  assert.equal(capped.text.split('\n')[0], '2\tline 2')
  assert.equal(capped.text.split('\n').at(-1), '401\tline 401')
  const tail = read({ start: 449, end: 999 })
  assert.deepEqual([tail.start, tail.end, tail.text], [449, 450, '449\tline 449\n450\tline 450'])
  const reversed = read({ start: 5, end: 2 })
  assert.deepEqual([reversed.start, reversed.end, reversed.text], [5, 5, '5\tline 5'])
  const beyond = read({ start: 451, end: 999 })
  assert.deepEqual([beyond.start, beyond.end, beyond.text], [451, 450, ''])
  assert.equal(read({ start: -3, end: 1 }).text, '1\tline 1')
})

test('readFile preserves trailing empty lines and the existing empty-file result', async (t) => {
  const { rootPath, roots } = await fixture(t)
  await writeFile(join(rootPath, 'trailing.txt'), 'one\r\ntwo\r\n')
  await writeFile(join(rootPath, 'empty.txt'), '')
  const trailing = readFile(roots, { path: 'trailing.txt' })
  assert.deepEqual([trailing.start, trailing.end, trailing.totalLines, trailing.text], [1, 3, 3, '1\tone\n2\ttwo\n3\t'])
  const empty = readFile(roots, { path: 'empty.txt' })
  assert.deepEqual([empty.start, empty.end, empty.totalLines, empty.text], [1, 1, 1, '1\t'])
})
