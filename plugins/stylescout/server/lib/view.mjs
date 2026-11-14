/**
 * Project a stored DNA document into the compact shape the M-2/M-3 workbench
 * renders. Keeping this server-side means the client never parses raw DNA.
 */
import { buildAssetIndex } from './asset-index.mjs'

export function toView(entry, dna) {
  const design = dna?.design_system || {}
  const color = design.color || {}
  const typography = design.typography || {}
  const spacing = design.spacing || {}
  const radius = (design.shape && design.shape.radius) || { scale: [], roles: {} }
  const layout = design.layout || {}
  const usage = (dna?.evidence && dna.evidence.usage) || {}

  const layers = {}
  for (const [key, layer] of Object.entries(color.layers || {})) {
    layers[key] = {
      background: layer.background,
      surface: layer.surface,
      text: layer.text,
      muted: layer.muted,
      border: layer.border,
      contrast: layer.contrast || {},
    }
  }

  return {
    id: entry.id,
    label: entry.name,
    tags: entry.tags || [],
    favorite: entry.favorite === true,
    name: (dna?.meta && dna.meta.name) || entry.name,
    source: entry.source,
    capturedAt: entry.createdAt,
    mode: color.mode || 'dark',
    layers,
    accent: color.accent
      ? { hex: color.accent.hex, onAccent: color.accent.onAccent, hue: color.accent.hue }
      : null,
    accentCandidates: (color.accentCandidates || []).slice(0, 5).map((candidate) => ({
      hex: candidate.hex,
      hue: candidate.hue,
      pixelShare: candidate.pixelShare,
      area: candidate.area,
    })),
    families: typography.families || {},
    typeScale: typography.scale || [],
    typeRoles: typography.roles || {},
    spacing: { baseUnit: spacing.baseUnit ?? 4, scale: spacing.scale || [] },
    radius,
    layout: {
      maxWidth: layout.maxWidth ?? null,
      breakpoints: layout.breakpoints || [],
    },
    topColors: (usage.topColors || []).slice(0, 6).map((colorEntry) => ({
      hex: colorEntry.hex,
      pixelShare: colorEntry.pixelShare,
      roles: colorEntry.roles,
    })),
    counts: (dna?.evidence && dna.evidence.normalizedCounts) || {},
    warnings: dna?.warnings || [],
    components: dna?.components || null,
    sections: (dna?.sections || []).map((section) => ({
      id: section.id,
      kind: section.kind,
      text: section.text,
      bbox: section.bbox,
      childCount: section.childCount,
      htmlFile: section.htmlFile || null,
      shotUrl: section.shot ? `/style-scout/files/captures/${entry.id}/${section.shot}` : null,
    })),
    assets: dna?.assets
      ? {
          images: (dna.assets.images || []).map((image) => ({
            src: image.src,
            alt: image.alt,
            w: image.w,
            h: image.h,
            thumbUrl: image.thumb ? `/style-scout/files/captures/${entry.id}/${image.thumb}` : null,
          })),
          icons: (dna.assets.icons || []).slice(0, 10).map((icon) => ({
            name: icon.name,
            w: icon.w,
            h: icon.h,
            svg: icon.svg,
          })),
          fonts: (dna.assets.fonts || []).slice(0, 12).map((font) => ({
            family: font.family,
            src: font.src,
          })),
        }
      : null,
    colorMap: dna?.colorMap || {},
    localAssets: dna?.localAssets
      ? {
          count: (dna.localAssets.assets || []).length,
          images: (dna.localAssets.counts && dna.localAssets.counts.image) || 0,
          fonts: (dna.localAssets.counts && dna.localAssets.counts.font) || 0,
          bytes: dna.localAssets.totalBytes || 0,
          licenseNote: dna.localAssets.licenseNote || '',
        }
      : null,
    cssUrl: `/style-scout/api/captures/${entry.id}/page.css`,
    cover: entry.cover || null,
    coverUrl: entry.cover ? `/style-scout/files/${entry.cover}` : null,
    bytes: entry.bytes ?? null,
    assetsIndex: buildAssetIndex(dna, entry.id, entry.name),
  }
}
