# 專用中轉部署指南（Cloudflare Worker）

## 一、點解要搞呢樣嘢？

「澳門找車位小助手」放喺 GitHub Pages，係**純靜態網站，冇後端**。
瀏覽器基於安全理由（CORS），唔畀一個網頁直接讀另一個網域嘅 API —— 
所以程式一直靠免費公用中轉（corsproxy.io、allorigins 等）幫手轉發。

問題係：**呢啲免費服務唔係你控制**。佢哋轉收費、加限制、或者索性熄咗，
你個程式就即刻讀唔到數據，而你咩都做唔到。今次「未能讀取數據」就係咁嚟。

Cloudflare Worker 係你自己嘅中轉，免費額度**每日 10 萬次請求**
（呢個程式每 30 秒問一次，一日先 2,880 次，用極都唔會爆）。
部署一次，之後唔使再理。

---

## 二、部署步驟（約 10 分鐘，唔使識寫程式）

### 第 1 步：開 Cloudflare 帳戶
1. 去 https://dash.cloudflare.com/sign-up
2. 用電郵註冊，免費計劃已經足夠，**唔使買網域，唔使畀信用卡**
3. 去電郵收信、㩒個連結驗證帳戶

### 第 2 步：建立 Worker
1. 登入後，左邊選單㩒 **Compute (Workers)** → **Workers & Pages**
2. 㩒 **Create application** → **Create Worker**
3. 改個名，例如 `findcarpark-proxy`
   （呢個名會變成你嘅網址：`findcarpark-proxy.你嘅帳號.workers.dev`）
4. 㩒 **Deploy**（會先部署一個「Hello World」範例，正常嘅）

### 第 3 步：貼上程式碼
1. 㩒 **Edit code**（或者 **< > Edit code** 掣）
2. 將編輯器裡面原本嘅程式碼**全部刪走**
3. 打開本資料夾嘅 [`worker.js`](./worker.js)，**全部複製**，貼落去
4. 㩒右上角 **Deploy**

### 第 4 步：抄低網址
部署成功後，Cloudflare 會顯示你個 Worker 網址，格式類似：

```
https://findcarpark-proxy.你嘅帳號.workers.dev
```

**抄低佢。**

### 第 5 步：喺程式入面設定
1. 用手機或電腦打開 https://ronlam1981.github.io/Findcarpark/
2. 㩒右上角 **齒輪圖示**（系統設定）
3. 搵到「**自設中轉網址（進階）**」
4. 貼上你頭先抄低嗰條 `.workers.dev` 網址
5. 㩒「**儲存並重試**」

搞掂。程式之後會**優先行你自己條中轉**，公用中轉只當後備。

---

## 三、驗證佢真係行得通

喺瀏覽器打開（換成你自己條網址）：

```
https://你個名.workers.dev/?url=https%3A%2F%2Fdsat.apigateway.data.gov.mo%2Fcar_park_maintance
```

- **見到一大堆 XML**（好多 `<Car_park_info ...>`）→ 成功 ✅
- **見到 `<!-- findcarpark-proxy error: ... -->`** → 錯誤訊息會直接講明邊度出事
- **見到 `Hello World`** → 第 3 步嘅程式碼未貼成功，返去再做一次

---

## 四、安全設計（點解呢個中轉唔會被人濫用）

| 防護 | 做咗咩 |
|---|---|
| **上游白名單** | 只准轉發去 `dsat.apigateway.data.gov.mo` 同 `api.data.gov.mo`。冇咗呢層，任何人都可以攞你個 Worker 當萬用跳板，去拉佢哋想拉嘅任何網站，責任算落你個帳戶度。 |
| **來源白名單** | 只有 `ronlam1981.github.io` 同本機開發網址叫得郁。第三方網站借你個 Worker 慳自己額度，行唔通。 |
| **只准 GET** | POST、PUT、DELETE 一律拒絕。 |
| **只准 HTTPS** | 唔會用明文連線轉發。 |
| **APPCODE 收埋** | 認證碼擺喺 Worker 入面，唔使再喺前端網頁曝露。 |

### 如果你日後換咗網址
改 `worker.js` 最頂 `ALLOWED_ORIGINS` 嗰個清單，加多一行，再 Deploy 一次。

### 建議：將 APPCODE 改成 Secret（可選，但更穩陣）
咁樣認證碼就唔會留喺程式碼入面：
1. Worker 頁面 → **Settings** → **Variables and Secrets**
2. 㩒 **Add** → 揀 **Secret**
3. Name 填 `APPCODE`，Value 填 `09d43a591fba407fb862412970667de4`
4. 㩒 **Deploy**

程式會自動優先用呢個 Secret。

---

## 五、萬一出事點查？

程式嘅「未能讀取數據」下面有條「**連線診斷詳情**」連結。
㩒開會列出**每一條途徑分別係點失敗**，例如：

```
1. 自設中轉 (即時) → HTTP_403
2. DSAT 直連 → Failed to fetch
3. corsproxy.io + Authorization → no_carpark_data · HTML頁/1204B: <!DOCTYPE html>...
```

旁邊有「**複製**」掣，一㩒就連同時間、瀏覽器版本一齊抄低，
直接貼返出嚟就可以對症下藥，唔使估。
