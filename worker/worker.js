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

/** 同一條 URL 喺 Cloudflare 邊緣快取幾耐（秒）。
 *  即時車位數據大約每分鐘更新一次，前端每 30 秒問一次，
 *  快取 15 秒可以減少對交通局伺服器嘅壓力，又唔會覺得數據舊咗。 */
const CACHE_TTL_SECONDS = 15;

/** data.gov.mo 在「停車場車位資訊」完全開放資料集公開提供的共用調用碼。
 *  它不是個人／帳戶憑證；只放在 Worker，前端毋須傳送。 */
const OFFICIAL_APPCODE = '09d43a591fba407fb862412970667de4';
const MAINTENANCE_URL = 'https://dsat.apigateway.data.gov.mo/car_park_maintance';

const PUBLIC_REALTIME_URL = 'https://www.dsat.gov.mo/dsat/carpark_realtime_core.aspx';
const PUBLIC_CARPARK_GIS_URL =
  'https://webmap.gis.gov.mo/arcgis/rest/services/WebMap/MacauMap_T_POI/MapServer/8/query' +
  '?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=json';

/** KV 入面存累積數據嗰條 key。 */
const HISTORY_KEY = 'busy_history_v1';
const LAST_REALTIME_KEY = 'last_realtime_xml_v1';
const LAST_DETAIL_KEY = 'last_detail_xml_v1';

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

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripTags(value) {
  return decodeHtml(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

function xmlAttr(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function publicCount(row, icon) {
  const re = new RegExp('src="[^"]*' + icon + '[^"]*"[^>]*>[\\s\\S]*?<\\/span>\\s*([^<]+)<\\/div>', 'i');
  const m = row.match(re);
  if (!m) return null;
  const text = stripTags(m[1]);
  if (!text || text === '-') return null;
  const n = parseInt(text, 10);
  return isNaN(n) ? null : n;
}

/** Parse DSAT's public, server-rendered realtime page. This is the same
 * information a visitor can read at carpark_realtime.aspx and needs no key. */
function parsePublicRealtimeHtml(html) {
  const out = [];
  const rows = String(html || '').match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const idm = row.match(/carpark_detail\.aspx\?id=(\d+)/i);
    if (!idm) continue;
    const nameBlock = row.match(/class="carpark_name_text"[^>]*>\s*<div>([\s\S]*?)<\/div>/i);
    if (!nameBlock) continue;
    const timeMatch = row.match(/font-size\s*:\s*12px[^>]*>([\s\S]*?)<\/div>/i);
    out.push({
      id: idm[1],
      name: stripTags(nameBlock[1]),
      light: publicCount(row, 'carpark_car\\.png'),
      moto: publicCount(row, 'carpark_motor\\.png'),
      ev: publicCount(row, 'carpark_ecar\\.png'),
      time: timeMatch ? stripTags(timeMatch[1]) : '',
    });
  }
  return out;
}

function maintenanceXmlFromPublicHtml(html) {
  const rows = parsePublicRealtimeHtml(html);
  const body = rows.map((r) => '<Car_park_info' +
    ' ID="' + xmlAttr(r.id) + '"' +
    ' NameC="' + xmlAttr(r.name) + '"' +
    (r.light === null ? '' : ' Car_CNT="' + r.light + '"') +
    (r.moto === null ? '' : ' MB_CNT="' + r.moto + '"') +
    (r.ev === null ? '' : ' EV_CNT="' + r.ev + '"') +
    ' Time="' + xmlAttr(r.time) + '"/>').join('');
  return { rows, xml: '<?xml version="1.0" encoding="UTF-8"?><CarPark>' + body + '</CarPark>' };
}

function normalName(value) {
  return String(value || '').toLowerCase()
    .replace(/[()（）·．。,.，\-—_\s]/g, '')
    .replace(/澳門/g, '').replace(/公共停車場/g, '').replace(/停車場/g, '')
    .replace(/大廈/g, '').replace(/廣場/g, '');
}

function findGisFeature(name, features) {
  const wanted = normalName(name);
  let best = null;
  for (const f of features) {
    const got = normalName(f && f.attributes && f.attributes.CNAME);
    if (!got) continue;
    if (got === wanted) return f;
    if ((got.includes(wanted) || wanted.includes(got)) && (!best || got.length > normalName(best.attributes.CNAME).length)) {
      best = f;
    }
  }
  return best;
}

function publicDetailXml(realtimeRows, gisJson) {
  const features = gisJson && Array.isArray(gisJson.features) ? gisJson.features : [];
  const matched = new Set();
  const body = realtimeRows.map((r) => {
    const f = findGisFeature(r.name, features);
    const a = f && f.attributes ? f.attributes : {};
    const g = f && f.geometry ? f.geometry : {};
    if (f) matched.add(f);
    return '<Car_park_info' +
      ' CP_ID="' + xmlAttr(r.id) + '"' +
      ' NameC="' + xmlAttr(r.name) + '"' +
      ' LocationC="' + xmlAttr(a.CADDR || '') + '"' +
      ' ContactNo="' + xmlAttr(a.TEL || '') + '"' +
      ' CarParkEntryC="' + xmlAttr(a.C_ENTRANCE_EXIT || '') + '"' +
      (Number.isFinite(g.x) ? ' X_coords="' + g.x + '"' : '') +
      (Number.isFinite(g.y) ? ' Y_coords="' + g.y + '"' : '') +
      (a.AMOUNT_LIGHTVEHICLE !== null && a.AMOUNT_LIGHTVEHICLE !== undefined
        ? ' TOTAL_CAR="' + xmlAttr(a.AMOUNT_LIGHTVEHICLE) + '"' : '') +
      (a.AMOUNT_MOTOCYCLE !== null && a.AMOUNT_MOTOCYCLE !== undefined
        ? ' TOTAL_MOTO="' + xmlAttr(a.AMOUNT_MOTOCYCLE) + '"' : '') +
      (a.AMOUNT_HEAVYVEHICLE !== null && a.AMOUNT_HEAVYVEHICLE !== undefined
        ? ' TOTAL_HEAVY="' + xmlAttr(a.AMOUNT_HEAVYVEHICLE) + '"' : '') + '/>';
  }).join('');
  return {
    matched: matched.size,
    total: realtimeRows.length,
    xml: '<?xml version="1.0" encoding="UTF-8"?><CarPark>' + body + '</CarPark>',
  };
}

async function fetchPublicMaintenance() {
  const res = await fetch(PUBLIC_REALTIME_URL, {
    headers: { 'Accept': 'text/html' },
    cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
  });
  if (!res.ok) throw new Error('交通事務局公開實時頁回應 HTTP ' + res.status);
  const parsed = maintenanceXmlFromPublicHtml(await res.text());
  if (!parsed.rows.length) throw new Error('交通事務局公開實時頁解析到 0 個停車場');
  return parsed;
}

async function fetchPublicDetails() {
  const realtime = await fetchPublicMaintenance();
  const gisRes = await fetch(PUBLIC_CARPARK_GIS_URL, {
    headers: { 'Accept': 'application/json' },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!gisRes.ok) throw new Error('澳門官方地圖回應 HTTP ' + gisRes.status);
  const result = publicDetailXml(realtime.rows, await gisRes.json());
  if (!result.total) throw new Error('公開停車場詳情解析到 0 個停車場');
  return result;
}

async function saveLastGood(env, key, xml) {
  if (!env || !env.HISTORY) return;
  await env.HISTORY.put(key, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    xml,
  }));
}

async function readLastGood(env, key, validator) {
  if (!env || !env.HISTORY) return null;
  try {
    const saved = JSON.parse(await env.HISTORY.get(key) || 'null');
    if (!saved || !saved.xml || !validator(saved.xml)) return null;
    return { xml: saved.xml, fetchedAt: saved.fetchedAt || '', source: 'KV last-good snapshot' };
  } catch (e) {
    return null;
  }
}

async function fetchOfficialXml(url) {
  const res = await fetch(url, {
    headers: {
      'Authorization': 'APPCODE ' + OFFICIAL_APPCODE,
      'Accept': 'application/xml, text/xml, */*',
    },
    cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
  });
  if (!res.ok) throw new Error('data.gov.mo 官方 API 回應 HTTP ' + res.status);
  return await res.text();
}

function validRealtimeXml(xml) {
  return parseCarparks(xml).length > 0;
}

function validDetailXml(xml) {
  return (String(xml || '').match(/<car_park_info\b/gi) || []).length > 0;
}

/** 正式結構化 API 是主來源；公開網頁和 KV 快照只在上游失效時接力。 */
async function getRealtimeFeed(env) {
  try {
    const xml = await fetchOfficialXml(MAINTENANCE_URL);
    if (!validRealtimeXml(xml)) throw new Error('data.gov.mo 官方 API 回傳 0 個停車場');
    await saveLastGood(env, LAST_REALTIME_KEY, xml);
    return { xml, fetchedAt: new Date().toISOString(), source: 'data.gov.mo official API' };
  } catch (officialError) {
    try {
      const publicFeed = await fetchPublicMaintenance();
      await saveLastGood(env, LAST_REALTIME_KEY, publicFeed.xml);
      return {
        xml: publicFeed.xml,
        fetchedAt: new Date().toISOString(),
        source: 'DSAT public realtime page fallback',
      };
    } catch (publicError) {
      const saved = await readLastGood(env, LAST_REALTIME_KEY, validRealtimeXml);
      if (saved) return saved;
      throw new Error((officialError && officialError.message) + '；後備亦失敗：' +
        (publicError && publicError.message));
    }
  }
}

async function getDetailFeed(env, url) {
  try {
    const xml = await fetchOfficialXml(url);
    if (!validDetailXml(xml)) throw new Error('data.gov.mo 官方詳情 API 回傳 0 個停車場');
    await saveLastGood(env, LAST_DETAIL_KEY, xml);
    return { xml, fetchedAt: new Date().toISOString(), source: 'data.gov.mo official API' };
  } catch (officialError) {
    try {
      const details = await fetchPublicDetails();
      await saveLastGood(env, LAST_DETAIL_KEY, details.xml);
      return {
        xml: details.xml,
        fetchedAt: new Date().toISOString(),
        source: 'DSAT public page + Macau official GIS fallback',
        matched: details.matched + '/' + details.total,
      };
    } catch (publicError) {
      const saved = await readLastGood(env, LAST_DETAIL_KEY, validDetailXml);
      if (saved) return saved;
      throw new Error((officialError && officialError.message) + '；後備亦失敗：' +
        (publicError && publicError.message));
    }
  }
}

/** 澳門時間 (UTC+8) 嘅「星期*24+小時」。Workers 行喺 UTC，所以要自己加返 8 個鐘，
 *  否則收集到嘅時段會同用戶睇到嘅鐘數差 8 個鐘。 */
function macauSlot(date) {
  const t = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return t.getUTCDay() * 24 + t.getUTCHours();
}

function macauDateHour(date) {
  const t = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return { date: t.toISOString().slice(0, 10), hour: t.getUTCHours() };
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

function foldToday(today, readings, date) {
  const p = macauDateHour(date);
  const out = today && today.date === p.date ? today : { date: p.date, parks: {} };
  for (const r of readings) {
    if (r.light === null && r.moto === null) continue;
    const park = out.parks[r.id] || (out.parks[r.id] = {});
    const cell = park[p.hour] || (park[p.hour] = [0, 0, 0, 0]);
    if (r.light !== null) { cell[0] += r.light; cell[1] += 1; }
    if (r.moto !== null) { cell[2] += r.moto; cell[3] += 1; }
  }
  return out;
}

async function collectOnce(env) {
  if (!env || !env.HISTORY) {
    return { ok: false, reason: '未綁定 KV namespace（HISTORY）' };
  }
  let feed;
  try { feed = await getRealtimeFeed(env); }
  catch (e) { return { ok: false, reason: (e && e.message) || '讀唔到官方即時資料' }; }
  const readings = parseCarparks(feed.xml);
  if (!readings.length) return { ok: false, reason: '解析唔到任何停車場' };

  let doc;
  try { doc = JSON.parse(await env.HISTORY.get(HISTORY_KEY) || 'null'); } catch (e) { doc = null; }
  if (!doc || typeof doc !== 'object' || !doc.slots) {
    doc = { startedAt: new Date().toISOString(), samples: 0, slots: {} };
  }
  doc.slots = foldSamples(doc.slots, readings, new Date());
  doc.today = foldToday(doc.today, readings, new Date());
  doc.samples = (doc.samples || 0) + 1;
  doc.parks = Object.keys(doc.slots).length;
  doc.updatedAt = new Date().toISOString();
  await env.HISTORY.put(HISTORY_KEY, JSON.stringify(doc));
  return { ok: true, parks: readings.length, samples: doc.samples, source: feed.source };
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

    /* data.gov.mo 完全開放資料集的 XML API 是主來源；公開頁及 KV 快照
       只在官方 API 暫時失效時接力。 */
    if (upstream.pathname.endsWith('/car_park_maintance')) {
      try {
        const feed = await getRealtimeFeed(env);
        return new Response(feed.xml, {
          status: 200,
          headers: Object.assign({
            'Content-Type': 'application/xml; charset=utf-8',
            'Cache-Control': 'public, max-age=' + CACHE_TTL_SECONDS,
            'X-Data-Source': feed.source,
            'X-Data-Fetched-At': feed.fetchedAt,
            'X-Upstream-Update-Frequency': '10 seconds',
          }, cors),
        });
      } catch (e) {
        return fail(502, (e && e.message) || '讀唔到官方即時資料', cors);
      }
    }

    if (upstream.pathname.endsWith('/car_park_detail')) {
      try {
        const details = await getDetailFeed(env, upstream.toString());
        const headers = {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          'X-Data-Source': details.source,
          'X-Data-Fetched-At': details.fetchedAt,
        };
        if (details.matched) headers['X-Matched-Carparks'] = details.matched;
        return new Response(details.xml, {
          status: 200,
          headers: Object.assign(headers, cors),
        });
      } catch (e) {
        return fail(502, (e && e.message) || '讀唔到官方停車場詳情', cors);
      }
    }

    return fail(403, '只支援停車場即時資料及停車場詳情兩個官方公開來源', cors);
  },
};

/* ── 小工具 ────────────────────────────────────────────────────────── */

function corsHeaders(origin) {
  // 唔喺名單上嘅來源，回一個永遠對唔上嘅值，瀏覽器自然會擋住。
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-cors-headers',
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

// Named exports keep the HTML adapters directly testable without changing
// the Worker's default fetch/scheduled entry points.
export {
  collectOnce,
  getRealtimeFeed,
  maintenanceXmlFromPublicHtml,
  parseCarparks,
  parsePublicRealtimeHtml,
  publicDetailXml,
};
