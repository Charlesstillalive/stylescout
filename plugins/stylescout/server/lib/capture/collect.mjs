/**
 * StyleScout capture engine (host side).
 *
 * Vendored from experiments/capture/collect.mjs (verified prototype) and turned
 * into a library: zero dependencies, CDP over the system Chrome/Edge, real
 * screenshots plus computed-style usage (count / area / pixel share).
 *
 * capture(url, { outDir }) writes capture.json + tokens.json + viewport.png +
 * full.png under outDir and resolves with the parsed objects.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { extractUiDocument } from './ui-probe.mjs'

/** Chrome/Edge candidates; STYLE_SCOUT_CHROME or CHROME_PATH overrides. */
const CHROME_CANDIDATES = [
  process.env.STYLE_SCOUT_CHROME || process.env.CHROME_PATH || '',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

function resolveChrome(options) {
  const explicit = options.chromePath || CHROME_CANDIDATES.find((candidate) => fss.existsSync(candidate))
  if (!explicit) throw new Error('capture: no Chrome/Edge found; set STYLE_SCOUT_CHROME or CHROME_PATH')
  return explicit
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const slugify = (url) => {
  const u = new URL(url)
  return (u.hostname + u.pathname).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'site'
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.listeners = new Set()
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || e))))
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id)
        clearTimeout(timer)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
        return
      }
      for (const fn of this.listeners) fn(msg)
    })
    this.ws.addEventListener('close', () => this.rejectPending(new Error('capture connection closed')))
    this.ws.addEventListener('error', () => this.rejectPending(new Error('capture connection failed')))
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, 60000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression, { awaitPromise = false, returnByValue = true } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue, userGesture: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception?.description || ''))
    return r.result?.value
  }
  // Large DOM snapshots can stall the protocol transport when returned in a
  // single message. Keep a private remote object and read bounded string chunks.
  // No globals are added to the source website; always release the remote handle.
  async evalJson(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: '({json: JSON.stringify(' + expression + ')})', returnByValue: false,
    })
    if (result.exceptionDetails) throw new Error('UI snapshot could not be serialized')
    const objectId = result.result?.objectId
    if (!objectId) throw new Error('UI snapshot handle missing')
    const call = async (functionDeclaration, args = []) => {
      const r = await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: args.map(value => ({value})), returnByValue: true })
      if (r.exceptionDetails) throw new Error('UI snapshot could not be read')
      return r.result?.value
    }
    try {
      const size = await call('function(){return this.json.length}')
      if (!Number.isSafeInteger(size) || size <= 0 || size > 32 * 1024 * 1024) throw new Error('页面内容超过可保存上限，请选择内容较少的页面')
      const chunks = [], step = 128 * 1024
      for (let start = 0; start < size; start += step) {
        const chunk = await call('function(start,end){return this.json.slice(start,end)}', [start, start + step])
        if (typeof chunk !== 'string' || chunk.length !== Math.min(step, size - start)) throw new Error('UI snapshot transfer incomplete')
        chunks.push(chunk)
      }
      return JSON.parse(chunks.join(''))
    } finally { await this.send('Runtime.releaseObject', {objectId}).catch(() => {}) }
  }
  rejectPending(error) { for(const {timer,reject} of this.pending.values()){clearTimeout(timer);reject(error)}this.pending.clear() }
  close() { this.rejectPending(new Error('capture closed'));try { this.ws.close() } catch {} }
}

async function launchChrome(chromePath) {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'style-scout-chrome-'))
  const child = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', () => {})
  const portFile = path.join(userDataDir, 'DevToolsActivePort')
  for (let i = 0; i < 120; i++) {
    if (fss.existsSync(portFile)) {
      const [port] = fss.readFileSync(portFile, 'utf8').split('\n')
      if (port) return { child, userDataDir, port: Number(port) }
    }
    await sleep(100)
  }
  child.kill()
  throw new Error('Chrome DevToolsActivePort not found')
}

async function pageWS(port) {  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(200)
  }
  throw new Error('no page target')
}

/**
 * Render a standalone HTML string in a headless Chrome/Edge and save a PNG.
 * Used by the AI layout preview loop (`style_scout_preview_layout`).
 */
export async function renderHtmlPreview({ html, outFile, width = 1440, height = 900 }) {
  await fs.mkdir(path.dirname(outFile), { recursive: true })
  const htmlFile = outFile.replace(/\.png$/i, '.html')
  await fs.writeFile(htmlFile, html, 'utf8')
  const { child, userDataDir, port } = await launchChrome(resolveChrome({}))
  let cdp = null
  try {
    const wsUrl = await pageWS(port)
    cdp = new CDP(wsUrl)
    await cdp.ready
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Page.navigate', { url: pathToFileURL(htmlFile).href })
    await cdp.eval('document.fonts.ready.then(() => true)', { awaitPromise: true }).catch(() => {})
    await sleep(250)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await fs.writeFile(outFile, Buffer.from(shot.data, 'base64'))
    return { file: outFile, htmlFile, width, height, bytes: (await fs.stat(outFile)).size }
  } finally {
    try { cdp?.close() } catch {}
    child.kill()
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Re-snapshot a locally rendered editable document, after an optional DOM setup.
 * The caller owns the loopback server and supplies only trusted setup code. */
export async function snapshotEditableUi({url, outDir, width, height, prepare}) {
  const {child,userDataDir,port}=await launchChrome(resolveChrome({}))
  let cdp
  try {
    cdp=new CDP(await pageWS(port));await cdp.ready
    await cdp.send('Page.enable');await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
    await cdp.send('Page.navigate',{url})
    for(let i=0;i<100;i++){if(await cdp.eval('document.readyState')==='complete')break;await sleep(50)}
    await cdp.eval('document.fonts.ready.then(()=>true)',{awaitPromise:true})
    const setup=prepare?await cdp.eval(prepare,{awaitPromise:true}):{}
    if(setup?.error)throw new Error(setup.error)
    if(setup?.width){width=setup.width;height=setup.height;await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})}
    await cdp.eval('(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true})()',{awaitPromise:true})
    const document=await cdp.evalJson('('+extractUiDocument.toString()+')()')
    const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})
    await fs.writeFile(path.join(outDir,'viewport.png'),Buffer.from(shot.data,'base64'))
    return {document,setup}
  } finally {
    try{cdp?.close()}catch{};child.kill()
    await fs.rm(userDataDir,{recursive:true,force:true}).catch(()=>{})
  }
}

