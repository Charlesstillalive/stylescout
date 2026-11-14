/**
 * StyleScout asset store.
 *
 * Layout under the data root (dev: plugin/data, prod: $DSH_HOME/style-scout):
 *   index.json                     one metadata source of truth
 *   captures/<capId>/              capture.json, tokens.json, viewport.png, full.png
 *   dna/<dnaId>.json               normalized DNA (versioned)
 *   themes/, exports/, tmp/        reserved for M-4
 *
 * All mutations go through this module so deletion always cascades.
 */
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const SCHEMA = 'style-scout/library@1'
const indexQueues = new Map()
function indexMutation(root,run) {
  const key=path.resolve(root),task=(indexQueues.get(key)||Promise.resolve()).then(run)
  const tail=task.catch(()=>{});indexQueues.set(key,tail)
  tail.finally(()=>{if(indexQueues.get(key)===tail)indexQueues.delete(key)})
  return task
}

/** Resolve the writable data root; STYLE_SCOUT_DATA_DIR wins (tests, dev). */
export function resolveDataRoot(env = process.env) {
  if (typeof env.STYLE_SCOUT_DATA_DIR === 'string' && env.STYLE_SCOUT_DATA_DIR !== '') {
    return env.STYLE_SCOUT_DATA_DIR
  }
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'style-scout')
}

const pad = (n) => String(n).padStart(2, '0')

/** cap_<slug>_<yyyymmddHHMMSS> (seconds keep same-minute re-captures distinct). */
export function captureId(slug, date = new Date()) {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `cap_${slug}_${stamp}`
}

/** dna_<slug>_v<n>, versioned against the existing dna files. */
export async function nextDnaId(root, slug) {
  const dir = path.join(root, 'dna')
  await fs.mkdir(dir, { recursive: true })
  const files = await fs.readdir(dir).catch(() => [])
  const prefix = `dna_${slug}_v`
  let max = 0
  for (const file of files) {
    if (!file.startsWith(prefix) || !file.endsWith('.json')) continue
    const version = Number(file.slice(prefix.length, -5))
    if (Number.isInteger(version) && version > max) max = version
  }
  return `dna_${slug}_v${max + 1}`
}

export async function ensureLayout(root) {
  for (const dir of ['captures', 'dna', 'themes', 'exports', 'tmp']) {
    await fs.mkdir(path.join(root, dir), { recursive: true })
  }
}

export function indexPath(root) {
  return path.join(root, 'index.json')
}

export async function readIndex(root) {
  const file = indexPath(root)
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
    if (parsed && parsed.schema === SCHEMA && Array.isArray(parsed.entries)) return parsed
    throw new Error('unexpected library schema')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { schema: SCHEMA, updatedAt: new Date().toISOString(), entries: [] }
    }
    // Best-effort rebuild from directories; never block startup.
    const rebuilt = await rebuildIndex(root)
    await writeIndex(root, rebuilt)
    return rebuilt
  }
}

export async function writeIndex(root, index) {
  await ensureLayout(root)
  const payload = { ...index, schema: SCHEMA, updatedAt: new Date().toISOString() }
  const tmp = path.join(root, 'tmp', `index-${process.pid}-${Date.now()}.json`)
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
  await fs.rename(tmp, indexPath(root))
  return payload
}

/** Rebuild entries from captures/<capId>/capture.json and dna/<dnaId>.json (best effort). */
export async function rebuildIndex(root) {
  const dnaDir = path.join(root, 'dna')
  const dnaFiles = await fs.readdir(dnaDir).catch(() => [])
  /** slug -> [{ id, version }] sorted by version */
  const dnaBySlug = new Map()
  for (const file of dnaFiles) {
    const match = file.match(/^dna_(.+)_v(\d+)\.json$/)
    if (match === null) continue
    try {
      JSON.parse(await fs.readFile(path.join(dnaDir, file), 'utf8'))
    } catch {
      continue
    }
    const slug = match[1]
    if (!dnaBySlug.has(slug)) dnaBySlug.set(slug, [])
    dnaBySlug.get(slug).push({ id: file.slice(0, -5), version: Number(match[2]) })
  }
  for (const versions of dnaBySlug.values()) versions.sort((a, b) => a.version - b.version)

  const capRoot = path.join(root, 'captures')
  const dirs = await fs.readdir(capRoot).catch(() => [])
  const captures = []
  for (const dir of dirs) {
    const capturePath = path.join(capRoot, dir, 'capture.json')
    if (!fss.existsSync(capturePath)) continue
    try {
      const capture = JSON.parse(await fs.readFile(capturePath, 'utf8'))
      const source = capture.source?.url || ''
      captures.push({
        dir,
        capture,
        source,
        slug: source ? slugifyLite(source) : dir.replace(/^cap_/, '').replace(/_\d+$/, ''),
        createdAt: capture.source?.capturedAt || new Date().toISOString(),
        bytes: await dirSize(path.join(capRoot, dir)),
      })
    } catch {}
  }
  captures.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))

  /* Pair captures with DNA versions per slug in chronological order so a
   * re-captured site keeps version 1 with the older capture. */
  const perSlug = new Map()
  for (const item of captures) perSlug.set(item.slug, (perSlug.get(item.slug) || 0) + 1)
  const usedVersion = new Map()
  const entries = captures.map((item) => {
    const versions = dnaBySlug.get(item.slug) || []
    let dnaIds
    if (perSlug.get(item.slug) === 1) {
      dnaIds = versions.map((version) => version.id)
    } else {
      const index = usedVersion.get(item.slug) || 0
      usedVersion.set(item.slug, index + 1)
      dnaIds = versions[index] === undefined ? [] : [versions[index].id]
    }
    return {
      id: item.dir,
      kind: item.capture.uiKind || 'capture',
      name: item.capture.meta?.title || item.source || item.dir,
      source: item.source,
      editableUi: item.capture.editableUi || null,
      tags: [],
      cover: `captures/${item.dir}/viewport.png`,
      dnaIds,
      themeIds: [],
      bytes: item.bytes,
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
    }
  })
  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return { schema: SCHEMA, updatedAt: new Date().toISOString(), entries }
}

