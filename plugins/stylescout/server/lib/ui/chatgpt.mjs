import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {readUi} from '../store/ui.mjs'
import {listEntries} from '../store/index.mjs'
import {flattenUi} from './document.mjs'
import {createUiVariant,uiAction} from './reuse.mjs'
import {remixContext,validatePlan} from './remix.mjs'
import {imageBytes} from './image-input.mjs'
const fail=(message,status=400)=>Object.assign(new Error(message),{status})
export function createChatgptActions(root){
  let queue=Promise.resolve()
  async function run(request){
    if(!request||typeof request!=='object')throw fail('操作内容不正确')
    const {action,id}=request
    if(action==='image'){
      const current=await readUi(root,id),node=flattenUi(current.document.root).find(x=>x.node.id===request.nodeId)?.node
      if(node?.tag!=='img')throw fail('请先选择一张图片')
      const src=current.edits[node.id]?.src||node.attrs?.src
      if(src?.startsWith('data:image/'))return {id,nodeId:node.id,revision:current.revision,src}
      const match=src?.match(/^\/style-scout\/files\/(captures\/[\w-]+\/assets\/[\w.-]+)$/)
      if(!match)throw fail('原图片尚未保存到本机，请先重新提取素材')
      const base=await fs.realpath(path.join(root,'captures')),file=await fs.realpath(path.join(root,match[1]))
      if(!file.startsWith(base+path.sep))throw fail('图片位置不正确')
      const type={'.png':'png','.jpg':'jpeg','.jpeg':'jpeg','.webp':'webp','.gif':'gif'}[path.extname(file).toLowerCase()]
      if(!type)throw fail('这张图片的格式暂不支持，请先另存为 PNG')
      const stat=await fs.stat(file);if(stat.size>5*1024*1024)throw fail('图片超过 5MB，请先缩小')
      return {id,nodeId:node.id,revision:current.revision,src:'data:image/'+type+';base64,'+(await fs.readFile(file)).toString('base64')}
    }
    if(!['save-version','save-image'].includes(action))return uiAction(root,request)
    if(typeof request.operationId!=='string'||!/^[-\w]{8,100}$/.test(request.operationId))throw fail('保存编号不正确')
    if(typeof request.name!=='string'||!request.name.trim()||request.name.length>100)throw fail('请填写 100 字以内的名称')
    const fingerprint=createHash('sha256').update(JSON.stringify({...request,operationId:undefined})).digest('hex'),dir=path.join(root,'chatgpt-saves'),file=path.join(dir,request.operationId+'.json'),taskId='gpt_'+request.operationId
    await fs.mkdir(dir,{recursive:true})
    let receipt;try{receipt=JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw fail('上次保存记录无法读取，请先检查资料库',409)}
    if(receipt){if(receipt.fingerprint!==fingerprint)throw fail('保存编号已用于另一项修改',409);if(receipt.result)return receipt.result;const existing=(await listEntries(root)).find(e=>e.provenance?.some(p=>p.taskId===taskId));if(existing)return {id:existing.id,url:'/style-scout/#ui='+existing.id,image:'/style-scout/files/'+existing.cover}}
    const current=await readUi(root,id);if(current.revision!==request.baseRevision)throw fail('原素材已有修改，请重新读取后再保存',409)
    let edits
    if(action==='save-image'){
      const node=flattenUi(current.document.root).find(x=>x.node.id===request.nodeId)?.node
      if(node?.tag!=='img')throw fail('请选择要替换的图片元素')
      imageBytes(request.image);edits={[node.id]:{src:request.image}}
    }else edits=validatePlan(current,remixContext(current),{edits:request.edits}).edits
    const write=async value=>{await fs.writeFile(file+'.tmp',JSON.stringify(value));await fs.rename(file+'.tmp',file)}
    await write({fingerprint})
    const result=await createUiVariant(root,current,{name:request.name,sourceId:id,taskId,edits})
    await write({fingerprint,result});return result
  }
  return request=>{const task=queue.then(()=>run(request));queue=task.catch(()=>{});return task}
}
