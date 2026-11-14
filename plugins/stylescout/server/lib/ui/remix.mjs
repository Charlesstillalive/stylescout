import fs from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {readUi} from '../store/ui.mjs'
import {getEntry} from '../store/index.mjs'
import {flattenUi,validateEdits,editStyles} from './document.mjs'
import {createUiVariant} from './reuse.mjs'

const fail=(message,status=400)=>Object.assign(new Error(message),{status,publicMessage:message})
const active=new Set(['queued','running'])
const safeError=error=>error.publicMessage|| (error.name==='AbortError'||error.name==='TimeoutError'?'处理已中断，请稍后重试。': '这次改造没有完成，原素材仍保留。请缩小修改范围或稍后重试。')
const directText=node=>(node.children||[]).filter(c=>c.text!==undefined).map(c=>c.text).join('')
export function remixContext(current){
  const all=flattenUi(current.document.root),selected=current.document.partRootId?all.find(({node})=>node.id===current.document.partRootId)?.node:current.document.root
  if(!selected)throw fail('找不到素材的主体，请重新收藏这块区域')
  const nodes=flattenUi(selected).filter(({node})=>!node.unsupported&&(!node.svg||node.tag==='svg')).map(({node,parent})=>({id:node.id,parent,role:node===selected?'selected-material':undefined,tag:node.tag,text:current.edits[node.id]?.text??directText(node),alt:node.attrs?.alt,hidden:!!current.edits[node.id]?.hidden,style:Object.fromEntries(Object.entries({...node.style,...current.edits[node.id]?.style}).filter(([k])=>editStyles.has(k))),size:node.box}))
  if(nodes.length>500)throw Object.assign(fail('这份界面较大，请先将想改的区域单独收藏，再交给 DSH。'),{publicMessage:'这份界面较大，请先将想改的区域单独收藏，再交给 DSH。'})
  return nodes
}
export function validatePlan(current,nodes,value){
  if(typeof value==='string'){
    try{value=JSON.parse(value.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''))}catch{throw fail('DSH 返回的修改方案无法读取')}
  }
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['summary','edits'].includes(k)))throw fail('修改方案格式不正确')
  validateEdits(current.document,value.edits)
  const allowed=new Map(nodes.map(n=>[n.id,n])),originals=new Map(flattenUi(current.document.root).map(({node})=>[node.id,node]));let changed=false
  for(const [id,patch] of Object.entries(value.edits)){
    if(!allowed.has(id)||Object.hasOwn(patch,'src'))throw fail('方案包含未提供的元素或图片替换')
    const original=originals.get(id)
    if(patch.text!==undefined&&original.tag!=='input'&&(original.children||[]).some(c=>c.id)&&!(original.children||[]).some(c=>c.text!==undefined&&!c.id))throw fail('请选择包含文字的元素修改文字')
    if(patch.text!==undefined&&patch.text!==allowed.get(id).text)changed=true
    if(patch.hidden!==undefined&&patch.hidden!==allowed.get(id).hidden)changed=true
    for(const [key,text] of Object.entries(patch.style||{})){
      const color=key==='color'||key==='background-color'
      const parts=text.trim().split(/\s+/),limit=['padding','border-radius'].includes(key)?4:key==='gap'?2:1
      const dimension=parts.length<=limit&&parts.every(v=>/^(0|\d+(?:\.\d+)?(?:px|%|rem|em))$/.test(v)||v==='auto'&&['width','height','margin-top','margin-left'].includes(key)||/^-\d+(?:\.\d+)?(?:px|%|rem|em)$/.test(v)&&key.startsWith('margin-'))
      const valid=color?/^(#[\da-f]{3}|#[\da-f]{6}|#[\da-f]{8}|transparent)$/i.test(text):key==='font-weight'?/^(normal|bold|[1-9]00)$/.test(text):dimension
      if(!valid)throw fail('样式值不正确')
      if(text!==allowed.get(id).style[key])changed=true
    }
  }
  if(!changed)throw fail('DSH 没有给出可执行的修改')
  return {edits:value.edits,summary:typeof value.summary==='string'?value.summary.slice(0,600):'已按要求生成修改版'}
}

