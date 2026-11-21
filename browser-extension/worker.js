const libraryPattern = 'http://127.0.0.1/*'
const libraryPage = url => {
  try { const u = new URL(url); return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.pathname === '/style-scout/' } catch { return false }
}
async function libraryTab() {
  const tabs = (await chrome.tabs.query({url: libraryPattern})).filter(t => libraryPage(t.url))
  const {address} = await chrome.storage.local.get('address')
  const origins = new Set(tabs.map(t => new URL(t.url).origin))
  const tab = address ? tabs.find(t => new URL(t.url).origin === address) : origins.size === 1 ? tabs[0] : null
  if (tab) return tab
  if (!address) throw Error('先在这个浏览器打开采风素材库，在素材库点一次采风扩展，再回原网页收藏。')
  const health = await fetch(address + '/style-scout/api/health', {signal: AbortSignal.timeout(2500)}).then(r => r.json()).catch(() => null)
  if (health?.service !== 'style-scout') throw Error('请先从「启动采风」打开素材库，再回这里点选。')
  const opened = await chrome.tabs.create({url: address + '/style-scout/', active: false})
  for (let i = 0; i < 50; i++) {
    const state = await chrome.tabs.get(opened.id)
    if (state.status === 'complete' && libraryPage(state.url)) return state
    await new Promise(r => setTimeout(r, 100))
  }
  throw Error('素材库还在打开，请再点一次收藏。')
}
async function notice(tabId, text) {
  await chrome.scripting.executeScript({target:{tabId},func: message => {
    const toast=document.createElement('div');toast.setAttribute('role','status')
    toast.style.cssText='all:initial;position:fixed;z-index:2147483647;top:18px;left:50%;transform:translateX(-50%);padding:12px 20px;color:white;background:#183e34;border-radius:9px;font:15px system-ui'
    toast.textContent=message;document.documentElement.append(toast);setTimeout(()=>toast.remove(),7000)
  },args:[text]})
}
async function startPicker(tab) {
  try {
    if (libraryPage(tab.url)) {
      const address = new URL(tab.url).origin
      const health = await (await fetch(address+'/style-scout/api/health')).json()
      if (health.service !== 'style-scout') throw Error('请打开采风素材库')
      await chrome.storage.local.set({address});await notice(tab.id,'已连接素材库。去喜欢的网页，再点一次采风。');return
    }
    if (!/^https?:/.test(tab.url || '')) throw Error('请在普通网页使用采风')
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['probe.js','picker.js']})
  } catch (e) {
    await chrome.action.setTitle({tabId:tab.id,title:String(e.message)})
    await chrome.action.setBadgeText({tabId:tab.id,text:'!'})
  }
}
chrome.action.onClicked.addListener(startPicker)
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({id:'pick-part',title:'用采风选一块收藏',contexts:['page','selection','link','image'],documentUrlPatterns:['http://*/*','https://*/*']})
})
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'pick-part' && tab) startPicker(tab)
})
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!sender.tab || sender.id !== chrome.runtime.id || sender.frameId !== 0 || message.type !== 'clip') return
  ;(async () => {
    const tab = await libraryTab(), address = new URL(tab.url).origin
    const [{documentId,result:ready}] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:async origin=>{
      return location.origin===origin && location.pathname==='/style-scout/' && (await (await fetch('/style-scout/api/health')).json()).service==='style-scout'
    },args:[address]})
    if (!ready) throw Error('请重新打开采风素材库。')
    await chrome.storage.local.set({address})
    const [{result}] = await chrome.scripting.executeScript({target:{tabId:tab.id, documentIds:[documentId]},func:async payload=>{
      try {
        const resp=await fetch('/style-scout/api/ui-actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
        const data=await resp.json()
        if(!resp.ok)return {error:data.error||'收藏失败'}
        window.dispatchEvent(new Event('stylescout:clip-saved'))
        return {url:new URL(data.url,location.origin).href}
      }catch{return {error:'素材库连接中断，请先检查素材库里是否已经有这份收藏。'}}
    },args:[{...message.payload,source:sender.tab.url,action:'clip-web-part'}]})
    return result
  })().then(respond,e=>respond({error:e.message}));return true
})
