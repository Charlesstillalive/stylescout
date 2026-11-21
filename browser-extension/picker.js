(() => {
  if (globalThis.styleScoutPicker) { globalThis.styleScoutPicker(); return }
  const panel = document.createElement('div')
  panel.style.cssText='all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none'
  const ui=panel.attachShadow({mode:'open'})
  ui.innerHTML='<style>:host{pointer-events:none}#box{position:fixed;outline:3px solid #2783ff;background:#3482ff12;pointer-events:none}#bar{position:fixed;top:14px;left:50%;transform:translateX(-50%);max-width:90vw;box-sizing:border-box;background:#173a33;color:white;padding:10px 18px;border-radius:10px;font:14px/1.6 system-ui;box-shadow:0 3px 14px #0003;pointer-events:auto}a,button{color:white;font:inherit}button{border:0;background:none;cursor:pointer;margin-left:10px}</style><div id="box" hidden></div><div id="bar" role="status"><span></span> <a hidden target="_blank" rel="noopener">打开素材</a><button aria-label="关闭">×</button></div>'
  document.documentElement.append(panel)
  const box=ui.querySelector('#box'), bar=ui.querySelector('span'), link=ui.querySelector('a')
  const listeners=new AbortController()
  let target, lastHit, busy=false, done=false
  function close(){listeners.abort();panel.remove();delete globalThis.styleScoutPicker}
  globalThis.styleScoutPicker=close;ui.querySelector('button').onclick=close
  bar.textContent='采风 · 移到按钮或卡片，点击收藏。↑ 选外层，↓ 选内层，Esc 退出。'
  function draw(){if(!target)return;const r=target.getBoundingClientRect();Object.assign(box.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});box.hidden=false}
  function hover(e){if(busy||done||!e.isTrusted||e.composedPath().includes(panel))return;lastHit=e.target;target=globalThis.styleScoutPickBlock(lastHit);draw()}
  function cancel(e){e.preventDefault();e.stopImmediatePropagation()}
  function key(e){
    if(!e.isTrusted)return
    if(e.key==='Escape'){cancel(e);close();return}
    if(busy||done||!target)return
    if(e.key==='ArrowUp'&&target.parentElement&&target.parentElement!==document.body){cancel(e);target=target.parentElement;draw()}
    if(e.key==='ArrowDown'&&lastHit!==target&&target.contains(lastHit)){cancel(e);let child=lastHit;while(child.parentElement!==target)child=child.parentElement;target=child;draw()}
  }
  async function inlineImage(src){
    if(/^data:image\/(png|jpeg|webp|gif);base64,/i.test(src))return src
    const url=new URL(src,location.href)
    if(!['http:','https:','blob:'].includes(url.protocol))throw Error()
    const res=await fetch(url,{credentials:'omit',signal:AbortSignal.timeout(5000)})
    if(!res.ok)throw Error()
    const blob=await res.blob()
    if(!/^image\/(png|jpeg|webp|gif)$/.test(blob.type)||blob.size>3*1024*1024)throw Error()
    return await new Promise((resolve,reject)=>{const f=new FileReader();f.onload=()=>resolve(f.result);f.onerror=reject;f.readAsDataURL(blob)})
  }
  async function collect(el,hit){
    const rect=el.getBoundingClientRect()
    if(el===document.body||el===document.documentElement||rect.width<1||rect.width>4000||rect.height>12000||el.querySelectorAll('*').length>1500)throw Error('请选一块较小的按钮、卡片或区域。')
    const doc=globalThis.styleScoutReadSelection(el), part=doc.root
    if(!part||part.unsupported||doc.warnings.some(w=>w.includes('上限')))throw Error('这块画面无法拆成可编辑元素，请换一块。')
    let background='transparent',missing=0
    for(let parent=el.parentElement;parent;parent=parent.parentElement){const c=getComputedStyle(parent).backgroundColor;if(c!=='rgba(0, 0, 0, 0)'&&c!=='transparent'){background=c;break}}
    const caption=Array.from(hit.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()
    const name=(el.getAttribute('aria-label')||el.querySelector('h1,h2,h3,h4,[role=heading]')?.textContent||caption||el.innerText?.trim().split(/\r?\n/)[0]||el.getAttribute('alt')||document.title).trim().slice(0,100)||'网页素材'
    const images=new Map()
    async function embed(node){
      if(node.tag==='img'&&node.attrs.src){
        const src=node.attrs.src
        if(!images.has(src))images.set(src,inlineImage(src).catch(()=>''))
        node.attrs.src=await images.get(src);if(!node.attrs.src)missing++
      }
      if(node.style&&/url\(/i.test(node.style['background-image']||''))missing++
      await Promise.all((node.children||[]).map(embed))
    }
    await embed(part)
    const payload={part,name,background,width:rect.width,height:rect.height}
    if(new Blob([JSON.stringify(payload)]).size>14*1024*1024)throw Error('这块素材太大，请选择更小的区域。')
    const result=await chrome.runtime.sendMessage({type:'clip',payload})
    if(!result?.url)throw Error(result?.error||'未能保存，请检查素材库。')
    bar.textContent='已收藏「'+name+'」'+(missing?'，部分图片未保留。':'。')
    link.href=result.url;link.hidden=false;done=true;box.hidden=true
  }
  async function click(e){
    if(!e.isTrusted||e.composedPath().includes(panel)||done)return
    cancel(e);if(busy)return
    if(!target||!target.contains(e.target))target=globalThis.styleScoutPickBlock(e.target)
    busy=true;bar.textContent='正在收藏…'
    try{await collect(target,e.target)}catch(error){bar.textContent=error.message+'  可再点选，或按 Esc 退出。'}finally{busy=false}
  }
  for(const [event,handler] of [['pointermove',hover],['click',click],['keydown',key],['scroll',draw],['resize',draw]])window.addEventListener(event,handler,{capture:true,signal:listeners.signal})
  for(const event of ['pointerdown','pointerup','mousedown','mouseup'])window.addEventListener(event,e=>{if(!done&&!e.composedPath().includes(panel))cancel(e)},{capture:true,signal:listeners.signal})
})()
