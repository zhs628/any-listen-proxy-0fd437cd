// BEGIN SOCKET-FETCH VENDOR
/* PeronGH/socket-fetch, MIT, pinned 3db1b05e853694a6453a5f159c573ef600d2ed5b
MIT License

Copyright (c) 2026 Peron

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
// vendor/socket-fetch/src/buffered_reader.ts
var LF = 10;
var CR = 13;
var BufferedReader = class {
  #reader;
  #buffer = new Uint8Array(0);
  constructor(stream) {
    this.#reader = stream.getReader();
  }
  /** Returns up to `max` bytes, or `null` at end of stream. */
  async read(max) {
    while (this.#buffer.length === 0) {
      const { done, value } = await this.#reader.read();
      if (done) return null;
      this.#buffer = value;
    }
    const chunk = this.#buffer.subarray(0, max);
    this.#buffer = this.#buffer.subarray(chunk.length);
    return chunk;
  }
  /**
   * Returns the next line without its LF or CRLF terminator, or `null` if the stream ends before any byte.
   * Throws if the line exceeds `limit` bytes or the stream ends mid-line.
   */
  async readLine(limit) {
    let searchFrom = 0;
    while (true) {
      const lf = this.#buffer.indexOf(LF, searchFrom);
      if (lf !== -1) {
        const end = lf > 0 && this.#buffer[lf - 1] === CR ? lf - 1 : lf;
        if (end > limit) throw new Error("Line too long");
        const line = this.#buffer.subarray(0, end);
        this.#buffer = this.#buffer.subarray(lf + 1);
        return line;
      }
      if (this.#buffer.length > limit + 1) throw new Error("Line too long");
      searchFrom = this.#buffer.length;
      const { done, value } = await this.#reader.read();
      if (done) {
        if (this.#buffer.length === 0) return null;
        throw new Error("Connection closed mid-line");
      }
      this.#buffer = this.#buffer.length === 0 ? value : concat(this.#buffer, value);
    }
  }
};
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// vendor/socket-fetch/src/http1.ts
var MAX_HEAD_SIZE = 64 * 1024;
var MAX_CHUNK_LINE_SIZE = 4 * 1024;
var SP = 32;
var HTAB = 9;
var CR2 = 13;
var NUL = 0;
var STATUS_LINE = /^HTTP\/1\.(\d) (\d{3})(?: (.*))?$/;
var CONTENT_LENGTH = /^\d+$/;
var HEX = /^[0-9a-fA-F]+$/;
var FRAMING_HEADERS = ["content-length", "transfer-encoding"];
var CRLF = new Uint8Array([13, 10]);
var LAST_CHUNK = new Uint8Array([48, 13, 10, 13, 10]);
function serializeRequest(method, url, requestHeaders, body) {
  const headers = new Headers(requestHeaders);
  const host = headers.get("host") ?? url.host;
  headers.delete("host");
  for (const name of FRAMING_HEADERS) headers.delete(name);
  if (!headers.has("accept")) headers.set("accept", "*/*");
  if (!headers.has("accept-encoding")) {
    headers.set(
      "accept-encoding",
      headers.has("range") ? "identity" : "gzip, deflate"
    );
  }
  let head = `${method} ${url.pathname}${url.search} HTTP/1.1\r
host: ${host}\r
`;
  for (const [name, value] of headers) head += `${name}: ${value}\r
`;
  if (body instanceof ReadableStream) {
    head += "transfer-encoding: chunked\r\n";
  } else if (body !== null) {
    head += `content-length: ${body.length}\r
`;
  } else if (method === "POST" || method === "PUT") {
    head += "content-length: 0\r\n";
  }
  if (!headers.has("connection")) head += "connection: close\r\n";
  head += "\r\n";
  const buffered = body instanceof Uint8Array ? body : null;
  const bytes = new Uint8Array(head.length + (buffered?.length ?? 0));
  for (let i = 0; i < head.length; i++) bytes[i] = head.charCodeAt(i);
  if (buffered !== null) bytes.set(buffered, head.length);
  return bytes;
}
function chunkedEncoder() {
  return new TransformStream({
    transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("Request body chunks must be Uint8Array");
      }
      if (chunk.length === 0) return;
      const size = `${chunk.length.toString(16)}\r
`;
      const bytes = new Uint8Array(size.length + chunk.length + 2);
      for (let i = 0; i < size.length; i++) bytes[i] = size.charCodeAt(i);
      bytes.set(chunk, size.length);
      bytes.set(CRLF, size.length + chunk.length);
      controller.enqueue(bytes);
    },
    flush(controller) {
      controller.enqueue(LAST_CHUNK);
    }
  });
}
async function readResponseHead(reader) {
  while (true) {
    const head = await readHead(reader);
    if (head.status === 101) {
      throw new Error("Unexpected 101 Switching Protocols");
    }
    if (head.status >= 200) return head;
  }
}
async function readHead(reader) {
  let budget = MAX_HEAD_SIZE;
  const nextLine = async () => {
    const line = await reader.readLine(budget);
    if (line === null) {
      throw new Error("Connection closed before response head");
    }
    if (line.includes(CR2) || line.includes(NUL)) {
      throw new Error("CR or NUL in response head");
    }
    budget -= line.length + 2;
    return line;
  };
  const statusLine = decode(await nextLine());
  const match = STATUS_LINE.exec(statusLine);
  if (match === null) {
    throw new Error(`Invalid status line: ${JSON.stringify(statusLine)}`);
  }
  const status = Number(match[2]);
  if (status < 100 || status > 599) {
    throw new Error(`Status code out of range: ${status}`);
  }
  const fields = [];
  while (true) {
    const line = await nextLine();
    if (line.length === 0) break;
    if (line[0] === SP || line[0] === HTAB) {
      const last = fields.at(-1);
      if (last === void 0) {
        throw new Error("Whitespace before first header field");
      }
      last[1] = `${trimOws(last[1])} ${trimOws(decode(line))}`;
      continue;
    }
    const text = decode(line);
    const colon = text.indexOf(":");
    if (colon <= 0) {
      throw new Error(`Invalid header field: ${JSON.stringify(text)}`);
    }
    fields.push([text.slice(0, colon), text.slice(colon + 1)]);
  }
  const headers = new Headers();
  for (const [name, value] of fields) headers.append(name, value);
  return {
    minorVersion: Number(match[1]),
    status,
    statusText: match[3] ?? "",
    headers
  };
}
function bodySource(reader, head, method) {
  if (method === "HEAD" || head.status === 204 || head.status === 304) {
    return null;
  }
  const transferEncoding = head.headers.get("transfer-encoding");
  if (transferEncoding !== null) {
    if (head.minorVersion === 0) {
      throw new Error("Transfer-Encoding in HTTP/1.0 response");
    }
    if (head.headers.has("content-length")) {
      throw new Error("Both Transfer-Encoding and Content-Length present");
    }
    const codings = parseList(transferEncoding).map(
      (coding) => coding.toLowerCase()
    );
    if (codings.length !== 1 || codings[0] !== "chunked") {
      throw new Error(`Unsupported Transfer-Encoding: ${transferEncoding}`);
    }
    return chunkedSource(reader);
  }
  const contentLength = head.headers.get("content-length");
  if (contentLength !== null) {
    return lengthSource(reader, parseContentLength(contentLength));
  }
  return () => reader.read(Infinity);
}
function parseContentLength(value) {
  const values = new Set(parseList(value));
  const [length] = values;
  if (values.size !== 1 || !CONTENT_LENGTH.test(length)) {
    throw new Error(`Invalid Content-Length: ${value}`);
  }
  const parsed = Number(length);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Content-Length too large: ${value}`);
  }
  return parsed;
}
function lengthSource(reader, length) {
  let remaining = length;
  return async () => {
    if (remaining === 0) return null;
    const chunk = await reader.read(remaining);
    if (chunk === null) throw new Error("Connection closed before end of body");
    remaining -= chunk.length;
    return chunk;
  };
}
function chunkedSource(reader) {
  let remaining = 0;
  let done = false;
  return async () => {
    if (done) return null;
    if (remaining === 0) {
      remaining = await readChunkSize(reader);
      if (remaining === 0) {
        await skipTrailers(reader);
        done = true;
        return null;
      }
    }
    const chunk = await reader.read(remaining);
    if (chunk === null) {
      throw new Error("Connection closed before end of chunked body");
    }
    remaining -= chunk.length;
    if (remaining === 0 && await reader.readLine(0) === null) {
      throw new Error("Connection closed before end of chunked body");
    }
    return chunk;
  };
}
async function readChunkSize(reader) {
  const line = await reader.readLine(MAX_CHUNK_LINE_SIZE);
  if (line === null) {
    throw new Error("Connection closed before end of chunked body");
  }
  const text = decode(line);
  const semicolon = text.indexOf(";");
  const size = (semicolon === -1 ? text : text.slice(0, semicolon)).replace(
    /[ \t]+$/,
    ""
  );
  if (!HEX.test(size)) {
    throw new Error(`Invalid chunk size: ${JSON.stringify(text)}`);
  }
  const parsed = parseInt(size, 16);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Chunk size too large: ${size}`);
  }
  return parsed;
}
async function skipTrailers(reader) {
  let budget = MAX_HEAD_SIZE;
  while (true) {
    const line = await reader.readLine(budget);
    if (line === null) {
      throw new Error("Connection closed before end of trailers");
    }
    if (line.length === 0) return;
    budget -= line.length + 2;
  }
}
var DECODERS = /* @__PURE__ */ new Map([
  ["gzip", (body) => decompress(body, "gzip")],
  ["x-gzip", (body) => decompress(body, "gzip")],
  ["deflate", inflate]
]);
function decodeContent(body, contentEncoding) {
  if (contentEncoding === null) return body;
  const decoders = parseList(contentEncoding).map(
    (coding) => DECODERS.get(coding.toLowerCase())
  );
  if (decoders.some((decoder) => decoder === void 0)) return body;
  let decoded = body;
  for (const decoder of decoders.reverse()) {
    decoded = decoder(decoded);
  }
  return decoded;
}
function decompress(body, format) {
  const decompression = new DecompressionStream(format);
  return body.pipeThrough(decompression);
}
function inflate(body) {
  const reader = body.getReader();
  let output;
  const start = async () => {
    let head = new Uint8Array(0);
    while (head.length < 2) {
      const { done, value } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(head.length + value.length);
      joined.set(head);
      joined.set(value, head.length);
      head = joined;
    }
    const rest = new ReadableStream({
      start(controller) {
        if (head.length > 0) controller.enqueue(head);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason)
    }, { highWaterMark: 0 });
    return decompress(rest, isZlibHeader(head) ? "deflate" : "deflate-raw").getReader();
  };
  return new ReadableStream({
    async pull(controller) {
      output ??= await start();
      const { done, value } = await output.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => (output ?? reader).cancel(reason)
  }, { highWaterMark: 0 });
}
function isZlibHeader(bytes) {
  return bytes.length >= 2 && (bytes[0] & 15) === 8 && bytes[0] >> 4 <= 7 && (bytes[0] << 8 | bytes[1]) % 31 === 0;
}
function parseList(value) {
  return value.split(",").map(trimOws).filter((element) => element !== "");
}
function trimOws(value) {
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}
function decode(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return text;
}

// vendor/socket-fetch/src/fetch.ts
var REDIRECT_STATUSES = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
var MAX_REDIRECTS = 20;
var REQUEST_BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-location",
  "content-type"
];
async function send(options, input, init) {
  const request = new Request(input, init);
  const { signal } = request;
  signal.throwIfAborted();
  const streaming = init?.body instanceof ReadableStream;
  const exchange = {
    method: request.method,
    url: new URL(request.url),
    headers: new Headers(request.headers),
    body: request.body === null ? null : streaming ? request.body : new Uint8Array(await request.arrayBuffer())
  };
  for (let redirects = 0; ; redirects++) {
    const response = await exchangeOnce(options, exchange, signal);
    const { status } = response;
    if (!REDIRECT_STATUSES.has(status) || request.redirect === "manual") {
      return finish(response, exchange.url, redirects > 0);
    }
    const location = response.headers.get("location");
    if (request.redirect === "follow" && location === null) {
      return finish(response, exchange.url, redirects > 0);
    }
    await response.body?.cancel();
    if (request.redirect === "error") {
      throw networkError(`Redirect with redirect mode "error"`);
    }
    const next = URL.parse(location, exchange.url);
    if (next === null) throw networkError(`Invalid Location: ${location}`);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw networkError(`Redirect to unsupported protocol: ${next.protocol}`);
    }
    if (redirects === MAX_REDIRECTS) throw networkError("Too many redirects");
    if (status !== 303 && exchange.body !== null && streaming) {
      throw networkError("Cannot replay a stream body on redirect");
    }
    if ((status === 301 || status === 302) && exchange.method === "POST" || status === 303 && exchange.method !== "GET" && exchange.method !== "HEAD") {
      exchange.method = "GET";
      exchange.body = null;
      for (const name of REQUEST_BODY_HEADERS) exchange.headers.delete(name);
    }
    if (next.origin !== exchange.url.origin) {
      exchange.headers.delete("authorization");
      exchange.headers.delete("host");
    }
    exchange.url = next;
  }
}
async function exchangeOnce(options, { method, url, headers, body }, signal) {
  const connect = url.protocol === "http:" ? options.connect : url.protocol === "https:" ? options.connectTls : void 0;
  if (connect === void 0) {
    throw networkError(`Unsupported protocol: ${url.protocol}`);
  }
  const message = serializeRequest(method, url, headers, body);
  const connection = new Connection(signal);
  try {
    const socket = await connection.open(connect, toAddress(url));
    await connection.run(write(socket, message, body, signal));
    const reader = new BufferedReader(socket.readable);
    const head = await connection.run(readResponseHead(reader));
    const source = bodySource(reader, head, method);
    const stream = source === null ? null : decodeContent(
      connection.stream(source),
      head.headers.get("content-encoding")
    );
    if (stream === null) await connection.close();
    return new Response(stream, {
      status: head.status,
      statusText: head.statusText,
      headers: head.headers
    });
  } catch (error) {
    await connection.close();
    throw connection.toFetchError(error);
  }
}
function finish(response, url, redirected) {
  const responseUrl = new URL(url);
  responseUrl.hash = "";
  return withFetchFields(response, responseUrl.href, redirected);
}
function withFetchFields(response, url, redirected) {
  const clone = response.clone.bind(response);
  return Object.defineProperties(response, {
    url: { value: url },
    redirected: { value: redirected },
    headers: { value: new ImmutableHeaders(response.headers) },
    clone: { value: () => withFetchFields(clone(), url, redirected) }
  });
}
var ImmutableHeaders = class extends Headers {
  append() {
    throw new TypeError("Headers are immutable");
  }
  set() {
    throw new TypeError("Headers are immutable");
  }
  delete() {
    throw new TypeError("Headers are immutable");
  }
};
function networkError(message) {
  return new TypeError("fetch failed", { cause: new Error(message) });
}
var Connection = class {
  #signal;
  #onAbort;
  #socket;
  #controller;
  #closed = false;
  constructor(signal) {
    this.#signal = signal;
    this.#onAbort = () => {
      this.#controller?.error(signal.reason);
      this.close();
    };
    signal.addEventListener("abort", this.#onAbort);
  }
  async open(connect, address) {
    const pending = Promise.resolve().then(() => connect(address));
    try {
      this.#socket = await this.run(pending);
    } catch (error) {
      pending.then(closeQuietly, () => {
      });
      throw error;
    }
    return this.#socket;
  }
  /** Settles with `promise`, or rejects with the abort reason as soon as the signal aborts. */
  run(promise) {
    const signal = this.#signal;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort);
      promise.then(resolve, reject).finally(
        () => signal.removeEventListener("abort", onAbort)
      );
    });
  }
  stream(source) {
    return new ReadableStream({
      start: (controller) => {
        this.#controller = controller;
      },
      pull: async (controller) => {
        try {
          const chunk = await this.run(source());
          if (chunk === null) {
            controller.close();
            await this.close();
          } else {
            controller.enqueue(chunk);
          }
        } catch (error) {
          await this.close();
          controller.error(this.toFetchError(error));
        }
      },
      cancel: () => this.close()
    }, { highWaterMark: 0 });
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#signal.removeEventListener("abort", this.#onAbort);
    if (this.#socket !== void 0) await closeQuietly(this.#socket);
  }
  toFetchError(error) {
    return this.#signal.aborted ? this.#signal.reason : new TypeError("fetch failed", { cause: error });
  }
};
async function write(socket, message, body, signal) {
  const writer = socket.writable.getWriter();
  try {
    await writer.write(message);
  } finally {
    writer.releaseLock();
  }
  if (body instanceof ReadableStream) {
    await body.pipeThrough(chunkedEncoder()).pipeTo(socket.writable, {
      preventClose: true,
      signal
    });
  }
}
async function closeQuietly(socket) {
  try {
    await socket.close();
  } catch {
  }
}
function toAddress(url) {
  const port = url.port === "" ? url.protocol === "https:" ? 443 : 80 : Number(url.port);
  return { hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"), port };
}

// vendor/socket-fetch/mod.ts
function createFetcher(options) {
  return (input, init) => send(options, input, init);
}
export {
  createFetcher
};
// END SOCKET-FETCH VENDOR
// Personal music proxy. No account-management credentials are needed at runtime.
export const hosts = ['api.bilibili.com','b23.tv','bilibili.com','bilivideo.com','bilivideo.cn','hdslb.com','music.126.net','music.163.com','126.net','y.qq.com','qqmusic.qq.com','gtimg.cn','kuwo.cn','kwcdn.kuwo.cn','music-api.gdstudio.xyz','oiapi.net','api.xunhuisi.store','www.cyanyun.com','h.miti.cc.cd','open.spotify.com','api-partner.spotify.com']
export function allowedTarget(value) {
  try { const u=new URL(value); return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&(hosts.some(h=>u.hostname===h||u.hostname.endsWith('.'+h))||(u.hostname==='raw.githubusercontent.com'&&u.pathname==='/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretDict.json')) } catch { return false }
}
// Operator-configured additions need no Worker source changes. Never allow IP/local destinations.
export function extraHosts(value){
 return String(value||'').split(/[\s,]+/).filter(h=>h.length<=253&&/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)&&!/(^|\.)(localhost|local|internal|home|lan|test|invalid)$/.test(h)).slice(0,128)
}
export function configuredTarget(value,env){
 if(allowedTarget(value))return true
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&extraHosts(env.EXTRA_ALLOWED_HOSTS).includes(u.hostname)}catch{return false}
}
const transportCapabilities=['configurable-hosts','upstream-headers-v1']
function transportInfo(env){return {protocolVersion:2,methods:['GET','HEAD'],capabilities:transportCapabilities,extraAllowedHosts:extraHosts(env.EXTRA_ALLOWED_HOSTS)}}
function forwardedHeaders(request){
 const raw=request.headers.get('X-Proxy-Upstream-Headers');if(!raw)return []
 if(raw.length>16384)throw Error('Upstream headers exceed 16 KiB')
 const values=JSON.parse(raw)
 if(!values||Array.isArray(values)||typeof values!=='object'||Object.keys(values).length>32)throw Error('Expected at most 32 upstream headers')
 return Object.entries(values).map(([name,value])=>{
  if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)||/^(host|cookie|set-cookie|content-length|transfer-encoding|connection|upgrade|proxy-.*|trailer|te|cf-.*|x-forwarded-.*)$/i.test(name))throw Error('Unsupported upstream header')
  if(typeof value!=='string'||/[^\x20-\x7e]/.test(value))throw Error('Invalid upstream header value')
  return [name,value]
 })
}
const biliApiCookiePaths=new Set(['/x/web-interface/wbi/search/type','/x/web-interface/wbi/view','/x/space/wbi/arc/search','/x/polymer/web-space/seasons_series_list','/x/polymer/web-space/seasons_archives_list','/x/player/wbi/playurl','/x/series/series','/x/series/archives'])
const defaultBiliUserAgent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
function biliSiteUrl(value,fallback,originOnly=false){
 try{const u=new URL(value);if(u.protocol!=='https:'||!['www.bilibili.com','bilibili.com'].includes(u.hostname)||u.username||u.password||u.port||u.search||u.hash||(originOnly&&u.pathname!=='/'))return fallback;return originOnly?u.origin:u.href}catch{return fallback}
}
function biliHeaders(target,env,base){
 const u=new URL(target),host=u.hostname,api=host==='api.bilibili.com',video=host==='bilivideo.com'||host.endsWith('.bilivideo.com')||host==='bilivideo.cn'||host.endsWith('.bilivideo.cn'),headers=new Headers(base)
 if(!api&&!video)return headers
 const agent=typeof env.BILI_USER_AGENT==='string'&&env.BILI_USER_AGENT.length>0&&env.BILI_USER_AGENT.length<=512&&!/[\r\n\0]/.test(env.BILI_USER_AGENT)?env.BILI_USER_AGENT:defaultBiliUserAgent
 headers.set('User-Agent',agent);headers.set('Referer',biliSiteUrl(env.BILI_REFERER,'https://www.bilibili.com/'))
 if(api){headers.set('Origin',biliSiteUrl(env.BILI_ORIGIN,'https://www.bilibili.com',true));headers.set('Accept','application/json, text/plain, */*')}
 const cookie=env.BILI_COOKIE
 const cookieAllowed=api&&biliApiCookiePaths.has(u.pathname)
 if(cookieAllowed&&typeof cookie==='string'&&cookie.length<=4096&&!/[^\x20-\x7e]/.test(cookie)&&cookie.includes('='))headers.set('Cookie',cookie)
 else headers.delete('Cookie')
 return headers
}
// Bilibili metadata uses the pinned socket HTTP client; audio remains streamed by fetch.
const anonymousCookiePaths=new Set([...biliApiCookiePaths,'/x/web-interface/view','/x/web-interface/card'])
export async function readBoundedBody(response,signal,limit){
 const reader=response.body?.getReader();if(!reader)return new Uint8Array()
 let length=0;const chunks=[]
 try{while(true){signal.throwIfAborted();const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>limit)throw Error('Upstream response exceeds '+limit+' bytes');chunks.push(value)}}catch(error){await reader.cancel().catch(()=>{});throw error}finally{reader.releaseLock()}
 const body=new Uint8Array(length);let at=0;for(const part of chunks){body.set(part,at);at+=part.length}return body
}
export async function socketHttpFetch(target,init,connectOverride){
 if(!allowedTarget(target))throw Error('Target is not allowed')
 const connect=connectOverride??(await import('cloudflare:sockets')).connect
 const socketConnect=address=>{if(address.port!==443||address.hostname!==new URL(target).hostname)throw Error('Socket destination mismatch');const socket=connect(address,{secureTransport:'on',allowHalfOpen:false});socket.closed?.catch(()=>{});return socket}
 return createFetcher({connect:()=>{throw Error('HTTPS required')},connectTls:socketConnect})(target,{...init,redirect:'manual'})
}
export const workerBuild='2026-11-14.1'
function diagnosticOverrides(request){
 const raw=request.headers.get('X-Proxy-Probe-Headers')
 if(!raw)return []
 if(raw.length>16384)throw Error('Diagnostic header configuration exceeds 16 KiB')
 const values=JSON.parse(raw)
 if(!values||Array.isArray(values)||typeof values!=='object'||Object.keys(values).length>32)throw Error('Expected at most 32 diagnostic headers')
 return Object.entries(values).map(([name,value])=>{
  if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)||/^(host|content-length|transfer-encoding|connection|upgrade|proxy-authorization|proxy-connection|trailer|te)$/i.test(name))throw Error('Unsupported diagnostic header')
  if(value!==null&&(typeof value!=='string'||/[^\x20-\x7e]/.test(value)))throw Error('Invalid diagnostic header value')
  return [name,value]
 })
}
// Header-only TLS/HTTP1 probe. It never serves normal proxy traffic or reads a response body.
export async function probeHttpsSocket(target,method,headers,signal,connectOverride){
 if(!allowedTarget(target))throw Error('Target is not allowed')
 signal.throwIfAborted()
 const connect=connectOverride??(await import('cloudflare:sockets')).connect,u=new URL(target)
 const socket=connect({hostname:u.hostname,port:443},{secureTransport:'on',allowHalfOpen:false})
 socket.closed.catch(()=>{})
 const close=()=>{socket.close().catch(()=>{})}
 signal.addEventListener('abort',close,{once:true});if(signal.aborted)close()
 let reader,writer
 try{
  const connection=await socket.opened;signal.throwIfAborted()
  const wireHeaders=new Headers(headers);wireHeaders.set('Host',u.host);wireHeaders.set('Connection','close')
  const requestText=`${method} ${u.pathname+u.search} HTTP/1.1\r\n`+[...wireHeaders].map(([k,v])=>`${k}: ${v}\r\n`).join('')+'\r\n'
  writer=socket.writable.getWriter();await writer.write(new TextEncoder().encode(requestText));writer.releaseLock();writer=undefined
  reader=socket.readable.getReader();let bytes=new Uint8Array(0),end=-1
  while(end<0){
   const chunk=await reader.read();signal.throwIfAborted();if(chunk.done)throw Error('Socket closed before response headers')
   const part=chunk.value.subarray(0,Math.max(0,32768-bytes.length)),next=new Uint8Array(bytes.length+part.length);next.set(bytes);next.set(part,bytes.length);bytes=next
   for(let i=0;i+3<bytes.length;i++)if(bytes[i]===13&&bytes[i+1]===10&&bytes[i+2]===13&&bytes[i+3]===10){end=i;break}
   if(end<0&&bytes.length>=32768)throw Error('Response headers exceed 32 KiB')
  }
  const responseHeaderText=new TextDecoder('iso-8859-1').decode(bytes.subarray(0,end)),lines=responseHeaderText.split('\r\n'),status=/^HTTP\/1\.[01] ([2-5]\d\d)(?: (.*))?$/.exec(lines.shift())
  if(!status)throw Error('Unsupported HTTP response status')
  const responseHeaders=new Headers()
  for(const line of lines){const at=line.indexOf(':');if(at<1)throw Error('Invalid HTTP response header');responseHeaders.append(line.slice(0,at),line.slice(at+1).trim())}
  return {response:new Response(null,{status:Number(status[1]),statusText:status[2]??'',headers:responseHeaders}),connection,requestText,responseHeaderText,wireHeaders}
 }finally{
  writer?.releaseLock();reader?.releaseLock();signal.removeEventListener('abort',close);close()
 }
}
function requestSummary(target,method,headers){
 const u=new URL(target)
 const visibleHeaders=Object.fromEntries(headers)
 if(headers.has('Authorization'))visibleHeaders.authorization='[redacted]'
 return {url:u.href,method,origin:u.origin,headers:visibleHeaders,cookieSent:headers.has('Cookie'),visibility:'fetch-input'}
}
function responseSummary(result){
 return {status:result.status,statusText:result.statusText,headers:Object.fromEntries(result.headers),setCookies:result.headers.getSetCookie?.()??[]}
}
function errorSummary(error,depth=0){return {name:String(error?.name??'Error'),message:String(error?.message??error),...(error?.cause&&depth<3?{cause:errorSummary(error.cause,depth+1)}:{})}}
const exposed='Content-Type, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, X-Upstream-URL, X-Proxy-Request-Id, X-Proxy-Upstream-Status, X-Proxy-Hop-Count, Server-Timing'
export function createHandler(outbound=fetch,connectSocket,socketTransport) {
 let anonymousCookie='',anonymousUntil=0
 const apiFetch=socketTransport??((target,init)=>socketHttpFetch(target,init,connectSocket))
 async function anonymousDevice(env,signal,dependencies){
  if(anonymousCookie&&anonymousUntil>Date.now()){dependencies?.push({kind:'anonymous-device',cache:'memory',networkRequests:0});return anonymousCookie}
  const target='https://api.bilibili.com/x/frontend/finger/spi',headers=biliHeaders(target,env,new Headers({'Accept-Encoding':'identity'})),start=Date.now()
  const dependency=dependencies?{kind:'anonymous-device',cache:'miss',request:{...requestSummary(target,'GET',headers),visibility:'socket-input'},response:null,headersMs:null}:null
  if(dependency)dependencies.push(dependency)
  let response
  try{response=await apiFetch(target,{method:'GET',headers,redirect:'manual',signal})}catch(error){if(dependency){dependency.error=errorSummary(error);dependency.headersMs=Date.now()-start}throw error}
  if(dependency){dependency.response=responseSummary(response);dependency.headersMs=Date.now()-start}
  if(!response.ok){await response.body?.cancel();throw Error('Anonymous device request HTTP '+response.status)}
  const data=JSON.parse(new TextDecoder().decode(await readBoundedBody(response,signal,32768))),id=data?.data?.b_3
  if(data?.code!==0||typeof id!=='string'||!/^[A-Za-z0-9-]{10,128}$/.test(id))throw Error('Invalid anonymous device response')
  anonymousCookie='buvid3='+id;anonymousUntil=Date.now()+30*60000;return anonymousCookie
 }
 return async function handle(request,env) {
  const url=new URL(request.url),origin=request.headers.get('Origin'),app=env.APP_ORIGIN||''
  const headers=new Headers({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin'})
  if(origin===app){headers.set('Access-Control-Allow-Origin',app);headers.set('Access-Control-Expose-Headers',exposed)}
  const reply=(body,status=200)=>new Response(body,{status,headers})
  if(origin&&origin!==app)return reply('Origin is not allowed',403)
  if(request.method==='OPTIONS') {
   headers.set('Access-Control-Allow-Methods','GET, HEAD, OPTIONS')
   headers.set('Access-Control-Allow-Headers','Authorization, Range, If-Range, If-None-Match, If-Modified-Since, X-Proxy-Probe-Headers, X-Spotify-Authorization, X-Proxy-Upstream-Headers')
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
  if(url.pathname==='/diagnostics')return json({service:'any-listen-personal-proxy',diagnosticsVersion:1,diagnosticsRevision:5,workerBuild,transport:transportInfo(env),requestId,edge,capabilities:['on-demand-probe','range-probe','bilibili-request-profile','request-probe','head-probe','full-request-trace','probe-header-overrides','tls-socket-probe','bilibili-api-tls','anonymous-device-cookie','spotify-metadata'],probeTransports:['production','fetch','tls-socket'],probeModes:['request','range','head'],defaultProbeMode:'range',observability:{redacted:false,responseHeaders:true,requestHeaders:'fetch-input',wireHeaders:false,egressIP:false,tlsFingerprint:false},storage:'none',automaticDiagnostics:false,limits:{redirects:4,probeTimeoutMs:8000,maxResponseHeadersBytes:32768,maxOverrideHeaders:32,maxOverrideBytes:16384,productionApiTimeoutMs:15000,productionApiMaxBodyBytes:2097152,productionApiMaxHeadersBytes:65536,anonymousCookieTtlMs:1800000},allowedHosts:hosts})
  if(url.pathname==='/health'){headers.set('Content-Type','application/json');return reply(JSON.stringify({service:'any-listen-personal-proxy',version:1,diagnosticsVersion:1,diagnosticsRevision:5,workerBuild,...transportInfo(env)}))}
  const probing=url.pathname==='/probe',mode=url.searchParams.get('mode')||'range'
  if(probing&&!['request','range','head'].includes(mode))return json({service:'any-listen-personal-proxy',error:'unsupported_probe_mode',probeModes:['request','range','head']},400)
  if(!probing&&url.pathname!=='/proxy')return reply('Not found',404)
  let target=url.searchParams.get('url')||''
  const apiRequest=allowedTarget(target)&&new URL(target).hostname==='api.bilibili.com'
  const transport=probing?(url.searchParams.get('transport')||'fetch'):(apiRequest?'production':'fetch')
  const dependencies=probing?[]:null
  let failure=null
  if(!['production','fetch','tls-socket'].includes(transport))return json({error:'unsupported_probe_transport'},400)
  let overrides=[];try{if(probing)overrides=diagnosticOverrides(request)}catch(error){return json({error:'invalid_probe_headers',message:String(error.message)},400)}
  let forwarded=[];try{forwarded=forwardedHeaders(request)}catch(error){return json({error:'invalid_upstream_headers',message:error.message},400)}
  const initialOrigin=configuredTarget(target,env)?new URL(target).origin:null
  const controller=new AbortController(),cancel=()=>controller.abort(),timer=probing||apiRequest?setTimeout(()=>controller.abort(),probing?8000:15000):undefined
  request.signal.addEventListener('abort',cancel,{once:true});if(request.signal.aborted)cancel()
  const safeHeader=(result,name,pattern)=>{const value=result.headers.get(name);return value&&pattern.test(value)?value:null}
  const finish=(message,status,outcome='complete',result)=>{
   if(!debugging)return reply(message,status)
   headers.set('X-Proxy-Request-Id',requestId);headers.set('X-Proxy-Hop-Count',String(hops.length))
   headers.set('Server-Timing',`proxy;dur=${Date.now()-started}`)
   if(result)headers.set('X-Proxy-Upstream-Status',String(result.status))
   if(probing)return json({service:'any-listen-personal-proxy',diagnosticsVersion:1,diagnosticsRevision:5,workerBuild,requestId,edge,mode,transport,dependencies,headerOverrideCount:overrides.length,cookieConfigured:Boolean(env.BILI_COOKIE),outcome,failure,headersMs:Date.now()-started,hops,upstream:result?{status:result.status,contentType:safeHeader(result,'content-type',/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+(?:;[ a-zA-Z0-9=._-]+)?$/),contentLength:safeHeader(result,'content-length',/^\d{1,20}$/),contentRange:safeHeader(result,'content-range',/^bytes (?:\d+-\d+|\*)\/(?:\d+|\*)$/),acceptRanges:safeHeader(result,'accept-ranges',/^(bytes|none)$/),cacheStatus:safeHeader(result,'cf-cache-status',/^[A-Z_]{1,24}$/),ray:safeHeader(result,'cf-ray',/^[a-zA-Z0-9-]{1,80}$/)}:null},status)
   return reply(message,status)
  }
  const upstreamHeaders=new Headers()
  for(const name of ['Range','If-Range','If-None-Match','If-Modified-Since'])if(request.headers.has(name))upstreamHeaders.set(name,request.headers.get(name))
  if(probing&&mode==='range')upstreamHeaders.set('Range','bytes=0-0')
  if(probing&&mode==='head')upstreamHeaders.delete('Range')
  try {
   for(let redirects=0;redirects<=4;redirects++) {
    if(!configuredTarget(target,env))return finish('Target is not allowed',403,'target_rejected')
    // Only configured Bilibili headers are added. Caller cookies and auth are never forwarded.
    const requestHeaders=biliHeaders(target,env,upstreamHeaders)
    if(new URL(target).origin===initialOrigin)for(const [name,value] of forwarded)requestHeaders.set(name,value)
    if(new URL(target).origin===initialOrigin&&new URL(target).hostname==='api-partner.spotify.com'){
     const spotifyAuth=request.headers.get('X-Spotify-Authorization')
     if(spotifyAuth&&/^Bearer [A-Za-z0-9._~+\/=-]{1,4096}$/.test(spotifyAuth))requestHeaders.set('Authorization',spotifyAuth)
     requestHeaders.set('app-platform','WebPlayer')
    }
    if(probing&&new URL(target).origin===initialOrigin)for(const [name,value] of overrides){if(value===null)requestHeaders.delete(name);else requestHeaders.set(name,value)}
    const productionTls=transport==='production'&&new URL(target).hostname==='api.bilibili.com'&&env.BILI_API_TRANSPORT!=='fetch'
    if(productionTls){
     if(anonymousCookiePaths.has(new URL(target).pathname)&&!requestHeaders.has('Cookie')&&!overrides.some(([name])=>name.toLowerCase()==='cookie'))requestHeaders.set('Cookie',await anonymousDevice(env,controller.signal,dependencies))
     requestHeaders.set('Accept-Encoding','identity')
    }
    const hopStart=debugging?Date.now():0,method=probing?(mode==='head'?'HEAD':'GET'):request.method
    const hop=debugging?{origin:new URL(target).origin,request:requestSummary(target,method,requestHeaders),status:null,headersMs:null}:null
    if(hop)hops.push(hop)
    let result
    if(productionTls){
     result=await apiFetch(target,{method,headers:requestHeaders,redirect:'manual',signal:controller.signal});if(hop){hop.transport='tls-socket-http';hop.request.visibility='socket-input'}
    }else if(transport==='tls-socket'){
     const raw=await probeHttpsSocket(target,method,requestHeaders,controller.signal,connectSocket);result=raw.response
     Object.assign(hop,{transport,connection:raw.connection,requestText:raw.requestText,responseHeaderText:raw.responseHeaderText});hop.request=requestSummary(target,method,raw.wireHeaders);hop.request.visibility='socket-http1'
    }else{result=await outbound(target,{method,headers:requestHeaders,redirect:'manual',signal:probing?controller.signal:request.signal});if(hop)hop.transport=transport}
    if(hop){hop.status=result.status;hop.headersMs=Date.now()-hopStart;hop.response=responseSummary(result);hop.redirect=[301,302,303,307,308].includes(result.status)}
    if([301,302,303,307,308].includes(result.status)) {
     const location=result.headers.get('Location');await result.body?.cancel()
     if(!location)return finish('Invalid upstream redirect',502,'invalid_redirect')
     target=new URL(location,target).href;continue
    }
    if(probing){await result.body?.cancel();return finish(null,200,result.status>=400?'upstream_rejected':'complete',result)}
    if(productionTls&&request.method!=='HEAD'){
     const body=await readBoundedBody(result,controller.signal,2*1048576),decodedHeaders=new Headers(result.headers)
     decodedHeaders.delete('Content-Encoding');decodedHeaders.delete('Transfer-Encoding');decodedHeaders.set('Content-Length',String(body.length))
     result=new Response(body.length?body:null,{status:result.status,statusText:result.statusText,headers:decodedHeaders})
    }
    headers.set('X-Upstream-URL',target)
    for(const name of ['Content-Type','Content-Length','Content-Range','Accept-Ranges','ETag','Last-Modified'])if(result.headers.has(name))headers.set(name,result.headers.get(name))
    return new Response(request.method==='HEAD'?null:result.body,{status:result.status,headers})
   }
   return finish('Too many upstream redirects',502,'redirect_limit')
  }catch(error){if(debugging){failure=errorSummary(error);if(hops.length)hops[hops.length-1].error=failure};return finish('Upstream connection failed',502,request.signal.aborted?'cancelled':controller.signal.aborted?'timeout':'network_error')}
  finally{clearTimeout(timer);request.signal.removeEventListener('abort',cancel)}
 }
}
export default {fetch:createHandler()}
