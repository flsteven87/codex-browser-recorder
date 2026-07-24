# README 研究：讓開源專案乾淨、友善、容易開始

研究日期：2026-07-24
研究問題：乾淨、受歡迎、對非技術新訪客友善的開源專案 README 應如何寫？這些做法如何套用到 Codex Browser Recorder？

## 結論先行

Codex Browser Recorder 的 README 應從「完整技術規格」改成「新訪客的第一個成功路徑」。

GitHub 對 README 的定位很直接：它通常是訪客最先看到的內容，應回答專案做什麼、為什麼有用、如何開始、去哪裡求助，以及誰在維護；GitHub 也明確建議 README 只保留開始使用與參與所需的內容，長篇文件應放到其他文件頁面。[GitHub：About the repository README file](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)

Open Source Guides 的問題清單幾乎相同：做什麼、為什麼有用、怎麼開始、去哪裡取得更多協助；它也提醒作者「讀者不是你」，讀者可能有完全不同的經驗背景。[Open Source Guides：Starting an Open Source Project](https://opensource.guide/starting-a-project/)

因此，這個專案最適合的 README 不是刪掉重要安全資訊，而是重新分層：

- README 留下使用價值、最短安裝、第一次錄影、安全底線、支援入口。
- Troubleshooting 承接環境需求、錯誤碼、FFmpeg/CDP 問題與進階安裝。
- Architecture 承接生命週期、信任邊界、frame/OOPIF、內部契約與驗證細節。
- CONTRIBUTING 承接 Node 版本、測試矩陣、release gate、checksum 與維護者流程。
- PRIVACY、SECURITY、TERMS、SUPPORT 保留各自的完整政策。

這種分層不是單純追求短。目的是讓第一次到訪的人在前 30 秒內知道：

1. 這是什麼；
2. 它會產生什麼；
3. 我能不能安全地使用；
4. 要按哪裡或輸入什麼；
5. 卡住時去哪裡。

## 第一方指引透露的寫作原則

### 1. README 是入口，不是唯一文件

GitHub 說 README 應快速說明專案能做什麼，較長的使用、設計與核心原則文件可放在 wiki 或其他長篇文件。[GitHub：About wikis](https://docs.github.com/en/communities/documenting-your-project-with-wikis/about-wikis) 本專案已經有 `docs/troubleshooting.md`、`docs/architecture.md`、`CONTRIBUTING.md`、`PRIVACY.md`、`SECURITY.md` 與 `SUPPORT.md`，因此無需在 README 再敘述一遍。

### 2. 先回答讀者的問題，再介紹系統的名詞

Open Source Guides 建議 README 優先回答「做什麼、為什麼有用、怎麼開始、去哪裡求助」。[Starting an Open Source Project](https://opensource.guide/starting-a-project/) 對本專案而言，「把一段經過同意的 Chrome 操作儲存成電腦上的 MP4」比 `Recording Session`、`Working Recording`、`Saved Recording` 更適合作為入口。

### 3. 對新手友善是明確寫出下一步

Open Source Guides 指出，隨社群成長，臨時到訪的貢獻者會依賴文件快速取得背景；若多位使用者反覆遇到相同問題，答案應被文件化。[Building Welcoming Communities](https://opensource.guide/building-community/) README 因此應有一條清楚的主要路徑，並把重複問題導向 troubleshooting 或 support，而不是一次展示所有分支與例外。

### 4. 社群與政策文件應各司其職

GitHub 會另外呈現 `CONTRIBUTING.md`，並在 repository overview、contribute page、issue 與 pull request 流程中主動連結它。[GitHub：Setting guidelines for repository contributors](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors) GitHub 也把 `CONTRIBUTING`、`CODE_OF_CONDUCT`、`SECURITY`、`SUPPORT` 視為獨立的 community health files。[GitHub：Creating a default community health file](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file) README 只需簡短導覽，不需複製其完整內容。

### 5. 不需要手工目錄

GitHub 會依標題自動生成 README 大綱與段落連結。[GitHub：About the repository README file](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes#auto-generated-table-of-contents-for-markdown-files) 目前 README 開頭的 `Documentation` 目錄可刪除，改把最重要的 docs/support 連結放到實際需要它們的段落，底部再放一個精簡的「文件」區塊。

## 六個成熟專案的實際做法

這些案例是設計樣本，不代表 star 數與 README 寫法存在因果關係。選擇它們是因為它們是成熟、高能見度的專案，而且官方 repository README 分別展示了幾種適合本專案的入口模式。

### Vite：極短的價值摘要，把深度內容交給文件站

[Vite 官方 README](https://github.com/vitejs/vite#readme) 的順序是名稱、短標語、六個可掃讀的優點、兩段「它是什麼」、清楚的文件 CTA，之後才是 packages、contribution、license、sponsors。

可借用的做法：

- 首屏以效益語言列 3–5 個重點。
- 一個醒目的 `Read the Docs` 入口，避免把完整手冊塞回 README。
- repository 維護資訊放在使用者理解產品之後。

### Home Assistant：一句話說清楚價值觀，馬上提供 demo、安裝與協助

[Home Assistant 官方 README](https://github.com/home-assistant/core#readme) 先用日常語言說明「把本地控制與隱私放在第一位」，接著直接連到 demo、安裝、教學、文件，並用產品截圖讓人看懂成果；支援入口也只用一小段指向 help page。

可借用的做法：

- 把「本機儲存、隱私、安全同意」轉成使用者價值，不先用內部安全模型解釋。
- 若能製作不含私人資料、可長期維護的合成示範，首屏放一張靜態成果圖或短 GIF。
- 讓安裝、教學、文件、求助各有清楚入口。

### Excalidraw：先展示結果，清楚區分使用者與開發者路徑

[Excalidraw 官方 README](https://github.com/excalidraw/excalidraw#readme) 以可視化產品、日常使用情境與簡短 feature list 起頭；在 quick start 特別說明該段是給「整合 npm package」的人，若要在本機開發 repository，請前往 development guide。它的 contributing 區也用「發現 bug？想貢獻？想翻譯？」這類讀者問題作為入口。

可借用的做法：

- 不把一般安裝與 repository 開發安裝混在同一條主路徑。
- 標題採用讀者問題，例如「想在本機開發？」、「遇到問題？」。
- 功能描述使用具體成果：本機 MP4、游標、點擊回饋、無音訊。

### n8n：一個畫面、一組能力、一條可立即成功的 Quick Start

[n8n 官方 README](https://github.com/n8n-io/n8n#readme) 在定位文字後顯示產品畫面，接著依序提供 key capabilities、quick start、resources、support。Quick Start 不列完整部署矩陣，而是先給一個命令，並告訴使用者成功後要開哪個網址。

可借用的做法：

- Quick Start 只保留一條推薦路徑，並寫出可驗證的成功訊號。
- 清楚告訴讀者「成功時你會看到什麼」：本專案可保留 `Local recording preflight passed` 與錄影完成後的檔案位置。
- 進階安裝和替代方案用連結承接。

### uv：先講優點與證據，再安裝，再到文件

[uv 官方 README](https://github.com/astral-sh/uv#readme) 的首屏是一句承諾、視覺證據、highlights，之後才是 installation 和 documentation。它的深入 feature recipes 雖然較長，但入口順序仍是價值優先。

可借用的做法：

- 在任何依賴、限制與實作說明之前，先列「你會得到什麼」。
- 把安裝指令與完整安裝文件分開；README 只放最常見方法。
- 技術事實應變成容易理解、可驗證的結果，而非抽象承諾。

### Supabase：把功能與支援入口按用途分類

[Supabase 官方 README](https://github.com/supabase/supabase#readme) 先用一句話定位，功能清單中的每一類都直接連到對應文件；Community & Support 不是一包連結，而是說明 forum、issues、email、Discord 分別適合什麼問題。

可借用的做法：

- 在功能旁就放最相關文件，不要求讀者先理解整套文件架構。
- 將「使用問題」「bug」「安全性問題」分流到 troubleshooting、GitHub issues、private vulnerability reporting。
- 不宜照搬其後半部很長的架構與 client library 清單；本專案已有更合適的 Architecture 文件。

## 建議給 Codex Browser Recorder 的內容順序

以下是可直接用來改寫 `README.md` 的順序。首屏應完成第 1–3 項，第一次成功路徑應在第 5 項以前出現。

### 1. 名稱與一句話結果

建議方向：

> Record a short, approved Chrome flow with Codex and save it as a local MP4.

下一句補上最重要的體驗：

> Codex opens one fresh tab, performs only the actions you approve, and adds a visible cursor and click feedback.

`experimental`、`community-developed` 是重要狀態資訊，但不應取代價值主張。可放在接下來一行或簡短 status note。

依據：GitHub 與 Open Source Guides 都把「專案做什麼、為何有用」列為 README 首要問題；Vite、Home Assistant、uv 都以一句價值定位起頭。[GitHub](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) · [Open Source Guides](https://opensource.guide/starting-a-project/) · [Vite](https://github.com/vitejs/vite#readme) · [Home Assistant](https://github.com/home-assistant/core#readme) · [uv](https://github.com/astral-sh/uv#readme)

### 2. 三至五個「你會得到什麼」

建議只留：

- A local H.264 MP4, with no audio.
- A visible cursor and click feedback for pointer actions.
- One fresh Chrome tab and one flow you explicitly approve.
- No built-in upload, sharing, or telemetry.

這裡不要出現 CDP、OOPIF、discriminated outcome、atomic publication 等詞。Vite、n8n、uv 都把首屏能力寫成可掃讀的效益清單。[Vite](https://github.com/vitejs/vite#readme) · [n8n](https://github.com/n8n-io/n8n#readme) · [uv](https://github.com/astral-sh/uv#readme)

### 3. 一個有用的視覺

若 repository 能提供完全合成、無私人資料、可重製的錄影樣本，放一張靜態截圖或短 GIF，內容應同時展示：

- 公開測試頁面；
- 專案游標；
- 點擊回饋；
- 成品是 MP4 的提示。

不要使用真實登入工作階段或維護者的個人瀏覽器畫面。若目前無法提供安全且可維護的素材，寧可暫時不放，不要使用裝飾性 hero。

依據：Home Assistant、Excalidraw、n8n 與 Supabase 都用實際產品畫面幫助新訪客理解結果。[Home Assistant](https://github.com/home-assistant/core#readme) · [Excalidraw](https://github.com/excalidraw/excalidraw#readme) · [n8n](https://github.com/n8n-io/n8n#readme) · [Supabase](https://github.com/supabase/supabase#readme)

### 4. 「Before you record」安全底線

保留一個短、醒目的安全區塊，控制在 3–4 點：

- Only record public, logged-out test flows with everyone’s agreement.
- The fresh tab may use your existing Chrome session.
- Everything visible in the page viewport, including embedded frames, can appear in the video.
- Never record credentials, payments, private messages, health data, or other sensitive content.

README 不應刪掉這些風險，因為它們會影響使用者是否能安全開始；但 fail-closed 實作、origin normalization、frame observation 與所有 failure code 應連到 Privacy/Architecture/Troubleshooting。

### 5. 「Install」只給一般使用者的推薦方法

先寫 UI 安裝：

1. Open **Plugins** in Codex.
2. Install **Codex Browser Recorder** and the official **Chrome** plugin.
3. Finish the Chrome extension setup, then start a new task.

接著只放兩個連結：

- Local installation / development
- Requirements and troubleshooting

不要在一般安裝段落立即展示 marketplace command、clone 特定 tag、archive checksum、非互動安裝與 cache 行為。Excalidraw 明確區分 package 使用者與 repository developer；n8n、uv 也先給一個主要安裝方式，再連到替代方案。[Excalidraw](https://github.com/excalidraw/excalidraw#readme) · [n8n](https://github.com/n8n-io/n8n#readme) · [uv](https://github.com/astral-sh/uv#readme)

### 6. 「Record your first flow」提供單一路徑

保留目前很好的兩步驟設計，但更白話：

1. Run the preflight prompt.
2. Request one concrete public flow.

每一步都寫預期結果：

- Preflight 成功會看到 `Local recording preflight passed`。
- Recording 成功會回報儲存的 `.mp4` 路徑。

不要在這段插入 15 秒 hard cap、duration inference、surface error code 或 origin transition 規則；在範例後加一行 `Need a custom duration or output folder? See the recording options.` 即可。n8n 的 Quick Start 展示了「一個動作＋一個成功後的下一步」的低摩擦模式。[n8n](https://github.com/n8n-io/n8n#readme)

### 7. 「What it records」用簡單對照表

建議：

| Records | Does not record |
| --- | --- |
| The visible content of one approved fresh tab | Codex UI or other tabs |
| Visible embedded frames | Browser chrome or an entire profile |
| Pointer cursor and click feedback | Audio |
| A local MP4 | Automatic uploads or sharing |

表格後僅補一句：Chrome is the only supported recording surface in this release. 把精確平台、URL、duration 與媒體限制連到 Troubleshooting 或 Supported scope。

### 8. 「Help and documentation」按讀者意圖分類

- **Can’t install or record?** Troubleshooting
- **Found a bug?** GitHub Issues / Support
- **Found a security issue?** Private vulnerability reporting
- **Want to understand how it works?** Architecture
- **Want to contribute?** Contributing

Supabase 以問題類型說明不同支援渠道；GitHub 也將 SUPPORT、SECURITY、CONTRIBUTING 視為獨立入口。[Supabase](https://github.com/supabase/supabase#readme) · [GitHub community health files](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)

### 9. License

維持單行 MIT 連結即可。

## 目前 README 建議刪減或移動的內容

目前 `README.md` 約 334 行、1,989 字，前半部在第一次成功範例之前就要求讀者理解大量平台、媒體、CDP、frame 與 release 細節。以下不是要刪除事實，而是改變它們出現的位置。

| 目前內容 | 建議處理 | 理由／目的地 |
| --- | --- | --- |
| `Documentation` 手工目錄 | 刪除 | GitHub 已自動生成大綱；最重要的連結應在讀者需要時出現。[GitHub](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes#auto-generated-table-of-contents-for-markdown-files) |
| `Requirements and Supported Scope` 的完整矩陣 | README 留 3–5 個必要條件，其餘移到 troubleshooting 或新增 `docs/supported-scope.md` | GitHub 建議 README 只保留開始所需資訊，長文件另放。[GitHub](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) |
| OOPIF、public CDP、first-frame contract、fail-closed 細節 | 移到 Architecture；README 只說「visible embedded frames are recorded」 | 對使用者保留結果與風險，對維護者保留完整機制。 |
| release tag、full commit SHA、checksum、candidate testing | 移到 CONTRIBUTING 或 release 文件 | 一般使用者安裝流程不應被發布工程淹沒；GitHub 會獨立呈現 contribution guidelines。[GitHub](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors) |
| `Record a Flow` 的完整 consent/origin/failure 規格 | README 壓成 `Recording options` 4–6 行，細節連 Privacy、Terms、Architecture | 首次使用只需要知道同意邊界與安全底線。 |
| `Recording Lifecycle and Output` | README 留一段「成功輸出」；完整內容移到 Architecture | `Working Recording`、atomic publish、terminal outcome 是內部模型，不是新訪客入口。 |
| `Architecture` 的函式名稱與 opaque preparation | README 只留 Architecture 連結 | GitHub 將長篇設計文件定位為 README 之外的內容。[GitHub](https://docs.github.com/en/communities/documenting-your-project-with-wikis/about-wikis) |
| `Development` 的五個驗證命令與 release smoke | 移到 CONTRIBUTING，README 只說 `Want to contribute?` | Excalidraw 把 repository development 導向獨立 guide。[Excalidraw](https://github.com/excalidraw/excalidraw#readme) |
| `Update or Uninstall` 的完整命令 | README 留一個 Help/Uninstall 連結；命令移到 troubleshooting | 不影響第一次成功，屬於操作參考。 |
| Privacy/Security/Support 的完整敘述 | 留 2–3 句重要承諾與分流連結 | 政策應保留，但已有專門 community health files。[GitHub](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file) |
| `Record & Replay` 比較 | 若確實常被混淆，改成 FAQ 一題；否則移到 support | Open Source Guides 建議把反覆出現的問題文件化，不需預先收錄所有可能問題。[Building Welcoming Communities](https://opensource.guide/building-community/) |

## 語氣與句型

### 建議採用

- 對讀者用 `you`，對產品用主動句。
- 一句只傳達一個決定或結果。
- 先說使用者得到什麼，再說實作方式。
- 標題用讀者語言：`Install`、`Record your first flow`、`Before you record`、`Need help?`
- 專有名詞第一次出現時用日常語言解釋，或直接連到技術文件。
- 安全警告使用清楚、平靜、可執行的語氣。

範例：

- 不建議：`The recorder reuses the Chrome plugin's permission-gated CDP connection.`
- 建議：`The recorder uses the Chrome access you approve for this flow.`
- 不建議：`A Working Recording is private temporary media that has not been validated or delivered.`
- 建議：`The plugin saves a file only after the recording passes validation.`
- 不建議：`Existing tabs, multiple tabs, non-loopback http... are unsupported.`
- 建議：`This release records one new Chrome tab at a time. See supported scope for the full list of limits.`

依據：Open Source Guides 提醒作者讀者可能有完全不同的經驗；Home Assistant、Excalidraw 與 n8n 都使用短句、具體用途與清楚 CTA。[Open Source Guides](https://opensource.guide/starting-a-project/) · [Home Assistant](https://github.com/home-assistant/core#readme) · [Excalidraw](https://github.com/excalidraw/excalidraw#readme) · [n8n](https://github.com/n8n-io/n8n#readme)

## 反模式

- **以限制開場**：新訪客還不知道價值，就先讀兩屏風險與例外。
- **把所有讀者當維護者**：一般安裝、local marketplace、release reproduction、candidate verification 混成同一條路徑。
- **把內部名詞當導覽**：用 `Recording Lifecycle and Output` 引導新手，而不是「What gets saved」。
- **首個成功範例出現太晚**：quick start 應緊接價值、安全底線與安裝。
- **重複其他文件**：README、Architecture、Privacy、Support、Contributing 同時解釋同一規則，後續容易漂移。
- **一次列出所有例外**：主流程被大量 platform、URL、duration、frame、failure 分支打斷。
- **模糊的成功標準**：只給命令，不說成功會看到什麼、檔案在哪裡。
- **連結只有文件名**：應告訴讀者每個入口解決哪一種問題。
- **過量 badges 或純裝飾 hero**：視覺應展示產品或建立信任，不應推遲核心訊息。

## 可直接作為改寫起點的首屏草案

以下不是最終 README，而是用來確認資訊層級的草案：

```markdown
# Codex Browser Recorder

Record a short, approved Chrome flow with Codex and save it as a local MP4.

- Records one fresh Chrome tab and only the actions you approve
- Shows the cursor and click feedback
- Saves an H.264 MP4 locally, with no audio
- Does not upload, share, or add telemetry

> [!IMPORTANT]
> Record only public, logged-out test flows that everyone involved has agreed
> may be recorded. The new tab may use your existing Chrome session, and
> everything visible in the page viewport can appear in the video.

## Install

Open **Plugins** in Codex and install **Codex Browser Recorder** and **Chrome**.
Finish the Chrome extension setup, then start a new task.

[Local installation](...) · [Requirements and troubleshooting](...)

## Record your first flow

First, check that your computer is ready:

...

Then request one public flow:

...
```

這個版本把目前 README 最重要的事實全部保留在首屏：錄什麼、存成什麼、使用哪個 browser、需要明確同意、存在 session/viewport 風險、沒有 upload/telemetry；但不要求新訪客先理解實作契約。

## 建議的驗收標準

改寫後可用以下問題檢查，而不是只追求字數：

- 不往下捲動時，能否說出這個 plugin 做什麼與產生什麼？
- 一般使用者能否在 60 秒內找到推薦安裝方式？
- 第一次錄影是否只有一條明確路徑？
- 每一步是否寫出成功訊號？
- 安全底線是否仍在第一次操作之前？
- 一般使用者是否可以完全跳過 CDP/OOPIF/lifecycle/release gate 等內部概念？
- troubleshooting、support、security、contributing 是否按問題意圖命名？
- README 中的每個長段落，是否真的影響第一次使用或第一次貢獻？
- 移走的技術事實是否已在專門文件中有唯一、可維護的家？

## 來源

官方指引：

- [GitHub Docs — About the repository README file](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
- [GitHub Docs — About wikis](https://docs.github.com/en/communities/documenting-your-project-with-wikis/about-wikis)
- [GitHub Docs — Setting guidelines for repository contributors](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors)
- [GitHub Docs — Creating a default community health file](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)
- [Open Source Guides — Starting an Open Source Project](https://opensource.guide/starting-a-project/)
- [Open Source Guides — Building Welcoming Communities](https://opensource.guide/building-community/)

專案案例（皆為官方 GitHub repository README）：

- [Vite](https://github.com/vitejs/vite#readme)
- [Home Assistant Core](https://github.com/home-assistant/core#readme)
- [Excalidraw](https://github.com/excalidraw/excalidraw#readme)
- [n8n](https://github.com/n8n-io/n8n#readme)
- [uv](https://github.com/astral-sh/uv#readme)
- [Supabase](https://github.com/supabase/supabase#readme)
