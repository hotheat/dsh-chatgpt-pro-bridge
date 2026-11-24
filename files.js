import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.idea', '.cache'])
const SENSITIVE = [/^\.env/i, /^id_rsa/, /\.pem$/i, /\.key$/i, /^\.netrc$/, /^\.npmrc$/, /^credentials/i]

function expandedPath(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('路径不能为空')
  const input = value.trim()
  return resolve(input === '~' || input.startsWith('~/') ? homedir() + input.slice(1) : input)
}

// Keep unavailable saved roots visible; reads still require a successful realpath.
export function normalizePath(value) {
  if (typeof value !== 'string' || !value.trim()) return value
  const path = expandedPath(value)
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export function normalizeRoots(roots) {
  return roots.map((root) => ({ ...root, path: normalizePath(root.path) }))
}

export function registerRoot(input) {
  const alias = String(input?.alias || '').trim()
  if (!alias) return { error: '别名不能为空' }
  if (typeof input?.path !== 'string' || !input.path.trim()) return { error: '路径不能为空' }
  const path = expandedPath(input?.path)
  try {
    const real = realpathSync(path)
    if (statSync(real).isDirectory()) return { root: { alias, path: real, readonly: true } }
  } catch {
    // Missing or inaccessible directories cannot be newly registered.
  }
  return { error: `不是已存在的目录：${path}` }
}

export function registerRoots(inputs) {
  const roots = []
  for (const input of inputs) {
    const alias = String(input?.alias || '').trim()
    if (roots.some((root) => root.alias === alias)) return { error: `别名重复：${alias}` }
    const result = registerRoot(input)
    if (result.error) return result
    roots.push(result.root)
  }
  return { roots }
}

export function addRoot(roots, input) {
  const result = registerRoot(input)
  if (result.error) return result
  return { roots: [...roots.filter((root) => root.alias !== result.root.alias), result.root] }
}

export function removeRoot(roots, alias) {
  if (typeof alias !== 'string' || !roots.some((root) => root.alias === alias)) return { error: `未知文件夹：${alias}` }
  return { roots: roots.filter((root) => root.alias !== alias) }
}

export function describeRoots(roots) {
  return normalizeRoots(roots).map((root) => ({
    alias: root.alias,
    path: root.path,
    readonly: root.readonly !== false,
    exists: existsSync(root.path),
  }))
}

function within(base, target) {
  const prefix = base.endsWith(sep) ? base : base + sep
  return target === base || target.startsWith(prefix)
}

function isSensitive(path) {
  return path.split(sep).some((component) => SENSITIVE.some((pattern) => pattern.test(component)))
}

export function resolveRoot(roots, args) {
  const wanted = String(args?.path || '')
  const absolute = wanted.startsWith('/') ? normalizePath(wanted) : null
  const matches = normalizeRoots(roots)
    .filter((root) => (absolute ? within(root.path, absolute) : true))
    .map((root) => ({ root, length: root.path.length }))
    .sort((a, b) => b.length - a.length)
  if (!matches.length) return { found: false, path: wanted }
  const { root } = matches[0]
  return { found: true, root: root.alias, path: root.path, relative: absolute ? relative(root.path, absolute) : wanted }
}

function resolveReadable(root, requested) {
  const denied = () => ({ error: '该文件属于敏感文件，已拒绝读取', code: 'DENIED_SENSITIVE' })
  if (isSensitive(basename(requested))) return denied()
  let base, path
  try {
    base = realpathSync(expandedPath(root.path))
    path = realpathSync(resolve(base, requested))
  } catch {
    return { error: `${requested} 不存在`, code: 'ENOENT' }
  }
  if (!within(base, path)) return { error: `${requested} 不在 ${root.path} 内`, code: 'OUTSIDE_ROOT' }
  if (isSensitive(relative(base, path))) return denied()
  return { base, path }
}

function readText(root, requested, limit) {
  const resolved = resolveReadable(root, requested)
  if (resolved.error) return resolved
  const stats = statSync(resolved.path)
  if (!stats.isFile()) return { error: '不是文件' }
  if (stats.size > limit) return { error: `文件过大（${stats.size} 字节），上限 ${limit / 1024} KiB` }
  return { path: relative(resolved.base, resolved.path), text: readFileSync(resolved.path, 'utf8') }
}

export function readFile(roots, args) {
  const root = args?.root ? roots.find((candidate) => candidate.alias === args.root) : roots[0]
  if (!root) return { error: `未知 root：${args?.root}` }
  const result = readText(root, String(args?.path || ''), 512 * 1024)
  if (result.error) return result
  const lines = result.text.split(/\r?\n/)
  const start = Math.max(1, Number(args?.start) || 1)
  const end = Math.min(lines.length, Math.max(start, Number(args?.end) || start + 199), start + 399)
  return {
    root: root.alias,
    path: result.path,
    start,
    end,
    totalLines: lines.length,
    text: lines.slice(start - 1, end).map((line, index) => `${start + index}\t${line}`).join('\n'),
  }
}

export function search(roots, args) {
  let expression
  try {
    expression = new RegExp(String(args?.pattern || ''))
  } catch (error) {
    return { error: `正则无效：${error.message}` }
  }
  const selected = args?.root ? roots.filter((root) => root.alias === args.root) : roots
  if (!selected.length) return { error: `未知 root：${args?.root}` }
  const limit = Math.min(100, Math.max(1, Number(args?.maxResults) || 40))
  const matches = []
  let scanned = 0

  const walk = (root, base, current, depth) => {
    if (matches.length >= limit || depth > 8 || scanned > 4000) return
    let entries
    try {
      const actual = realpathSync(current)
      if (!within(base, actual)) return
      entries = readdirSync(actual, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (matches.length >= limit || scanned > 4000) return
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const full = join(current, entry.name)
      if (isSensitive(relative(base, full))) continue
      if (entry.isDirectory()) {
        walk(root, base, full, depth + 1)
        continue
      }
      // Keep skipping symbolic links, including links to ordinary files.
      if (!entry.isFile()) continue
      let result
      try {
        result = readText(root, relative(base, full), 256 * 1024)
      } catch {
        continue
      }
      if (result.error) continue
      scanned += 1
      const lines = result.text.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        if (expression.test(lines[index])) {
          matches.push({ root: root.alias, path: result.path, line: index + 1, text: lines[index].slice(0, 240) })
          if (matches.length >= limit) return
        }
      }
    }
  }

  for (const root of selected) {
    let base
    try {
      base = realpathSync(expandedPath(root.path))
    } catch {
      continue
    }
    walk({ ...root, path: base }, base, base, 0)
  }
  return { pattern: args.pattern, scannedFiles: scanned, count: matches.length, truncated: matches.length >= limit, matches }
}
