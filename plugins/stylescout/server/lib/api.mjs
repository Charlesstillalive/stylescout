/**
 * StyleScout host HTTP API (registered as one webServer prefix).
 *
 * GET    /style-scout/api/health              liveness + data root
 * GET    /style-scout/api/library             rendered asset views
 * GET    /style-scout/api/captures/:id        entry + raw DNA
 * DELETE /style-scout/api/captures/:id        cascade delete
 * POST   /style-scout/api/capture             { url } → capture → DNA → library
 * GET    /style-scout/files/<relative path>   capture screenshots (png)
 */
import fs from 'node:fs/promises'
import fss from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { toView } from './view.mjs'
import * as store from './store/index.mjs'
import { readDraft, saveDraft } from './store/draft.mjs'
import { readUi, saveUi } from './store/ui.mjs'
import { uiAction } from './ui/reuse.mjs'
import { createChatgptActions } from './ui/chatgpt.mjs'

const MAX_BODY_BYTES = 64 * 1024
const LOCAL_ROOT = '/style-scout/local/'
const PAGE_URL = new URL('./page/app.html', import.meta.url)

/** Open a URL in the OS default browser (host side; renderer window.open is unreliable). */
function launchBrowser(url) {
  const options = { detached: true, stdio: 'ignore', windowsHide: true }
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], options).unref()
  else if (process.platform === 'darwin') spawn('open', [url], options).unref()
  else spawn('xdg-open', [url], options).unref()
}
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
}

/** Local preview targets stay inside the user home, temp dirs or the cwd. */
function localFileAllowed(file) {
  if (!path.isAbsolute(file)) return false
  const allowed = [os.homedir(), os.tmpdir(), process.cwd()]
  return allowed.some((root) => file === root || file.startsWith(root + path.sep))
}

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null && error !== undefined) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

