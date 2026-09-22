/**
 * 澳門找車位小助手 —— 專用中轉 (Cloudflare Worker)
 * =================================================
 *
 * 點解需要佢？
 *   GitHub Pages 係純靜態網站，冇後端。瀏覽器直接 call 交通事務局個 API
 *   會被 CORS 擋住，所以一定要有個中轉幫手轉發。以前靠免費公用中轉
 *   (corsproxy.io 等)，但佢哋陸續收費／失效，程式就會讀唔到數據。
 *   呢個 Worker 係你自己控制，唔會突然消失。
 *
 * 部署方法見同一個資料夾嘅 README.md。
 */

/* ── 設定 ──────────────────────────────────────────────────────────── */

/** 只准轉發去呢啲主機。冇咗呢層，任何人都可以攞你個 Worker 當萬用跳板用。 */
const ALLOWED_UPSTREAM_HOSTS = [
  'dsat.apigateway.data.gov.mo',
  'api.data.gov.mo',
];

/** 只准呢啲網頁叫呢個 Worker。要加新網址就喺呢度加一行。 */
const ALLOWED_ORIGINS = [
  'https://ronlam1981.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

/** 交通局 API 嘅 APPCODE。擺喺 Worker 度，前端就唔使自己帶。
 *  建議用 Cloudflare 嘅 Secret 存放（README 有講），env.APPCODE 會蓋過呢個預設值。 */
const DEFAULT_APPCODE = '09d43a591fba407fb862412970667de4';

/** 同一條 URL 喺 Cloudflare 邊緣快取幾耐（秒）。
 *  即時車位數據大約每分鐘更新一次，前端每 30 秒問一次，
 *  快取 15 秒可以減少對交通局伺服器嘅壓力，又唔會覺得數據舊咗。 */
const CACHE_TTL_SECONDS = 15;

/* ── 主程式 ────────────────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    // 瀏覽器帶自訂 header 之前會先發一個 OPTIONS 預檢請求。
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fail(405, '只支援 GET 請求', cors);
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) {
      return fail(400,
        '缺少 url 參數。正確用法：' + new URL(request.url).origin +
        '/?url=https%3A%2F%2Fdsat.apigateway.data.gov.mo%2Fcar_park_maintance',
        cors);
    }

    let upstream;
    try {
      upstream = new URL(target);
    } catch (e) {
      return fail(400, 'url 參數唔係一條有效網址：' + target, cors);
    }

    if (upstream.protocol !== 'https:') {
      return fail(400, '只轉發 https 網址', cors);
    }

    if (!ALLOWED_UPSTREAM_HOSTS.includes(upstream.hostname)) {
      return fail(403,
        '唔准轉發去 ' + upstream.hostname +
        '。允許嘅主機：' + ALLOWED_UPSTREAM_HOSTS.join('、'),
        cors);
    }

    // 認證：優先用 Worker 自己存嘅 APPCODE；冇設就沿用前端帶嚟嗰個。
    const appcode = (env && env.APPCODE) || DEFAULT_APPCODE;
    const headers = { 'Accept': 'application/xml, text/xml, */*' };
    if (appcode) {
      headers['Authorization'] = 'APPCODE ' + appcode;
    } else {
      const passed = request.headers.get('Authorization');
      if (passed) headers['Authorization'] = passed;
    }

    let res;
    try {
      res = await fetch(upstream.toString(), {
        method: 'GET',
        headers,
        cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
      });
    } catch (e) {
      // 交通局伺服器連唔到／逾時，講清楚係邊個環節出事。
      return fail(502, '連唔到 ' + upstream.hostname + '：' + (e && e.message), cors);
    }

    if (!res.ok) {
      const body = await res.text();
      return fail(res.status,
        upstream.hostname + ' 回應 HTTP ' + res.status + '：' + body.slice(0, 300),
        cors);
    }

    // Stream the body straight through rather than reading it into a string:
    // the free plan allows 10 ms of CPU per request, and decoding ~50 KB of
    // XML on every call spends that budget for no reason. Only the error
    // path needs the text, and that one is rare.
    return new Response(res.body, {
      status: 200,
      headers: Object.assign({
        'Content-Type': res.headers.get('Content-Type') || 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=' + CACHE_TTL_SECONDS,
        'X-Proxied-Host': upstream.hostname,
      }, cors),
    });
  },
};

/* ── 小工具 ────────────────────────────────────────────────────────── */

function corsHeaders(origin) {
  // 唔喺名單上嘅來源，回一個永遠對唔上嘅值，瀏覽器自然會擋住。
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-cors-headers',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

/** 錯誤一律回 XML 格式嘅註解，前端嘅診斷面板可以原文照抄顯示出嚟。 */
function fail(status, message, cors) {
  return new Response('<!-- findcarpark-proxy error: ' + message + ' -->', {
    status,
    headers: Object.assign({ 'Content-Type': 'application/xml; charset=utf-8' }, cors),
  });
}
