// Personal music proxy. No account-management credentials are needed at runtime.
export const hosts = ['api.bilibili.com','b23.tv','bilibili.com','bilivideo.com','bilivideo.cn','hdslb.com','music.126.net','music.163.com','126.net','y.qq.com','qqmusic.qq.com','gtimg.cn','kuwo.cn','kwcdn.kuwo.cn','music-api.gdstudio.xyz','oiapi.net','api.xunhuisi.store','www.cyanyun.com','h.miti.cc.cd']
export function allowedTarget(value) {
  try { const u=new URL(value); return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&hosts.some(h=>u.hostname===h||u.hostname.endsWith('.'+h)) } catch { return false }
}
const exposed='Content-Type, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, X-Upstream-URL, X-Proxy-Request-Id, X-Proxy-Upstream-Status, X-Proxy-Hop-Count, Server-Timing'
export function createHandler(outbound=fetch) {
 return async function handle(request,env) {
  const url=new URL(request.url),origin=request.headers.get('Origin'),app=env.APP_ORIGIN||''
  const headers=new Headers({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin'})
  if(origin===app){headers.set('Access-Control-Allow-Origin',app);headers.set('Access-Control-Expose-Headers',exposed)}
  const reply=(body,status=200)=>new Response(body,{status,headers})
  if(origin&&origin!==app)return reply('Origin is not allowed',403)
  if(request.method==='OPTIONS') {
   headers.set('Access-Control-Allow-Methods','GET, HEAD, OPTIONS')
   headers.set('Access-Control-Allow-Headers','Authorization, Range, If-Range, If-None-Match, If-Modified-Since')
   headers.set('Access-Control-Max-Age','600');return reply(null,204)
  }
  if(!['GET','HEAD'].includes(request.method))return reply('Method is not allowed',405)
  if(url.pathname==='/'){
   if(!env.PROXY_KEY||!app)return reply('Proxy configuration incomplete',503)
   const signingKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.PROXY_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign'])
   const proof=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',signingKey,new TextEncoder().encode('any-listen-connect\n'+app+'\n'+url.origin))),b=>b.toString(16).padStart(2,'0')).join('')
   const callback=new URL(app);callback.hash='personal-proxy?'+new URLSearchParams({endpoint:url.origin,proof})
   const href=callback.href.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')
   headers.set('Content-Type','text/html; charset=utf-8');headers.set('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'")
   return reply(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>个人代理已就绪</title><style>body{font:17px system-ui;max-width:420px;margin:15vh auto;padding:24px;background:#f5f5f7;color:#1d1d1f}.back{display:inline-block;padding:0;background:none;color:#fa375d;margin-bottom:20px}a{display:block;padding:16px;border-radius:14px;background:#fa375d;color:white;text-align:center;text-decoration:none}p{line-height:1.7;color:#666}</style><a class="back" href="${href}">‹ 返回播放器</a><h1>个人代理已就绪</h1><p>点下面的按钮返回播放器。服务地址会自动带回，播放器验证后即可连接。</p><a href="${href}">连接到播放器</a><p>请在生成工程时使用的设备和浏览器中完成连接。若使用主屏幕 App，可回到 App 的手动连接入口填写本页地址。</p></html>`)
  }
  if(!env.PROXY_KEY||env.PROXY_KEY.length<32)return reply('Set PROXY_KEY to at least 32 random characters in Cloudflare Settings > Variables and Secrets.',503)
  // Query key supports native media elements; avoid access logs and caching.
  const key=request.headers.get('Authorization')?.replace(/^Bearer /,'')||url.searchParams.get('key')||''
  if(key!==env.PROXY_KEY)return reply('Invalid proxy key',401)
  const debugging=url.pathname==='/diagnostics'||url.pathname==='/probe'
  const started=debugging?Date.now():0,requestId=debugging?crypto.randomUUID():'',hops=debugging?[]:null
  const edge=debugging?{colo:request.cf?.colo??null,country:request.cf?.country??null}:null
  const json=(data,status=200)=>{headers.set('Content-Type','application/json');return reply(JSON.stringify(data),status)}
  if(url.pathname==='/diagnostics')return json({service:'any-listen-personal-proxy',diagnosticsVersion:1,requestId,edge,capabilities:['on-demand-probe','range-probe'],storage:'none',automaticDiagnostics:false,limits:{redirects:4,probeTimeoutMs:8000},allowedHosts:hosts})
  if(url.pathname==='/health'){headers.set('Content-Type','application/json');return reply(JSON.stringify({service:'any-listen-personal-proxy',version:1,diagnosticsVersion:1}))}
  const probing=url.pathname==='/probe'
  if(!probing&&url.pathname!=='/proxy')return reply('Not found',404)
  let target=url.searchParams.get('url')||''
  const controller=new AbortController(),cancel=()=>controller.abort(),timer=probing?setTimeout(()=>controller.abort(),8000):undefined
  request.signal.addEventListener('abort',cancel,{once:true});if(request.signal.aborted)cancel()
  const safeHeader=(result,name,pattern)=>{const value=result.headers.get(name);return value&&pattern.test(value)?value:null}
  const finish=(message,status,outcome='complete',result)=>{
   if(!debugging)return reply(message,status)
   headers.set('X-Proxy-Request-Id',requestId);headers.set('X-Proxy-Hop-Count',String(hops.length))
   headers.set('Server-Timing',`proxy;dur=${Date.now()-started}`)
   if(result)headers.set('X-Proxy-Upstream-Status',String(result.status))
   if(probing)return json({service:'any-listen-personal-proxy',diagnosticsVersion:1,requestId,edge,outcome,headersMs:Date.now()-started,hops,upstream:result?{status:result.status,contentType:safeHeader(result,'content-type',/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+(?:;[ a-zA-Z0-9=._-]+)?$/),contentLength:safeHeader(result,'content-length',/^\d{1,20}$/),contentRange:safeHeader(result,'content-range',/^bytes (?:\d+-\d+|\*)\/(?:\d+|\*)$/),acceptRanges:safeHeader(result,'accept-ranges',/^(bytes|none)$/),cacheStatus:safeHeader(result,'cf-cache-status',/^[A-Z_]{1,24}$/),ray:safeHeader(result,'cf-ray',/^[a-zA-Z0-9-]{1,80}$/)}:null},status)
   return reply(message,status)
  }
  const upstreamHeaders=new Headers()
  for(const name of ['Range','If-Range','If-None-Match','If-Modified-Since'])if(request.headers.has(name))upstreamHeaders.set(name,request.headers.get(name))
  if(probing)upstreamHeaders.set('Range','bytes=0-0')
  try {
   for(let redirects=0;redirects<=4;redirects++) {
    if(!allowedTarget(target))return finish('Target is not allowed',403,'target_rejected')
    // Fixed platform headers only. Never forward the caller's cookies or auth.
    const host=new URL(target).hostname
    upstreamHeaders.delete('Referer')
    if(host==='api.bilibili.com'||host.endsWith('.bilivideo.com')||host.endsWith('.bilivideo.cn'))upstreamHeaders.set('Referer','https://www.bilibili.com/')
    const hopStart=debugging?Date.now():0
    const result=await outbound(target,{method:probing?'GET':request.method,headers:upstreamHeaders,redirect:'manual',signal:probing?controller.signal:request.signal})
    if(debugging)hops.push({origin:new URL(target).origin,status:result.status,headersMs:Date.now()-hopStart})
    if([301,302,303,307,308].includes(result.status)) {
     const location=result.headers.get('Location');await result.body?.cancel()
     if(!location)return finish('Invalid upstream redirect',502,'invalid_redirect')
     target=new URL(location,target).href;continue
    }
    if(probing){await result.body?.cancel();return finish(null,200,'complete',result)}
    headers.set('X-Upstream-URL',target)
    for(const name of ['Content-Type','Content-Length','Content-Range','Accept-Ranges','ETag','Last-Modified'])if(result.headers.has(name))headers.set(name,result.headers.get(name))
    return new Response(request.method==='HEAD'?null:result.body,{status:result.status,headers})
   }
   return finish('Too many upstream redirects',502,'redirect_limit')
  }catch{return finish('Upstream connection failed',502,request.signal.aborted?'cancelled':controller.signal.aborted?'timeout':'network_error')}
  finally{clearTimeout(timer);request.signal.removeEventListener('abort',cancel)}
 }
}
export default {fetch:createHandler()}