const LOCAL_ASSET_RE = /\/style-scout\/files\/captures\/([^/"')\s]+)\/assets\/([^"')\s]+)/g

/** Copy locally captured assets next to the bundle and rewrite URLs to relative paths. */
async function packageAssets(dir, files, dataRoot) {
  const mapping = new Map()
  for (const content of Object.values(files)) {
    if (typeof content !== 'string') continue
    for (const match of content.matchAll(LOCAL_ASSET_RE)) {
      if (mapping.has(match[0])) continue
      const source = path.join(dataRoot, 'captures', match[1], 'assets', match[2])
      if (!fss.existsSync(source)) continue
      const relative = 'assets/' + match[1] + '/' + match[2]
      const target = path.join(dir, relative)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(source, target)
      mapping.set(match[0], relative)
    }
  }
  if (mapping.size === 0) return files
  const rewritten = {}
  for (const [name, content] of Object.entries(files)) {
    if (typeof content !== 'string') {
      rewritten[name] = content
      continue
    }
    let out = content
    for (const [from, to] of mapping) out = out.split(from).join(to)
    rewritten[name] = out
  }
  return rewritten
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * @param {{ dataRoot: string, captureUrl: (url: string) => Promise<any>, getWorkbenchUrl?: () => Promise<string> }} options
 * @returns {{ handle: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> }}
 */
export function createApi({ dataRoot, captureUrl, getWorkbenchUrl, remixTasks, standalone=false }) {
  const chatgptActions=createChatgptActions(dataRoot)
  async function libraryViews() {
    const entries = await store.listEntries(dataRoot)
    const views = []
    for (const entry of entries) {
      const dnaId = (entry.dnaIds || [])[0]
      if (dnaId === undefined) continue
      try {
        const dna = JSON.parse(await fs.readFile(path.join(dataRoot, 'dna', `${dnaId}.json`), 'utf8'))
        views.push(toView(entry, dna))
      } catch {
        // A missing DNA file only hides that card; the entry stays listed for repair.
      }
    }
    return views
  }

  async function serveFile(pathname, res) {
    const relative = decodeURIComponent(pathname.slice('/style-scout/files/'.length))
    const baseDir = path.resolve(dataRoot)
    const resolved = path.resolve(baseDir, relative)
    const inside = resolved.startsWith(baseDir + path.sep)
    if (!inside) return json(res, 403, { error: 'forbidden' })
    const extension = path.extname(resolved).toLowerCase()
    const mime = MIME[extension]
    if (mime === undefined) return json(res, 404, { error: 'not found' })
    /* Exported text artifacts are served from exports/ only; captures expose images. */
    if ((extension === '.css' || extension === '.json') && !relative.startsWith('exports/')) {
      return json(res, 404, { error: 'not found' })
    }
    if (!fss.existsSync(resolved)) return json(res, 404, { error: 'not found' })
    res.writeHead(200, {
      'content-type': mime,
      'cache-control': 'private, max-age=300',
    })
    res.end(await fs.readFile(resolved))
  }

  /**
   * Serve a local preview target (HTML and its relative assets) from the file
   * system so the same-origin iframe can be themed in place.
   */
  async function serveLocal(pathname, res) {
    const raw = decodeURIComponent(pathname.slice(LOCAL_ROOT.length))
    let file = path.resolve(raw)
    if (!localFileAllowed(file)) return json(res, 403, { error: 'forbidden' })
    let stat = await fs.stat(file).catch(() => null)
    if (stat !== null && stat.isDirectory()) {
      file = path.join(file, 'index.html')
      stat = await fs.stat(file).catch(() => null)
    }
    const mime = MIME[path.extname(file).toLowerCase()]
    if (mime === undefined) return json(res, 404, { error: 'not found' })
    if (stat === null || !stat.isFile()) return json(res, 404, { error: 'not found' })
    res.writeHead(200, {
      'content-type': mime,
      'cache-control': 'no-store',
    })
    res.end(await fs.readFile(file))
  }

  async function handle(req, res) {
    try {
      const requestUrl = new URL(req.url ?? '/', 'http://dsh.invalid')
      const pathname = requestUrl.pathname

      /* Same-origin guard: local routes must not be reachable from arbitrary web pages.
       * Non-browser callers (tests, curl, agent tools) send no Origin header and pass. */
      const originHeader = req.headers && req.headers.origin
      if (typeof originHeader === 'string' && originHeader !== '') {
        let sameOrigin = false
        try {
          sameOrigin = new URL(originHeader).host === req.headers.host
        } catch {
          sameOrigin = false
        }
        if (!sameOrigin) return json(res, 403, { error: 'cross-origin request rejected' })
      }

      if (pathname === '/style-scout/api/draft') {
        try {
          if (req.method === 'GET') return json(res, 200, await readDraft(dataRoot))
          if (req.method === 'POST') return json(res, 200, await saveDraft(dataRoot, await readJsonBody(req, 16 * 1024 * 1024)))
          return json(res, 405, { error: 'method not allowed' })
        } catch (error) {
          return json(res, error.status || 500, { error: error.message })
        }
      }

      /* Standalone workbench page (V2): opened in a real browser window. */
      if (req.method === 'GET' && ['/style-scout/', '/style-scout/app', '/style-scout/assembly'].includes(pathname)) {
        if (getWorkbenchUrl) {
          const stable = new URL(await getWorkbenchUrl())
          if (req.headers.host !== stable.host) {
            stable.pathname=pathname;stable.search=requestUrl.search
            res.writeHead(302,{location:stable.href,'cache-control':'no-store'});res.end();return
          }
        }
        const html = await fs.readFile(pathname === '/style-scout/assembly' ? PAGE_URL : new URL('./page/library.html', import.meta.url), 'utf8').catch(() => null)
        if (html === null) return json(res, 500, { error: 'workbench page missing' })
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(html)
        return
      }
      if (req.method === 'GET' && pathname === '/style-scout/ui-document.mjs') {
        res.writeHead(200, {'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'})
        res.end(await fs.readFile(new URL('./ui/document.mjs', import.meta.url))); return
      }
      if(req.method==='GET'&&['/style-scout/remix.js','/style-scout/chatgpt.js'].includes(pathname)){
        res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'})
        res.end(await fs.readFile(new URL('./page/'+pathname.split('/').at(-1),import.meta.url)));return
      }
      if(pathname==='/style-scout/api/remix-tasks'||/^\/style-scout\/api\/remix-tasks\/task_[\w-]+\/retry$/.test(pathname)){
        try{
          if(!remixTasks)return json(res,503,{error:'请重新打开 DSH 以启用改造功能。'})
          if(pathname==='/style-scout/api/remix-tasks'&&req.method==='GET')return json(res,200,await remixTasks.list())
          if(req.method!=='POST')return json(res,405,{error:'method not allowed'})
          const body=await readJsonBody(req)
          return json(res,202,{task:pathname.endsWith('/retry')?await remixTasks.retry(pathname.split('/').at(-2),body.operationId):await remixTasks.submit(body)})
        }catch(error){return json(res,error.status||500,{error:error.message})}
      }
      if (req.method === 'GET' && pathname === '/style-scout/api/health') return json(res,200,{ok:true,service:'style-scout',chatgpt:true,standalone})
      if(pathname==='/style-scout/api/chatgpt-actions'&&req.method==='POST'){
        try{return json(res,200,await chatgptActions(await readJsonBody(req,8*1024*1024)))}catch(error){return json(res,error.status||400,{error:error.message})}
      }
      if (pathname === '/style-scout/api/ui-actions' && req.method === 'POST') {
        try{return json(res,200,await uiAction(dataRoot,await readJsonBody(req,16*1024*1024)))}
        catch(error){return json(res,error.status||400,{error:error.message})}
      }
      if (pathname === '/style-scout/api/ui-library' && req.method === 'GET') {
        const entries = await store.listEntries(dataRoot)
        const items = await Promise.all(entries.map(async entry => {
          let available = false, count = 0, modified = false, warnings = []
          try {
            const dir = path.join(dataRoot, 'captures', entry.id)
            const metadata = entry.editableUi || JSON.parse(await fs.readFile(path.join(dir,'capture.json'),'utf8')).editableUi
            available = Boolean(metadata && fss.existsSync(path.join(dir,'ui.json')))
            count = metadata?.count || 0; warnings = metadata?.warnings || []
            modified = fss.existsSync(path.join(dir,'ui-edits.json'))
          } catch {}
          return {...entry, available, count, modified, warnings, coverUrl:'/style-scout/files/' + entry.cover}
        }))
        return json(res,200,{entries:items})
      }
      const uiMatch = pathname.match(/^\/style-scout\/api\/ui\/([\w-]+)$/)
      if (uiMatch) {
        try {
          if (req.method === 'GET') return json(res,200,await readUi(dataRoot,uiMatch[1]))
          if (req.method === 'POST') return json(res,200,await saveUi(dataRoot,uiMatch[1],await readJsonBody(req,16*1024*1024)))
          return json(res,405,{error:'method not allowed'})
        } catch(error) {return json(res,error.status||500,{error:error.message})}
      }
      if (req.method === 'GET' && pathname === '/style-scout') {
        res.writeHead(302, { location: '/style-scout/' })
        res.end()
        return
      }

      /* Open the standalone workbench in the OS browser (renderer window.open is
       * unreliable inside the desktop shell). */
      if (req.method === 'GET' && pathname === '/style-scout/api/open') {
        const rawHost = (req.headers && req.headers.host) || ''
        const host = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(rawHost) ? rawHost : '127.0.0.1'
        const target = getWorkbenchUrl ? await getWorkbenchUrl() : `http://${host}/style-scout/`
        if (process.env.STYLE_SCOUT_NO_OPEN !== '1') {
          try {
            launchBrowser(target)
          } catch (error) {
            return json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        return json(res, 200, { ok: true, url: target })
      }

      if (req.method === 'POST' && pathname === '/style-scout/api/export-bundle') {
        const body = await readJsonBody(req, 16 * 1024 * 1024)
        const files = body.files
        if (files === null || typeof files !== 'object' || Array.isArray(files)) {
          return json(res, 400, { error: 'files object required' })
        }
        const writeDir = typeof body.writeDir === 'string' && body.writeDir !== '' ? path.resolve(body.writeDir) : null
        if (writeDir !== null && !localFileAllowed(writeDir)) {
          return json(res, 400, { error: 'writeDir outside allowed roots' })
        }
        const id = 'export_' + Date.now().toString(36)
        const dir = path.join(dataRoot, 'exports', id)
        const packaged = await packageAssets(dir, files, dataRoot)
        const written = []
        let total = 0
        for (const [relative, content] of Object.entries(packaged)) {
          if (typeof content !== 'string') return json(res, 400, { error: 'file content must be a string' })
          const safe = path.normalize(String(relative)).replace(/^([/\\])+/, '')
          if (safe === '' || safe.includes('..') || path.isAbsolute(relative)) {
            return json(res, 400, { error: 'invalid file path: ' + relative })
          }
          total += Buffer.byteLength(content, 'utf8')
          if (total > 20 * 1024 * 1024) return json(res, 413, { error: 'bundle too large' })
          const target = path.join(dir, safe)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, content, 'utf8')
          written.push(safe)
        }
        if (writeDir !== null) {
          for (const file of written) {
            const target = path.join(writeDir, file)
            await fs.mkdir(path.dirname(target), { recursive: true })
            await fs.copyFile(path.join(dir, file), target)
          }
        }
        return json(res, 200, {
          id,
          dir,
          written,
          writtenDir: writeDir,
          url: `/style-scout/files/exports/${id}/index.html`,
        })
      }

      /* Export into a target git repo on an isolated worktree branch (no checkout). */
      if (req.method === 'POST' && pathname === '/style-scout/api/export-project') {
        const body = await readJsonBody(req, 16 * 1024 * 1024)
        const files = body.files
        if (files === null || typeof files !== 'object' || Array.isArray(files)) {
          return json(res, 400, { error: 'files object required' })
        }
        const targetRaw = typeof body.targetDir === 'string' ? body.targetDir.trim() : ''
        if (targetRaw === '') return json(res, 400, { error: 'targetDir required' })
        const targetDir = path.resolve(targetRaw)
        if (!localFileAllowed(targetDir)) return json(res, 400, { error: 'targetDir outside allowed roots' })
        let repoRoot
        let baseBranch
        try {
          repoRoot = (await runGit(targetDir, ['rev-parse', '--show-toplevel'])).stdout.trim()
          baseBranch = (await runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
        } catch {
          return json(res, 400, { error: 'targetDir is not inside a git repository' })
        }
        const id = 'export_' + Date.now().toString(36)
        const branch = 'stylescout/' + id
        const worktree = path.join(os.tmpdir(), 'stylescout-worktree-' + id)
        try {
          await runGit(repoRoot, ['worktree', 'add', '-b', branch, worktree])
        } catch (error) {
          return json(res, 500, { error: 'failed to create git worktree: ' + String(error.stderr || error.message).trim() })
        }
        try {
          const packaged = await packageAssets(worktree, files, dataRoot)
          const written = []
          for (const [relative, content] of Object.entries(packaged)) {
            if (typeof content !== 'string') return json(res, 400, { error: 'file content must be a string' })
            const safe = path.normalize(String(relative)).replace(/^([/\\])+/, '')
            if (safe === '' || safe.includes('..') || path.isAbsolute(relative)) {
              return json(res, 400, { error: 'invalid file path: ' + relative })
            }
            const target = path.join(worktree, safe)
            await fs.mkdir(path.dirname(target), { recursive: true })
            await fs.writeFile(target, content, 'utf8')
            written.push(safe)
          }
          await runGit(worktree, ['add', '-A'])
          let committed = false
          let commitError = null
          if (body.commit !== false) {
            const message = typeof body.message === 'string' && body.message.trim() !== '' ? body.message : 'StyleScout export'
            try {
              await runGit(worktree, ['commit', '-m', message])
              committed = true
            } catch (error) {
              commitError = String(error.stderr || error.message).trim()
            }
          }
          let stat = ''
          try {
            stat = (await runGit(worktree, ['show', '--stat', '--oneline', 'HEAD'])).stdout.trim()
          } catch { /* no commit yet */ }
          return json(res, 200, {
            id,
            repo: repoRoot,
            branch,
            baseBranch,
            worktree,
            committed,
            commitError,
            written,
            stat,
            diffCommand: `git -C "${repoRoot}" diff ${baseBranch}..${branch} --stat`,
            mergeCommand: `git -C "${repoRoot}" merge --no-ff ${branch}`,
          })
        } catch (error) {
          return json(res, 500, { error: error instanceof Error ? error.message : String(error), worktree, branch })
        }
      }

      /* Data-root backup (index/dna/captures/themes/templates/layouts). */
      if (pathname === '/style-scout/api/backup' && req.method === 'POST') {
        return json(res, 200, await store.createBackup(dataRoot))
      }

      if (pathname === '/style-scout/api/backups' && req.method === 'GET') {
        return json(res, 200, { backups: await store.listBackups(dataRoot) })
      }

      /* Saved page templates (agent-generated JSON the workbench can import). */
      if (pathname === '/style-scout/api/templates') {
        const templatesDir = path.join(dataRoot, 'templates')
        if (req.method === 'GET') {
          const files = fss.existsSync(templatesDir)
            ? fss.readdirSync(templatesDir).filter((file) => file.endsWith('.json'))
            : []
          const templates = []
          for (const file of files) {
            try {
              const template = JSON.parse(await fs.readFile(path.join(templatesDir, file), 'utf8'))
              templates.push({
                file,
                name: template.name || file.replace(/\.json$/, ''),
                slots: Array.isArray(template.slots) ? template.slots.length : 0,
                fills: Array.isArray(template.fills) ? template.fills.length : 0,
              })
            } catch { /* skip unreadable template */ }
          }
          return json(res, 200, { templates })
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req, 2 * 1024 * 1024)
          const template = body.template
          if (template === null || typeof template !== 'object' || !Array.isArray(template.slots)) {
            return json(res, 400, { error: 'template.slots array required' })
          }
          const rawName = typeof body.name === 'string' && body.name.trim() !== '' ? body.name : (typeof template.name === 'string' ? template.name : 'template')
          const file = String(rawName).replace(/[^A-Za-z0-9._-一-鿿]/g, '-').slice(0, 60) + '.json'
          await fs.mkdir(templatesDir, { recursive: true })
          await fs.writeFile(path.join(templatesDir, file), JSON.stringify(template, null, 2), 'utf8')
          return json(res, 200, { file })
        }
        return json(res, 405, { error: 'method not allowed' })
      }

      const templateMatch = pathname.match(/^\/style-scout\/api\/templates\/([A-Za-z0-9._一-鿿-]+\.json)$/)
      if (templateMatch !== null && req.method === 'GET') {
        const file = templateMatch[1]
        const target = path.join(dataRoot, 'templates', file)
        if (file.includes('..') || !fss.existsSync(target)) return json(res, 404, { error: 'not found' })
        return json(res, 200, { file, template: JSON.parse(await fs.readFile(target, 'utf8')) })
      }

      /* Saved 2D layouts (agent-generated region trees the region canvas imports). */
      if (pathname === '/style-scout/api/layouts') {
        const layoutsDir = path.join(dataRoot, 'layouts')
        if (req.method === 'GET') {
          const files = fss.existsSync(layoutsDir)
            ? fss.readdirSync(layoutsDir).filter((file) => file.endsWith('.json'))
            : []
          const layouts = []
          const countLayerFills = (nodes) => (nodes || []).reduce((sum, node) => {
            if (node === null || typeof node !== 'object') return sum
            const hasAsset = node.asset !== null && node.asset !== undefined ? true : node.fill !== null && node.fill !== undefined
            return sum + (hasAsset ? 1 : 0) + (Array.isArray(node.children) ? countLayerFills(node.children) : 0)
          }, 0)
          for (const file of files) {
            try {
              const layout = JSON.parse(await fs.readFile(path.join(layoutsDir, file), 'utf8'))
              const layers = Array.isArray(layout.layers) ? layout.layers : null
              const regions = Array.isArray(layout.regions) ? layout.regions : null
              layouts.push({
                file,
                name: layout.name || file.replace(/\.json$/, ''),
                schema: layout.schema || 'style-scout/layout@1',
                regions: regions !== null ? regions.length : (layers !== null ? layers.length : 0),
                layers: layers !== null ? layers.length : 0,
                fills: layers !== null ? countLayerFills(layers) : (regions || []).filter((region) => region && region.fill).length,
              })
            } catch { /* skip unreadable layout */ }
          }
          return json(res, 200, { layouts })
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req, 2 * 1024 * 1024)
          const layout = body.layout
          const nodes = layout !== null && typeof layout === 'object'
            ? (Array.isArray(layout.layers) ? layout.layers : Array.isArray(layout.regions) ? layout.regions : null)
            : null
          if (nodes === null) {
            return json(res, 400, { error: 'layout.layers or layout.regions array required' })
          }
          const rawName = typeof body.name === 'string' && body.name.trim() !== '' ? body.name : (typeof layout.name === 'string' ? layout.name : 'layout')
          const file = String(rawName).replace(/[^A-Za-z0-9._-一-鿿]/g, '-').slice(0, 60) + '.json'
          await fs.mkdir(layoutsDir, { recursive: true })
          await fs.writeFile(path.join(layoutsDir, file), JSON.stringify(layout, null, 2), 'utf8')
          return json(res, 200, { file })
        }
        return json(res, 405, { error: 'method not allowed' })
      }

      const layoutMatch = pathname.match(/^\/style-scout\/api\/layouts\/([A-Za-z0-9._一-鿿-]+\.json)$/)
      if (layoutMatch !== null && req.method === 'GET') {
        const file = layoutMatch[1]
        const target = path.join(dataRoot, 'layouts', file)
        if (file.includes('..') || !fss.existsSync(target)) return json(res, 404, { error: 'not found' })
        return json(res, 200, { file, layout: JSON.parse(await fs.readFile(target, 'utf8')) })
      }

      if (req.method === 'GET' && pathname === '/style-scout/api/health') {
        return json(res, 200, { ok: true, root: dataRoot })
      }
      if (req.method === 'GET' && pathname === '/style-scout/api/library') {
        return json(res, 200, { entries: await libraryViews() })
      }
      if (pathname.startsWith(LOCAL_ROOT) && req.method === 'GET') {
        return serveLocal(pathname, res)
      }
      if (pathname.startsWith('/style-scout/files/') && req.method === 'GET') {
        return serveFile(pathname, res)
      }
      if (req.method === 'POST' && pathname === '/style-scout/api/export') {
        const body = await readJsonBody(req)
        const css = typeof body.css === 'string' ? body.css : ''
        if (css.trim() === '') return json(res, 400, { error: 'css is required' })
        if (Buffer.byteLength(css, 'utf8') > 512 * 1024) return json(res, 400, { error: 'css too large' })
        const name = String(body.name || 'theme').slice(0, 80)
        const tokens = body.tokens !== null && typeof body.tokens === 'object' ? body.tokens : {}
        const id = `export_${Date.now().toString(36)}`
        const dir = path.join(dataRoot, 'exports', id)
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, 'theme.css'), css, 'utf8')
        await fs.writeFile(path.join(dir, 'tokens.json'), JSON.stringify(tokens, null, 2), 'utf8')

        /* Optional: drop theme.css next to the user's local target so it can be
         * linked from their own HTML without a manual copy. */
        let written = null
        if (typeof body.writeDir === 'string' && body.writeDir !== '') {
          const writeDir = path.resolve(body.writeDir)
          if (!localFileAllowed(writeDir)) return json(res, 400, { error: 'writeDir outside allowed roots' })
          await fs.mkdir(writeDir, { recursive: true })
          written = path.join(writeDir, 'theme.css')
          await fs.writeFile(written, css, 'utf8')
        }

        return json(res, 200, {
          id,
          name,
          dir,
          written,
          cssUrl: `/style-scout/files/exports/${id}/theme.css`,
          tokensUrl: `/style-scout/files/exports/${id}/tokens.json`,
        })
      }
      if (req.method === 'POST' && pathname === '/style-scout/api/capture') {
        const body = await readJsonBody(req)
        const url = typeof body.url === 'string' ? body.url.trim() : ''
        if (!/^https?:\/\/\S+$/i.test(url)) return json(res, 400, { error: 'url must be an http(s) URL' })
        const view = await captureUrl(url)
        return json(res, 200, { entry: view })
      }

      /* Captured stylesheet for block previews (V2-3 canvas). */
      const cssMatch = pathname.match(/^\/style-scout\/api\/captures\/([^/]+)\/page\.css$/)
      if (cssMatch !== null && req.method === 'GET') {
        const captureId = decodeURIComponent(cssMatch[1])
        const file = path.join(dataRoot, 'captures', captureId, 'page.css')
        if (!fss.existsSync(file)) return json(res, 404, { error: 'not found' })
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
        res.end(await fs.readFile(file, 'utf8'))
        return
      }

      /* Section markup as HTML (canvas import in V2-3). */
      const sectionMatch = pathname.match(/^\/style-scout\/api\/captures\/([^/]+)\/sections\/([A-Za-z0-9_-]+)$/)
      if (sectionMatch !== null && req.method === 'GET') {
        const captureId = decodeURIComponent(sectionMatch[1])
        const sectionId = sectionMatch[2]
        const file = path.join(dataRoot, 'captures', captureId, 'sections', `${sectionId}.html`)
        if (!fss.existsSync(file)) return json(res, 404, { error: 'not found' })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(await fs.readFile(file, 'utf8'))
        return
      }

      if (pathname === '/style-scout/api/themes') {
        if (req.method === 'GET') {
          return json(res, 200, { themes: await store.listThemes(dataRoot) })
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req, 2 * 1024 * 1024)
          if (typeof body.name !== 'string' || body.name.trim() === '') return json(res, 400, { error: 'name required' })
          if (body.tokens === null || typeof body.tokens !== 'object') return json(res, 400, { error: 'tokens required' })
          const theme = await store.saveTheme(dataRoot, {
            name: body.name,
            tokens: body.tokens,
            colorMap: body.colorMap && typeof body.colorMap === 'object' ? body.colorMap : {},
            sourceEntryId: typeof body.sourceEntryId === 'string' ? body.sourceEntryId : null,
          })
          return json(res, 200, { theme })
        }
        return json(res, 405, { error: 'method not allowed' })
      }

      const themeMatch = pathname.match(/^\/style-scout\/api\/themes\/([^/]+)$/)
      if (themeMatch !== null) {
        const themeId = decodeURIComponent(themeMatch[1])
        if (req.method === 'GET') {
          const theme = await store.getTheme(dataRoot, themeId)
          if (theme === undefined) return json(res, 404, { error: 'not found' })
          return json(res, 200, { theme })
        }
        if (req.method === 'DELETE') {
          await store.deleteTheme(dataRoot, themeId)
          return json(res, 200, { deleted: true })
        }
        return json(res, 405, { error: 'method not allowed' })
      }

      const themeRestoreMatch = pathname.match(/^\/style-scout\/api\/themes\/([^/]+)\/restore$/)
      if (themeRestoreMatch !== null && req.method === 'POST') {
        const themeId = decodeURIComponent(themeRestoreMatch[1])
        const body = await readJsonBody(req)
        const theme = await store.restoreThemeVersion(dataRoot, themeId, Number(body.version) || 0)
        if (theme === undefined) return json(res, 404, { error: 'theme or version not found' })
        return json(res, 200, { theme })
      }

      const match = pathname.match(/^\/style-scout\/api\/captures\/([^/]+)$/)
      if (match !== null) {
        const id = decodeURIComponent(match[1])
        if (req.method === 'PATCH') {
          const body = await readJsonBody(req)
          const patch = {}
          if (typeof body.name === 'string') {
            const name = body.name.trim().slice(0, 80)
            if (name === '') return json(res, 400, { error: 'name must not be empty' })
            patch.name = name
          }
          if (Array.isArray(body.tags)) patch.tags = body.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.slice(0, 24)).slice(0, 12)
          if (typeof body.favorite === 'boolean') patch.favorite = body.favorite
          if (Object.keys(patch).length === 0) return json(res, 400, { error: 'nothing to update' })
          const entry = await store.updateEntry(dataRoot, id, patch)
          if (entry === undefined) return json(res, 404, { error: 'not found' })
          const dnaId = (entry.dnaIds || [])[0]
          const dna = dnaId === undefined
            ? null
            : JSON.parse(await fs.readFile(path.join(dataRoot, 'dna', `${dnaId}.json`), 'utf8').catch(() => 'null'))
          return json(res, 200, { entry: toView(entry, dna) })
        }
        if (req.method === 'GET') {
          const entry = await store.getEntry(dataRoot, id)
          if (entry === undefined) return json(res, 404, { error: 'not found' })
          const dnaId = (entry.dnaIds || [])[0]
          const dna = dnaId === undefined
            ? null
            : JSON.parse(await fs.readFile(path.join(dataRoot, 'dna', `${dnaId}.json`), 'utf8').catch(() => 'null'))
          return json(res, 200, { entry, dna })
        }
        if (req.method === 'DELETE') {
          const result = await store.deleteEntry(dataRoot, id)
          if (!result.removed) return json(res, 404, { error: 'not found' })
          return json(res, 200, { deleted: true, files: result.files })
        }
        return json(res, 405, { error: 'method not allowed' })
      }

      return json(res, 404, { error: 'not found' })
    } catch (error) {
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  return { handle }
}
