import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const queues = new Map()
const fileOf = (root) => path.join(root, 'drafts', 'current.json')

export async function readDraft(root) {
  try {
    const value = JSON.parse(await fs.readFile(fileOf(root), 'utf8'))
    if (value.schema !== 'style-scout/draft@1' || !Number.isInteger(value.revision) || !value.draft || !Array.isArray(value.draft.regions) || !['regions', 'template', 'free'].includes(value.draft.mode)) throw new Error('草稿文件损坏，请从备份恢复')
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 'style-scout/draft@1', revision: 0, draft: null }
    throw error
  }
}

export function saveDraft(root, { draft, baseRevision, operationId }) {
  const key = path.resolve(root)
  const job = (queues.get(key) || Promise.resolve()).then(async () => {
    if (!draft || typeof draft !== 'object' || !Array.isArray(draft.regions) || !['regions', 'template', 'free'].includes(draft.mode) || !Number.isInteger(baseRevision) || baseRevision < 0 || typeof operationId !== 'string' || !operationId || operationId.length > 100) {
      throw Object.assign(new Error('草稿格式不正确'), { status: 400 })
    }
    const current = await readDraft(root)
    if (current.operationId === operationId) return current
    if (current.revision !== baseRevision) throw Object.assign(new Error('另一窗口已保存更新，请先处理版本冲突'), { status: 409 })
    const next = { schema: 'style-scout/draft@1', revision: current.revision + 1, savedAt: new Date().toISOString(), operationId, draft }
    const dir = path.dirname(fileOf(root))
    await fs.mkdir(dir, { recursive: true })
    // A recoverable previous version accompanies the current draft in backups.
    if (current.draft) await fs.copyFile(fileOf(root), path.join(dir, 'previous.json'))
    const temp = path.join(dir, randomUUID() + '.tmp')
    try {
      await fs.writeFile(temp, JSON.stringify(next, null, 2), 'utf8')
      await fs.rename(temp, fileOf(root))
    } finally {
      await fs.rm(temp, { force: true })
    }
    return next
  })
  queues.set(key, job.catch(() => {}))
  return job
}
