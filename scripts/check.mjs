import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {startStandalone} from '../plugins/stylescout/server/lib/standalone.mjs'
import {downloadChatgptImage,mcpTools} from '../plugins/stylescout/server/lib/cli.mjs'
import {readUi} from '../plugins/stylescout/server/lib/store/ui.mjs'
import * as store from '../plugins/stylescout/server/lib/store/index.mjs'
const root=await fs.mkdtemp(path.join(os.tmpdir(),'stylescout-gpt-check-'))
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
let server
try{
 const dir=path.join(root,'captures','source');await fs.mkdir(dir,{recursive:true})
 const document={schema:'style-scout/ui@1',title:'改造测试卡片',count:3,source:'https://example.com',viewport:{width:360,height:260},partRootId:'card',warnings:[],root:{id:'root',tag:'body',attrs:{},style:{margin:'0',padding:'20px'},children:[{id:'card',tag:'div',attrs:{},style:{width:'280px',padding:'10px','background-color':'#eeeeee'},children:[{id:'picture',tag:'img',attrs:{src:png,alt:'测试图片',width:'80',height:'80'},style:{width:'80px',height:'80px'},children:[]},{id:'title',tag:'h2',attrs:{},style:{color:'#111111'},children:[{text:'原卡片'}]}]}]}}
 await fs.writeFile(path.join(dir,'ui.json'),JSON.stringify(document));await fs.writeFile(path.join(dir,'capture.json'),JSON.stringify({editableUi:{file:'ui.json',count:4}}));await store.upsertEntry(root,{id:'source',kind:'part',name:document.title,source:document.source,cover:'captures/source/viewport.png',editableUi:{file:'ui.json',count:4}})
 const original=await readUi(root,'source');server=await startStandalone(root)
 const call=async input=>{const response=await fetch(new URL('/style-scout/api/chatgpt-actions',server.url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});return {status:response.status,...await response.json()}}
 const cover=await call({action:'preview',id:'source'});await fs.copyFile(path.join(root,cover.image.replace('/style-scout/files/','')),path.join(dir,'viewport.png'))
 const request={action:'save-version',id:'source',baseRevision:0,name:'新卡片',operationId:'gpt-test-version',edits:{title:{text:'周末茶会'},card:{style:{'background-color':'#fff4dd'}}}}
 const a=await call(request);assert.equal(a.status,200);assert.ok(a.id);assert.deepEqual(await readUi(root,'source'),original)
 assert.equal((await call(request)).id,a.id);assert.equal((await call({...request,name:'冲突'})).status,409)
 assert.equal((await call({...request,operationId:'stale-gpt-version',baseRevision:5})).status,409)
 const imageRequest={action:'save-image',id:a.id,baseRevision:1,nodeId:'picture',image:png,name:'图片修改版',operationId:'gpt-test-image'}
 const b=await call(imageRequest);assert.equal(b.status,200);assert.notEqual(b.id,a.id)
 const updated=await readUi(root,b.id);assert.ok(updated.edits.picture.src.includes('/captures/'+b.id+'/assets/'));assert.equal(updated.edits.title.text,'周末茶会')
 assert.equal((await call(imageRequest)).id,b.id)
 assert.equal((await call({...imageRequest,operationId:'invalid-gpt-image',image:'data:image/png;base64,bm90LWltYWdl'})).status,400)
 const corruptImage='data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(32)]).toString('base64')
 assert.equal((await call({...imageRequest,operationId:'corrupt-gpt-image',image:corruptImage})).status,400)
 assert.equal((await store.listEntries(root)).length,3)
 assert.deepEqual(await readUi(root,'source'),original)
 await server.close();server=await startStandalone(root);assert.equal((await call(imageRequest)).id,b.id)
 const backup=await store.createBackup(root);assert.ok(backup.copied.includes('chatgpt-saves'));assert.ok(!backup.copied.includes('standalone.lock'))
 const imageTool=mcpTools.find(t=>t.name==='stylescout_save_image');assert.deepEqual(imageTool._meta['openai/fileParams'],['file']);assert.deepEqual(Object.keys(imageTool.inputSchema.properties.file.properties),['download_url','file_id','mime_type','file_name'])
 const file={file_id:'file-test',download_url:'https://files.oaiusercontent.com/test'}
 assert.equal(await downloadChatgptImage(file,async()=>new Response(Buffer.from(png.split(',')[1],'base64'))),png)
 for(const download_url of ['http://files.oaiusercontent.com/a','https://127.0.0.1/a','https://files.oaiusercontent.com.evil.com/a'])await assert.rejects(()=>downloadChatgptImage({...file,download_url}))
 await assert.rejects(()=>downloadChatgptImage(file,async()=>new Response('expired',{status:403})),/失效/)
 const child=spawn(process.execPath,[path.resolve('plugins/stylescout/server/lib/cli.mjs'),'mcp'],{env:{...process.env,STYLE_SCOUT_URL:server.url},windowsHide:true});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b)
 const messages=[{id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{id:2,method:'tools/list'},{id:3,method:'tools/call',params:{name:'stylescout_list',arguments:{}}},{id:4,method:'tools/call',params:{name:'stylescout_image',arguments:{id:'source',nodeId:'picture'}}}];child.stdin.end(messages.map(m=>JSON.stringify({jsonrpc:'2.0',...m})).join('\n')+'\n');await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(stderr)))})
 const replies=stdout.trim().split('\n').map(s=>JSON.parse(s));assert.equal(replies.length,4);assert.equal(replies[1].result.tools.length,11);assert.equal(JSON.parse(replies[2].result.content[0].text).entries.length,3);assert.equal(replies[3].result.content[1].type,'image');assert.ok(!replies[3].result.content[0].text.includes('base64'))
 console.log('PASS ChatGPT: standalone render/save, preserved source, independent image assets, repeat/restart deduplication, stale/invalid rejection, backup, file-input schema and real MCP stdio calls. Image generation and account connection are NOT simulated as completed.')
 if(process.argv.includes('--serve')){console.log(JSON.stringify({url:server.url,root}));await new Promise(()=>{})}
}finally{await server?.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true})}
