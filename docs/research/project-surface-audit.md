# README 以外的公開表面優化稽核

日期：2026-07-24

## 稽核結論

本專案的技術約束完整，但多數公開表面先呈現實作術語，再要求讀者自行推導產品價值與下一步。優化原則有四項：先說清楚產品入口、讓每個頁面提供明確下一步、以分層方式承載技術細節、依使用者意圖導流。
README 以外最優先的工作不是刪除技術資訊，而是把技術資訊移到使用者已經需要它的層級。新使用者應先看到「能完成什麼」，遇到問題的人應先看到「現在該做什麼」，維護者才進入契約、事件來源與發布門檻。

## 優先級總覽

| 優先級 | 公開表面 | 核心問題 | 建議結果 | 影響／成本 |
| --- | --- | --- | --- | --- |
| P0-1 | 外掛安裝與啟動提示 | 入口文案以內部機制為主，提示詞不是完整任務 | 價值優先的描述與可直接執行的 starter prompts | 高／低 |
| P0-2 | 同意與錄製結果文案 | 每次互動暴露大量底層限制，錯誤修復不具體 | 簡明同意內容與逐錯誤碼的明確下一步 | 高／中 |
| P0-3 | 支援入口 | 使用問題被導向不存在的提問管道 | 依意圖提供可用的問題、錯誤與功能入口 | 高／低 |
| P1-4 | Issue forms | 先要求理解架構與限制，才詢問使用者問題 | 先收集症狀與價值，再保留必要安全確認 | 中／低 |
| P1-5 | 支援與疑難排解 | 導覽以版本、CDP 與錯誤碼為中心 | 症狀優先入口，技術碼留作搜尋索引 | 中／中 |
| P1-6 | 貢獻與 PR | 新手路徑缺失，所有變更共用重型門檻 | 新手 quickstart、條件式檢查、維護者指南分流 | 中／中 |
| P1-7 | Privacy | 使用者承諾與實作細節混在同一層 | 摘要表格先回答核心承諾，再展開技術細節 | 中／低 |
| P1-8 | GitHub repo 與 release | 對外描述與發布說明偏內部實作 | 以使用價值、升級理由與更新步驟開場 | 中／低 |
| P2-9 | Research IA | 歷史研究文件的位置與狀態不清 | 集中到 research 區並標示非規範性 | 低／低 |
| P2-10 | 應保留的技術表面 | 部分文件本來就服務技術或法律受眾 | 保留內容，只補受眾導覽連結 | 防誤改／低 |

## P0-1：外掛安裝表面應先表達價值

證據：`plugin.json` 第 4 行與第 22–36 行，以及 `agents/openai.yaml` 第 2–4 行，目前描述重心是技術能力。三個提示詞各約 94–115 字元，直接使用 preflight、same-origin、pointer-driven 等機制詞。
其中兩個提示詞只描述流程片段，並未形成包含目的、輸入與交付結果的完整任務。
這會讓安裝完成後的第一個可點擊入口看起來像測試規格，而不是產品能替使用者完成的工作。

建議把外掛描述改成價值優先，例如：「把你核准的瀏覽器操作錄成可檢視的本機 MP4，並在開始前確認這台 Mac 是否具備錄影條件。」技術限制可放在第二句或詳細說明，而不是第一個辨識訊號。
starter prompts 應改寫為完整任務，清楚包含要錄什麼、何時停止，以及成功時會得到什麼。可採三種意圖：檢查 Mac 的本機錄影條件、錄製一段指定時間的公開頁面、錄製指定的公開頁面操作並存檔。
避免把 preflight、same-origin、pointer-driven 當成使用者必須理解的動詞。
官方外掛規格把 default prompts 定位為 starter prompts，最多 3 個、每個上限 128 字元，並建議盡量接近 50 字元。

測試證據：`tests/plugin-structure.test.mjs` 第 98–105 行硬編碼舊文案。
測試應驗證語意契約，而不是逐字鎖死行銷文案。
建議驗證提示數量、長度上限、非空、包含可執行行動詞與完整結果意圖；不要比對整段固定字串。

## P0-2：同意內容與錄製結果應提供可理解的下一步

證據：`SKILL.md` 第 52–61 行要求每次同意畫面同時揭露 hard limit、H.264、project cursor、frames、synthetic events 與 fail-closed 等內部細節。這些資訊有價值，但一次全部呈現會稀釋真正需要同意的範圍。
同意內容應保留：錄製目標、將執行的操作、輸出位置、沿用的登入工作階段、視窗或 viewport 範圍，以及敏感內容排除方式。
文字應使用一般語言，例如「只錄製你核准的頁面與操作；不會自動上傳；你可在完成後刪除本機檔案」。
事件來源、合成事件與隔離執行環境等 provenance 細節應移至 Privacy 的技術章節並提供連結。

