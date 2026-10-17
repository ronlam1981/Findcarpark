import { collectOnce, getRealtimeFeed, parseCarparks } from './worker.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class MemoryKV {
  constructor() { this.data = new Map(); }
  async get(key) { return this.data.get(key) || null; }
  async put(key, value) { this.data.set(key, value); }
}

const officialXml = '<?xml version="1.0"?><CarPark>' +
  '<Car_park_info ID="6045" Car_CNT="7" MB_CNT="0" Time="2026-10-16 12:00:00"/>' +
  '<Car_park_info ID="1" Car_CNT="21" MB_CNT="8" Time="2026-10-16 12:00:00"/>' +
  '</CarPark>';

const publicHtml = '<table><tr><td><a href="carpark_detail.aspx?id=1">' +
  '<div class="carpark_name_text"><div>測試停車場</div><div style="font-size:12px">2026-10-16 12:01</div></div>' +
  '<span><img src="carpark_car.png"></span> 18</div>' +
  '<span><img src="carpark_motor.png"></span> 6</div></td></tr></table>';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return body; } };
}

const originalFetch = globalThis.fetch;
const env = { HISTORY: new MemoryKV() };
try {
  globalThis.fetch = async () => response(officialXml);
  const official = await getRealtimeFeed(env);
  assert(official.source === 'data.gov.mo official API', 'official API was not preferred');
  assert(parseCarparks(official.xml).length === 2, 'official XML parser count mismatch');

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? response('down', 503) : response(publicHtml);
  };
  const publicFallback = await getRealtimeFeed(env);
  assert(publicFallback.source === 'DSAT public realtime page fallback', 'public fallback not used');
  assert(parseCarparks(publicFallback.xml)[0].light === 18, 'public fallback count mismatch');

  globalThis.fetch = async () => response('down', 503);
  const snapshot = await getRealtimeFeed(env);
  assert(snapshot.source === 'KV last-good snapshot', 'KV snapshot not used');
  assert(parseCarparks(snapshot.xml)[0].light === 18, 'KV snapshot mismatch');

  globalThis.fetch = async () => response(officialXml);
  const collected = await collectOnce(env);
  assert(collected.ok && collected.parks === 2, 'scheduled collection failed');
  const history = JSON.parse(await env.HISTORY.get('busy_history_v1'));
  assert(history.samples === 1 && history.slots['6045'], 'history was not preserved/folded');
} finally {
  globalThis.fetch = originalFetch;
}

print('worker tests passed');
