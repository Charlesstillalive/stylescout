import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateEdits } from '../ui/document.mjs'
const queues = new Map()
const error = (message,status=400) => Object.assign(new Error(message),{status})
export async function readUi(root,id) {
  if (!/^[\w-]+$/.test(id)) throw error('收藏编号不正确')
  const dir=path.join(root,'captures',id)
  let document
  try { document=JSON.parse(await fs.readFile(path.join(dir,'ui.json'),'utf8')) } catch(e) { if(e.code==='ENOENT')throw error('这份旧收藏还没有可编辑元素，请重新提取网址',404); throw error('收藏文件无法读取',500) }
  let version={revision:0,edits:{}}
  try { version=JSON.parse(await fs.readFile(path.join(dir,'ui-edits.json'),'utf8')) } catch(e) {if(e.code!=='ENOENT')throw error('修改记录无法读取，原始收藏仍保留',500)}
  return {document,...version}
}
export function saveUi(root,id,body) {
  const key=path.resolve(root)+'/'+id
  const task=(queues.get(key)||Promise.resolve()).then(async()=>{
    const current=await readUi(root,id)
    if(typeof body.operationId!=='string'||!body.operationId||body.operationId.length>100)throw error('保存编号不正确')
    if(body.operationId===current.operationId)return {revision:current.revision,savedAt:current.savedAt}
    if(body.baseRevision!==current.revision)throw error('另一窗口已保存更新。请先重新打开收藏，避免覆盖。',409)
    validateEdits(current.document,body.edits)
    const next={revision:current.revision+1,edits:body.edits,operationId:body.operationId,savedAt:new Date().toISOString()}
    const dir=path.join(root,'captures',id),temp=path.join(dir,randomUUID()+'.tmp'),file=path.join(dir,'ui-edits.json')
    if(current.revision)await fs.copyFile(file,path.join(dir,'ui-edits.previous.json'))
    try {await fs.writeFile(temp,JSON.stringify(next),'utf8');await fs.rename(temp,file)} finally {await fs.rm(temp,{force:true})}
    return {revision:next.revision,savedAt:next.savedAt}
  })
  queues.set(key,task.catch(()=>{}));return task
}
