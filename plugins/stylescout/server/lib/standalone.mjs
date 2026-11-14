import fs from 'node:fs/promises'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createApi} from './api.mjs'
import {createWorkbenchServer} from './workbench-server.mjs'
import * as store from './store/index.mjs'
import {capture,slugify} from './capture/collect.mjs'
import {buildDNA} from './dna/normalize.mjs'
import {toView} from './view.mjs'

export async function existingService(root=store.resolveDataRoot()){
  let address=process.env.STYLE_SCOUT_URL
  if(!address){try{const {port}=JSON.parse(await fs.readFile(path.join(root,'workbench-address.json'),'utf8'));if(!Number.isInteger(port)||port<1024||port>65535)return null;address='http://127.0.0.1:'+port+'/style-scout/'}catch{return null}}
  const url=new URL(address);if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.username||url.password)throw new Error('采风仅连接本机素材库')
  try{const health=await(await fetch(new URL('/style-scout/api/health',url),{signal:AbortSignal.timeout(1500)})).json();return health.service==='style-scout'?{url:url.href,...health}:null}catch{return null}
}
export async function ensureService(){
  const current=await existingService()
  if(current){if(!current.chatgpt)throw new Error('旧版采风仍在 DSH 中运行。请正常退出 DSH 后，再启动 ChatGPT 版采风。');return current.url}
  if(process.env.STYLE_SCOUT_URL)throw new Error('指定的本机采风服务未启动')
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--serve'],{detached:true,stdio:'ignore',windowsHide:true,env:process.env});child.unref()
  for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,200));const service=await existingService();if(service?.chatgpt)return service.url}
  throw new Error('采风未能启动，请运行启动采风查看提示。')
}
export async function startStandalone(root=store.resolveDataRoot()){
  await fs.mkdir(root,{recursive:true})
  const current=await existingService(root);if(current)throw new Error('已有采风正在使用这份素材库，请正常退出 DSH 或使用现有入口。')
  const lock=path.join(root,'standalone.lock')
  try{const pid=Number(await fs.readFile(lock,'utf8'));try{process.kill(pid,0);throw new Error('采风正在启动或运行，请稍后重试。')}catch(error){if(error.code!=='ESRCH')throw error}await fs.unlink(lock)}catch(error){if(error.code!=='ENOENT')throw error}
  const handle=await fs.open(lock,'wx');await handle.writeFile(String(process.pid));await handle.close()
  let tail=Promise.resolve()
  const captureUrl=url=>{const job=tail.then(async()=>{await store.ensureLayout(root);const slug=slugify(url),capId=store.captureId(slug);const result=await capture(url,{outDir:path.join(root,'captures'),dir:capId,slug});const dna=await buildDNA(result.tokens);dna.components=result.capture.components;dna.sections=result.capture.sections;dna.assets=result.capture.assets;dna.localAssets=result.capture.localAssets;const dnaId=await store.nextDnaId(root,slug),entry=await store.saveCapture(root,{capId,slug,url,capture:result.capture,dna,dnaId});return toView(entry,dna)});tail=job.catch(()=>{});return job}
  const api=createApi({dataRoot:root,captureUrl,standalone:true}),server=createWorkbenchServer({dataRoot:root,handle:api.handle})
  const close=async()=>{await tail;await server.close();await fs.rm(lock,{force:true})}
  try{const url=await server.start();return {url,close}}catch(error){await close();throw error}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--serve')){try{const server=await startStandalone();console.log(server.url);for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>server.close().then(()=>process.exit()))}catch(error){console.error(error.message);process.exitCode=1}}
  else try{const url=await ensureService();console.log(url);if(process.argv.includes('--open'))spawn('cmd.exe',['/c','start','',url],{windowsHide:true,stdio:'ignore'}).unref()}catch(error){console.error(error.message);process.exitCode=1}
}