證據：`recording-outcome.mjs` 第 55–200 行使用 recording contract、frame stream、approved origin、Saved Recording、Working Recording 等術語。
結果摘要應先說明「成功儲存」、「未開始錄製」、「錄製中斷」或「檔案未完成」等直接結果。
錯誤說明先寫可觀察症狀，修復欄位再給一個精確、可執行的下一步。
目前以 preflight code 分組的 remediation 過度共用，部分說明會把使用者導回原本檢查，形成循環。
ffmpeg 問題應明確要求安裝或設定可執行檔，並附上重新檢查的命令或入口。
平台不支援應直接說明支援的平台與替代方案，不應只要求重新執行 preflight。
輸出資料夾問題應指出使用者已核准的目的地，區分不存在與不可寫，並提供建立或改選資料夾的下一步；空間不足應由後續 artifact failure 明確說明，不應混進 preflight 結果。
「Saved Recording」可改為「已儲存影片」，「Working Recording」可改為「未完成的暫存影片」。

## P0-3：支援頁面目前存在提問死路

證據：`SUPPORT.md` 第 34–45 行要求使用問題建立 GitHub issue。
但 `.github/ISSUE_TEMPLATE/config.yml` 設定 blank issues 為 false，現有表單只有 bug 與 feature。
GitHub Discussions 亦未啟用，因此「一般使用問題」沒有可用入口。

建議新增 `question.yml`，或啟用 Discussions 並建立 Q&A 分類。`SUPPORT.md` 應直接提供按意圖分類的連結：使用問題、可重現錯誤、功能建議、安全漏洞。
若選擇 Discussions，Issue forms 應把一般操作問題導向 Q&A，而不是讓使用者硬套 bug 表單。
每個入口都應說明預期回覆內容與不可公開的敏感資料。

## P1-4：Issue forms 應先問發生了什麼

證據：`.github/ISSUE_TEMPLATE/bug_report.yml` 第 9–55 行以禁止事項開場，並使用 allowlisted、bounded、CDP 等術語。第一屏應先問「發生了什麼」、「你預期什麼」與「在哪個步驟失敗」。
安全提醒改成簡明警語：不要貼上密碼、權杖、Cookie、私人頁面內容或未刪除敏感資訊的影片。
加入一個錯誤碼範例，讓使用者知道可以貼如 `ffmpeg_missing` 的可搜尋代碼。
環境與重現資訊放在症狀之後，CDP 等欄位只在進階診斷區出現。

證據：`.github/ISSUE_TEMPLATE/feature_request.yml` 第 9–41 行要求提案者認證內部架構條件。
表單應先詢問要解決的問題、受益對象、目前替代做法與預期效益。
只保留必要的資料安全確認；不要要求一般使用者理解或承諾內部架構。
若功能確實涉及瀏覽器事件或輸出契約，可由維護者在後續 triage 補問。

## P1-5：Support 與 troubleshooting 應從症狀導覽

證據：`SUPPORT.md` 第 3–16 行以版本歷史、release gates 與 OOPIF 開場。
版本歷史應移到 changelog，發布門檻應移到 maintainer release 文件。
Support 首屏應只回答：我遇到哪類問題、去哪裡取得協助、提交前要準備什麼。

證據：troubleshooting 第 46 行以後的標題偏向 CDP 與錯誤碼。
新增症狀優先入口，例如「按下錄製後沒有開始」、「影片是空白的」、「操作沒有被記錄」、「找不到輸出檔案」。
每個症狀頁可在尾端保留相關錯誤碼與 CDP 名稱，維持搜尋與維護效率。
瀏覽器設定導覽應使用 `codex://settings/browser-use`，同時保留可複製的文字路徑作為備援。

## P1-6：貢獻與 PR 表面需要新手路徑與條件式門檻

證據：`CONTRIBUTING.md` 第 6–44 行從 prerequisites 與通用 issue/TDD gates 開始。
文件缺少 clone、安裝依賴、執行第一個測試、挑選第一個小任務的連續 quickstart。
新增「第一次貢獻」區段，提供最短成功路徑與預期測試輸出。
允許拼字、連結與純文件小修不必先開 issue，並清楚界定哪些變更仍須事前討論。
第 46 行以後的 release verification 比例過高，應拆到維護者專用 release guide。

證據：PR template 第 5–20 行要求每個 PR 都勾選完整 privacy 與 TDD 條件。
把檢查項目標為「若適用」，或拆成文件、程式碼與發布等多種模板。
所有 PR 只需共同回答變更目的、驗證方式與風險；隱私與 TDD 問題依變更範圍出現。

## P1-7：Privacy 應先回答承諾，再解釋機制

