export function installChatgpt({api,flush,getCurrent,getEntries,loadLibrary,openCollection}){
  const $=id=>document.getElementById(id)
  document.body.classList.add('chatgpt-primary')
  const style=document.createElement('style');style.textContent='.chatgpt-primary #remix-open,.chatgpt-primary #remix-panel{display:none!important}#gpt-dialog .dialog-actions{flex-wrap:wrap}#gpt-copy{white-space:nowrap}#gpt-dialog textarea{width:100%;height:140px;font:inherit}#gpt-dialog p{line-height:1.8}#gpt-dialog select{width:100%;padding:8px}#gpt-dialog .notice{padding:12px;background:#f3f5ef;border-radius:8px}';document.head.append(style)
  const button=document.createElement('button');button.id='chatgpt-open';button.className='primary';button.textContent='交给 ChatGPT 修改';$('save').before(button)
  const dialog=document.createElement('dialog');dialog.id='gpt-dialog';dialog.innerHTML=`<h2 id="gpt-title">交给 ChatGPT 修改</h2>
    <p id="gpt-source"></p>
    <label>1 · 写下修改要求<textarea id="gpt-brief" maxlength="2000" placeholder="例如：把按钮换成深蓝色，保留图标和文字。"></textarea></label>
    <button id="gpt-copy" class="primary">复制素材和修改要求</button>
    <p id="gpt-copy-status" role="status"></p>
    <div id="gpt-manual" hidden><label>手动复制以下内容<textarea id="gpt-message" readonly></textarea></label></div>
    <ol start="2"><li>打开 ChatGPT 桌面版，新建对话，输入 @ 选择「采风 StyleScout」，粘贴并发送。</li>
    <li>等 ChatGPT 回复新版本名称，再回素材库按这个名称搜索。</li></ol>
    <button id="gpt-library" hidden>回素材库找新版本</button>
    <details><summary>在 @ 菜单里找不到采风？</summary><p>解压采风安装包，双击「安装桌面插件.cmd」。安装成功后重新打开桌面客户端，再开一个新对话。</p></details>
    <p id="gpt-image-help"></p><details id="gpt-upload"><summary>把 ChatGPT 改好的图片存回来</summary><p>已连接插件时，可以让 ChatGPT 直接另存。也可以在这里上传改好的 PNG、JPEG 或 WebP 图片；会新建一份收藏，原版不覆盖。</p><label>替换哪张图片<select id="gpt-image-node"></select></label><label>新版本名称<input id="gpt-name" maxlength="100"></label><label>选择改好的图片<input id="gpt-file" type="file" accept="image/png,image/jpeg,image/webp"></label><button id="gpt-import">另存到素材库</button></details><p id="gpt-status" role="status"></p><div class="dialog-actions"><button id="gpt-close">关闭</button></div>`;dialog.setAttribute('aria-labelledby','gpt-title');document.body.append(dialog)
  let target=null,images=[],saving=false
  const status=t=>$('gpt-status').textContent=t
  button.onclick=async()=>{try{await flush();target=getCurrent();const current=await api('/style-scout/api/ui/'+target.id);images=[];const walk=n=>{if(n.tag==='img')images.push(n);for(const c of n.children||[])walk(c)};walk(current.document.root)
    $('gpt-source').textContent='素材：'+target.name;$('gpt-name').value=target.name.slice(0,80)+' · ChatGPT 修改版';$('gpt-brief').value=localStorage.getItem('ss.gpt.brief.'+target.id)||'';$('gpt-file').value='';$('gpt-image-node').replaceChildren(...images.map(n=>{const o=document.createElement('option');o.value=n.id;o.textContent=n.attrs?.alt||'图片 '+n.id;return o}));$('gpt-import').disabled=!images.length;$('gpt-upload').hidden=!images.length
    $('gpt-image-help').textContent=images.length?'图片内部的人物要由 ChatGPT 的改图工具处理。动图改成静态图片时，动画不会保留。':'这份素材没有独立图片，可以让 ChatGPT 修改文字、颜色和样式。';status('');resetCopy();dialog.showModal()
  }catch(e){alert(e.message)}}
  function resetCopy(){
    $('gpt-copy-status').textContent=''
    $('gpt-manual').hidden=true
    $('gpt-library').hidden=true
  }
  $('gpt-library').onclick=async()=>{
    dialog.close()
    $('search').value=''
    $('kind-filter').value=''
    await $('back').onclick()
    $('search').focus()
  }
  $('gpt-brief').oninput=()=>{resetCopy();if(target)localStorage.setItem('ss.gpt.brief.'+target.id,$('gpt-brief').value)}
  $('gpt-close').onclick=()=>{if(!saving)dialog.close()}
  dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault()})
  $('gpt-copy').onclick=async()=>{
    const brief=$('gpt-brief').value.trim()
    const feedback=$('gpt-copy-status')
    if(!brief){feedback.textContent='先写一句想改什么，例如「把按钮改成深蓝色」。';$('gpt-brief').focus();return}
    let current
    try{current=await api('/style-scout/api/ui/'+target.id)}catch(error){feedback.textContent=error.message;return}
    const message=[
      '请使用采风插件修改我的素材：'+target.name,
      '素材编号：'+target.id, '当前版本：'+current.revision, '我的要求：'+brief,
      '先读取元素和预览。请保留原素材，把修改版另存回采风，检查后告诉我新版本的名称和打开链接。',
      '如果需要改图片内容，请读取原图并使用改图工具。若未能保存，请说明原因。'
    ].join('\n')
    try{
      await navigator.clipboard.writeText(message)
      feedback.textContent='已复制。现在切换到 ChatGPT 桌面版，按第 2 步粘贴并发送。'
    }catch{
      $('gpt-manual').hidden=false
      $('gpt-message').value=message
      $('gpt-message').select()
      feedback.textContent='浏览器没有自动复制。请复制下方已选中的文字，再按第 2 步发送。'
    }
    $('gpt-library').hidden=false
  }
  $('gpt-import').onclick=async()=>{const btn=$('gpt-import');if(saving)return;saving=true;const sourceId=target.id,nodeId=$('gpt-image-node').value,name=$('gpt-name').value;const controls=[...dialog.querySelectorAll('button,input,select,textarea')];controls.forEach(el=>el.disabled=true);try{const file=$('gpt-file').files[0];if(!file||file.size>5*1024*1024||!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('请选择 5MB 以内的 PNG、JPEG 或 WebP 图片。');const image=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file)});await flush();const current=await api('/style-scout/api/ui/'+sourceId),body={action:'save-image',id:sourceId,nodeId,baseRevision:current.revision,name,image};const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body))),signature=Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join(''),key='ss.gpt.save.'+sourceId;let previous;try{previous=JSON.parse(localStorage.getItem(key)||'null')}catch{}body.operationId=previous?.signature===signature?previous.operationId:crypto.randomUUID();localStorage.setItem(key,JSON.stringify({signature,operationId:body.operationId}));status('正在保存新版本并检查图片…');const result=await api('/style-scout/api/chatgpt-actions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});await loadLibrary();await openCollection(getEntries().find(e=>e.id===result.id));dialog.close()}catch(e){status(e.message)}finally{saving=false;controls.forEach(el=>el.disabled=false);btn.disabled=!images.length}}
}
