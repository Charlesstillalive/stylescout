// Runs inside the captured page. Keep this function self-contained.
export function extractUiDocument() {
  const properties = ('display visibility position top right bottom left z-index box-sizing width height min-width min-height max-width max-height margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left overflow overflow-x overflow-y flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-content align-self justify-content justify-items justify-self order gap row-gap column-gap grid-template-columns grid-template-rows grid-auto-flow grid-auto-columns grid-auto-rows grid-column grid-row vertical-align float clear color background-color background-image background-size background-position background-repeat background-clip background-origin border-top border-right border-bottom border-left border-radius border-collapse border-spacing box-shadow opacity transform transform-origin filter backdrop-filter clip-path object-fit object-position aspect-ratio font-family font-size font-weight font-style font-stretch font-variant line-height letter-spacing word-spacing text-align text-indent text-transform text-decoration white-space word-break overflow-wrap text-overflow list-style-type list-style-position list-style-image fill fill-rule stroke stroke-width stroke-linecap stroke-linejoin paint-order vector-effect').split(' ')
  properties.push(...('writing-mode text-orientation text-wrap text-wrap-mode text-wrap-style font-feature-settings font-variation-settings font-kerning text-rendering -webkit-text-fill-color -webkit-text-stroke-width -webkit-text-stroke-color -webkit-line-clamp -webkit-box-orient mask-image mask-size mask-position mask-repeat mask-composite isolation mix-blend-mode perspective perspective-origin transform-style backface-visibility translate rotate scale').split(' '))
  properties.push('grid-template-areas','text-box-trim','text-box-edge','pointer-events')
  const excluded = new Set(['script','style','link','meta','base','noscript','template','audio','source','track'])
  const attrs = new Set(['viewBox','viewbox','d','fill','stroke','stroke-width','width','height','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','points','preserveAspectRatio','preserveaspectratio','transform','xmlns','alt','title','colspan','rowspan','type','placeholder','value','checked','selected','multiple','role','aria-label','id'])
  for(const key of 'offset stop-color stop-opacity fill-opacity stroke-opacity gradientUnits gradientTransform spreadMethod clipPathUnits maskUnits maskContentUnits filterUnits primitiveUnits in in2 result values mode operator k1 k2 k3 k4 stdDeviation dx dy flood-color flood-opacity color-interpolation-filters'.split(' '))attrs.add(key)
  let count = 0, unsupported = 0, truncated = false
  const warnings = []
  // Preserve natural block height, otherwise frozen pixel heights change margin
  // collapsing and prevent longer edited text from growing with its container.
  const heightSelectors = []
  const heightRules = rules => { for (const rule of rules) {
    if (rule.media && !matchMedia(rule.conditionText).matches) continue
    if (rule.selectorText && rule.style?.height && rule.style.height !== 'auto') heightSelectors.push(rule.selectorText)
    else if (rule.cssRules) heightRules(rule.cssRules)
  } }
  for (const sheet of document.styleSheets) { try { heightRules(sheet.cssRules) } catch {} }
  function styles(el, pseudo) {
    const cs = getComputedStyle(el, pseudo)
    const result = {}
    for (const key of properties) { const value = cs.getPropertyValue(key); if (value) result[key] = value }
    // CSSOM rounds used sizes to decimals. Rounding a flex row down by 1/64px
    // can wrap its last child onto a new line in the reconstructed document.
    for (const key of ['width','height','min-width','max-width','min-height','max-height']) if (/^\d+(\.\d+)?px$/.test(result[key]||'')) result[key]=(Math.round(parseFloat(result[key])*64)/64)+'px'
    for (const key of ['grid-template-columns','grid-template-rows']) result[key]=result[key]?.replace(/\d+(?:\.\d+)?px/g,value=>(Math.round(parseFloat(value)*64)/64)+'px')
    // Chromium serializes legacy line-clamped boxes as flow-root; replaying
    // flow-root drops the clamp even when its two prefixed properties survive.
    if (/^[1-9]\d*$/.test(result['-webkit-line-clamp'])&&result['-webkit-box-orient']==='vertical'&&result.display==='flow-root')result.display='-webkit-box'
    if (!pseudo && !['img','svg','button','input','textarea','select','canvas','video','iframe'].includes(el.localName) && !['absolute','fixed'].includes(cs.position)) {
      const explicit = (el.style.height && el.style.height !== 'auto') || heightSelectors.some(selector => { try { return el.matches(selector) } catch { return false } })
      if (!explicit) result.height = 'auto'
    }
    // Freeze the visible state. Interaction and animation are not copied.
    result.animation = 'none'; result.transition = 'none'; result['caret-color'] = 'transparent'
    if (pseudo) result.content = cs.content
    return result
  }
  function visit(el, depth = 0) {
    const tag = el.localName
    if (excluded.has(tag)) return null
    if (count >= 8000 || depth > 90) { truncated = true; return null }
    const style = styles(el)
    if (style.display === 'none' || style.visibility === 'hidden') return null
    const rect = el.getBoundingClientRect()
    // Invisible tracking/embedding frames are not visible UI and must not become
    // a misleading special-content placeholder or an edit interception surface.
    if ((['iframe','canvas','video','object','embed'].includes(tag)||el.shadowRoot)&&(!rect.width||!rect.height))return null
    const id = 'ui' + (++count)
    const node = { id, tag, style, attrs: {}, children: [], box: { x: rect.x + scrollX, y: rect.y + scrollY, w: rect.width, h: rect.height } }
    if(el.namespaceURI==='http://www.w3.org/2000/svg')node.svg=true
    for (const attr of el.attributes) if (attrs.has(attr.name)) node.attrs[attr.name] = attr.value
    if (tag === 'input') { node.attrs.type = ['checkbox','radio'].includes(el.type) ? el.type : 'text'; node.attrs.value = el.type === 'password' ? '' : el.value; if (el.checked) node.attrs.checked = '' }
    if (tag === 'textarea') node.children.push({ text: el.value })
    if (tag === 'img') { node.attrs.src = el.currentSrc || el.src; node.attrs.loading = 'eager' }
    if (tag === 'use') { const ref = el.getAttribute('href') || el.getAttribute('xlink:href'); if (ref?.startsWith('#')) node.attrs.href = ref }
    for (const pseudo of ['::before', '::after']) {
      const value = getComputedStyle(el, pseudo).content
      if (value && !['none','normal'].includes(value)) (node.pseudo ||= {})[pseudo] = styles(el, pseudo)
    }
    if (['iframe','canvas','video','object','embed'].includes(tag) || el.shadowRoot) {
      unsupported++
      node.tag = 'div'; node.attrs = {}; node.children = [{ text: '此处为特殊画面，暂不能拆分编辑' }]
      node.style.background = '#eef1f5'; node.style.color = '#586174'
      node.unsupported = true
      return node
    }
    if (tag !== 'textarea') for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) node.children.push({ text: child.textContent })
      else if (child.nodeType === Node.ELEMENT_NODE) { const next = visit(child, depth + 1); if (next) node.children.push(next) }
    }
    return node
  }
  const root = visit(document.body)
  if (unsupported) warnings.push(unsupported + ' 处特殊画面尚不能拆分，已在画面中标出')
  if (truncated) warnings.push('页面过于复杂，已达到提取上限；部分内容未提取')
  let fonts = ''
  const scan = (rules,base) => { for (const rule of rules) {
    if (rule.type === CSSRule.FONT_FACE_RULE) fonts += rule.cssText.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g,(_,quote,url)=>'url("'+new URL(url,base).href+'")') + '\n'
    else if (rule.cssRules) scan(rule.cssRules,base)
  } }
  for (const sheet of document.styleSheets) { try { scan(sheet.cssRules,sheet.href||document.baseURI) } catch {} }
  return { schema: 'style-scout/ui@1', title: document.title, source: location.href, capturedAt: new Date().toISOString(), viewport: { width: innerWidth, height: innerHeight }, height: Math.min(document.documentElement.scrollHeight, 16000), htmlStyle: styles(document.documentElement), root, fonts, count, warnings }
}