function slugifyLite(url) {
  try {
    const u = new URL(url)
    return (u.hostname + u.pathname).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'site'
  } catch {
    return 'site'
  }
}

export async function dirSize(dir) {
  let total = 0
  const walk = async (current) => {
    const items = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const item of items) {
      const full = path.join(current, item.name)
      if (item.isDirectory()) await walk(full)
      else {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) total += stat.size
      }
    }
  }
  await walk(dir)
  return total
}

export async function listEntries(root) {
  const index = await readIndex(root)
  return index.entries
}

export async function getEntry(root, id) {
  const entries = await listEntries(root)
  return entries.find((entry) => entry.id === id)
}

/** Insert or replace one entry (index.json is the single metadata source). */
export async function upsertEntry(root, entry) {
  return indexMutation(root,async()=>{
  const index = await readIndex(root)
  const entries = index.entries.filter((item) => item.id !== entry.id)
  entries.push(entry)
  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  await writeIndex(root, { ...index, entries })
  return entry
  })
}

export async function updateEntry(root, id, patch) {
  return indexMutation(root,async()=>{
  const index = await readIndex(root)
  const entry = index.entries.find((item) => item.id === id)
  if (entry === undefined) return undefined
  Object.assign(entry, patch, { updatedAt: new Date().toISOString() })
  await writeIndex(root, index)
  return entry
  })
}

/**
 * Delete an entry and every file it owns (capture dir, DNA versions, themes).
 * @returns {{removed:boolean, files:string[]}}
 */
export async function deleteEntry(root, id) {
  return indexMutation(root,async()=>{
  const index = await readIndex(root)
  const entry = index.entries.find((item) => item.id === id)
  if (entry === undefined) return { removed: false, files: [] }

  const files = []
  const capDir = path.join(root, 'captures', entry.id)
  await fs.rm(capDir, { recursive: true, force: true })
  files.push(capDir)

  for (const dnaId of entry.dnaIds || []) {
    const dnaPath = path.join(root, 'dna', `${dnaId}.json`)
    await fs.rm(dnaPath, { force: true })
    files.push(dnaPath)
  }
  for (const themeId of entry.themeIds || []) {
    const themePath = path.join(root, 'themes', `${themeId}.json`)
    await fs.rm(themePath, { force: true })
    files.push(themePath)
  }

  index.entries = index.entries.filter((item) => item.id !== id)
  await writeIndex(root, index)
  return { removed: true, files }
  })
}

/** Save capture files already written under captures/<capId> plus its DNA. */
export async function saveCapture(root, { capId, slug, url, capture, dna, dnaId }) {
  const capDir = path.join(root, 'captures', capId)
  const dnaFile = path.join(root, 'dna', `${dnaId}.json`)
  await fs.writeFile(dnaFile, JSON.stringify(dna, null, 2), 'utf8')
  const createdAt = capture.source?.capturedAt || new Date().toISOString()
  const entry = {
    id: capId,
    kind: 'capture',
    name: (dna.meta?.name || capture.meta?.title || url).slice(0, 80),
    source: url,
    editableUi: capture.editableUi || null,
    tags: [],
    favorite: false,
    cover: `captures/${capId}/viewport.png`,
    dnaIds: [dnaId],
    themeIds: [],
    bytes: await dirSize(capDir),
    createdAt,
    updatedAt: createdAt,
  }
  await upsertEntry(root, entry)
  return entry
}

/* ---------------- saved themes (V2-5) ---------------- */

function themesDir(root) {
  return path.join(root, 'themes')
}

