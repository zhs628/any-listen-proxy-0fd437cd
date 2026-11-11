// Personal music proxy. No account-management credentials are needed at runtime.
export const hosts = ['api.bilibili.com','b23.tv','bilibili.com','bilivideo.com','bilivideo.cn','hdslb.com','music.126.net','music.163.com','126.net','y.qq.com','qqmusic.qq.com','gtimg.cn','kuwo.cn','kwcdn.kuwo.cn','music-api.gdstudio.xyz','oiapi.net','api.xunhuisi.store','www.cyanyun.com','h.miti.cc.cd']
export function allowedTarget(value) {
  try { const u=new URL(value); return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&hosts.some(h=>u.hostname===h||u.hostname.endsWith('.'+h)) } catch { return false }
}
const exposed='Content-Type, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, X-Upstream-URL'
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
  if(url.pathname==='/')return reply('Any Listen personal proxy. Return to the app and test this address.')
  if(!env.PROXY_KEY||env.PROXY_KEY.length<32)return reply('Set PROXY_KEY to at least 32 random characters in Cloudflare Settings > Variables and Secrets.',503)
  // Query key supports native media elements; avoid access logs and caching.
  const key=request.headers.get('Authorization')?.replace(/^Bearer /,'')||url.searchParams.get('key')||''
  if(key!==env.PROXY_KEY)return reply('Invalid proxy key',401)
  if(url.pathname==='/health'){headers.set('Content-Type','application/json');return reply(JSON.stringify({service:'any-listen-personal-proxy',version:1}))}
  if(url.pathname!=='/proxy')return reply('Not found',404)
  let target=url.searchParams.get('url')||''
  const upstreamHeaders=new Headers()
  for(const name of ['Range','If-Range','If-None-Match','If-Modified-Since'])if(request.headers.has(name))upstreamHeaders.set(name,request.headers.get(name))
  try {
   for(let redirects=0;redirects<=4;redirects++) {
    if(!allowedTarget(target))return reply('Target is not allowed',403)
    // Fixed platform headers only. Never forward the caller's cookies or auth.
    const host=new URL(target).hostname
    upstreamHeaders.delete('Referer')
    if(host==='api.bilibili.com'||host.endsWith('.bilivideo.com')||host.endsWith('.bilivideo.cn'))upstreamHeaders.set('Referer','https://www.bilibili.com/')
    const result=await outbound(target,{method:request.method,headers:upstreamHeaders,redirect:'manual',signal:request.signal})
    if([301,302,303,307,308].includes(result.status)) {
     const location=result.headers.get('Location');await result.body?.cancel()
     if(!location)return reply('Invalid upstream redirect',502)
     target=new URL(location,target).href;continue
    }
    headers.set('X-Upstream-URL',target)
    for(const name of exposed.split(', '))if(result.headers.has(name))headers.set(name,result.headers.get(name))
    return new Response(request.method==='HEAD'?null:result.body,{status:result.status,headers})
   }
   return reply('Too many upstream redirects',502)
  }catch{return reply('Upstream connection failed',502)}
 }
}
export default {fetch:createHandler()}
