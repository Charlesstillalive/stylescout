/**
 * StyleScout DNA normalizer (host side).
 *
 * Vendored from experiments/dna-normalize/normalize.mjs (usage-aware prototype):
 * pixel-share weighted palette, dark/light layer detection, accent candidates,
 * type scale snapping, 4px spacing grid, radius roles.
 */
/* ---------------- color utils ---------------- */

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  }
}
function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase()
}
function mixHex(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b)
  return rgbToHex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t })
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

function linearize(v) {
  v /= 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
function relLuminance(rgb) {
  const r = linearize(rgb.r), g = linearize(rgb.g), b = linearize(rgb.b)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const L1 = relLuminance(a), L2 = relLuminance(b)
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2)
  return (hi + 0.05) / (lo + 0.05)
}
function rgbToXyz({ r, g, b }) {
  const R = linearize(r) * 100, G = linearize(g) * 100, B = linearize(b) * 100
  return {
    x: R * 0.4124 + G * 0.3576 + B * 0.1805,
    y: R * 0.2126 + G * 0.7152 + B * 0.0722,
    z: R * 0.0193 + G * 0.1192 + B * 0.9505,
  }
}
function xyzToLab({ x, y, z }) {
  const ref = { x: 95.047, y: 100, z: 108.883 }
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x / ref.x), fy = f(y / ref.y), fz = f(z / ref.z)
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}
function rgbToLab(rgb) { return xyzToLab(rgbToXyz(rgb)) }
function deltaE(a, b) {
  const A = rgbToLab(a), B = rgbToLab(b)
  return Math.sqrt((A.L - B.L) ** 2 + (A.a - B.a) ** 2 + (A.b - B.b) ** 2)
}
function chroma(rgb) {
  const { r, g, b } = rgb
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  return (max - min) / 255
}
function hsl(rgb) {
  const { r, g, b } = rgb
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 510
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)) / 255
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s, l }
}
function hueName(h) {
  if (h < 15 || h >= 345) return 'red'
  if (h < 40) return 'orange'
  if (h < 65) return 'amber'
  if (h < 95) return 'yellow-green'
  if (h < 150) return 'green'
  if (h < 185) return 'teal'
  if (h < 215) return 'cyan-blue'
  if (h < 250) return 'blue'
  if (h < 280) return 'indigo'
  if (h < 310) return 'purple'
  if (h < 345) return 'pink'
  return 'neutral'
}

/* ---------------- typography ---------------- */