const COLLECT_JS = String.raw`(() => {
  const out = { colors: [], fonts: {}, sizes: [], spacings: [], radii: [], containers: [], frameworks: {}, meta: {} };
  const colorMap = new Map();
  const fontMap = new Map();
  const sizeMap = new Map();
  const charMap = new Map();
  const spaceMap = new Map();
  const radiusMap = new Map();
  const containerMap = new Map();
  const parse = (v) => {
    if (!v || typeof v !== 'string') return null;
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((x) => parseFloat(x.trim()));
    const a = parts.length >= 4 ? parts[3] : 1;
    if (a < 0.08) return null;
    const [r, g, b] = parts;
    if ([r, g, b].some((n) => !Number.isFinite(n))) return null;
    return '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('').toUpperCase();
  };
  const addColor = (value, role, weight, el) => {
    const hex = parse(value);
    if (!hex) return;
    let item = colorMap.get(hex);
    if (!item) { item = { hex, count: 0, area: 0, roles: new Set(), samples: [] }; colorMap.set(hex, item); }
    item.count += 1;
    item.area += weight;
    item.roles.add(role);
    if (item.samples.length < 3) {
      const tag = el ? el.tagName.toLowerCase() : '';
      const cls = el && typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
      if (tag) item.samples.push(tag + (cls ? '.' + cls : ''));
    }
  };
  const els = document.querySelectorAll('*');
  const vw = innerWidth, vh = innerHeight;
  for (const el of els) {
    let rect;
    try { rect = el.getBoundingClientRect(); } catch { continue; }
    const area = rect.width * rect.height;
    if (area < 4) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
    const weight = Math.min(area, vw * vh * 3);
    addColor(cs.color, 'text', weight, el);
    addColor(cs.backgroundColor, 'background', weight, el);
    if (parseFloat(cs.borderTopWidth) > 0) addColor(cs.borderTopColor, 'border', weight * 0.4, el);
    const interactive = el.closest && el.closest('a,button,[role="button"],input[type="submit"]');
    if (interactive) {
      addColor(cs.color, 'action', weight, el);
      addColor(cs.backgroundColor, 'action', weight, el);
    }
    if (el instanceof SVGElement || el.tagName.toLowerCase() === 'svg') {
      if (cs.fill && cs.fill !== 'none') addColor(cs.fill, 'fill', weight, el);
      if (cs.stroke && cs.stroke !== 'none') addColor(cs.stroke, 'stroke', weight, el);
    }
    const ownText = el.children.length === 0 ? (el.textContent || '').trim() : '';
    if (ownText) {
      const fam = (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim();
      const fs = parseFloat(cs.fontSize);
      const fw = parseInt(cs.fontWeight, 10) || 400;
      if (fam && Number.isFinite(fs)) {
        const key = fam + '|' + fs + '|' + fw;
        const f = fontMap.get(key) || { family: fam, size: fs, weight: fw, count: 0, area: 0, chars: 0 };
        f.count += 1; f.area += weight; f.chars += ownText.length;
        fontMap.set(key, f);
        sizeMap.set(fs, (sizeMap.get(fs) || 0) + 1);
        charMap.set(fs, (charMap.get(fs) || 0) + ownText.length);
      }
    }
    for (const p of ['marginTop','marginRight','marginBottom','marginLeft','paddingTop','paddingRight','paddingBottom','paddingLeft','rowGap','columnGap','gap']) {
      const v = parseFloat(cs[p]);
      if (Number.isFinite(v) && v > 0) spaceMap.set(v, (spaceMap.get(v) || 0) + 1);
    }
    for (const p of ['borderTopLeftRadius','borderTopRightRadius']) {
      const v = parseFloat(cs[p]);
      if (Number.isFinite(v) && v > 0) radiusMap.set(v, (radiusMap.get(v) || 0) + 1);
    }
    if (rect.width >= 240 && rect.width <= vw + 2) {
      const w = Math.round(rect.width);
      containerMap.set(w, (containerMap.get(w) || 0) + 1);
    }
  }
  // media query breakpoints + CSS 变量
  const breakpoints = new Set();
  const cssVars = {};
  const walk = (rules) => {
    if (!rules) return;
    for (const r of rules) {
      try {
        if (r.style && r.style.length) {
          for (const prop of r.style) {
            if (prop.startsWith('--') && /accent|brand|primary|link|focus|blue|purple|violet|coral/i.test(prop)) {
              const hex = parse(r.style.getPropertyValue(prop).trim());
              if (hex && !cssVars[prop]) cssVars[prop] = hex;
            }
          }
        }
        if (r.type === 4 || (r.media && r.cssRules)) { // CSSMediaRule
          const txt = r.conditionText || r.media?.mediaText || '';
          for (const m of txt.matchAll(/(?:min|max)-width:\s*(\d+(?:\.\d+)?)px/g)) breakpoints.add(Math.round(parseFloat(m[1])));
        }
        if (r.cssRules) walk(r.cssRules);
      } catch {}
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules); } catch {}
  }
  out.colors = [...colorMap.values()].map((c) => ({ ...c, roles: [...c.roles] })).sort((a, b) => b.area - a.area).slice(0, 200);
  out.fonts = [...fontMap.values()].sort((a, b) => b.area - a.area).slice(0, 80);
  out.sizes = [...sizeMap.entries()].map(([px, count]) => ({ px, count, chars: charMap.get(px) || 0 })).sort((a, b) => b.chars - a.chars || b.count - a.count);
  out.spacings = [...spaceMap.entries()].map(([px, count]) => ({ px, count })).sort((a, b) => b.count - a.count).slice(0, 60);
  out.radii = [...radiusMap.entries()].map(([px, count]) => ({ px, count })).sort((a, b) => b.count - a.count).slice(0, 40);
  out.containers = [...containerMap.entries()].map(([width, count]) => ({ width, count })).sort((a, b) => b.count - a.count).slice(0, 20);
  out.breakpoints = [...breakpoints].sort((a, b) => a - b).slice(0, 24);
  out.cssVars = Object.fromEntries(Object.entries(cssVars).slice(0, 80));
  out.frameworks = {
    react: !!(window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot]')),
    next: !!window.__NEXT_DATA__,
    vue: !!window.__VUE__,
    three: !!window.THREE,
    gsap: !!window.gsap,
    lenis: !!window.Lenis,
    canvasCount: document.querySelectorAll('canvas').length,
    webgl: (() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } })(),
  };
  out.meta = {
    title: document.title,
    url: location.href,
    lang: document.documentElement.lang || '',
    viewport: { width: vw, height: vh },
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    bodyFont: getComputedStyle(document.body).fontFamily,
    bodyBg: parse(getComputedStyle(document.body).backgroundColor),
    themeColor: (document.querySelector('meta[name="theme-color"]') || {}).content || null,
  };
  return out;
})()`

