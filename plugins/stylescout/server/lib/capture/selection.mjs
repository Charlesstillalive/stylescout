// Shared by the original-page picker and the annotation collector.
export function pickBlock(hit, strict = false){
  let card
  for(let el=hit;el&&el!==document.body;el=el.parentElement){
    if(el.matches('button,a,[role="button"],input,select,textarea'))return card||el
    if(el.matches('article,figure,[role="listitem"]'))return el
    if(!card && el.matches('div,li,section')){
      const rect=el.getBoundingClientRect(),style=getComputedStyle(el)
      if(rect.width>=90&&rect.height>=54&&rect.height<=innerHeight*1.4&&el.children.length){
        const siblings=el.parentElement?.children||[]
        const repeated=/grid|flex/.test(getComputedStyle(el.parentElement).display)&&Array.from(siblings).some(other=>{
          if(other===el||other.tagName!==el.tagName)return false
          const r=other.getBoundingClientRect();return Math.abs(r.width-rect.width)<rect.width*.12&&Math.abs(r.height-rect.height)<rect.height*.35
        })
        if(repeated||/\bcard\b/i.test(el.className)||parseFloat(style.borderRadius)>0&&el.children.length>1)card=el
      }
    }
  }
  return card || (strict ? null : hit.closest('svg') || hit)
}

// These functions are passed to the capture browser; keep their dependencies explicit.
export function readMarkedPart(text, pick, extract) {
  const normalize = value => (value || '').trim().replace(/\s+/g, ' ')
  const wanted = normalize(text)
  const matches = []
  for (const el of document.body.querySelectorAll('*')) {
    if (!(el instanceof HTMLElement) || !el.checkVisibility({opacityProperty:true,visibilityProperty:true})) continue
    if (normalize(el.textContent) !== wanted && normalize(el.getAttribute('aria-label')) !== wanted &&
        !(el.children.length && el.childElementCount <= 12 && normalize(el.innerText) === wanted)) continue
    matches.push(el)
  }
  const hits = matches.filter(el => !matches.some(other => other !== el && el.contains(other)))
  const cards = new Set(hits.map(hit => pick(hit, true)))
  if (!hits.length) return {error:'找不到这段原文。请选卡片上完整的标题或按钮文字；需要登录的内容请用原网页取材。'}
  if (cards.size > 1) return {error:'这段文字对应多块内容。请用其中一张卡片独有的标题或说明再试。'}
  const [card] = cards
  if (!card) return {error:'找到了文字，但无法确定整块卡片的范围。请用原网页的采风选框确认。'}
  card.scrollIntoView({block:'center',behavior:'instant'})
  const rect = card.getBoundingClientRect()
  if (!rect.width || !rect.height || rect.width > 4000 || rect.height > 12000 || card.querySelectorAll('*').length > 1500)
    return {error:'这块内容太大或不可见，请选择更小的一块。'}
  const doc = extract(card, true)
  if (!doc.root || doc.root.unsupported || doc.warnings.some(w => w.includes('上限'))) return {error:'这块内容无法完整提取。'}
  let background = 'transparent'
  for (let el = card.parentElement; el; el = el.parentElement) {
    const color = getComputedStyle(el).backgroundColor
    if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') { background = color; break }
  }
  Object.assign(doc.root.style, {position:'relative',inset:'auto',top:'auto',left:'auto',right:'auto',bottom:'auto',margin:'0',transform:'none',width:rect.width+'px',height:rect.height+'px','box-sizing':'border-box'})
  const nodeId = doc.root.id
  doc.root = {id:'clipbody',tag:'body',style:{margin:'0',background},children:[doc.root]}
  doc.htmlStyle = {}
  return {doc,nodeId,width:Math.ceil(rect.width),height:Math.min(1000,Math.ceil(rect.height))}
}