證據：`PRIVACY.md` 第 6–42 行混合使用者承諾、isolated world、event provenance 與 result schema。
新增首頁摘要表，至少列出「收集什麼、儲存在哪裡、是否上傳、沿用何種 session、如何排除敏感內容、如何刪除」。
摘要後再分層展開執行環境、事件來源與結果 schema。
必須保留登入工作階段沿用、embedded frames、無自動上傳、敏感內容排除、保留期限與清理方式。
技術細節不應消失，而應讓需要稽核的人可直接定位。

## P1-8：GitHub repo 與 release 應以採用與升級意圖為中心

2026-07-24 API 查詢顯示，repository description 為：
`Codex plugin that records approved Browser test flows as local H.264 MP4s with a visible cursor.`
現有 topics 為 browser-automation、codex、developer-tools、ffmpeg、mp4、openai、screen-recording。
目前沒有自訂 social image。
最新 release 以 canonical invocation、tab inventory、ghost ring 與 test gates 開場。

建議 description 改成一般價值語言，例如：「Record approved Chrome test flows as private local videos directly from Codex。」
release notes 首段依序回答：誰應該更新、這次對使用者改變什麼、如何更新。
實作細節與測試門檻移到後續 Technical details 或 Maintainer notes。
topics 可新增 `testing`、`qa`，讓測試與品質保證使用者更容易找到專案。
自訂 social preview 屬 P2：先修正入口文案與支援路由，再設計可辨識的分享圖片。

## P2-9：Research 資訊架構應標示歷史內容

證據：`docs/readme-research.md` 位於 docs 根目錄，但專案已存在 `docs/research/`。
將該文件移至 `docs/research/`，避免它與正式使用文件並列。
新增 `docs/research/README.md`，說明此區為非規範性的歷史研究、日期背景與現行文件的權威來源。
移動時更新內部連結，但不要讓研究結論取代產品或政策文件。

## P2-10：正確的技術與法律表面應保留

Architecture 文件本來就面向工程受眾，技術深度合理，且已有 source map。
`SECURITY.md` 與 `CODE_OF_CONDUCT.md` 簡潔且符合標準用途，不需為了口語化而擴寫。
`TERMS.md` 不應在缺乏法律審查時簡化或改寫。
這些頁面只需在開頭補充適用受眾，以及回到使用者文件、支援或隱私摘要的連結。

## 三階段執行建議

### 第一階段：採用與問題復原

先改 plugin description、starter prompts、同意內容、recording outcome、Support 路由與 question 入口。
同時把錯誤修復改成逐 preflight code 的具體下一步，優先處理 ffmpeg、平台與資料夾問題。
這一階段直接降低首次使用阻力，也消除錄製失敗後的支援死路。

### 第二階段：貢獻與文件分層

重寫 bug/feature forms 的問題順序，新增 contributor quickstart，拆出 maintainer release guide。
把 Privacy 改為摘要表加技術細節，並為 troubleshooting 增加症狀優先導覽。
調整 PR template 為條件式檢查，讓小型文件貢獻不必承擔不相關門檻。

### 第三階段：可發現性與長期資訊架構

更新 GitHub description、topics 與 release notes 結構。
整理 research 文件位置與非規範性標示。
最後製作 social preview，並為技術、政策與法律文件補上受眾導覽連結。

## 參考來源

- [Build plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Chrome extension](https://learn.chatgpt.com/docs/chrome-extension)
- [GitHub issue 與 pull request templates](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/about-issue-and-pull-request-templates)
- [GitHub support resources](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-support-resources-to-your-project)
- [GitHub releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [GitHub social media preview](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview)

## 驗收標準

- 安裝頁第一屏能在不理解 preflight、CDP 或 frame stream 的情況下說明產品價值。
- 三個 starter prompts 都是完整可執行任務，符合最多 3 個、每個不超過 128 字元，並以約 50 字元為目標。
- 同意畫面只要求理解範圍、操作、輸出、session、viewport 與敏感排除；技術 provenance 可由連結深入。
- 每個錄製失敗結果都提供一個精確下一步，ffmpeg、平台與資料夾問題不再共用循環式 remediation。
- 一般使用問題、bug、feature 與 security 各有可用且直接的入口，不存在停用 blank issue 後的死路。
- Issue forms 先收集症狀或價值，不要求使用者認證 allowlist、CDP 或內部架構。
- troubleshooting 可從人類可觀察症狀進入，並保留錯誤碼作為搜尋索引。
- 新貢獻者可依 quickstart 完成 clone、安裝與第一個測試；純小型文件修正不強制先開 issue。
- Privacy 首屏能快速回答資料、儲存、上傳、session、敏感排除與清理政策。
- release notes 首屏明確回答更新對象、使用者變更與更新方式。
- Architecture、Security、Code of Conduct 與 Terms 的專業完整性維持不變。
- 所有文案測試驗證語意與限制，不再逐字鎖死可演進的公開文案。
