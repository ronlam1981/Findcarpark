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

/** 交通事務局即時車位嘅端點，定時收集同轉發都係用佢。 */
const MAINTENANCE_URL = 'https://dsat.apigateway.data.gov.mo/car_park_maintance';

/** KV 入面存累積數據嗰條 key。 */
const HISTORY_KEY = 'busy_history_v1';

/* ── 定時收集（Cron Trigger）────────────────────────────────────────
 *
 * 瀏覽器關咗就唔會執行任何嘢，所以喺前端收集繁忙時間數據，永遠只收到
 * 「有人開住個網頁」嗰啲時段。呢度唔同：Cloudflare 會按 wrangler.toml
 * 入面嘅 cron 時間表，喺佢自己部機行呢段程式，一日 24 小時，冇人開網頁
 * 都照行。收到嘅數據存喺 KV，所有用呢個 Worker 嘅人共享同一份。
 *
 * 結構同前端一樣：
 *   { "<停車場編號>": { "<星期*24+小時>": [輕型總和, 次數, 電單車總和, 次數] } }
 * 就地平均，所以儲存量唔會隨時間增長。
 */

/** Workers 執行環境冇 DOMParser，所以要自己抽。格式係屬性式：
 *    <Car_park_info ID="1" Car_CNT="50" MB_CNT="20" Time="..."/>
 *  元素名同屬性名一律唔分大小寫 —— 交通局嘅大小寫寫法唔一致，
 *  前端就係因為分大小寫而試過全部車位讀成 0。 */
function parseCarparks(xml) {
  const out = [];
  const items = String(xml || '').match(/<car_park_info\b[^>]*>/gi) || [];
  for (const tag of items) {
    const attrs = {};
    const re = /([A-Za-z_][\w:-]*)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(tag)) !== null) attrs[m[1].toLowerCase()] = m[2];
    const pick = (...names) => {
      for (const n of names) {
        const v = attrs[n.toLowerCase()];
        if (v !== undefined && v !== '') return v;
      }
      return undefined;
    };
    const id = pick('ID', 'CP_ID', 'CAR_PARK_NO', 'NO');
    if (!id) continue;
    const num = (v) => {
      if (v === undefined) return null;
      const n = parseInt(v, 10);
      return isNaN(n) ? null : n;
    };
    out.push({
      id: String(id),
      light: num(pick('Car_CNT', 'CAR_CNT', 'LIGHT_CAR', 'CAR')),
      moto:  num(pick('MB_CNT', 'MO_CNT', 'MOTORCYCLE', 'MOTO')),
    });
  }
  return out;
}

/** 澳門時間 (UTC+8) 嘅「星期*24+小時」。Workers 行喺 UTC，所以要自己加返 8 個鐘，
 *  否則收集到嘅時段會同用戶睇到嘅鐘數差 8 個鐘。 */
function macauSlot(date) {
  const t = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return t.getUTCDay() * 24 + t.getUTCHours();
}

function foldSamples(store, readings, date) {
  const slot = String(macauSlot(date));
  for (const r of readings) {
    if (r.light === null && r.moto === null) continue;
    const park = store[r.id] || (store[r.id] = {});
    const cell = park[slot] || (park[slot] = [0, 0, 0, 0]);
    if (r.light !== null) { cell[0] += r.light; cell[1] += 1; }
    if (r.moto  !== null) { cell[2] += r.moto;  cell[3] += 1; }
  }
  return store;
}

async function collectOnce(env) {
  if (!env || !env.HISTORY) {
    return { ok: false, reason: '未綁定 KV namespace（HISTORY）' };
  }
  const appcode = (env && env.APPCODE) || DEFAULT_APPCODE;
  const res = await fetch(MAINTENANCE_URL, {
    headers: { 'Authorization': 'APPCODE ' + appcode, 'Accept': 'application/xml' },
  });
  if (!res.ok) return { ok: false, reason: '交通事務局回應 HTTP ' + res.status };

  const readings = parseCarparks(await res.text());
  if (!readings.length) return { ok: false, reason: '解析唔到任何停車場' };

  let doc;
  try { doc = JSON.parse(await env.HISTORY.get(HISTORY_KEY) || 'null'); } catch (e) { doc = null; }
  if (!doc || typeof doc !== 'object' || !doc.slots) {
    doc = { startedAt: new Date().toISOString(), samples: 0, slots: {} };
  }
  doc.slots = foldSamples(doc.slots, readings, new Date());
  doc.samples = (doc.samples || 0) + 1;
  doc.parks = Object.keys(doc.slots).length;
  doc.updatedAt = new Date().toISOString();
  await env.HISTORY.put(HISTORY_KEY, JSON.stringify(doc));
  return { ok: true, parks: readings.length, samples: doc.samples };
}

/* ── 主程式 ────────────────────────────────────────────────────────── */

export default {
  /** Cloudflare 按時表叫呢個，唔需要任何人開住網頁。 */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(collectOnce(env).then((r) => {
      if (!r.ok) console.log('[collect] 失敗：' + r.reason);
      else console.log('[collect] 收集咗 ' + r.parks + ' 個停車場，累計 ' + r.samples + ' 次');
    }));
  },

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

    const params = new URL(request.url).searchParams;

    /* 讀返定時收集到嘅累積數據。開放畀所有准許嘅來源讀，因為呢份數據
       本身就係要大家共享 —— 一個人收集，所有人受惠。 */
    if (params.get('history') === '1') {
      if (!env || !env.HISTORY) {
        return fail(503, '呢個中轉未綁定 KV namespace，所以未有定時收集數據。' +
                         '部署指南第九節有講點開。', cors);
      }
      const raw = await env.HISTORY.get(HISTORY_KEY);
      return new Response(raw || '{"samples":0,"slots":{}}', {
        status: 200,
        headers: Object.assign({
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        }, cors),
      });
    }

    /* 手動觸發一次收集，方便部署完即刻驗證，唔使等半個鐘。 */
    if (params.get('collect') === '1') {
      const r = await collectOnce(env);
      return new Response(JSON.stringify(r), {
        status: r.ok ? 200 : 503,
        headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors),
      });
    }

    const target = params.get('url');
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

/**
 * 錯誤一律回純文字。
 *
 * 之前呢度回嘅係一個 XML 註解 `<!-- ... -->`。問題係：一份淨得註解、
 * 冇根元素嘅文件唔係合法 XML，所以你喺瀏覽器打開條網址想驗證嗰陣，
 * 瀏覽器只會彈「Start tag expected」解析錯誤，反而完全睇唔到訊息本身 ——
 * 而驗證正正係呢個訊息最有用嘅時候。純文字任何瀏覽器都照原文顯示。
 */
function fail(status, message, cors) {
  return new Response('findcarpark-proxy 出錯：' + message + '\n', {
    status,
    headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, cors),
  });
}
