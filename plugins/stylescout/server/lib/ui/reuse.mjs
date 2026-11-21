import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import {randomUUID,createHash} from 'node:crypto'
import * as store from '../store/index.mjs'
import {readUi,saveUi} from '../store/ui.mjs'
import {renderUi,flattenUi,validateEdits} from './document.mjs'
import {capture,snapshotEditableUi} from '../capture/collect.mjs'

const fail=(message,status=400)=>Object.assign(new Error(message),{status})
const clone=x=>JSON.parse(JSON.stringify(x))
const assetPattern=/\/style-scout\/files\/captures\/([\w-]+)\/assets\/([\w.-]+)/g
const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.gif':'image/gif','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf','.ico':'image/x-icon'}
const briefNode=n=>(n.children||[]).filter(c=>c.text!==undefined).map(c=>c.text).join('').trim()||n.attrs?.alt||n.attrs?.['aria-label']||n.tag
function nameOf(value){if(typeof value!=='string'||!value.trim()||value.length>100)throw fail('请填写不超过 100 字的名称');return value.trim()}
function number(value,fallback,min,max){const n=value??fallback;if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max)throw fail('页面尺寸或间距超出范围');return n}
async function readAsset(root,relative){
  const base=await fs.realpath(path.join(root,'captures')),file=await fs.realpath(path.join(root,relative))
  if(!file.startsWith(base+path.sep))throw fail('素材路径不正确')
  return fs.readFile(file)
}
// The temporary renderer serves only this HTML and bounded capture asset paths.
// No source-site scripts execute, and no library mutation is exposed here.
async function withRenderer(root,html,run,serveAssets=true){
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);return}
      const match=(req.url||'').match(/^\/style-scout\/files\/(captures\/[\w-]+\/assets\/[\w.-]+)$/)
      if(!serveAssets||!match)throw new Error('not found')
      const type=mime[path.extname(match[1]).toLowerCase()];if(!type)throw new Error('not found')
      const bytes=await readAsset(root,match[1]);res.writeHead(200,{'content-type':type});res.end(bytes)
    }catch{res.writeHead(404);res.end()}
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const origin='http://127.0.0.1:'+server.address().port
  try{return await run(origin)}finally{await new Promise(r=>{server.close(r);server.closeIdleConnections()})}
}

