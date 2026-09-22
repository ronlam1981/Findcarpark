# 專用中轉部署指南（Cloudflare Worker）

## 一、一句話：點解要搞

個網站放喺 GitHub Pages，**冇後端**。瀏覽器唔准網頁直接讀交通事務局嘅 API，
所以一直借網上免費「中轉」服務幫手轉發 —— 而呢啲免費服務會執笠、會轉收費。
之前個「未能讀取數據」就係咁嚟。

部署一個屬於你自己嘅中轉，就唔使再靠人哋。免費額度**每日 10 萬次請求**，
而你自己一日開足 24 小時都只係約 2,880 次（唔夠 3%）。

---

## 二、開 Cloudflare 帳戶（一次過，約 3 分鐘）

1. 去 https://dash.cloudflare.com/sign-up
2. 用電郵註冊。**免費計劃已經足夠，唔使買網域，唔使畀信用卡。**
3. 去電郵收信，㩒個連結驗證帳戶

---

## 三、部署（揀一條路，唔使兩條都做）

### 路線 A：喺網頁度複製貼上（唔使裝嘢，推薦）

1. 登入後，左邊選單 → **Compute (Workers)** → **Workers & Pages**
2. **Create application** → **Create Worker**
3. 改名做 `findcarpark-proxy` → **Deploy**
   （會先部署一個 Hello World 範例，正常嘅）
4. 㩒 **Edit code**
5. 將編輯器裡面原本嘅程式碼**全部刪走**
6. 打開本資料夾嘅 [`worker.js`](./worker.js)，**全選複製**，貼落去
7. 㩒右上角 **Deploy**

### 路線 B：一條指令（識用終端機就快啲）

喺電腦 clone 咗呢個 repo 之後，入去 `worker/` 資料夾：

```bash
npx wrangler login     # 第一次要做，會開瀏覽器叫你授權
npx wrangler deploy
```

設定已經寫好喺 [`wrangler.toml`](./wrangler.toml)，唔使再改。

---

## 四、抄低網址，填入程式

部署成功後會顯示你個網址，形如：

```
https://findcarpark-proxy.你嘅帳號.workers.dev
```

**抄低佢**，然後：

1. 打開 https://ronlam1981.github.io/Findcarpark/
2. 㩒右上角**齒輪圖示**（系統設定）
3. 搵到「**自設中轉網址（進階）**」，貼上條網址
4. **先㩒「測試」** ← 呢步好緊要
5. 見到綠色「成功！經你個中轉讀到 N 個停車場嘅即時車位」→ 再㩒「**儲存**」

搞掂。之後程式會**優先行你自己條中轉**，公共中轉只當後備。

---

## 五、「測試」講咩就係咩

㩒「測試」會真係經你個中轉去攞一次數據，然後老實報告：

| 顯示 | 即係 | 點做 |
|---|---|---|
| ✅ 讀到 N 個停車場 | 完全成功 | 㩒儲存 |
| ❌ 網址要以 https:// 開頭 | 貼漏咗開頭 | 補返 |
| ❌ 逾時：中轉冇回應 | 網址打錯，或者 Worker 未部署好 | 覆核條網址 |
| ❌ 連唔到…未准許 …github.io 呢個來源 | Worker 嘅來源白名單冇你個網址 | 見第六節 |
| ❌ 中轉回應 HTTP 403 | 上游白名單擋咗，或者 APPCODE 唔啱 | 睇訊息內容 |
| ❌ 回嘅唔係停車場數據 | 貼錯咗第二個服務嘅網址 | 覆核條網址 |

**唔會出現「好似成功咗但其實冇用」嘅情況** —— 呢個先係重點。

---

## 六、安全設計（點解唔會畀人濫用）

| 防護 | 做咗咩 |
|---|---|
| **上游白名單** | 只准轉發去 `dsat.apigateway.data.gov.mo` 同 `api.data.gov.mo`。冇咗呢層，任何人都可以攞你個 Worker 當萬用跳板去拉佢想拉嘅網站，責任算落你個帳戶 |
| **來源白名單** | 只有 `ronlam1981.github.io` 同本機開發網址叫得郁 |
| **只准 GET / HTTPS** | 其他方法同明文連線一律拒絕 |
| **APPCODE 收埋** | 可以擺喺 Worker 嘅 Secret，唔使再喺前端網頁曝露 |

### 換咗網址點算
改 `worker.js` 最頂 `ALLOWED_ORIGINS` 清單，加一行，再 Deploy 一次。

