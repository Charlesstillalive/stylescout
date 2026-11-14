export function installRemix({api,flush,getCurrent,getEntries,loadLibrary,openCollection}){
  const $=id=>document.getElementById(id),make=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node}
  const style=make('style');style.textContent='.remix-panel{margin:16px 24px;padding:16px 20px;border:1px solid #d9e3dc;border-radius:12px;background:#fff}.remix-panel summary{cursor:pointer;font-size:14px;font-weight:650}.remix-list{display:flex;gap:12px;overflow:auto;padding-top:12px}.remix-task{min-width:270px;max-width:380px;flex:1;padding:14px;border:1px solid #e2e8e1;border-radius:10px}.remix-task p{font-size:12px;line-height:1.6;margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}.remix-task img{width:100%;height:110px;object-fit:contain;object-position:left;background:#f0f3ef;border-radius:5px}.remix-task button{margin:6px 8px 0 0}.remix-task .error{color:#ac382d}#remix-dialog textarea{width:100%;min-height:130px;resize:vertical;font:inherit;font-size:14px;line-height:1.7}#remix-dialog .hint{margin:8px 0}.remix-status{font-size:13px;line-height:1.7;white-space:pre-wrap}';document.head.append(style)
  const panel=make('details');panel.className='remix-panel';panel.hidden=true;panel.id='remix-panel'
  const summary=make('summary','DSH 改造记录'),list=make('div');list.className='remix-list';list.id='remix-list';panel.append(summary,list);document.querySelector('header').after(panel)
  const button=make('button','交给 DSH 改造');button.id='remix-open';button.className='primary';$('save').before(button)
  const dialog=make('dialog');dialog.id='remix-dialog'
  dialog.innerHTML='<form id="remix-form"><h2>让 DSH 改成你的想法</h2><p id="remix-source" class="hint"></p><p class="hint">改造整份收藏并另存一个新版本，原素材保留。使用 DSH 的默认模型处理，可在这里查看结果。</p><label>新版本名称<input id="remix-name" maxlength="100" required></label><label>想怎么修改<textarea id="remix-brief" maxlength="2000" required placeholder="例如：米白背景、深绿色文字，保留布局，按钮改成预约茶事。"></textarea></label><p class="hint">支持文字、颜色、字号、圆角与间距；暂不支持生成新图片或大幅重排。只想改单块时，先将它单独收藏。</p><p id="remix-status" class="remix-status" role="status"></p><div class="dialog-actions"><button type="button" id="remix-close">关闭</button><button id="remix-submit" class="primary">提交给 DSH</button></div></form>'
  document.body.append(dialog)
  const examples=make('div');examples.className='remix-examples';examples.setAttribute('aria-label','修改要求示例')
  const exampleTitle=make('p','不知道怎么说？点一个例子，再按你的想法修改。');exampleTitle.className='hint'
  $('remix-brief').closest('label').after(exampleTitle,examples)
  for(const [label,brief] of [['换个配色','保留原来的排版和文字，把这块素材改成米白背景、深绿色文字。'],['修改标题','把主标题改成“周末茶会”，其他文字、图片和排版保持不变。'],['调整按钮','把按钮改成深绿色、白色文字、圆角 20px，保留按钮大小和位置。']]){const sample=make('button',label);sample.type='button';sample.onclick=()=>{if($('remix-brief').value.trim()){message('你已经写了要求。请先清空输入框，再使用示例；当前内容不会被替换。');return}$('remix-brief').value=brief;saveDraft();message('已填入示例，你可以继续修改。确认后再点「提交给 DSH」。');$('remix-brief').focus()};examples.append(sample)}
  let target=null,polling=false,last='',tasks=[],known=new Set(),first=true
  const draftKey=id=>'ss.remix.draft.'+id
  const message=text=>$('remix-status').textContent=text
  function saveDraft(){if(!target)return;try{localStorage.setItem(draftKey(target.id),JSON.stringify({brief:$('remix-brief').value,name:$('remix-name').value}))}catch{}}
  $('remix-brief').oninput=saveDraft;$('remix-name').oninput=saveDraft
  async function open(entry){
    await flush();target=entry
    let draft;try{draft=JSON.parse(localStorage.getItem(draftKey(entry.id))||'null')}catch{}
    $('remix-source').textContent='改造素材：'+entry.name
    $('remix-name').value=draft?.name||entry.name.slice(0,82)+' · DSH 改造';$('remix-brief').value=draft?.brief||''
    message('');dialog.showModal();$('remix-brief').focus()
  }
  button.onclick=()=>open(getCurrent()).catch(e=>{message(e.message);if(!dialog.open)alert(e.message)})
  $('remix-close').onclick=()=>{saveDraft();dialog.close()}
  dialog.addEventListener('cancel',saveDraft)
  function render(){
    panel.hidden=!tasks.length;summary.textContent='DSH 改造记录 · '+tasks.length+' 次'
    list.replaceChildren()
    for(const task of tasks){
      const card=make('article');card.className='remix-task';card.dataset.taskId=task.id
      card.append(make('strong',task.name),make('p',task.brief),make('p',task.stage))
      if(task.error){const error=make('p',task.error);error.className='error';card.append(error)}
      if(task.status==='completed'){
        const img=make('img');img.src=task.result.image;img.alt=task.name+'的修改预览';card.append(img,make('p',task.summary))
        const view=make('button','打开修改版');view.onclick=async()=>{view.disabled=true;try{await loadLibrary();const entry=getEntries().find(e=>e.id===task.result.id);if(!entry)throw new Error('这份修改版已经不在素材库中');await openCollection(entry);panel.open=false}catch(e){card.append(make('p',e.message))}finally{view.disabled=false}}
        const again=make('button','继续改造');again.onclick=async()=>{try{await loadLibrary();const entry=getEntries().find(e=>e.id===task.result.id);if(!entry)throw new Error('这份修改版已经不在素材库中');await open(entry)}catch(e){card.append(make('p',e.message))}}
        card.append(view,again)
      }else if(task.status==='failed'){
        const retry=make('button','重试这次改造');retry.onclick=async()=>{retry.disabled=true;try{const key='ss.remix.retry.'+task.id;let operationId=localStorage.getItem(key);if(!operationId){operationId=crypto.randomUUID();localStorage.setItem(key,operationId)}await api('/style-scout/api/remix-tasks/'+task.id+'/retry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationId})});await poll()}catch(e){card.append(make('p',e.message));retry.disabled=false}}
        card.append(retry)
      }
      list.append(card)
    }
  }
  async function poll(){
    if(polling)return;polling=true
    try{
      const result=await api('/style-scout/api/remix-tasks');const next=JSON.stringify(result.tasks)
      if(next!==last){
        const completed=result.tasks.filter(t=>t.status==='completed'&&!known.has(t.id))
        tasks=result.tasks;last=next;render()
        if(completed.length&&!first||tasks.some(t=>['running','queued'].includes(t.status))||first&&tasks[0]?.status==='failed')panel.open=true
        if(completed.length&&!first)await loadLibrary()
        known=new Set(tasks.filter(t=>t.status==='completed').map(t=>t.id));first=false
      }
    }catch{/* The existing connection banner owns offline state. Drafts remain local. */}finally{polling=false}
  }
  $('remix-form').onsubmit=async event=>{
    event.preventDefault();$('remix-submit').disabled=true;saveDraft();message('正在提交，刷新页面不会丢失已提交任务。')
    try{
      await flush();const current=await api('/style-scout/api/ui/'+target.id)
      const body={id:target.id,baseRevision:current.revision,brief:$('remix-brief').value,name:$('remix-name').value}
      const signature=JSON.stringify(body),key='ss.remix.submit.'+target.id;let pending
      try{pending=JSON.parse(localStorage.getItem(key)||'null')}catch{}
      const operationId=pending?.signature===signature?pending.operationId:crypto.randomUUID()
      localStorage.setItem(key,JSON.stringify({signature,operationId}))
      const result=await api('/style-scout/api/remix-tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,operationId})})
      localStorage.removeItem(draftKey(target.id));dialog.close();await poll();panel.open=true
      const card=list.querySelector('[data-task-id="'+result.task.id+'"]');card?.scrollIntoView({block:'nearest',inline:'nearest'})
    }catch(e){message(e.message)}finally{$('remix-submit').disabled=false}
  }
  poll();setInterval(()=>{if(!document.hidden)poll()},2000)
}