export async function readThemeIndex(root) {
  try {
    const raw = await fs.readFile(path.join(themesDir(root), 'index.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.themes) ? parsed : { themes: [] }
  } catch {
    return { themes: [] }
  }
}

async function writeThemeIndex(root, index) {
  await fs.mkdir(themesDir(root), { recursive: true })
  await fs.writeFile(path.join(themesDir(root), 'index.json'), JSON.stringify(index, null, 2), 'utf8')
}

export async function getTheme(root, id) {
  try {
    return JSON.parse(await fs.readFile(path.join(themesDir(root), `${id}.json`), 'utf8'))
  } catch {
    return undefined
  }
}

/** All themes with their full payload (theme counts stay small). */
export async function listThemes(root) {
  const index = await readThemeIndex(root)
  const themes = []
  for (const summary of index.themes) {
    const theme = await getTheme(root, summary.id)
    if (theme !== undefined) themes.push(theme)
  }
  return themes
}

/**
 * Save or re-save a theme. Re-saving the same name keeps up to five historical
 * versions (each version is the previous payload).
 */
export async function saveTheme(root, { name, tokens, colorMap, sourceEntryId }) {
  const cleanName = String(name || '').trim().slice(0, 60)
  if (cleanName === '') throw new Error('theme name required')
  const index = await readThemeIndex(root)
  const now = new Date().toISOString()
  const existing = index.themes.find((item) => item.name === cleanName)
  let theme
  if (existing !== undefined) {
    const current = await getTheme(root, existing.id)
    const versions = current === undefined
      ? []
      : [{ at: current.updatedAt, tokens: current.tokens, colorMap: current.colorMap || {} }, ...(current.versions || [])].slice(0, 5)
    theme = {
      id: existing.id,
      name: cleanName,
      createdAt: current?.createdAt || now,
      updatedAt: now,
      sourceEntryId: sourceEntryId || current?.sourceEntryId || null,
      tokens,
      colorMap: colorMap || {},
      versions,
    }
    existing.updatedAt = now
    existing.versions = versions.length
  } else {
    const id = 'theme_' + Date.now().toString(36)
    theme = { id, name: cleanName, createdAt: now, updatedAt: now, sourceEntryId: sourceEntryId || null, tokens, colorMap: colorMap || {}, versions: [] }
    index.themes.push({ id, name: cleanName, updatedAt: now, versions: 0 })
  }
  await fs.mkdir(themesDir(root), { recursive: true })
  await fs.writeFile(path.join(themesDir(root), `${theme.id}.json`), JSON.stringify(theme, null, 2), 'utf8')
  await writeThemeIndex(root, index)
  return theme
}

/** Restore a historical version (pushing the current payload into history). */
export async function restoreThemeVersion(root, id, versionIndex = 0) {
  const current = await getTheme(root, id)
  if (current === undefined) return undefined
  const versions = current.versions || []
  const snapshot = versions[versionIndex]
  if (snapshot === undefined) return undefined
  const now = new Date().toISOString()
  const theme = {
    ...current,
    updatedAt: now,
    tokens: snapshot.tokens,
    colorMap: snapshot.colorMap || {},
    versions: [{ at: current.updatedAt, tokens: current.tokens, colorMap: current.colorMap || {} }, ...versions].slice(0, 5),
  }
  await fs.writeFile(path.join(themesDir(root), `${id}.json`), JSON.stringify(theme, null, 2), 'utf8')
  return theme
}

export async function deleteTheme(root, id) {
  const index = await readThemeIndex(root)
  index.themes = index.themes.filter((item) => item.id !== id)
  await writeThemeIndex(root, index)
  await fs.rm(path.join(themesDir(root), `${id}.json`), { force: true })
  return true
}

/* ---------------- data-root backups ---------------- */

/**
 * Copy index/dna/captures/themes/templates/layouts into backups/<id>/ and write
 * a manifest. Exports and previous backups are skipped.
 */
export async function createBackup(root) {
  const id = 'backup_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const dir = path.join(root, 'backups', id)
  const skip = new Set(['backups', 'exports', 'standalone.lock'])
  const copied = []
  await fs.mkdir(dir, { recursive: true })
  for (const name of await fs.readdir(root)) {
    if (skip.has(name)) continue
    const source = path.join(root, name)
    if (!fss.existsSync(source)) continue
    await fs.cp(source, path.join(dir, name), { recursive: true })
    copied.push(name)
  }
  const entries = await listEntries(root)
  const themes = await listThemes(root)
  const sizeBytes = await dirSize(dir)
  const manifest = {
    schema: 'style-scout/backup@1',
    id,
    createdAt: new Date().toISOString(),
    copied,
    entries: entries.map((entry) => ({ id: entry.id, name: entry.name, tags: entry.tags || [], favorite: entry.favorite === true })),
    themes: themes.map((theme) => ({ id: theme.id, name: theme.name })),
    sizeBytes,
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return { id, dir, copied, sizeBytes, entries: manifest.entries.length, themes: manifest.themes.length }
}

export async function listBackups(root) {
  const backupsRoot = path.join(root, 'backups')
  const backups = []
  if (!fss.existsSync(backupsRoot)) return backups
  for (const name of fss.readdirSync(backupsRoot)) {
    const manifestPath = path.join(backupsRoot, name, 'manifest.json')
    if (!fss.existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
      backups.push({
        id: manifest.id,
        createdAt: manifest.createdAt,
        sizeBytes: manifest.sizeBytes,
        entries: (manifest.entries || []).length,
        themes: (manifest.themes || []).length,
      })
    } catch { /* skip unreadable backup */ }
  }
  backups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return backups
}