### 將 APPCODE 改成 Secret（可選，更穩陣）
- 路線 A：Worker 頁面 → **Settings** → **Variables and Secrets** → **Add** → 揀 **Secret**，
  Name 填 `APPCODE`，Value 填認證碼 → **Deploy**
- 路線 B：`npx wrangler secret put APPCODE`

程式會自動優先用呢個 Secret。

---

## 七、自己驗證（唔想靠個 App）

喺瀏覽器打開（換成你自己條網址）：

```
https://你個名.workers.dev/?url=https%3A%2F%2Fdsat.apigateway.data.gov.mo%2Fcar_park_maintance
```

- 見到一大堆 `<Car_park_info ...>` → 成功 ✅
- 見到 `<!-- findcarpark-proxy error: ... -->` → 訊息會直接講明邊度出事
- 見到 `Hello World` → 第三節嘅程式碼未貼成功，返去再做一次

---

## 八、開啟 24 小時定時收集（強烈推薦）

呢步做完，繁忙時間數據就**唔再靠你開住程式** —— Cloudflare 會每半個鐘
自己收集一次，一日 24 小時，而且**所有用你個中轉嘅人共享同一份數據**。

免費額度計過：每日 48 次寫入，上限 1,000 次，**用咗 4.8%**。

### 第 1 步：開一個 KV 儲存空間

**網頁版：**
1. Cloudflare 左邊選單 → **Storage & Databases** → **KV**
2. 㩒 **Create Instance**（或 **Create a namespace**）
3. Namespace name 填：`findcarpark-history`
4. 㩒 **Add**

**指令版：**
```bash
npx wrangler kv namespace create HISTORY
```
會印出一個 `id`，抄低佢填落 `wrangler.toml`。

### 第 2 步：綁定落你個 Worker

**網頁版：**
1. 返去你個 Worker → **Settings** → **Bindings**
2. **Add** → 揀 **KV namespace**
3. 填：
   - **Variable name：** `HISTORY`  ← 一定要係大楷 HISTORY
   - **KV namespace：** 揀返頭先開嗰個 `findcarpark-history`
4. **Deploy**

> ⚠️ Variable name 打錯（例如 `history` 細楷）就唔會生效。

### 第 3 步：開定時觸發

**網頁版：**
1. Worker → **Settings** → **Triggers**（或 **Cron Triggers**）
2. **Add Cron Trigger**
3. 填：
   ```
   */30 * * * *
   ```
   （即係每 30 分鐘一次）
4. **Add** / **Deploy**

**指令版：** `wrangler.toml` 已經寫好，`npx wrangler deploy` 就得。

### 第 4 步：即刻試一次，唔使等半個鐘

喺瀏覽器打開（換成你條網址）：

```
https://你個名.workers.dev/?collect=1
```

| 見到 | 即係 |
|---|---|
| `{"ok":true,"parks":91,"samples":1}` | ✅ 成功，已經收集咗一次 |
| `{"ok":false,"reason":"未綁定 KV namespace（HISTORY）"}` | 第 2 步未做好，或者變數名打錯 |
| `{"ok":false,"reason":"交通事務局回應 HTTP ..."}` | 上游出事，同 KV 無關 |

再打開呢條睇累積數據：

```
https://你個名.workers.dev/?history=1
```

### 第 5 步：喺程式度確認

打開網站 → 齒輪 → 應該見到綠色：

> ✅ **中轉定時收集運作中**
> 累計 N 次讀數，涵蓋 91 個停車場。

之後任何停車場嘅「繁忙時間」圖表，右上角會標住「**24 小時收集**」而唔係「本機紀錄」。

### 收集到嘅數據係點樣？

- 結構：每個停車場 × 每個「星期幾＋幾點」時段，存住輕型車同電單車嘅**平均車位**
- 就地平均，所以**儲存量唔會隨時間增長**（一年後同一星期後差唔多大）
- 時區用**澳門時間**（Worker 行喺 UTC，程式碼有自己加返 8 個鐘）
- 冇個人資料，純粹係公開停車場嘅車位數字

---

## 九、萬一部署唔到都唔使驚

個程式**仲有 8 條後備途徑**。冇咗你個 Worker，佢會自動跌返落公共中轉，
照樣運作 —— 只係冇咁穩陣。所以部署 Worker 係**淨賺**，冇下行風險。

出事就㩒程式入面「未能讀取數據」下面嘅「**連線診斷詳情**」→「**複製**」，
會連同時間、瀏覽器版本、每條途徑點樣失敗一齊抄低，貼返出嚟就診斷得到。
