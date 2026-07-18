# 文件事實查核與過時資訊盤點

> 2026-07-19 runtime 補充：後續實機測試已取代下方的 browser support
> 結論。在 ChatGPT desktop 與 Browser plugin build `26.715.31925` 中，in-app
> Browser 沒有產生第一個 screencast frame，單獨執行
> `Page.captureScreenshot` 也逾時；Chrome 則能直接產生並確認 screencast
> frame。舊版完整錄影仍失敗，是因為它丟棄該 frame 後又多做一次 screenshot
> request。目前 source 已改為直接使用串流 JPEG、只支援 Chrome、在 consent
> 前拒絕 IAB，且提交前必須通過無輸出 contract gate 與連續兩次完整 Chrome
> MP4 smoke。下方內容描述較早的 `v0.3.0` 查核基準，不得視為目前的支援矩陣。

查核日期：2026-07-18（Asia/Taipei）

## 查核範圍與基準

本次以 GitHub release `v0.3.0` 對應的 commit
[`32bfdf995465122075ff18b712dc3e91605b9051`](https://github.com/flsteven87/codex-browser-recorder/commit/32bfdf995465122075ff18b712dc3e91605b9051)
為已發布基準，再逐項比對目前工作樹中的 `README.md`、政策文件、貢獻與支援文件、plugin manifest、skill contract、release scripts、錄影實作與測試。

外部事實優先採用 OpenAI 官方 Codex 文件、Chrome DevTools Protocol、GitHub 官方 API／文件、Node.js 官方 release schedule 與 Homebrew formula。以下狀態描述的是本輪文件優化時的工作樹；未提交內容後續若再調整，仍應以實作與官方來源重新核對。

## 結論先行

原文件的大部分核心安全與媒體承諾都能被實作支持：單一 fresh tab、明確同意、同源 top-level 限制、5–60 秒明示時長、未明示時 15 秒上限、720p／10 fps、H.264 `yuv420p` MP4、無音訊、`0700` 工作目錄、`0600` 成品、碰撞不覆寫、失敗不發布，以及不把 raw frames／CDP／FFmpeg 診斷放入公開結果。

真正需要優先處理的不是大量改寫，而是把「產品名稱、安裝入口、release 可重現性、錄影生命週期、跨來源邊界」說精準。本輪已找出並促成修正的過時資訊包括舊的直接 listing URL、把 Git tag 稱為 immutable、把 Browser 與 Chrome 安裝路徑混為一談，以及錯置 finalization 順序。最終工作樹核對時的狀態如下；「待補強」代表相容性或維護風險，不代表目前核心安全承諾已被實作違反。

| 優先級 | 狀態 | 發現 | 證據 | 建議 |
| --- | --- | --- | --- | --- |
| P0 | 本輪已修正 | `docs/architecture.md` 一度把 acquire CDP／doctor 放在 navigate 前；實作是建立 tab → navigate → acquire CDP → doctor → start capture。最終編號 lifecycle 與 Mermaid 已同步。 | [`create-recording.mjs` L738–L791](https://github.com/flsteven87/codex-browser-recorder/blob/32bfdf995465122075ff18b712dc3e91605b9051/plugins/codex-browser-recorder/skills/record-browser/scripts/create-recording.mjs#L738-L791)、[`docs/architecture.md`](../architecture.md#lifecycle-and-invariants) | 後續維持 architecture source-of-truth map，任何 coordinator 時序變更都一起改文件與測試。 |
| P0 | 本輪已修正 | `SUPPORT.md` 原寫「cross-origin recording」不支援，會與 README／實作支援的 cross-origin／OOPIF embedded frames 衝突；真正不支援的是 cross-origin **top-level navigation**。 | [`README.md` 的 supported scope](../../README.md#requirements-and-supported-scope)、[`cursor-recording.mjs`](https://github.com/flsteven87/codex-browser-recorder/blob/32bfdf995465122075ff18b712dc3e91605b9051/plugins/codex-browser-recorder/skills/record-browser/scripts/cursor-recording.mjs)、[`SUPPORT.md`](../../SUPPORT.md#unsupported-flows) | 維持「cross-origin top-level navigation」用語，勿再縮寫為範圍過大的 cross-origin recording。 |
| P1 | 本輪已修正 | README 一度用「installed Browser plugin」泛稱 browser selection；官方產品把 **Browser** 與 **Chrome** 視為不同 plugin，Chrome 另需 extension setup。2026-07-19 的 runtime 證據進一步確認本 release 只支援 Chrome，因此目前 recording requirements 與 remediation 都直接指向 Chrome，IAB 則明確 fail closed。 | [Browser 官方文件](https://learn.chatgpt.com/docs/browser)、[Chrome extension 官方文件](https://learn.chatgpt.com/docs/chrome-extension)、[Plugins 官方文件](https://learn.chatgpt.com/docs/plugins) | 只有指官方 **Browser** plugin 時才把 Browser 當產品名；本 recorder 的 supported surface 必須精確寫成 Chrome。 |
| P1 | 本輪已揭露 | README 承諾 cross-origin／OOPIF fixture coverage，但底層 `Page.startScreencast` 在 CDP 規格仍標示 Experimental；目前的 real-browser smoke 只驗證 Chrome top-level W3C pointer flow，尚無公開的真實 Chrome OOPIF smoke 證據。README 已明說 version-sensitive、由 deterministic CDP fixtures 覆蓋，release checklist 也只要求已支援的 Chrome surface。 | [CDP `Page.startScreencast`](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast)、[`v0.3.0` release](https://github.com/flsteven87/codex-browser-recorder/releases/tag/v0.3.0)、[OOPIF 單元測試](https://github.com/flsteven87/codex-browser-recorder/blob/32bfdf995465122075ff18b712dc3e91605b9051/tests/cursor-recording.test.mjs#L523) | 只有 release notes 記錄真實 public Chrome iframe smoke 與版本時，才提升相容性保證。 |
| P1 | 本輪已修正 | troubleshooting 一度只列 Typical codes，漏掉 7 個 public code，且未揭露 `frame_too_large`／`invalid_frame` 在目前 coordinator 會正規化成 `capture_failed`。最終 guide 已可搜尋全部 54 個 allowlisted code，並說明正規化邊界。 | [`recording-outcome.mjs` L55–L203](https://github.com/flsteven87/codex-browser-recorder/blob/32bfdf995465122075ff18b712dc3e91605b9051/plugins/codex-browser-recorder/skills/record-browser/scripts/recording-outcome.mjs#L55-L203)、[`docs/troubleshooting.md`](../troubleshooting.md#recording-stopped-safely) | 新測試直接比對實作匯出的完整 allowlist 與文件 code index，新增、移除或拼錯 code 都會失敗。 |
| P2 | 本輪已修正 | 「local processing／不新增 upload」可能被讀成頁面沒有網路流量；實際上目標頁與 embedded frames 仍會照正常頁面行為發出網路請求。最終 README 與 Privacy 已明確區分兩者。 | [`PRIVACY.md` local processing](../../PRIVACY.md#local-processing) 與瀏覽器一般載入語義 | 維持「recorder 不新增上傳／telemetry」與「被錄製頁面仍有自己的網路活動」兩層揭露。 |
| P2 | 本輪已修正 | 新增的 architecture／troubleshooting 一開始沒被 release-readiness 納入，後續又發現公開文件清單散落四處。最終已加入 required public files、相對連結／anchor 與完整 failure-code 測試，並由單一 `release-materials.mjs` 匯出 public text／Markdown 路徑。 | [`release-materials.mjs`](../../scripts/release-materials.mjs)、[`validate-release-readiness.mjs`](../../scripts/validate-release-readiness.mjs)、[`documentation-links.test.mjs`](../../tests/documentation-links.test.mjs) | 新增或移除公開文件只需更新 canonical 清單；validator、structure、fixture 與 link scan 由同一來源派生。 |

## 已確認並在本輪處理的過時資訊

### 1. 安裝入口與舊 listing URL

舊 README 的 `chatgpt.com/plugins/...` 直連在未登入查核時導向泛用 Apps 頁，無法再作為可公開驗證的安裝入口。OpenAI 現行文件以 ChatGPT desktop app 的 **Plugins Directory** 為主要 UI，CLI 則以 `/plugins` 瀏覽；自建來源用 `codex plugin marketplace add <SOURCE>`。因此目前 README 改成 Plugins Directory、官方文件與 local marketplace 指令是正確方向。

但「Codex Browser Recorder 一定出現在所有帳號的 Directory」仍無法用匿名官方頁面證明；listing availability 可能受發佈、workspace 或帳號狀態影響。文件若要完全 fail-safe，可寫成「若你的 workspace 可用，搜尋並安裝」，並把 GitHub local marketplace 保留為可驗證替代路徑。

README 也已把維護流程分成 Plugins Directory 與 local marketplace：前者依官方指引從支援的 plugin browser 選 **Uninstall plugin**，workspace-managed plugin 則交由管理員；後者才使用 CLI remove／add 指令。

來源：[Plugins](https://learn.chatgpt.com/docs/plugins)、[Build plugins](https://learn.chatgpt.com/docs/build-plugins)、[Browser](https://learn.chatgpt.com/docs/browser)。本機 `codex-cli 0.144.4` 也確認 `codex plugin marketplace add`、`codex plugin add`、`codex plugin remove` 的目前語法與 README 相符。

### 2. Git tag 不是 immutable release

原文把 `v0.3.0` 稱為 immutable。這不成立：GitHub Releases API 在查核時回傳 `immutable: false`，tag 是 annotated tag object `9ad1082b…`，解參照後 commit 為 `32bfdf995…`。Git 也允許以 force 重新指向 tag；只有啟用 GitHub immutable releases 且 release 顯示 Immutable 時，tag 與 assets 才被鎖定。

目前 README 改為「version selector, not a cryptographic immutability guarantee」是正確的。嚴格可重現性應固定完整 commit，或從與 clone tag 相同的 versioned release page 下載 archive，再與版本化文件中獨立記錄的 digest 比對；同一個 mutable release 上的 `.sha256` asset 不能單獨作為 immutable trust anchor。release URL 與 shell 變數的版本現在也納入 public-version gate。查核時 release asset `codex-browser-recorder-v0.3.0.zip` 的 API digest 為 `sha256:2f603b01dcd40fea0483038f79093ac41fed93de59afb6e98131dc5a6e6442e1`。

來源：[GitHub Releases API](https://api.github.com/repos/flsteven87/codex-browser-recorder/releases/latest)、[GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)、[Git `tag` 文件](https://git-scm.com/docs/git-tag)、[`v0.3.0` release](https://github.com/flsteven87/codex-browser-recorder/releases/tag/v0.3.0)。

### 3. Browser 與 Chrome 是不同安裝路徑

OpenAI 現行 Browser 文件要求在 ChatGPT desktop app 安裝 **Browser** plugin，並於 `Settings > Browser > Developer mode > Enable full CDP access` 啟用完整 CDP；Browser 不在 CLI／IDE surface 提供。Chrome 則使用 **Chrome** plugin 與 Chrome extension。README 仍精確區分這兩項官方產品，但目前 recorder 的 requirements、installation 與 remediation 只把 Chrome 列為 supported surface，IAB 明確不支援。

來源：[Browser](https://learn.chatgpt.com/docs/browser)、[Chrome extension](https://learn.chatgpt.com/docs/chrome-extension)、[Plugins](https://learn.chatgpt.com/docs/plugins)。

### 4. Finalization 與 publication 順序

實作不是「先 publish 再 stop capture」。真正順序是：停止 frame pump／screencast／encoder，完成 cursor composition，驗證媒體，再進行 collision-safe durable publication，最後清理 private artifacts 並關閉 fresh tab。工作樹中的 Mermaid 與編號 lifecycle 已依此順序及正確啟動順序重排。

來源：[`browser-recording.mjs` L546–L663](https://github.com/flsteven87/codex-browser-recorder/blob/32bfdf995465122075ff18b712dc3e91605b9051/plugins/codex-browser-recorder/skills/record-browser/scripts/browser-recording.mjs#L546-L663)、[`create-recording.mjs` L305–L409](https://github.com/flsteven87/codex-browser-recorder/blob/32bfdf995465122075ff18b712dc3e91605b9051/plugins/codex-browser-recorder/skills/record-browser/scripts/create-recording.mjs#L305-L409)、[`recording-artifacts.mjs` L250–L382](https://github.com/flsteven87/codex-browser-recorder/blob/32bfdf995465122075ff18b712dc3e91605b9051/plugins/codex-browser-recorder/skills/record-browser/scripts/recording-artifacts.mjs#L250-L382)。

## 已確認仍為現行資訊

- GitHub latest release 在查核時是 `v0.3.0`，release commit 是 `32bfdf995465122075ff18b712dc3e91605b9051`；該原始 tag／archive 不含 2026-07-19 的 OpenAI resubmission runtime 修復，README 與 SUPPORT 已明確區分兩者。
- Node.js 24 仍在官方 LTS release line；repo 的 `>=24` development requirement 不過時。Node 只屬 repo 開發／驗證需求，並非終端錄影使用者額外安裝的 runtime。[Node.js release schedule](https://nodejs.org/en/about/previous-releases)
- Homebrew 的現行公式仍是 `brew install ffmpeg`，且包含 x264 dependency；實作另外以 preflight 檢查 `ffmpeg`、`ffprobe`、`libx264`、MP4 muxer 與 ffprobe JSON，不依賴安裝來源的假設。[Homebrew FFmpeg formula](https://formulae.brew.sh/formula/ffmpeg)、[`doctor.mjs` L52–L73](https://github.com/flsteven87/codex-browser-recorder/blob/32bfdf995465122075ff18b712dc3e91605b9051/plugins/codex-browser-recorder/skills/record-browser/scripts/doctor.mjs#L52-L73)
- URL／duration policy 與文件一致：HTTPS、無 URL credentials；HTTP 只允許 `localhost`、`127.0.0.1`、`[::1]`；明示時長 5–60 秒，未明示時 15 秒。[`recording-policy.mjs` L1–L66](https://github.com/flsteven87/codex-browser-recorder/blob/32bfdf995465122075ff18b712dc3e91605b9051/plugins/codex-browser-recorder/skills/record-browser/scripts/recording-policy.mjs#L1-L66)
- 媒體 profile 與文件一致：最高 1280×720、10 fps、H.264 `yuv420p` MP4、單一 video stream、無 audio；release notes 記錄同一 profile 與 252 tests。[`v0.3.0` release](https://github.com/flsteven87/codex-browser-recorder/releases/tag/v0.3.0)
- artifact 承諾與實作一致：預設 Downloads 路徑、隱私安全檔名、private working mode `0700`、saved mode `0600`、exclusive collision handling、驗證後才發布、cleanup failure 有受限 recovery metadata。[`recording-artifacts.mjs` L125–L214](https://github.com/flsteven87/codex-browser-recorder/blob/32bfdf995465122075ff18b712dc3e91605b9051/plugins/codex-browser-recorder/skills/record-browser/scripts/recording-artifacts.mjs#L125-L214)、[`recording-artifacts.mjs` L250–L382](https://github.com/flsteven87/codex-browser-recorder/blob/32bfdf995465122075ff18b712dc3e91605b9051/plugins/codex-browser-recorder/skills/record-browser/scripts/recording-artifacts.mjs#L250-L382)
- 「recorder 不自動 upload／share／telemetry」、「raw frames 不進 skill 的 model context／public result」可由 skill contract 與 bounded outcome schema 支持；README 與 Privacy 也已補上目標頁本身仍有正常網路請求的隱私 caveat。[`recording-outcome.mjs` L1–L32](https://github.com/flsteven87/codex-browser-recorder/blob/32bfdf995465122075ff18b712dc3e91605b9051/plugins/codex-browser-recorder/skills/record-browser/scripts/recording-outcome.mjs#L1-L32)、[`SKILL.md`](https://github.com/flsteven87/codex-browser-recorder/blob/32bfdf995465122075ff18b712dc3e91605b9051/plugins/codex-browser-recorder/skills/record-browser/SKILL.md)
- Codex Record & Replay 是把示範轉成 reusable skill 的另一項功能，不是本 plugin 的影片錄製；README 現在把兩者分開是正確的。[Record & Replay](https://learn.chatgpt.com/docs/extend/record-and-replay)

## 文件防漂移措施

本輪已把 architecture／troubleshooting 納入單一 canonical public-file 清單，新增相對連結與 anchor 測試，並讓 troubleshooting 的 54 個 exact codes 與實作匯出的 public allowlist 雙向相等。README 也已分清 tag 與 cryptographic immutability、把 tag-specific release URL 與 checksum 指令納入版本同步，並把 CDP fixture coverage 與 manual smoke coverage 分開陳述。

後續 release 仍須保留兩項人工查核：

1. 每次 Codex plugin release 前重新查核官方 Browser、Chrome、Plugins 與 Build plugins 文件；這已寫入 release checklist，但仍不能由離線 validator 取代。
2. 若要把 cross-origin／OOPIF 從 version-sensitive fixture coverage 提升成實機相容性保證，加入真實 Chrome embedded-frame smoke、版本與被測 commit。

## 驗證紀錄

- OpenAI、CDP、GitHub、Homebrew 與 Node.js 上述來源於 2026-07-18 均可正常回應。
- 本機確認 `codex-cli 0.144.4` 的 plugin marketplace／add／remove help 與目前命令範例相符。
- GitHub Releases API 回傳 `v0.3.0`、`immutable: false` 與 release asset digest；`git ls-remote --tags` 確認 annotated tag 與解參照 commit。
- 2026-07-18 文件查核工作樹的 `npm run check` 共 254 項測試通過。
- 2026-07-19 resubmission candidate 的 `npm run check` 共 276 項測試通過，並通過 `npm run check:release-candidate`、`npm run check:release`、無輸出 Chrome frame contract、連續兩次完整 Chrome MP4 與 pointer/click 視覺 smoke。
- 11 份主要 Markdown 的本機相對連結目標皆存在；2026-07-18 查核時，外部連結逐一 follow redirect 後均回應 HTTP 200。
