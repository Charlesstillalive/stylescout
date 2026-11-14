import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'

// Keep the browser origin stable across DSH restarts. The OS chooses the first
// available port; only this installation's runtime data remembers it.
export function createWorkbenchServer({dataRoot, handle}) {
  const configFile = path.join(dataRoot, 'workbench-address.json')
  let starting = null, server = null, closed = false
  async function listen(port) {
    const candidate = http.createServer((req, res) => {
      const allowed = new Set(['127.0.0.1:'+candidate.address().port, 'localhost:'+candidate.address().port])
      if (!allowed.has(req.headers.host)) {res.writeHead(403);res.end('forbidden');return}
      Promise.resolve(handle(req,res)).catch(() => {if(!res.headersSent)res.writeHead(500);res.end()})
    })
    await new Promise((resolve,reject) => {
      candidate.once('error',reject)
      candidate.listen(port,'127.0.0.1',()=>{candidate.removeListener('error',reject);resolve()})
    })
    candidate.on('error', error => console.error('StyleScout workbench:', error.message))
    return candidate
  }
  function start() {
    if (closed) return Promise.reject(new Error('采风服务已关闭，请重新启动采风'))
    if (starting) return starting
    starting = (async()=>{
      await fs.mkdir(dataRoot,{recursive:true})
      let port = 0
      try {const saved=JSON.parse(await fs.readFile(configFile,'utf8'));if(Number.isInteger(saved.port)&&saved.port>=1024&&saved.port<=65535)port=saved.port} catch {}
      try {server=await listen(port)} catch(error) {
        if (!port || !['EADDRINUSE','EACCES'].includes(error.code)) throw error
        let health;try{health=await(await fetch('http://127.0.0.1:'+port+'/style-scout/api/health',{signal:AbortSignal.timeout(1000)})).json()}catch{}
        if(health?.service==='style-scout')throw new Error('这份素材库已有采风服务运行，请使用现有采风窗口。')
        server=await listen(0)
      }
      const url='http://127.0.0.1:'+server.address().port+'/style-scout/'
      try {
        await fs.writeFile(configFile+'.tmp',JSON.stringify({port:server.address().port}),'utf8')
        await fs.rename(configFile+'.tmp',configFile)
      } catch(error) {await new Promise(resolve=>server.close(resolve));server=null;throw error}
      return url
    })().catch(error=>{starting=null;throw error})
    return starting
  }
  async function close() {
    closed=true
    if(starting)await starting.catch(()=>{})
    if(server){const active=server;server=null;await new Promise(resolve=>{active.close(resolve);active.closeIdleConnections()})}
  }
  return {start,close}
}