function detachPart(nodeId){
  const node=document.querySelector('[data-ui-id="'+nodeId+'"]')
  if(!node||node===document.body)return {error:'请选择页面里的按钮、卡片或区域'}
  const rect=node.getBoundingClientRect(),cs=getComputedStyle(node)
  if(rect.width<1||rect.height<1)return {error:'隐藏或空白元素不能单独收藏'}
  if(rect.width>4000||rect.height>12000)return {error:'选区过大，请选择更小的一块'}
  let background='transparent'
  for(let p=node.parentElement;p;p=p.parentElement){const color=getComputedStyle(p).backgroundColor;if(color!=='rgba(0, 0, 0, 0)'&&color!=='transparent'){background=color;break}}
  const copy=node.cloneNode(true),defs=[],seen=new Set()
  const collectReferences=element=>{
    for(const child of [element,...element.querySelectorAll('*')]){
      const values=[...child.attributes].map(a=>a.value)
      for(const pseudo of ['::before','::after']){const style=getComputedStyle(child,pseudo);for(const key of ['content','filter','clip-path','mask-image','fill','stroke'])values.push(style.getPropertyValue(key))}
      const refs=values.flatMap(value=>[...value.matchAll(/url\(["']?#([^)'"\s]+)["']?\)/g)].map(m=>m[1]))
      const href=child.getAttribute('href')||child.getAttribute('xlink:href');if(href?.startsWith('#'))refs.push(href.slice(1))
      for(const id of refs){if(seen.has(id))continue;seen.add(id);const dependency=document.getElementById(id);if(dependency&&!node.contains(dependency)&&dependency.namespaceURI==='http://www.w3.org/2000/svg'){defs.push(dependency.cloneNode(true));collectReferences(dependency)}}
    }
  }
  collectReferences(node)
  // Freeze the selected root's current used size. Descendants retain their own
  // flex/grid relationships, typography, pictures and decorative pseudo rules.
  Object.assign(copy.style,{position:'relative',top:'auto',right:'auto',bottom:'auto',left:'auto',margin:'0',float:'none',flex:'none',gridArea:'auto',display:cs.display==='inline'?'inline-block':cs.display,width:cs.width==='auto'?rect.width+'px':cs.width,height:cs.height==='auto'?rect.height+'px':cs.height,transform:'none',translate:'none',rotate:'none',scale:'none'})
  document.documentElement.removeAttribute('style')
  document.body.replaceChildren();for(const attr of [...document.body.attributes])document.body.removeAttribute(attr.name)
  Object.assign(document.body.style,{margin:'0',padding:'24px',boxSizing:'border-box',background,display:'block',width:Math.ceil(rect.width+48)+'px',minHeight:Math.ceil(rect.height+48)+'px'})
  if(defs.length){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),container=document.createElementNS('http://www.w3.org/2000/svg','defs');svg.setAttribute('width','0');svg.setAttribute('height','0');svg.style.cssText='position:absolute;overflow:hidden;pointer-events:none';container.append(...defs);svg.append(container);document.body.append(svg)}
  document.body.append(copy)
  return {width:Math.max(160,Math.ceil(rect.width+48)),height:Math.max(120,Math.min(1000,Math.ceil(rect.height+48))),background}
}

// Prefix UI IDs, SVG references and font names so sources cannot collide.
function namespace(document,edits,prefix){
  const result=clone(document),patches={},ids=new Map()
  for(const {node} of flattenUi(result.root))if(node.attrs?.id)ids.set(node.attrs.id,prefix+node.attrs.id)
  const replace=value=>typeof value==='string'?value.replace(/url\(["']?#([^)'"\s]+)["']?\)/g,(all,id)=>ids.has(id)?'url(#'+ids.get(id)+')':all):value
  for(const {node} of flattenUi(result.root)){
    const old=node.id;node.id=prefix+old;if(edits[old])patches[node.id]=clone(edits[old])
    if(node.attrs?.id)node.attrs.id=ids.get(node.attrs.id)
    if(node.attrs?.href?.startsWith('#')&&ids.has(node.attrs.href.slice(1)))node.attrs.href='#'+ids.get(node.attrs.href.slice(1))
    for(const obj of [node.style,node.attrs,...Object.values(node.pseudo||{})])for(const key of Object.keys(obj||{}))obj[key]=replace(obj[key])
  }
  const fonts=new Map()
  result.fonts=(result.fonts||'').replace(/font-family:\s*("[^"]+"|'[^']+'|[^;}]+)([;}])/g,(all,f,end)=>{const original=f.trim().replace(/^["']|["']$/g,'');const renamed=prefix+original;fonts.set(original,renamed);return 'font-family:"'+renamed+'"'+end})
  for(const {node} of flattenUi(result.root))for(const obj of [node.style,...Object.values(node.pseudo||{})])if(obj?.['font-family'])obj['font-family']=obj['font-family'].split(',').map(f=>{const key=f.trim().replace(/^["']|["']$/g,'');return fonts.has(key)?'"'+fonts.get(key)+'"':f}).join(',')
  if(result.partRootId)result.partRootId=prefix+result.partRootId
  return {document:result,edits:patches}
}

function assembleParts(sources,options){
  const {width,columns,gap,padding,background}=options,cell=(width-padding*2-gap*(columns-1))/columns
  document.body.replaceChildren();document.body.style.cssText='margin:0;display:grid;align-items:start;grid-template-columns:repeat('+columns+', '+cell+'px);gap:'+gap+'px;padding:'+padding+'px;box-sizing:border-box;width:'+width+'px;background:'+background
  document.documentElement.removeAttribute('style')
  for(const source of sources){
    const parsed=new DOMParser().parseFromString(source.html,'text/html')
    for(const style of parsed.querySelectorAll('style'))document.head.append(style.cloneNode(true))
    const content=parsed.querySelector('[data-ui-id="'+source.rootId+'"]')
    if(!content)throw new Error('素材内容缺失')
    for(const defs of parsed.querySelectorAll('body>svg'))if(defs!==content)document.body.append(defs.cloneNode(true))
    const slot=document.createElement('section');slot.style.cssText='position:relative;overflow:hidden;min-width:0'
    slot.append(content);document.body.append(slot)
    Object.assign(content.style,{position:'relative',margin:'0',top:'auto',right:'auto',bottom:'auto',left:'auto'})
    if(getComputedStyle(content).backgroundColor==='rgba(0, 0, 0, 0)')content.style.backgroundColor=source.background
    const rect=content.getBoundingClientRect(),factor=Math.min(1,cell/Math.max(1,rect.width))
    slot.style.height=Math.ceil(rect.height*factor)+'px';slot.style.width=cell+'px'
    content.style.transformOrigin='top left';content.style.transform='scale('+factor+')'
  }
  return {}
}

async function ownAssets(root,id,document,origin){
  let json=JSON.stringify(document).split(origin).join('')
  const refs=new Map([...json.matchAll(assetPattern)].map(m=>[m[0],{capture:m[1],file:m[2]}]))
  const dir=path.join(root,'captures',id,'assets');await fs.mkdir(dir,{recursive:true})
  for(const [ref,value] of refs){
    if(value.capture===id)continue
    const bytes=await readAsset(root,'captures/'+value.capture+'/assets/'+value.file)
    const file=createHash('sha256').update(bytes).digest('hex').slice(0,40)+path.extname(value.file);await fs.writeFile(path.join(dir,file),bytes)
    json=json.split(ref).join('/style-scout/files/captures/'+id+'/assets/'+file)
  }
  return JSON.parse(json)
}

async function createDocument(root,{name,kind,source,provenance,html,width,height,prepare,inlineOnly=false,selectedText}){
  const id='cap_'+kind+'_'+randomUUID().replaceAll('-',''),dir=path.join(root,'captures',id)
  await fs.mkdir(dir,{recursive:true})
  try{
    let sourceWarnings=[]
    if(selectedText){
      const part=await capture(source,{outDir:path.dirname(dir),dir:id,selectedText})
      html=renderUi(part.doc);width=part.width;height=part.height
      prepare='('+detachPart.toString()+')('+JSON.stringify(part.nodeId)+')'
      sourceWarnings=part.doc.warnings
    }
    const result=await withRenderer(root,html,async origin=>{
      const snapshot=await snapshotEditableUi({url:origin+'/',outDir:dir,width,height,prepare})
      return {document:inlineOnly?snapshot.document:await ownAssets(root,id,snapshot.document,origin),setup:snapshot.setup}
    },!inlineOnly)
    const document=result.document;document.title=name;document.source=source;document.provenance=provenance
    document.warnings=[...new Set([...sourceWarnings,...document.warnings])]
    if(kind==='part'){document.partRootId=document.root.children.filter(n=>n.id).at(-1).id;document.canvasBackground=result.setup.background}
    if(document.warnings.some(w=>w.includes('上限')))throw fail('选区或组合过于复杂，请减少内容')
    await fs.writeFile(path.join(dir,'ui.json'),JSON.stringify(document),'utf8')
    const editableUi={file:'ui.json',count:document.count,warnings:document.warnings},createdAt=new Date().toISOString()
    await fs.writeFile(path.join(dir,'capture.json'),JSON.stringify({uiKind:kind,source:{url:source,capturedAt:createdAt},meta:{title:name},editableUi,provenance}),'utf8')
    const entry={id,kind,name,source,provenance,editableUi,tags:[],favorite:false,cover:'captures/'+id+'/viewport.png',dnaIds:[],themeIds:[],createdAt,updatedAt:createdAt,bytes:await store.dirSize(dir)}
    await store.upsertEntry(root,entry)
    return {entry,url:'/style-scout/#ui='+id}
  }catch(error){
    const parent=path.resolve(root,'captures'),target=path.resolve(dir)
    if(target.startsWith(parent+path.sep)&&path.dirname(target)===parent)await fs.rm(target,{recursive:true,force:true})
    throw error
  }
}

export async function uiAction(root,request){
  if(!request||typeof request!=='object'||Array.isArray(request))throw fail('操作内容不正确')
  const {action,id}=request
  if(action==='collect-selection'){
    const text=request.selectedText
    if(typeof text!=='string'||!text.trim()||text.length>500)throw fail('请选择卡片上的标题或不超过 500 字的原文。')
    let url
    try{url=new URL(request.url)}catch{throw fail('请提供原网页地址。')}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw fail('网页地址无效。')
    const saved=await createDocument(root,{kind:'part',name:nameOf(request.name??text.trim().slice(0,100)),source:url.href,provenance:[],selectedText:text})
    return {id:saved.entry.id,url:saved.url,warnings:saved.entry.editableUi.warnings}
  }
  if(action==='list')return {entries:(await store.listEntries(root)).filter(e=>!request.kind||e.kind===request.kind).map(e=>({id:e.id,kind:e.kind,name:e.name,source:e.source,count:e.editableUi?.count||0,url:'/style-scout/#ui='+e.id}))}
  if(action==='nodes'){
    const {document,edits,revision}=await readUi(root,id),q=String(request.search||'').toLowerCase()
    const nodes=flattenUi(document.root).filter(({node})=>!q||((edits[node.id]?.text??briefNode(node))+' '+node.tag).toLowerCase().includes(q)).map(({node,parent})=>({id:node.id,parent,tag:node.tag,text:edits[node.id]?.text??briefNode(node),size:node.box,editable:!node.unsupported}))
    const offset=Math.floor(number(request.offset,0,0,100000)),limit=Math.floor(number(request.limit,100,1,500))
    return {id,revision,total:nodes.length,nodes:nodes.slice(offset,offset+limit)}
  }
  if(action==='clip-web-part'){
    const name=nameOf(request.name),source=new URL(request.source)
    if(!['http:','https:'].includes(source.protocol)||source.username||source.password)throw fail('网页地址无效')
    const width=number(request.width,0,1,4000),height=number(request.height,0,1,12000)
    const background=/^(transparent|rgba?\([\d., %]+\))$/.test(request.background)?request.background:'transparent'
    const ids=new Set()
    const cleanStyle=style=>Object.fromEntries(Object.entries(style||{}).filter(([key,value])=>
      /^[a-z-]+$/.test(key)&&typeof value==='string'&&!/[{};<>@\\]/.test(value)&&
      !/url\s*\(/i.test(value.replace(/url\(["']?#[\w.-]+["']?\)/g,''))))
    function clean(node,depth=0){
      if(depth>80||ids.size>1500)throw fail('这块内容太多，请选择更小的区域')
      if(typeof node?.text==='string'&&!node.id)return {text:node.text}
      if(!/^ui\d+$/.test(node?.id)||ids.has(node.id)||!/^\w+$/.test(node.tag))throw fail('选区结构不完整')
      ids.add(node.id)
      const attrs=Object.fromEntries(Object.entries(node.attrs||{}).filter(([key,value])=>
        ['alt','title','role','aria-label','placeholder','id','viewBox','d','fill','stroke','stroke-width','width','height','x','y','cx','cy','r','x1','x2','y1','y2','rx','ry','points','transform','fill-rule','offset','stop-color','opacity','stroke-linecap','stroke-linejoin','preserveAspectRatio'].includes(key)&&typeof value==='string'&&!/url\s*\(/i.test(value.replace(/url\(#[\w.-]+\)/g,''))))
      if(node.tag==='img'&&/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(node.attrs?.src))attrs.src=node.attrs.src
      const pseudo={}
      for(const k of ['::before','::after'])if(node.pseudo?.[k])pseudo[k]=cleanStyle(node.pseudo[k])
      return {id:node.id,tag:node.tag,attrs,style:cleanStyle(node.style),pseudo,children:(node.children||[]).map(c=>clean(c,depth+1))}
    }
    const part=clean(request.part)
    if(!part.id||part.tag==='body')throw fail('请选择页面中的一块')
    Object.assign(part.style,{position:'relative',top:'auto',left:'auto',right:'auto',bottom:'auto',margin:'0',transform:'none',width:width+'px',height:height+'px','box-sizing':'border-box'})
    const rootNode={id:'clipbody',tag:'body',style:{margin:'0',background},children:[part]}
    const saved=await createDocument(root,{name,kind:'part',source:source.href,provenance:[],inlineOnly:true,html:renderUi({root:rootNode}),width:Math.ceil(width),height:Math.min(1000,Math.ceil(height)),prepare:'('+detachPart.toString()+')('+JSON.stringify(part.id)+')'})
    return {id:saved.entry.id,url:saved.url}
  }
  if(action==='save-part'){
    const name=nameOf(request.name),current=await readUi(root,id)
    if(current.revision!==request.baseRevision)throw fail('来源已被修改，请重新打开后再收藏',409)
    const node=flattenUi(current.document.root).find(x=>x.node.id===request.nodeId)?.node
    if(!node||node===current.document.root||node.unsupported||node.svg&&node.tag!=='svg')throw fail('请选择完整按钮、卡片、图片、图标或区域')
    return createDocument(root,{name,kind:'part',source:current.document.source,provenance:[{id,nodeId:node.id,revision:current.revision}],html:renderUi(current.document,current.edits),...current.document.viewport,prepare:'('+detachPart.toString()+')('+JSON.stringify(node.id)+')'})
  }
  if(action==='compose'){
    const name=nameOf(request.name)
    if(!Array.isArray(request.items)||!request.items.length||request.items.length>24)throw fail('请选择 1 至 24 份独立素材')
    const width=Math.round(number(request.width,1440,320,4000)),columns=Math.floor(number(request.columns,1,1,4)),gap=number(request.gap,24,0,200),padding=number(request.padding,24,0,200)
    const background=request.background||'#f7f7f5'
    if(typeof background!=='string'||!/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(background)||width-padding*2-gap*(columns-1)<columns*40)throw fail('背景颜色或页面排列不正确')
    const sources=[],provenance=[]
    for(const [i,item] of request.items.entries()){
      const current=await readUi(root,item.id)
      if(!current.document.partRootId)throw fail('请先把喜欢的区域单独存为素材，再用于组合')
      if(item.revision!==current.revision)throw fail('素材已有更新，请刷新素材列表后再组合',409)
      const scoped=namespace(current.document,current.edits,'p'+i+'_')
      sources.push({html:renderUi(scoped.document,scoped.edits),rootId:scoped.document.partRootId,background:current.document.canvasBackground||'transparent'})
      provenance.push({id:item.id,revision:current.revision})
    }
    const options={width,columns,gap,padding,background}
    return createDocument(root,{name,kind:'page',source:'https://stylescout.local/my-page',provenance,html:'<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',width,height:900,prepare:'('+assembleParts.toString()+')('+JSON.stringify(sources)+','+JSON.stringify(options)+')'})
  }
  if(action==='edit'){
    const current=await readUi(root,id)
    validateEdits(current.document,request.edits)
    const edits={...current.edits}
    for(const [nodeId,patch] of Object.entries(request.edits))edits[nodeId]={...edits[nodeId],...patch,style:{...edits[nodeId]?.style,...patch.style}}
    return saveUi(root,id,{edits,baseRevision:request.baseRevision,operationId:request.operationId})
  }
  if(action==='preview'){
    const current=await readUi(root,id),key='ui-'+randomUUID(),dir=path.join(root,'exports','previews',key)
    await fs.mkdir(dir,{recursive:true})
    const prepare=request.requireImages?'(async()=>{try{await Promise.all([...document.images].map(i=>i.decode()));return {}}catch{return {error:"图片无法打开，未保存新版本。"}}})()':undefined
    await withRenderer(root,renderUi(current.document,current.edits),origin=>snapshotEditableUi({url:origin+'/',outDir:dir,...current.document.viewport,prepare}))
    return {id,revision:current.revision,image:'/style-scout/files/exports/previews/'+key+'/viewport.png',url:'/style-scout/#ui='+id}
  }
  throw fail('不支持这项素材操作')
}

// Publish only after the independent copy has been edited and rendered.
export async function createUiVariant(root,current,{name,sourceId,taskId,edits}){
  validateEdits(current.document,edits)
  const id='cap_remix_'+randomUUID().replaceAll('-',''),dir=path.join(root,'captures',id)
  await fs.mkdir(dir,{recursive:true})
  try{
    const patches=clone(current.edits)
    for(const [key,value] of Object.entries(edits))patches[key]={...patches[key],...value,style:{...patches[key]?.style,...value.style}}
    for(const patch of Object.values(patches))if(patch.src?.startsWith('data:image/')){
      const match=patch.src.match(/^data:image\/(png|jpeg|webp|gif);base64,(.+)$/)
      if(match){const bytes=Buffer.from(match[2],'base64'),file=createHash('sha256').update(bytes).digest('hex')+'.'+match[1];await fs.mkdir(path.join(dir,'assets'),{recursive:true});await fs.writeFile(path.join(dir,'assets',file),bytes);patch.src='/style-scout/files/captures/'+id+'/assets/'+file}
    }
    const bundle=await ownAssets(root,id,{document:clone(current.document),edits:patches},'http://stylescout-unused.invalid')
    const document=bundle.document;document.title=name;document.provenance=[{id:sourceId,revision:current.revision,taskId}]
    const kind=document.partRootId?'part':'page',createdAt=new Date().toISOString()
    await fs.writeFile(path.join(dir,'ui.json'),JSON.stringify(document))
    await fs.writeFile(path.join(dir,'ui-edits.json'),JSON.stringify({revision:1,edits:bundle.edits,operationId:taskId,savedAt:createdAt}))
    const preview=await uiAction(root,{action:'preview',id,requireImages:Object.values(edits).some(e=>e.src)})
    await fs.copyFile(path.join(root,preview.image.replace('/style-scout/files/','')),path.join(dir,'viewport.png'))
    const editableUi={file:'ui.json',count:document.count,warnings:document.warnings||[]}
    await fs.writeFile(path.join(dir,'capture.json'),JSON.stringify({uiKind:kind,source:{url:document.source,capturedAt:createdAt},meta:{title:name},editableUi,provenance:document.provenance}))
    const entry={id,kind,name,source:document.source,provenance:document.provenance,editableUi,tags:[],favorite:false,cover:'captures/'+id+'/viewport.png',dnaIds:[],themeIds:[],createdAt,updatedAt:createdAt,bytes:await store.dirSize(dir)}
    await store.upsertEntry(root,entry)
    return {id,url:'/style-scout/#ui='+id,image:'/style-scout/files/'+entry.cover}
  }catch(error){
    const parent=path.resolve(root,'captures'),target=path.resolve(dir)
    if(path.dirname(target)===parent)await fs.rm(target,{recursive:true,force:true})
    throw error
  }
}