const PIXEL_JS = String.raw`(async (dataUrl) => {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const maxW = 360;
  const scale = Math.min(1, maxW / img.naturalWidth);
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const total = w * h;
  return [...counts.entries()].map(([hex, n]) => ({ hex, share: +(n / total).toFixed(5), count: n })).sort((a, b) => b.share - a.share).slice(0, 120);
})`

/**
 * Component kit probe: group visible interactive/surface elements by their
 * computed visual signature and keep the most common variants. Interaction
 * states (hover/focus/active) are out of v1 scope.
 */
const COMPONENT_PROBE_JS = String.raw`(() => {
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 32)
  const areaOf = (el) => { try { const r = el.getBoundingClientRect(); return r.width * r.height } catch { return 0 } }
  const visible = (el) => {
    let r; try { r = el.getBoundingClientRect(); } catch { return false }
    if (r.width < 40 || r.height < 14) return false
    const cs = getComputedStyle(el)
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0
  }
  const borderOf = (cs) => {
    const w = parseFloat(cs.borderTopWidth) || 0
    return w <= 0 ? 'none' : w + 'px ' + cs.borderTopStyle + ' ' + cs.borderTopColor
  }
  const styleOf = (cs) => ({
    color: cs.color,
    background: cs.backgroundColor === 'rgba(0, 0, 0, 0)' ? '' : cs.backgroundColor,
    border: borderOf(cs),
    borderRadius: cs.borderTopLeftRadius,
    padding: cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft,
    fontFamily: (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(),
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing === 'normal' ? '' : cs.letterSpacing,
    boxShadow: cs.boxShadow === 'none' ? '' : cs.boxShadow,
  })
  const buckets = { buttons: new Map(), inputs: new Map(), cards: new Map(), links: new Map(), headings: new Map() }
  const add = (bucket, el, kind) => {
    if (!visible(el)) return
    const cs = getComputedStyle(el)
    const style = styleOf(cs)
    const signature = [kind, style.background, style.color, style.border, style.borderRadius, style.fontSize, style.fontWeight, style.padding].join('|')
    const entry = bucket.get(signature) || { kind, count: 0, area: 0, text: '', style }
    entry.count += 1
    entry.area += areaOf(el)
    if (entry.text === '') entry.text = textOf(el)
    bucket.set(signature, entry)
  }
  const interactive = (el) => el.matches('a,button,[role="button"],input[type="submit"],input[type="button"]')
  for (const el of document.querySelectorAll('*')) {
    if (!(el instanceof HTMLElement)) continue
    const tag = el.tagName.toLowerCase()
    if (interactive(el)) {
      add(buckets.buttons, el, 'button')
      continue
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      add(buckets.inputs, el, 'input')
      continue
    }
    if (tag === 'a') {
      add(buckets.links, el, 'link')
      continue
    }
    if (/^h[1-6]$/.test(tag)) {
      if (!visible(el)) continue
      const cs = getComputedStyle(el)
      const style = styleOf(cs)
      const key = tag + '|' + style.fontSize + '|' + style.fontWeight + '|' + style.color
      const entry = buckets.headings.get(key) || { kind: tag, tag, count: 0, area: 0, text: '', style }
      entry.count += 1
      entry.area += areaOf(el)
      if (entry.text === '') entry.text = textOf(el)
      buckets.headings.set(key, entry)
      continue
    }
    const cs = getComputedStyle(el)
    const radius = parseFloat(cs.borderTopLeftRadius) || 0
    const hasBg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent'
    const hasBorder = (parseFloat(cs.borderTopWidth) || 0) > 0
    if (el.children.length > 0 && radius >= 4 && (hasBg || hasBorder) && areaOf(el) >= 6000) add(buckets.cards, el, 'card')
  }
  const top = (bucket, n) => [...bucket.values()].sort((a, b) => b.count - a.count || b.area - a.area).slice(0, n)
  return {
    buttons: top(buckets.buttons, 4),
    inputs: top(buckets.inputs, 3),
    cards: top(buckets.cards, 3),
    links: top(buckets.links, 2),
    headings: top(buckets.headings, 6),
  }
})()`

/**
 * Section + asset probe (V2): block-level structure (nav/hero/features/pricing/
 * footer…) with page-coordinate boxes and markup, plus image/SVG/font evidence.
 */
