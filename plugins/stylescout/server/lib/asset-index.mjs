/**
 * Unified asset index (`style-scout/asset@1`).
 *
 * Every captured thing is an asset with a `kind`; sections, UI components and
 * media are just different kinds. The workbench library, AI input and the
 * layer tree all derive from this single list instead of separate buckets.
 */
export const ASSET_SCHEMA = 'style-scout/asset@1'

const COMPONENT_GROUPS = [
  ['button', '按钮', 'buttons', 'button'],
  ['input', '输入框', 'inputs', 'input'],
  ['card', '卡片', 'cards', 'card'],
  ['link', '链接', 'links', 'link'],
  ['heading', '标题层级', 'headings', 'heading'],
]

export function buildAssetIndex(dna, captureId, captureLabel) {
  const assets = []
  const labelBase = captureLabel || captureId

  for (const section of dna?.sections || []) {
    assets.push({
      schema: ASSET_SCHEMA,
      id: `asset_${captureId}_section_${section.id}`,
      kind: 'section',
      group: 'section',
      captureId,
      label: `${labelBase} · ${section.kind || 'section'}`,
      bbox: section.bbox || null,
      text: section.text || '',
      source: { sectionId: section.id, kind: section.kind || 'section', htmlFile: section.htmlFile || null },
    })
  }

  for (const [kind, label, key, tag] of COMPONENT_GROUPS) {
    const items = dna?.components?.[key] || []
    items.forEach((item, index) => {
      assets.push({
        schema: ASSET_SCHEMA,
        id: `asset_${captureId}_${kind}_${index}`,
        kind,
        group: 'component',
        captureId,
        label: item.text ? String(item.text).slice(0, 40) : `${label} ${index + 1}`,
        source: {
          atomType: label,
          tag: item.tag || tag,
          text: item.text || '',
          style: item.style || {},
          count: item.count || 0,
        },
      })
    })
  }

  for (const image of dna?.assets?.images || []) {
    assets.push({
      schema: ASSET_SCHEMA,
      id: `asset_${captureId}_image_${assets.length}`,
      kind: 'image',
      group: 'media',
      captureId,
      label: image.alt || image.src || 'image',
      source: { src: image.src, alt: image.alt || '', w: image.w || null, h: image.h || null, thumb: image.thumb || null },
    })
  }
  for (const icon of dna?.assets?.icons || []) {
    assets.push({
      schema: ASSET_SCHEMA,
      id: `asset_${captureId}_icon_${assets.length}`,
      kind: 'icon',
      group: 'media',
      captureId,
      label: icon.name || 'icon',
      source: { name: icon.name, w: icon.w, h: icon.h, svg: icon.svg },
    })
  }
  for (const font of dna?.assets?.fonts || []) {
    assets.push({
      schema: ASSET_SCHEMA,
      id: `asset_${captureId}_font_${assets.length}`,
      kind: 'font',
      group: 'media',
      captureId,
      label: font.family || 'font',
      source: { family: font.family, src: font.src },
    })
  }

  const counts = { section: 0, component: 0, media: 0, total: assets.length }
  const byKind = {}
  for (const asset of assets) {
    counts[asset.group] += 1
    byKind[asset.kind] = (byKind[asset.kind] || 0) + 1
  }
  return { schema: ASSET_SCHEMA, captureId, counts, byKind, assets }
}
