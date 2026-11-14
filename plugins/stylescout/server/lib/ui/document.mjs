// Shared, dependency-free UI document renderer. Captured scripts never run.
const tags = new Set('body div span p h1 h2 h3 h4 h5 h6 main section article aside header footer nav a button input textarea select option optgroup label form fieldset legend ul ol li dl dt dd figure figcaption picture img svg path g defs symbol use rect circle ellipse line polyline polygon text tspan linearGradient radialGradient stop clipPath mask pattern title desc table thead tbody tfoot tr th td caption colgroup col br hr strong em b i small u s sub sup pre code blockquote details summary'.split(' '))
const voids = new Set(['input','img','br','hr','col'])
for(const tag of 'filter feFlood feColorMatrix feOffset feGaussianBlur feComposite feBlend'.split(' '))tags.add(tag)
const safeAttrs = new Set('viewBox viewbox d fill stroke stroke-width width height x y x1 x2 y1 y2 cx cy r rx ry points preserveAspectRatio preserveaspectratio transform xmlns alt title colspan rowspan type placeholder value checked selected multiple role aria-label id href src loading'.split(' '))
for(const key of 'offset stop-color stop-opacity fill-opacity stroke-opacity gradientUnits gradientTransform spreadMethod clipPathUnits maskUnits maskContentUnits filterUnits primitiveUnits in in2 result values mode operator k1 k2 k3 k4 stdDeviation dx dy flood-color flood-opacity color-interpolation-filters'.split(' '))safeAttrs.add(key)
export const editStyles = new Set(['color','background-color','font-size','font-weight','border-radius','width','height','padding','gap','margin-top','margin-left'])
const escape = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
export function flattenUi(root) { const result=[]; const walk=(node,depth=0,parent=null)=>{ if (!node?.id) return; result.push({node,depth,parent}); for(const child of node.children||[]) walk(child,depth+1,node.id) }; walk(root); return result }
export function safeImageUrl(value) { return typeof value === 'string' && (/^\/style-scout\/files\/captures\/[\w-]+\/assets\/[\w.-]+$/.test(value) || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(value)) }
function css(style = {}) { return Object.entries(style).filter(([k,v])=>/^[a-z-]+$/.test(k)&&typeof v==='string'&&!/[<>]/.test(v)).map(([k,v])=>k+':'+v).join(';') }
export function validateEdits(document, edits) {
  if (!edits || typeof edits !== 'object' || Array.isArray(edits)) throw new Error('修改内容格式不正确')
  const ids = new Map(flattenUi(document.root).map(x=>[x.node.id,x.node]))
  if (Object.keys(edits).length > ids.size) throw new Error('修改元素数量不正确')
  for (const [id, edit] of Object.entries(edits)) {
    if (!ids.has(id) || !edit || typeof edit !== 'object' || Array.isArray(edit)) throw new Error('找不到待修改元素')
    for (const key of Object.keys(edit)) if (!['text','src','style','hidden'].includes(key)) throw new Error('不支持的修改字段')
    if (edit.text !== undefined && (typeof edit.text !== 'string' || edit.text.length > 20000)) throw new Error('文字过长或格式不正确')
    if (edit.src !== undefined && (ids.get(id).tag !== 'img' || !safeImageUrl(edit.src) || edit.src.length > 8*1024*1024)) throw new Error('请选择本地图片替换')
    if (edit.hidden !== undefined && typeof edit.hidden !== 'boolean') throw new Error('隐藏设置不正确')
    if (edit.style !== undefined) {
      if (!edit.style || typeof edit.style !== 'object' || Array.isArray(edit.style)) throw new Error('样式格式不正确')
      for (const [k,v] of Object.entries(edit.style)) if (!editStyles.has(k) || typeof v !== 'string' || v.length > 120 || /[;{}<>]|url\s*\(/i.test(v)) throw new Error('不支持的样式修改')
    }
  }
  return edits
}
export function renderUi(document, edits = {}) {
  const pseudo = []
  function render(node) {
    if (node.text !== undefined && !node.id) return escape(node.text)
    const patch = edits[node.id] || {}, tag = tags.has(node.tag) ? node.tag : node.svg ? 'g' : 'div'
    const style = {...node.style,...patch.style}; if(patch.text!==undefined&&patch.style?.height===undefined&&!['input','textarea','svg'].includes(tag))style.height='auto'; if(patch.hidden) style.display='none'
    if(patch.style?.color)style['-webkit-text-fill-color']=patch.style.color
    const attrs = {...node.attrs}; if(patch.src) attrs.src=patch.src
    if (tag==='img' && !safeImageUrl(attrs.src)) delete attrs.src
    // Only local SVG references; no navigation, forms or active remote documents.
    if(attrs.href && !(tag==='use' && /^#[\w:.-]+$/.test(attrs.href))) delete attrs.href
    const attrString = Object.entries(attrs).filter(([k])=>safeAttrs.has(k)).map(([k,v])=>' '+k+'="'+escape(v)+'"').join('')
    for(const [selector,value] of Object.entries(node.pseudo||{})) if(['::before','::after'].includes(selector)) pseudo.push('[data-ui-id="'+node.id+'"]'+selector+'{'+css(value)+'}')
    let textDone=false
    let content=(node.children||[]).map(child=>{
      if(child.text!==undefined&&!child.id&&patch.text!==undefined) {if(textDone)return '';textDone=true;return escape(patch.text)}
      return render(child)
    }).join('')
    if (patch.text !== undefined && (node.children || []).every(child => child.text !== undefined || child.tag === 'br')) content = escape(patch.text).replace(/\n/g,'<br>')
    if(patch.text!==undefined&&!textDone) {if(tag==='input') attrs.value=patch.text; else if(!(node.children||[]).some(c=>c.id))content=escape(patch.text)}
    const finalAttrs = tag==='input'&&patch.text!==undefined ? attrString.replace(/ value="[^"]*"/,'')+' value="'+escape(patch.text)+'"' : attrString
    return '<'+tag+' data-ui-id="'+escape(node.id)+'" style="'+escape(css(style))+'"'+finalAttrs+'>'+ (voids.has(tag)?'':content+'</'+tag+'>')
  }
  const body=render(document.root)
  const fonts=String(document.fonts||'').replace(/<\/style/gi,'').replace(/@import[^;]+;/gi,'')
  return '<!doctype html><html style="'+escape(css(document.htmlStyle))+'"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src \'self\' data:; font-src \'self\' data:; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'"><style>'+fonts+'\n'+pseudo.join('\n')+'\n[data-ui-id]{cursor:default}html{scroll-behavior:auto!important;scrollbar-width:none}::-webkit-scrollbar{display:none}</style></head>'+body+'</html>'
}