const SECTION_PROBE_JS = String.raw`(() => {
  const textOf = (el) => (el.innerText || '').replace(/\s+/g, ' ').trim()
  const boxOf = (el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.max(0, Math.round(r.x + scrollX)), y: Math.max(0, Math.round(r.y + scrollY)), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return r.width >= 240 && r.height >= 80 && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0
  }
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'header' || tag === 'nav' || el.getAttribute('role') === 'navigation') return 'nav'
    if (tag === 'footer') return 'footer'
    const blob = ((typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '') + ' ' + textOf(el).slice(0, 160)).toLowerCase()
    if (/pricing|price|plan|tier|per seat|month|\$|¥/.test(blob)) return 'pricing'
    if (/hero|banner|masthead|jumbotron/.test(blob)) return 'hero'
    if (/feature|benefit|capabilit|grid|columns/.test(blob)) return 'features'
    if (/testimonial|review|quote|customer/.test(blob)) return 'testimonials'
    if (/faq|question|answer/.test(blob)) return 'faq'
    if (/cta|call to action|sign ?up|get started/.test(blob)) return 'cta'
    return 'section'
  }
  const candidates = []
  const seen = new Set()
  const push = (el) => {
    if (!(el instanceof HTMLElement) || seen.has(el)) return
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute('role')
    const chrome = tag === 'header' || tag === 'nav' || tag === 'footer' || role === 'navigation' || role === 'banner' || role === 'contentinfo'
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return
    if (r.width < 300 || r.height < (chrome ? 40 : 120)) return
    seen.add(el)
    candidates.push(el)
  }
  document.querySelectorAll('header, nav, footer, [role="banner"], [role="contentinfo"], main section, main > div, body > section, body > main > div, article > section, [class*="hero"], [class*="section"], [class*="banner"]').forEach(push)
  const h1 = document.querySelector('h1')
  if (h1) {
    const owner = h1.closest('section, header, main > div, body > div')
    if (owner) {
      seen.delete(owner)
      push(owner)
      const index = candidates.indexOf(owner)
      if (index > 0) { candidates.splice(index, 1); candidates.unshift(owner) }
    }
  }
  const kept = []
  for (const el of candidates) {
    if (kept.length >= 10) break
    if (kept.some((k) => k.contains(el) || el.contains(k))) continue
    kept.push(el)
  }
  if (kept.length < 3) {
    const fallback = Array.from(document.querySelectorAll('main > *, body > main > *, body > section, body > div > section'))
      .filter((el) => el instanceof HTMLElement)
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.height >= 240 && r.width >= 600
      })
    for (const el of fallback) {
      if (kept.length >= 5) break
      if (kept.some((k) => k.contains(el) || el.contains(k))) continue
      kept.push(el)
    }
  }
  kept.sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1))

  /* Split page-sized wrappers into their meaningful child blocks. */
  const rawEls = []
  for (const el of kept) {
    const r = el.getBoundingClientRect()
    if (r.height > 3500 && el.children.length >= 2) {
      const children = Array.from(el.children).filter((child) => {
        if (!(child instanceof HTMLElement)) return false
        const cr = child.getBoundingClientRect()
        const cs = getComputedStyle(child)
        return cr.height >= 140 && cr.width >= 400 && cs.display !== 'none'
      })
      if (children.length >= 2) {
        for (const child of children.slice(0, 6)) rawEls.push(child)
        continue
      }
    }
    rawEls.push(el)
  }
  const finalEls = []
  for (const el of rawEls) {
    if (finalEls.some((keptEl) => keptEl === el || keptEl.contains(el) || el.contains(keptEl))) continue
    finalEls.push(el)
  }
  const limitedEls = finalEls.slice(0, 10)
  const h1El = document.querySelector('h1')
  const heroEl = h1El ? h1El.closest('section, header, main > div, body > div') : null

  const sections = limitedEls.map((el, index) => {
    let html = ''
    try { html = el.outerHTML } catch {}
    const kind = kindOf(el)
    const isHero = kind !== 'nav' && kind !== 'footer' && (el === heroEl || (h1El !== null && el.contains(h1El))) && index <= 2
    return {
      id: 'sec_' + (index + 1),
      kind: isHero ? 'hero' : kind,
      bbox: boxOf(el),
      text: textOf(el).slice(0, 240),
      childCount: el.children.length,
      html: html.length > 120000 ? html.slice(0, 120000) : html,
      truncated: html.length > 120000,
    }
  })

  const images = []
  for (const img of document.querySelectorAll('img')) {
    const r = img.getBoundingClientRect()
    if (r.width < 60 || r.height < 40 || getComputedStyle(img).display === 'none') continue
    images.push({ src: String(img.currentSrc || img.src || '').slice(0, 500), alt: String(img.alt || '').slice(0, 120), w: Math.round(r.width), h: Math.round(r.height), bbox: boxOf(img) })
    if (images.length >= 12) break
  }

  const icons = []
  for (const svg of document.querySelectorAll('svg')) {
    const r = svg.getBoundingClientRect()
    if (r.width < 10 || r.width > 140) continue
    let html = ''
    try { html = svg.outerHTML } catch {}
    if (!html || html.length > 16000) continue
    const title = svg.querySelector('title')
    const name = svg.getAttribute('aria-label') || (title && title.textContent) || (svg.getAttribute('class') || 'icon').split(/\s+/)[0]
    icons.push({ name: String(name).slice(0, 40), w: Math.round(r.width), h: Math.round(r.height), svg: html })
    if (icons.length >= 12) break
  }

  const fonts = []
  const seenFont = new Set()
  const walk = (rules) => {
    if (!rules) return
    for (const rule of rules) {
      try {
        if (rule.style && (rule.type === 5 || rule.style.getPropertyValue('src'))) {
          const family = rule.style.getPropertyValue('font-family')
          if (family && !seenFont.has(family)) {
            seenFont.add(family)
            fonts.push({ family: family.replace(/["']/g, '').trim(), src: rule.style.getPropertyValue('src').slice(0, 300) })
          }
        }
        if (rule.cssRules) walk(rule.cssRules)
      } catch {}
    }
  }
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules) } catch {} }

  return {
    sections,
    assets: {
      images,
      icons,
      fonts: fonts.slice(0, 20),
    },
  }
})()`