export function createRemixTasks({root,generate,createVariant=createUiVariant}){
  const dir=path.join(root,'remix-tasks'),tasks=new Map(),controllers=new Map()
  let tail=Promise.resolve(),closed=false,submitTail=Promise.resolve()
  const write=async task=>{const temp=path.join(dir,task.id+'.'+randomUUID()+'.tmp');try{await fs.writeFile(temp,JSON.stringify(task));await fs.rename(temp,path.join(dir,task.id+'.json'))}finally{await fs.rm(temp,{force:true})}}
  const ready=(async()=>{
    await fs.mkdir(dir,{recursive:true})
    for(const file of await fs.readdir(dir)){
      if(!/^task_[\w-]+\.json$/.test(file))continue
      let task;try{task=JSON.parse(await fs.readFile(path.join(dir,file),'utf8'))}catch{continue}
      if(task.id+'.json'!==file)continue
      if(active.has(task.status)){task.status='failed';task.error='DSH 已重新启动，上次任务中断。要求已保留，可以重试。';task.updatedAt=new Date().toISOString();await write(task)}
      tasks.set(task.id,task)
    }
  })()
  const publicTask=t=>JSON.parse(JSON.stringify(t))
  async function run(task,current){
    const controller=new AbortController();controllers.set(task.id,controller)
    const timeout=setTimeout(()=>controller.abort(),180000)
    try{
      if(closed)throw new DOMException('Stopped','AbortError')
      task.status='running';task.stage='DSH 正在理解要求并修改';task.updatedAt=new Date().toISOString();await write(task)
      const nodes=remixContext(current)
      const response=await generate({brief:task.brief,nodes,signal:controller.signal,taskId:task.id})
      controller.signal.throwIfAborted()
      const plan=validatePlan(current,nodes,response.plan??response)
      task.stage='正在保存新版本并生成预览';task.model=response.model;await write(task)
      const result=await createVariant(root,current,{name:task.name,sourceId:task.sourceId,taskId:task.id,edits:plan.edits})
      task.status='completed';task.result=result;task.summary=plan.summary;task.stage='改造完成，已存进素材库'
    }catch(error){task.status='failed';task.error=safeError(error);task.stage='未完成，可重试'}
    finally{clearTimeout(timeout);controllers.delete(task.id);task.updatedAt=new Date().toISOString();await write(task)}
  }
  function submit(input){
    const operation=submitTail.then(async()=>{
      await ready
      if(closed||!generate)throw fail('DSH 改造暂不可用，请保持 DSH 打开并从侧栏重新进入。',503)
      if(!input||typeof input!=='object'||typeof input.operationId!=='string'||!/^[-\w]{8,100}$/.test(input.operationId))throw fail('提交编号不正确')
      const previous=[...tasks.values()].find(t=>t.operationId===input.operationId)
      if(previous){if(previous.sourceId!==input.id||previous.brief!==input.brief||previous.sourceRevision!==input.baseRevision||typeof input.name==='string'&&input.name.trim()&&previous.name!==input.name.trim().slice(0,100))throw fail('提交编号已用于另一项要求',409);return publicTask(previous)}
      if(typeof input.brief!=='string'||!input.brief.trim()||input.brief.length>2000)throw fail('请填写 1 至 2000 字的修改要求')
      if([...tasks.values()].filter(t=>active.has(t.status)).length>=5)throw fail('已有任务在处理，请完成后再提交',429)
      const current=await readUi(root,input.id),entry=await getEntry(root,input.id)
      if(current.revision!==input.baseRevision)throw fail('素材已有新修改，请重新打开后再提交。',409)
      remixContext(current)
      const name=typeof input.name==='string'&&input.name.trim()?input.name.trim().slice(0,100):(entry?.name||current.document.title||'我的素材').slice(0,82)+' · DSH 改造'
      const now=new Date().toISOString(),task={id:'task_'+randomUUID(),operationId:input.operationId,sourceId:input.id,sourceName:entry?.name||current.document.title,sourceRevision:current.revision,name,brief:input.brief,status:'queued',stage:'等待 DSH 处理',createdAt:now,updatedAt:now}
      await write(task);tasks.set(task.id,task)
      tail=tail.then(()=>run(task,current)).catch(()=>{})
      return publicTask(task)
    })
    submitTail=operation.catch(()=>{});return operation
  }
  return {submit,
    async list(){await ready;return {available:!!generate,tasks:[...tasks.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,100).map(publicTask)}},
    async retry(id,operationId){await ready;const task=tasks.get(id);if(!task)throw fail('找不到这次改造',404);if(task.status!=='failed')throw fail('这次改造无需重试',409);return submit({id:task.sourceId,baseRevision:task.sourceRevision,brief:task.brief,name:task.name,operationId})},
    async idle(){await submitTail;await tail},
    async dispose(){closed=true;for(const controller of controllers.values())controller.abort();await ready;await submitTail;await tail},
  }
}