const GENERIC_FAMILIES = new Set([
  '-apple-system', 'blinkmacsystemfont', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace',
  'sans-serif', 'serif', 'monospace', 'segoe ui', 'arial', 'helvetica', 'helvetica neue',
  'times new roman', 'courier new', 'noto sans', 'noto sans sc', 'pingfang sc', 'microsoft yahei',
  'simsun', 'sans', 'inherit',
])
function cleanFamily(family) {
  if (!family) return { family: '', generic: true }
  const first = String(family).split(',')[0].trim().replace(/^["']|["']$/g, '')
  return { family: first, generic: GENERIC_FAMILIES.has(first.toLowerCase()) }
}
function uniq(arr) { return [...new Set(arr)] }
function sortNum(arr) { return [...arr].sort((a, b) => a - b) }

const WEB_TYPE_SCALE = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 56, 64, 72, 80, 96, 120]
function suggestTypeScale(sizes) {
  const snapped = sizes.map((raw) => {
    let best = raw
    let bestDist = Infinity
    for (const c of WEB_TYPE_SCALE) {
      const d = Math.abs(raw - c)
      if (d < bestDist) { bestDist = d; best = c }
    }
    return bestDist <= 1.6 ? best : Math.round(raw)
  })
  return sortNum(uniq(snapped))
}
function typeRoles(scale) {
  const roles = { display: [], h1: [], h2: [], h3: [], body: [], bodySmall: [], caption: [] }
  for (const s of scale) {
    if (s >= 48) roles.display.push(s)
    else if (s >= 32) roles.h1.push(s)
    else if (s >= 24) roles.h2.push(s)
    else if (s >= 20) roles.h3.push(s)
    else if (s >= 15) roles.body.push(s)
    else if (s >= 13) roles.bodySmall.push(s)
    else roles.caption.push(s)
  }
  return roles
}

/* ---------------- normalize ---------------- */

function buildColorModel(raw) {
  const entries = []
  const add = (hex, role, weight = 1) => {
    if (!hex || typeof hex !== 'string' || !/^#[0-9a-f]{3,8}$/i.test(hex)) return
    const rgb = hexToRgb(hex)
    entries.push({
      hex: rgbToHex(rgb), rgb, role, weight,
      roles: new Set([role]), pixelShare: 0, area: 0, count: 0,
    })
  }
  const c = raw.color || {}
  // 有 usage 时：用真实使用数据建 palette（面积/出现次数/像素占比）
  if (raw.usage?.colors?.length) {
    for (const u of raw.usage.colors) {
      if (!u?.hex || !/^#[0-9a-f]{3,8}$/i.test(u.hex)) continue
      const rgb = hexToRgb(u.hex)
      entries.push({
        hex: rgbToHex(rgb),
        rgb,
        role: (u.roles || [])[0] || 'usage',
        weight: 1 + (u.pixelShare || 0) * 200 + Math.log10((u.area || 0) + 1) / 20,
        roles: new Set(u.roles || []),
        pixelShare: u.pixelShare || 0,
        area: u.area || 0,
        count: u.count || 0,
      })
    }
    for (const [hex, role] of [[c.bg, 'background'], [c.surface, 'surface'], [c.ink, 'text'], [c.muted, 'muted'], [c.border, 'border'], [c.accent, 'accent']]) add(hex, role, 1)
  } else {
    add(c.bg, 'background', 3)
    add(c.surface, 'surface', 2)
    add(c.ink, 'text', 2)
    add(c.muted, 'muted', 1)
    add(c.border, 'border', 1)
    add(c.accent, 'accent', 2)
    for (const x of c.extra || []) add(x, 'extra', 1)
  }

  // 去重（ΔE < 5）
  const merged = []
  for (const e of entries) {
    const hit = merged.find((m) => deltaE(m.rgb, e.rgb) < 5)
    if (hit) {
      hit.weight += e.weight
      e.roles.forEach((r) => hit.roles.add(r))
      hit.pixelShare += e.pixelShare || 0
      hit.area += e.area || 0
      hit.count += e.count || 0
    } else {
      merged.push({ ...e, roles: new Set(e.roles) })
    }
  }
  for (const m of merged) {
    m.lum = relLuminance(m.rgb)
    m.chroma = chroma(m.rgb)
    const { h, s } = hsl(m.rgb)
    m.hue = h
    m.hueName = m.chroma < 0.12 ? 'neutral' : hueName(h)
    m.saturation = s
  }

  let darkBg = null
  let lightBg = null
  if (raw.usage?.colors?.length) {
    const neutrals = merged.filter((e) => e.chroma < 0.16)
    darkBg = neutrals.filter((e) => e.lum < 0.4).sort((a, b) => (b.pixelShare || 0) - (a.pixelShare || 0) || a.lum - b.lum)[0] || null
    lightBg = neutrals.filter((e) => e.lum > 0.6 && (e.pixelShare || 0) >= 0.02).sort((a, b) => (b.pixelShare || 0) - (a.pixelShare || 0) || b.lum - a.lum)[0] || null
  } else {
    darkBg = [...merged].filter((e) => e.chroma < 0.14).sort((a, b) => a.lum - b.lum || b.weight - a.weight)[0] || null
    lightBg = [...merged]
      .filter((e) => e.chroma < 0.16 && e.lum > 0.7 && e.weight >= 2)
      .sort((a, b) => b.lum - a.lum || b.weight - a.weight)[0] || null
  }

  function makeLayer(background) {
    const rest = merged.filter((e) => e !== background)
    const textPool = rest.filter((e) => e.roles?.has('text'))
    const text =
      (raw.usage ? [...textPool].sort((a, b) => (b.area || 0) - (a.area || 0))[0] : null) ||
      [...rest].sort((a, b) => contrast(b.rgb, background.rgb) - contrast(a.rgb, background.rgb))[0] ||
      background
    const surfacePool = rest.filter((e) => e.roles?.has('background') && Math.abs(e.lum - background.lum) > 0.003 && Math.abs(e.lum - background.lum) <= 0.06)
    let surface =
      (raw.usage
        ? [...surfacePool].sort((a, b) => (b.pixelShare || 0) - (a.pixelShare || 0) || Math.abs(Math.abs(a.lum - background.lum) - 0.03) - Math.abs(Math.abs(b.lum - background.lum) - 0.03))[0]
        : null) ||
      [...rest]
        .filter((e) => {
          const d = Math.abs(e.lum - background.lum)
          return d >= 0.003 && d <= 0.06
        })
        .sort((a, b) => Math.abs(Math.abs(a.lum - background.lum) - 0.03) - a.weight * 0.002 - (Math.abs(Math.abs(b.lum - background.lum) - 0.03) - b.weight * 0.002))[0] ||
      null
    if (surface && contrast(text.rgb, surface.rgb) < 4.5) surface = null
    if (!surface) {
      const derived = mixHex(background.hex, text.hex, background.lum < 0.4 ? 0.07 : 0.04)
      surface = { hex: derived, rgb: hexToRgb(derived) }
    }
    const mutedPool = rest.filter((e) => e !== text && e.chroma < 0.22 && contrast(e.rgb, background.rgb) >= 3)
    const muted = [...(mutedPool.length ? mutedPool : rest.filter((e) => e !== text))]
      .sort((a, b) => Math.abs(contrast(a.rgb, background.rgb) - 4.5) - a.weight * 0.02 - (Math.abs(contrast(b.rgb, background.rgb) - 4.5) - b.weight * 0.02))[0] || text
    const borderPool = rest.filter((e) => e.chroma < 0.2 && deltaE(e.rgb, background.rgb) >= 6)
    let border = [...borderPool].sort((a, b) => Math.abs(deltaE(a.rgb, background.rgb) - 14) - a.weight * 0.2 - (Math.abs(deltaE(b.rgb, background.rgb) - 14) - b.weight * 0.2))[0]
    if (!border || deltaE(border.rgb, background.rgb) > 40) border = { hex: mixHex(background.hex, text.hex, 0.14), rgb: hexToRgb(mixHex(background.hex, text.hex, 0.14)) }
    const roleHex = (e) => (e ? e.hex : null)
    return {
      background: roleHex(background),
      surface: roleHex(surface),
      text: roleHex(text),
      muted: roleHex(muted),
      border: roleHex(border),
      contrast: {
        textOnBackground: round(contrast(text.rgb, background.rgb), 2),
        textOnSurface: round(contrast(text.rgb, surface.rgb), 2),
        mutedOnBackground: round(contrast(muted.rgb, background.rgb), 2),
        textOnBackground_passesAA: contrast(text.rgb, background.rgb) >= 4.5,
      },
      _objects: { background, surface, text, muted, border },
    }
  }

  const dark = darkBg && darkBg.lum < 0.4 ? makeLayer(darkBg) : null
  const light = lightBg && (!dark || lightBg.lum - darkBg.lum > 0.4) ? makeLayer(lightBg) : null
  const mode = dark && light ? 'dual' : dark ? 'dark' : 'light'

  const chromatic = merged.filter((e) => e.chroma >= 0.16 && e.lum > 0.05 && e.lum < 0.92)
  let accent = null
  let accentList = []
  if (raw.usage?.colors?.length) {
    const visible = chromatic.filter((e) => (e.pixelShare || 0) >= 0.002)
    accentList = [...chromatic].sort((a, b) => (b.pixelShare || 0) - (a.pixelShare || 0) || (b.area || 0) - (a.area || 0) || b.chroma - a.chroma)
    accent = [...visible].sort((a, b) => b.chroma * b.weight - a.chroma * a.weight)[0] || null
  } else {
    accentList = [...chromatic].sort((a, b) => b.chroma * b.weight - a.chroma * a.weight)
    accent = accentList[0] || null
  }
  const accentTextPool = accent ? merged.filter((e) => contrast(e.rgb, accent.rgb) >= 4.5) : []
  const accentText = accent ? accentTextPool.sort((a, b) => contrast(b.rgb, accent.rgb) - contrast(a.rgb, accent.rgb))[0] : null

  const warnings = []
  if (mode === 'dual') warnings.push('检测到深色与浅色两层表面；原始角色（bg/surface/ink）可能来自不同层，已按亮度重新分层。')
  if (!accent) {
    warnings.push(raw.usage
      ? '页面内没有面积足够的强调色（像素占比 <0.2%），强调色需从品牌资产或交互元素人工指定。'
      : '未提取到高彩度强调色，建议从 Logo/品牌资产补采。')
  }
  if (accent && accent.chroma < 0.25) warnings.push(`强调色彩度偏低（${accent.hex}），可能不是品牌主色。`)
  if (dark && !dark.contrast.textOnBackground_passesAA) warnings.push(`深色层正文对比度 ${dark.contrast.textOnBackground} 未达 AA。`)
  if (light && !light.contrast.textOnBackground_passesAA) warnings.push(`浅色层正文对比度 ${light.contrast.textOnBackground} 未达 AA。`)
  if (light && lightBg && raw.color?.ink) {
    const rawInk = hexToRgb(raw.color.ink)
    if (relLuminance(rawInk) > 0.5 && lightBg.lum > 0.9) {
      warnings.push('浅色层证据偏弱：原始 ink 也是亮色，白色可能只是文字/描边，不一定存在独立浅色区块。')
    }
  }

  return {
    mode,
    layers: { ...(dark ? { dark: stripInternal(dark) } : {}), ...(light ? { light: stripInternal(light) } : {}) },
    accent: accent
      ? {
          hex: accent.hex,
          hue: accent.hueName,
          chroma: round(accent.chroma, 3),
          onAccent: accentText ? accentText.hex : null,
        }
      : null,
    accentCandidates: accentList.slice(0, 6).map((e) => ({
      hex: e.hex,
      hue: e.hueName,
      chroma: round(e.chroma, 3),
      pixelShare: round(e.pixelShare || 0, 4),
      area: Math.round(e.area || 0),
    })),
    spectrum: [...merged]
      .sort((a, b) => b.weight - a.weight || b.lum - a.lum)
      .map((e) => ({
        hex: e.hex,
        luminance: round(e.lum, 3),
        chroma: round(e.chroma, 3),
        hue: e.hueName,
        roles: [...e.roles],
      })),
    warnings,
  }
}

function stripInternal(layer) {
  const { _objects, ...rest } = layer
  return rest
}
function round(v, n = 2) { const p = 10 ** n; return Math.round(v * p) / p }

function normalizeSpacing(raw) {
  const usage = raw.usage?.spacings
  const values = (usage ? usage.map((s) => s.px) : raw.space?.scale || []).filter((v) => Number.isFinite(v) && v > 0)
  const counts = new Map((usage || []).map((s) => [s.px, s.count]))
  const snapped = new Set()
  const mapping = {}
  const snapCounts = {}
  for (const v of values) {
    const s = v <= 3 ? 2 : Math.round(v / 4) * 4
    snapped.add(s)
    mapping[s] = [...(mapping[s] || []), v]
    snapCounts[s] = (snapCounts[s] || 0) + (counts.get(v) || 0)
  }
  const entries = [...snapped].map((px) => ({ px, count: snapCounts[px] || 0 }))
  const core = entries.filter((e) => e.px <= 64 && e.count >= 2).sort((a, b) => b.count - a.count).slice(0, 10).sort((a, b) => a.px - b.px)
  const sectionGaps = entries.filter((e) => e.px >= 80).sort((a, b) => a.px - b.px)
  const scale = core.map((e) => e.px)
  return {
    baseUnit: 4,
    scale,
    sectionGaps,
    raw: sortNum(uniq(values)),
    mapping,
    counts: snapCounts,
    note: '原始值为 computed 像素；已吸附到 4px 栅格；≤64px 且出现≥2次进入 scale，≥80px 归为 sectionGaps；counts 为使用次数。',
  }
}

function normalizeRadius(raw) {
  const values = (raw.radius?.scale || []).filter((v) => Number.isFinite(v) && v > 0)
  const snapped = values.map((v) => {
    if (v >= 999) return 999
    if (v >= 40) return 999 // 45/50 这类通常是圆形头像/胶囊，不是 45px 圆角
    return Math.max(2, Math.round(v / 2) * 2)
  })
  const scale = sortNum(uniq(snapped))
  const nonPill = scale.filter((v) => v < 999)
  return {
    scale,
    roles: {
      small: nonPill[0] ?? null,
      medium: nonPill[Math.floor(nonPill.length / 2)] ?? null,
      large: nonPill[nonPill.length - 1] ?? null,
      pill: scale.includes(999) ? 999 : nonPill[nonPill.length - 1] ?? null,
    },
    raw: sortNum(uniq(values)),
    note: '>=40px 视为大圆角/胶囊候选；999 视为 pill。',
  }
}

function normalizeLayout(raw) {
  const bp = (raw.layout?.breakpoints || []).filter(Number.isFinite)
  const CANON_BP = [320, 375, 480, 640, 768, 1024, 1280, 1440]
  const snappedBp = bp.map((v) => {
    const nearest = CANON_BP.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a))
    return Math.abs(nearest - v) <= 16 ? nearest : v
  })
  const clustered = []
  for (const v of sortNum(uniq(snappedBp))) {
    const prev = clustered[clustered.length - 1]
    if (prev !== undefined && v - prev <= 8) continue
    clustered.push(v)
  }
  return {
    maxWidth: raw.layout?.maxWidth ?? null,
    gutter: raw.layout?.gutter ? raw.layout.gutter : null,
    breakpoints: clustered,
    note: raw.layout?.gutter === 0 ? 'gutter=0 表示在 body 上取值，不代表真实容器留白，已置空。' : '',
  }
}

function normalizeTypography(raw) {
  const font = raw.font || {}
  const families = {}
  const warnings = []
  for (const role of ['display', 'body', 'mono']) {
    const { family, generic } = cleanFamily(font[role]?.family || font[role]?.stack)
    families[role] = {
      family,
      generic,
      weights: sortNum(uniq((font[role]?.weights || []).filter(Number.isFinite))),
    }
    if (generic && family) warnings.push(`${role} 字体落在系统兜底 "${family}"，不是品牌字体。`)
  }
  if (families.display.family && families.body.family && families.display.family === families.body.family) {
    warnings.push('display 与 body 使用同一字体，层级靠字号/字重区分。')
  }
  if (families.display.generic && !families.body.generic) {
    warnings.push('display 仅取到兜底字体；已保留原值，建议用 body 字体或品牌字体覆盖。')
  }
  let sizes
  if (raw.usage?.sizes?.length) {
    const usageSizes = raw.usage.sizes.filter((s) => Number.isFinite(s.px))
    const totalChars = usageSizes.reduce((a, s) => a + (s.chars || s.count || 0), 0) || 1
    const maxSane = Math.max(...usageSizes.filter((s) => s.px <= 120).map((s) => s.px), 0)
    const kept = usageSizes.filter(
      (s) => (s.chars || s.count || 0) >= totalChars * 0.02 || (maxSane > 0 && s.px >= maxSane * 0.6 && s.count >= 2),
    )
    sizes = sortNum(uniq(kept.map((s) => s.px)))
  } else {
    sizes = sortNum(uniq((raw.size?.scale || []).filter((v) => Number.isFinite(v) && v > 0)))
  }
  const sizeCounts = raw.usage?.sizes ? Object.fromEntries(raw.usage.sizes.map((s) => [s.px, { count: s.count, chars: s.chars || 0 }])) : {}
  const scale = suggestTypeScale(sizes)
  return {
    families,
    scale,
    raw: sizes,
    sizeCounts,
    roles: typeRoles(scale),
    note: '原始字号缺使用频次时 scale 为"吸附 + 合并"的候选；sizeCounts 为实际使用次数（来自真浏览器采集）。',
    warnings,
  }
}

function designStyle(color, typo, spacing) {
  const mode = color.mode === 'dual' ? 'dual-tone（深色主视觉 + 浅色内容）' : color.mode === 'dark' ? 'dark-first' : 'light-first'
  const accentFamily = color.accent?.hue || 'neutral'
  const families = uniq(Object.values(typo.families).map((f) => f.family).filter(Boolean))
  const hasMono = typo.families.mono && !typo.families.mono.generic
  const density = spacing.scale.length >= 6 && Math.max(...spacing.scale) >= 32 ? 'airy' : 'comfortable'
  const mood = []
  if (color.mode !== 'light') mood.push('暗色')
  if (accentFamily !== 'neutral') mood.push(`${accentFamily} 强调`)
  if (hasMono) mood.push('技术感')
  if (families.some((f) => /geist|inter|berkeley|mono/i.test(f))) mood.push('现代中性')
  if (density === 'airy') mood.push('留白充足')
  const confidence = round(
    clamp(0.55 + (color.accent ? 0.1 : -0.05) + (typo.raw.length >= 8 ? 0.08 : 0) + (color.layers.dark && color.layers.light ? 0.05 : 0), 0.35, 0.85),
    2,
  )
  return {
    mode,
    density,
    accent_family: accentFamily,
    typography_voice: families.filter((f) => !GENERIC_FAMILIES.has(f.toLowerCase()))[0] || families[0] || 'unknown',
    mood,
    confidence,
  }
}

async function buildDNA(raw) {
  const color = buildColorModel(raw)
  const typography = normalizeTypography(raw)
  const spacing = normalizeSpacing(raw)
  const radius = normalizeRadius(raw)
  const layout = normalizeLayout(raw)
  const style = designStyle(color, typography, spacing)
  const warnings = [...color.warnings, ...typography.warnings, ...(layout.note ? [layout.note] : [])]
  if (raw.source?.kind === 'url') {
    warnings.push('强调色由当前渲染快照推断，可能与品牌主色不一致（例如品牌紫未被首屏元素使用）；建议用 Logo/品牌资产复核。')
  }
  return {
    schema: 'style-scout/dna@0.1',
    meta: {
      name: raw.name || 'Untitled',
      generatedAt: new Date().toISOString(),
      generator: 'dna-normalize/0.1',
    },
    source: raw.source || null,
    design_system: {
      color: { mode: color.mode, layers: color.layers, accent: color.accent, accentCandidates: color.accentCandidates, spectrum: color.spectrum },
      typography: {
        families: typography.families,
        scale: typography.scale,
        raw: typography.raw,
        roles: typography.roles,
        note: typography.note,
      },
      spacing,
      shape: { radius },
      layout,
    },
    design_style: style,
    evidence: {
      rawCounts: {
        colors: 7 + (raw.color?.extra?.length || 0),
        sizes: raw.size?.scale?.length || 0,
        spacing: raw.space?.scale?.length || 0,
        radii: raw.radius?.scale?.length || 0,
      },
      normalizedCounts: {
        colors: color.spectrum.length,
        typeScale: typography.scale.length,
        spacing: spacing.scale.length,
        radii: radius.scale.length,
      },
      usage: raw.usage
        ? {
            topColors: raw.usage.colors.slice(0, 12).map((c) => ({ hex: c.hex, pixelShare: c.pixelShare, area: c.area, roles: c.roles })),
            fonts: raw.usage.fonts.slice(0, 8),
            sizes: raw.usage.sizes.slice(0, 12),
            spacings: raw.usage.spacings.slice(0, 12),
            cssVars: raw.usage.cssVars || {},
          }
        : undefined,
    },
    warnings,
  }
}

export { buildDNA }