/** Collect accessible stylesheet text (same-origin + inline) for block previews. */
const CSS_PROBE_JS = String.raw`(() => {
  const out = []
  let total = 0
  const walk = (rules) => {
    for (const rule of rules) {
      try {
        const text = rule.cssText
        if (text) { out.push(text); total += text.length }
        if (rule.cssRules) walk(rule.cssRules)
      } catch {}
      if (total > 600000) return false
    }
    return true
  }
  for (const sheet of document.styleSheets) {
    try { if (!walk(sheet.cssRules || [])) break } catch {}
  }
  return out.join('\n')
})()`

function normHex(hex) {
  const h = hex.replace('#', '')
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}
function lum({ r, g, b }) {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function chroma({ r, g, b }) { return (Math.max(r, g, b) - Math.min(r, g, b)) / 255 }
function deltaE(hexA, hexB) {
  const lab = (hex) => {
    const { r, g, b } = normHex(hex)
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    const R = f(r) * 100, G = f(g) * 100, B = f(b) * 100
    const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 95.047
    const y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 100
    const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 108.883
    const ff = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
    const fx = ff(x), fy = ff(y), fz = ff(z)
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
  }
  const A = lab(hexA), B = lab(hexB)
  return Math.sqrt((A.L - B.L) ** 2 + (A.a - B.a) ** 2 + (A.b - B.b) ** 2)
}
function mergePixel(cssColors, pixels) {
  const result = cssColors.map((c) => ({ ...c, pixelShare: 0 }))
  for (const p of pixels) {
    let best = null, bestD = 12
    for (const c of result) {
      const d = deltaE(c.hex, p.hex)
      if (d < bestD) { bestD = d; best = c }
    }
    if (best) best.pixelShare += p.share
    else result.push({ hex: p.hex, count: 0, area: 0, roles: ['pixel'], samples: [], pixelShare: p.share, pixelOnly: true })
  }
  return result.sort((a, b) => b.pixelShare - a.pixelShare || b.area - a.area)
}

const ASSET_LIMITS = { image: 3 * 1024 * 1024, font: 2 * 1024 * 1024, total: 25 * 1024 * 1024, maxImages: 24, maxFonts: 12 }

function assetExt(url) {
  const match = /\.(png|jpe?g|webp|avif|gif|svg|ico|bmp|woff2|woff|ttf|otf|eot)(?:$|\?)/i.exec(url)
  return match ? '.' + match[1].toLowerCase().replace('jpeg', 'jpg') : null
}

function assetKind(url) {
  const ext = assetExt(url)
  if (ext === null) return null
  return ['.woff2', '.woff', '.ttf', '.otf', '.eot'].includes(ext) ? 'font' : 'image'
}

function collectAssetUrls(text) {
  const urls = new Set()
  const push = (value) => {
    if (typeof value !== 'string') return
    const clean = value.trim().replace(/^['"]|['"]$/g, '')
    if (clean === '' || /^(data:|blob:|about:|javascript:)/i.test(clean) || clean.startsWith('#')) return
    urls.add(clean)
  }
  for (const match of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) push(match[2])
  for (const match of text.matchAll(/\s(?:src|poster)\s*=\s*(["'])([^"']+)\1/gi)) push(match[2])
  for (const match of text.matchAll(/\ssrcset\s*=\s*(["'])([^"']+)\1/gi)) {
    for (const part of match[2].split(',')) push(part.trim().split(/\s+/)[0])
  }
  return [...urls]
}

async function fetchAsset(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (StyleScout capture)' },
    })
    if (!response.ok) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0) return null
    return { buffer, contentType: response.headers.get('content-type') || '' }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Download referenced images/fonts next to the capture, rewrite HTML/CSS to the
 * local file URLs, and write an assets manifest (source URL + license note).
 * Best-effort: individual failures are skipped.
 */
export async function localizeAssets({ dir, pageUrl, cssFile = 'page.css' }) {
  const capId = path.basename(dir)
  const pageCssPath = path.join(dir, cssFile)
  const files = []
  try {
    const pageCss = await fs.readFile(pageCssPath, 'utf8')
    if (pageCss !== '') files.push({ file: pageCssPath, text: pageCss })
  } catch {}
  const sectionsDir = path.join(dir, 'sections')
  try {
    for (const name of await fs.readdir(sectionsDir)) {
      if (!name.endsWith('.html')) continue
      const file = path.join(sectionsDir, name)
      files.push({ file, text: await fs.readFile(file, 'utf8') })
    }
  } catch {}

  const seen = new Set()
  const candidates = []
  for (const entry of files) {
    for (const raw of collectAssetUrls(entry.text)) {
      let absolute
      try { absolute = new URL(raw, pageUrl).href } catch { continue }
      if (!/^https?:/i.test(absolute)) continue
      const kind = assetKind(absolute)
      if (kind === null || seen.has(absolute)) continue
      seen.add(absolute)
      candidates.push({ raw, absolute, kind })
    }
  }

  const replacements = new Map()
  const assets = []
  const counts = { image: 0, font: 0 }
  let totalBytes = 0
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true })
  for (const candidate of candidates) {
    if (totalBytes > ASSET_LIMITS.total) break
    if (candidate.kind === 'image' && counts.image >= ASSET_LIMITS.maxImages) continue
    if (candidate.kind === 'font' && counts.font >= ASSET_LIMITS.maxFonts) continue
    const fetched = await fetchAsset(candidate.absolute)
    if (fetched === null) continue
    const limit = candidate.kind === 'font' ? ASSET_LIMITS.font : ASSET_LIMITS.image
    if (fetched.buffer.length > limit) continue
    const hash = createHash('sha1').update(candidate.absolute).digest('hex').slice(0, 12)
    const ext = assetExt(candidate.absolute) || (candidate.kind === 'font' ? '.woff2' : '.bin')
    const file = 'assets/' + hash + ext
    await fs.writeFile(path.join(dir, file), fetched.buffer)
    totalBytes += fetched.buffer.length
    counts[candidate.kind] += 1
    assets.push({
      file,
      sourceUrl: candidate.absolute,
      kind: candidate.kind,
      bytes: fetched.buffer.length,
      contentType: fetched.contentType,
      license: 'unknown',
    })
    const localUrl = '/style-scout/files/captures/' + capId + '/' + file
    replacements.set(candidate.raw, localUrl)
    replacements.set(candidate.absolute, localUrl)
  }

  if (replacements.size > 0) {
    const rewrite = (text) => {
      let out = text
      for (const [from, to] of replacements) {
        if (out.includes(from)) out = out.split(from).join(to)
      }
      return out
    }
    for (const entry of files) {
      const next = rewrite(entry.text)
      if (next !== entry.text) await fs.writeFile(entry.file, next, 'utf8')
    }
  }

  const manifest = {
    schema: 'style-scout/assets@1',
    source: pageUrl,
    capturedAt: new Date().toISOString(),
    licenseNote: 'Downloaded from the source page for local preview/reference. Verify licence before redistribution.',
    totalBytes,
    counts,
    assets,
  }
  await fs.writeFile(path.join(dir, 'assets', 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return manifest
}

async function localizeUiDocument(doc, dir, manifest) {
  const capId = path.basename(dir), resources = new Set(), map = new Map()
  for (const asset of manifest?.assets || []) map.set(asset.sourceUrl, '/style-scout/files/captures/' + capId + '/' + asset.file)
  const scan = value => {
    if (!value || typeof value !== 'object') return
    if (value.attrs?.src) resources.add(value.attrs.src)
    for (const item of Object.values(value)) {
      if (typeof item === 'string') {
        for (const match of item.matchAll(/url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^'"\)\s]+))\s*\)/g)) {
          const url=match[1]??match[2]??match[3]
          if (!url.startsWith('#')) resources.add(url)
        }
      } else if (item && typeof item === 'object') scan(item)
    }
  }
  scan(doc)
  let missing = 0, total = 0
  const todo = [...resources].slice(0, 96)
  const extByType = { 'image/png':'.png', 'image/jpeg':'.jpg', 'image/webp':'.webp', 'image/svg+xml':'.svg', 'image/gif':'.gif', 'image/avif':'.avif', 'font/woff2':'.woff2', 'font/woff':'.woff', 'font/ttf':'.ttf', 'font/otf':'.otf' }
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true })
  let cursor = 0
  await Promise.all(Array.from({length:4}, async () => {
    while (cursor < todo.length) {
      const raw = todo[cursor++]; let absolute
      try { absolute = new URL(raw, doc.source).href } catch { missing++; continue }
      if (map.has(absolute)) { map.set(raw, map.get(absolute)); continue }
      if (total > 40 * 1024 * 1024) { missing++; continue }
      let fetched
      if (absolute.startsWith('data:image/')) {
        try { const m = absolute.match(/^data:([^,]+),(.*)$/s); fetched = { contentType:m[1].split(';')[0], buffer:/(?:^|;)base64(?:;|$)/i.test(m[1]) ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2])) } } catch {}
      } else if (/^https?:/.test(absolute)) fetched = await fetchAsset(absolute)
      const ext = fetched && (extByType[fetched.contentType.split(';')[0]] || assetExt(absolute))
      if (!fetched || !ext || fetched.buffer.length > 8 * 1024 * 1024) { missing++; continue }
      total += fetched.buffer.length
      const file = 'ui-' + createHash('sha1').update(absolute).digest('hex').slice(0,16) + ext
      await fs.writeFile(path.join(dir, 'assets', file), fetched.buffer)
      map.set(raw, '/style-scout/files/captures/' + capId + '/assets/' + file)
    }
  }))
  const rewrite = value => {
    if (typeof value === 'string') { let text = value; for(const [from,to] of map) text = text.split(from).join(to); return text }
    if (Array.isArray(value)) return value.map(rewrite)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rewrite(v)]))
    return value
  }
  Object.assign(doc, rewrite(doc))
  if (missing || resources.size > 96) doc.warnings.push('部分图片或字体未能保存到本机，可能显示为空白或替代字体（' + (missing + Math.max(0,resources.size - 96)) + ' 项）')
}

export async function capture(url, options = {}) {
  if (typeof options.outDir !== "string" || options.outDir === "") throw new Error("capture: options.outDir is required")
  const slug = options.slug || slugify(url)
  const dir = path.join(options.outDir, options.dir || slug)
  await fs.mkdir(dir, { recursive: true })
  const { child, port, userDataDir } = await launchChrome(resolveChrome(options))
  let cdp
  let phase = '打开网页'
  try {
    const wsUrl = await pageWS(port)
    cdp = new CDP(wsUrl)
    await cdp.ready
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Page.bringToFront')
    const navigation = await cdp.send('Page.navigate', { url })
    if (navigation.errorText) throw new Error('网页未能打开：' + navigation.errorText)
    for (let i = 0; i < 120; i++) {
      const state = await cdp.eval('document.readyState').catch(() => null)
      if (state === 'complete') break
      await sleep(250)
    }
    await sleep(800)
    await cdp.eval(`Promise.race([document.fonts.ready.then(() => true), new Promise(r => setTimeout(() => r(false), 8000))])`, { awaitPromise: true }).catch(() => {})
    /* Fail loudly on Chromium error pages instead of storing them as a capture. */
    const loadFailure = await cdp.eval(`(() => {
      const t = document.title || ''
      const err = document.querySelector('#main-frame-error, .interstitial-wrapper')
      return err ? (t || 'error page') : null
    })()`).catch(() => null)
    if (loadFailure) throw new Error('capture: page failed to load (' + loadFailure + ')')
    // Hydrated sites may keep their headline transparent after load/fonts-ready.
    // Wait for actual readable first-screen content, without unhiding hidden UI.
    const contentReady=await cdp.eval(`(async()=>{
      const ready=()=>{
        const heading=[...document.querySelectorAll('h1')].find(e=>{const r=e.getBoundingClientRect();return r.width>10&&r.height>10});if(!heading||!heading.textContent.trim())return true;
        const walker=document.createTreeWalker(heading,NodeFilter.SHOW_TEXT);
        while(walker.nextNode()){
          if(!walker.currentNode.textContent.trim())continue;
          const range=document.createRange();range.selectNodeContents(walker.currentNode);const r=range.getBoundingClientRect();
          if(r.width<5||r.height<5)continue;
          let visible=true;for(let el=walker.currentNode.parentElement;el;el=el.parentElement){const s=getComputedStyle(el),b=el.getBoundingClientRect();if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)<.95||((s.overflow==='hidden'||s.clip!=='auto'||s['clip-path']!=='none')&&(b.width<5||b.height<5))){visible=false;break}}
          if(visible)return true;
        }return false;
      };
      for(let i=0;i<160;i++){if(ready())return true;await new Promise(r=>setTimeout(r,250));}
      return false;
    })()`,{awaitPromise:true})
    if(!contentReady)throw new Error('网页正文仍未显示完成，请稍后重新提取')
    // 滚动触发懒加载
    await cdp.eval(`(async () => {
      const h = Math.min(document.documentElement.scrollHeight, 16000);
      for (let y = 0; y < h; y += 700) { window.scrollTo({top:y,behavior:'instant'}); await new Promise(r => setTimeout(r, 120)); }
      window.scrollTo({top:0,behavior:'instant'});
      await new Promise(r => setTimeout(r, 1200));
      await Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,8000))]);
      // Freeze the same visual state for the editable tree and its reference
      // screenshot. Finish entry animations; pause infinite decorations in place.
      for (const animation of document.getAnimations()) {
        try { if(Number.isFinite(animation.effect.getComputedTiming().endTime))animation.finish();animation.pause(); } catch {}
      }
      window.scrollTo({top:0,behavior:'instant'});
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      return true;
    })()`, { awaitPromise: true })
    phase = '提取界面元素'
    const raw = await cdp.eval(COLLECT_JS)
    const components = await cdp.eval(COMPONENT_PROBE_JS).catch(() => null)
    const structure = await cdp.eval(SECTION_PROBE_JS).catch(() => null)
    const pageCss = await cdp.eval(CSS_PROBE_JS).catch(() => '')
    const uiDocument = await cdp.evalJson('(' + extractUiDocument.toString() + ')()')
    // 截图
    phase = '保存网页截图'
    const metrics = await cdp.send('Page.getLayoutMetrics')
    const content = metrics.cssContentSize || metrics.contentSize
    const fullHeight = Math.min(Math.max(content.height, 900), 8000)
    const vp = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await fs.writeFile(path.join(dir, 'viewport.png'), Buffer.from(vp.data, 'base64'))
    const full = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1440, height: fullHeight, scale: 1 },
    })
    const fullBuf = Buffer.from(full.data, 'base64')
    await fs.writeFile(path.join(dir, 'full.png'), fullBuf)

    /* V2: block screenshots + asset thumbnails (bounded so a capture stays small). */
    const sections = []
    const sectionProbe = (structure && Array.isArray(structure.sections)) ? structure.sections : []
    if (sectionProbe.length > 0) await fs.mkdir(path.join(dir, 'sections'), { recursive: true })
    for (const section of sectionProbe.slice(0, 8)) {
      const sectionOut = { ...section, shot: null, htmlFile: null }
      try {
        const clip = {
          x: section.bbox.x,
          y: section.bbox.y,
          width: Math.max(1, Math.min(section.bbox.w || 1440, 1440)),
          height: Math.max(1, Math.min(section.bbox.h || 900, 2200)),
          scale: 0.5,
        }
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip })
        const file = `sections/${section.id}.png`
        await fs.writeFile(path.join(dir, file), Buffer.from(shot.data, 'base64'))
        sectionOut.shot = file
      } catch {
        sectionOut.shot = null
      }
      /* Markup lives next to the screenshot, not inside JSON (keeps capture.json light). */
      if (typeof section.html === 'string' && section.html.length > 0) {
        const htmlFile = `sections/${section.id}.html`
        await fs.writeFile(path.join(dir, htmlFile), section.html, 'utf8')
        sectionOut.htmlFile = htmlFile
      }
      delete sectionOut.html
      sections.push(sectionOut)
    }

    const assets = { images: [], icons: [], fonts: [] }
    const probeAssets = (structure && structure.assets) || {}
    assets.icons = Array.isArray(probeAssets.icons) ? probeAssets.icons : []
    assets.fonts = Array.isArray(probeAssets.fonts) ? probeAssets.fonts : []
    const probeImages = Array.isArray(probeAssets.images) ? probeAssets.images.slice(0, 10) : []
    if (probeImages.length > 0) await fs.mkdir(path.join(dir, 'assets'), { recursive: true })
    for (const [index, image] of probeImages.entries()) {
      try {
        const clip = {
          x: image.bbox.x,
          y: image.bbox.y,
          width: Math.max(1, Math.min(image.bbox.w || 800, 1200)),
          height: Math.max(1, Math.min(image.bbox.h || 600, 800)),
          scale: 0.25,
        }
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip })
        const file = `assets/img_${index + 1}.png`
        await fs.writeFile(path.join(dir, file), Buffer.from(shot.data, 'base64'))
        assets.images.push({ ...image, thumb: file })
      } catch {
        assets.images.push({ ...image, thumb: null })
      }
    }
    let cssFile = null
    if (typeof pageCss === 'string' && pageCss.length > 0) {
      cssFile = 'page.css'
      await fs.writeFile(path.join(dir, cssFile), pageCss, 'utf8')
    }

    /* Localize images/fonts next to the capture and rewrite URLs. */
    phase = '保存界面素材'
    let localAssets = null
    try {
      localAssets = await localizeAssets({ dir, pageUrl: url, cssFile })
    } catch { /* best-effort: keep the capture even without localized assets */ }
    await localizeUiDocument(uiDocument, dir, localAssets)
    await fs.writeFile(path.join(dir, 'ui.json'), JSON.stringify(uiDocument), 'utf8')

    // 像素覆盖（全页截图缩样）
    const dataUrl = 'data:image/png;base64,' + full.data
    let pixels = []
    try { pixels = await cdp.eval(`(${PIXEL_JS})(${JSON.stringify(dataUrl)})`, { awaitPromise: true }) } catch { /* pixel sampling is best-effort */ }
    const colors = mergePixel(raw.colors, pixels)
    const capture = {
      schema: 'style-scout/capture@0.1',
      slug,
      source: { url, capturedAt: new Date().toISOString() },
      meta: { ...raw.meta, fullHeight },
      frameworks: raw.frameworks,
      components,
      sections,
      assets,
      cssVars: raw.cssVars || {},
      colors,
      fonts: raw.fonts,
      sizes: raw.sizes,
      spacings: raw.spacings,
      radii: raw.radii,
      containers: raw.containers,
      breakpoints: raw.breakpoints,
      screenshots: { viewport: 'viewport.png', full: 'full.png' },
      cssFile,
      localAssets,
      editableUi: { file: 'ui.json', count: uiDocument.count, warnings: uiDocument.warnings },
    }
    // 同时写一份 design-studio 兼容的 tokens 摘要（给 normalize 用）
    const pickBg = colors.find((c) => c.roles.includes('background') && chroma(normHex(c.hex)) < 0.2) || colors[0]
    const pickText = colors.find((c) => c.roles.includes('text') && c.hex !== pickBg.hex) || colors[1] || pickBg
    const varAccentEntry = Object.entries(raw.cssVars || {}).find(([k, v]) => /accent|brand|primary|link/i.test(k) && chroma(normHex(v)) >= 0.12)
    const actionAccents = colors.filter((c) => c.roles.includes('action') && chroma(normHex(c.hex)) >= 0.14 && (c.pixelShare || 0) >= 0.0002)
    const accentPool = actionAccents.length
      ? actionAccents
      : colors.filter((c) => chroma(normHex(c.hex)) >= 0.16 && (c.pixelShare || 0) >= 0.002)
    const pickAccent = varAccentEntry
      ? { hex: varAccentEntry[1] }
      : [...accentPool].sort((a, b) => chroma(normHex(b.hex)) - chroma(normHex(a.hex)) || b.area - a.area)[0]
    const pickSurface = colors.find((c) => c.hex !== pickBg.hex && chroma(normHex(c.hex)) < 0.2 && Math.abs(lum(normHex(c.hex)) - lum(normHex(pickBg.hex))) > 0.005 && Math.abs(lum(normHex(c.hex)) - lum(normHex(pickBg.hex))) < 0.2) || pickBg
    const fontFamilies = [...new Map(raw.fonts.map((f) => [f.family, f])).values()]
    const display = fontFamilies[0] || { family: '' }
    const body = fontFamilies[1] || display
    const mono = fontFamilies.find((f) => /mono|code/i.test(f.family)) || { family: '' }
    const tokens = {
      name: raw.meta.title || url,
      source: { kind: 'url', ref: url, at: new Date().toISOString() },
      color: {
        bg: pickBg.hex, surface: pickSurface.hex, ink: pickText.hex,
        muted: pickText.hex, accent: pickAccent?.hex || pickText.hex, border: pickSurface.hex,
        extra: colors.slice(0, 12).map((c) => c.hex),
      },
      font: {
        display: { family: display.family, stack: display.family, weights: [display.weight].filter(Boolean) },
        body: { family: body.family, stack: body.family, weights: [body.weight].filter(Boolean) },
        mono: { family: mono.family, stack: mono.family, weights: [mono.weight].filter(Boolean) },
      },
      size: { scale: raw.sizes.map((s) => s.px).sort((a, b) => a - b) },
      space: { scale: raw.spacings.map((s) => s.px).sort((a, b) => a - b) },
      radius: { scale: raw.radii.map((s) => s.px).sort((a, b) => a - b) },
      layout: { maxWidth: raw.containers[0]?.width || null, gutter: null, breakpoints: raw.breakpoints },
      usage: {
        colors: colors.slice(0, 120).map((c) => ({ hex: c.hex, count: c.count, area: Math.round(c.area), pixelShare: +(c.pixelShare || 0).toFixed(5), roles: c.roles, samples: c.samples })),
        fonts: raw.fonts,
        sizes: raw.sizes,
        spacings: raw.spacings,
        radii: raw.radii,
        containers: raw.containers,
        pixelTop: pixels.slice(0, 40),
        cssVars: raw.cssVars || {},
      },
    }
    await fs.writeFile(path.join(dir, 'capture.json'), JSON.stringify(capture, null, 2), 'utf8')
    await fs.writeFile(path.join(dir, 'tokens.json'), JSON.stringify(tokens, null, 2), 'utf8')
    return { slug, dir, capture, tokens }
  } catch (error) {
    throw new Error(phase + '失败：' + error.message, {cause: error})
  } finally {
    try { cdp?.close() } catch {}
    try { child.kill() } catch {}
    await sleep(300)
    fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {})
  }
}

