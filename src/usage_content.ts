export const usage_languages = ['en', 'zh', 'ja'] as const;
export type usage_language = typeof usage_languages[number];

interface usage_section {
  id: string;
  title: string;
  paragraphs?: string[];
  items?: string[];
  code?: string;
}

export interface usage_guide {
  title: string;
  summary: string;
  contents: string;
  sections: usage_section[];
}

const startup_example = `"terminalSidebar.sidebars": {
  "left": [],
  "right": [{
    "id": "build",
    "name": "Build",
    "command": "",
    "shell": "bash",
    "args": ["--login"],
    "env": { "FOO": "bar", "UNUSED": null }
  }]
}`;

/** Bundled help mirrors the supported user workflows in docs/guide.md. */
export const usage_guides: Record<usage_language, usage_guide> = {
  en: {
    title: 'Usage', summary: 'Terminals, previews, and their controls — beside your editor.', contents: 'Contents',
    sections: [
      { id: 'start', title: 'Get started', items: [
        'Open Side Terminals in the Primary Side Bar or run “Terminal Sidebar: Open Secondary Terminal” from the Command Palette. The arrow in either title toolbar opens the other side.',
        'Select + to create a terminal. Right-click + and choose “Preview in Sidebar Terminal” to open a document. Supported source editors also show the preview icon in their title toolbar.',
        'The Primary Side Bar has collapsible sections; several can remain expanded. The Secondary Side Bar has a compact tab strip. Each terminal runs its own process.',
        'Select the gear for startup configuration. Use the parent … menu for Usage, About, saved profiles, and restarting the active terminal.',
      ] },
      { id: 'tabs', title: 'Tab controls', items: [
        'Child-tab buttons are New, Search, and Close. Right-click Search for “Find in all open tabs”. Right-click Close for closing the active tab or every open tab in that side bar.',
        'Right-click a tab for Rename, Change tab marker, Find, Restart / Reload preview, Close, and Export… / Save a copy…. Saving a document copy copies its original file; it does not overwrite the source.',
        'Drag headings to reorder them. Keyboard alternatives: Alt+Shift+Up/Down in the Primary Side Bar; Alt+Shift+Left/Right in the Secondary Side Bar. F2 renames a focused tab; Delete or middle-click closes it.',
        'Double-click blank space in the Secondary Side Bar tab strip to create a terminal. Folding a section or hiding a side bar keeps its process alive.',
        'Idle or exited terminals close directly. A detected running command, or an uncertain idle state, asks for confirmation. Restarting a running terminal also asks.',
      ] },
      { id: 'find', title: 'Find and links', paragraphs: [
        'Press Cmd+F on macOS or Ctrl+F on Windows/Linux in a terminal or preview. Find includes previous/next matches, case sensitivity, whole words, regular expressions, match counts, and highlighting. Esc closes Find and returns focus. There is no Replace operation on terminal output.',
        '“Find in all open tabs” searches both sidebars: retained terminal buffers, PDF text on all pages, rendered Markdown/HTML, and formatted source. Select a result to open its tab. Results are a snapshot; reopen global Find after output or files change.',
        'Scanned, image-only PDFs require a text layer from another tool. Very large searches and expensive regular expressions have limits to keep the interface responsive.',
        'Cmd-click / Ctrl-click terminal HTTP(S) links and supported file locations such as `src/app.ts:12:3`. Relative file paths use the last known working directory; not every diagnostic format is recognized.',
      ] },
      { id: 'documents', title: 'Open and read documents', paragraphs: [
        'Use the editor title preview icon, a file context menu, or “Terminal Sidebar: Preview in Sidebar Terminal”. Supported files are PDF, Markdown, LaTeX, HTML/HTM, CSS, JSON, and JSONC. Previews share tab ordering and markers without creating shell startup profiles.',
        'Text previews provide page-sized scrolling, Zoom in / 100% / Zoom out, a zoom selector, Open source file, and Reload. Markdown and HTML also have an outline. Cmd/Ctrl + mouse wheel or Cmd/Ctrl +/-/0 controls zoom. Use j/k to scroll and g/G for the beginning/end while the preview has focus.',
        'Saving the source, including saves from Vim or Neovim, refreshes the preview. Text previews require UTF-8 files up to 4 MiB. Local resources must be beside the source or in its subdirectories. Reading positions are remembered.',
      ] },
      { id: 'markdown', title: 'Markdown, HTML, and formatted source', paragraphs: [
        'Markdown supports common CommonMark/GFM features: headings, lists, tables, fenced code, links, local images, strikethrough, task lists, and footnotes. KaTeX math accepts `$…$`, `$$…$$`, `\\(…\\)`, `\\[…\\]`, and fenced `math` blocks. Raw HTML remains text. Unsupported or oversized formulas remain readable source; not every third-party Markdown dialect is supported.',
        'Change preview font selects the Markdown reading font. Default follows VS Code; Editor font follows the editor setting. The User setting `terminalSidebar.markdownFontFamily` follows Settings Sync when enabled. Install custom fonts on each device.',
        'HTML is a static preview with local images and stylesheets. Scripts, forms, embedded frames, and remote resources are inactive. CSS, JSON, and JSONC show formatted source, retaining JSONC comments. Invalid or costly formatting falls back to the original text; source files are never rewritten.',
      ] },
      { id: 'pdf', title: 'PDF and LaTeX', paragraphs: [
        'PDF controls offer contents, previous/next page or page-sized scrolling, zoom, a page number, and reload. The gear selects continuous scrolling (default), single page, two pages, and dark reading. Dark reading also inverts images; disable it to inspect original colours.',
        'Cmd/Ctrl + mouse wheel and Cmd/Ctrl +/-/0 zoom. Use h/l to turn pages and j/k to scroll. Only nearby pages render. Page, zoom, and browsing preferences are remembered per workspace. A rebuilt PDF refreshes automatically; incomplete output leaves the last valid preview visible.',
        'Opening .tex locates an existing compiled PDF using root comments, LaTeX Workshop output-directory settings, and common output folders. If several match, choose one. If none exists, compile first or select a PDF. This extension does not run a compiler or project build scripts.',
        'Double-click a PDF location to return to LaTeX source through SyncTeX. Build with `-synctex=1`, keep the matching `.synctex` or `.synctex.gz`, and install `synctex` on the extension host. `latex-workshop.synctex.path` can specify its executable. The compiler mapping may resolve to the nearest source line.',
      ] },
      { id: 'startup', title: 'Startup configuration', paragraphs: [
        'The gear opens independent Primary / Secondary Side Bar startup lists. Name labels the tab; Command runs once when the terminal starts; Shell selects an executable. Blank Command opens an interactive shell. Blank Shell uses the default. The circular refresh button discovers installed shells again.',
        'Save writes both lists. Cancel discards the draft. Return to terminals keeps the draft and undo history for later editing. Adding or closing live tabs does not change startup lists; changing startup settings leaves existing processes alone.',
        'User setting `terminalSidebar.sidebars` also accepts literal `args` and `env`. Keep shell arguments out of the executable field. Omitting args retains default arguments; `[]` clears them. An environment value of `null` removes that variable. The visual editor preserves these fields.',
        'The public keys left/right mean Primary/Secondary Side Bar regardless of screen position. Keep profile IDs stable across renames and reorderings. Each side allows 32 startup profiles and 32 additional ordinary terminals.',
        'Startup commands, arguments, and environment values may sync with VS Code Settings Sync. Keep credentials in local credential storage or the tool’s own login. Tools, custom fonts, and credentials need separate setup on each machine.',
      ], code: startup_example },
      { id: 'memory', title: 'Markers, status, and memory', paragraphs: [
        'Change tab marker offers bookmark, tag, flag, star, ask, and a searchable Others catalog. Colours use the terminal palette or tab foreground colours from the theme. Inactive icons blend with the normal foreground; tab-name text keeps its usual colour.',
        'Startup-profile markers follow the same side and stable profile ID across repositories. Document markers follow the same file across workspaces and sides. Temporary-terminal markers remain workspace-local. Removing a shared marker also stays remembered.',
        'The tab dot shows the latest shell-reported command: running, failed, or completed. Viewing a completed tab clears its completion dot. Background bell indicators also clear when viewed. The footer retains the latest result. Colours follow the theme; silence is never interpreted as command completion.',
        'Each workspace remembers tab order, names, active tabs, expanded sections, reading positions, and reported working directories. Reloading or closing VS Code ends terminal processes; restored tabs start new ones and do not replay typed commands. Startup profiles reopen even if their tabs were closed previously.',
        'Directory and command-state tracking depend on supported shell integration and are best effort. A missing remembered directory falls back to the workspace or home. Typed input and output are not stored as layout memory; terminal output is not continuously logged.',
      ] },
      { id: 'export', title: 'Export and save', items: [
        'Right-click a terminal tab → Export… → HTML, PDF, Markdown, or Plain text. The export captures its retained buffer, not unlimited history.',
        'HTML retains colours without scripts or active links. Printing it in a browser can produce selectable PDF text; enable background graphics to keep colours.',
        'PDF preserves rendered colours, fonts, and Unicode as page images. Text in this export is not selectable or searchable.',
        'Markdown embeds sanitized HTML; readers such as GitHub may strip inline colours. Plain text removes formatting.',
        'Text is limited to 1 Mi UTF-16 code units; HTML/Markdown to 8 Mi. PDF exports allow up to 16 MiB, 100 pages, and one million terminal cells. Oversized exports report an error.',
        'Document tabs use Save a copy… to copy the original PDF or source file to a chosen location. HTML copies do not bundle linked assets.',
      ] },
      { id: 'compatibility', title: 'Compatibility and troubleshooting', paragraphs: [
        'Use VS Code 1.106+ with a desktop or remote Node.js extension host and a trusted workspace. Browser-only and virtual workspaces are unsupported. For SSH, WSL, or Dev Containers, install tools and the matching extension package on the remote host.',
        'If the editor preview icon is not visible, open a saved supported file and check the editor’s … menu; crowded toolbars can move actions there. The Command Palette preview command remains available. For a missing LaTeX preview, check that the PDF has been compiled.',
        'For missing glyphs, install a font that contains them and select it in terminal/editor font settings. Unsupported shells or custom arguments may disable automatic shell integration, affecting command dots, close confirmation, and directory memory.',
        'About shows the installed version, author, repository, and licence. This Usage page works offline; its language selection is remembered on this machine.',
      ] },
    ],
  },
  zh: {
    title: '使用说明', summary: '在编辑器旁使用终端、文稿预览与查找。', contents: '目录',
    sections: [
      { id: 'start', title: '快速开始', items: [
        '在 Primary Side Bar（主侧栏）打开 Side Terminals，或从命令面板运行 “Terminal Sidebar: Open Secondary Terminal”。两个侧栏标题上的箭头可呼出另一侧。',
        '点击 + 新建终端；右键点击 +，选择 “Preview in Sidebar Terminal” 打开文稿。支持的源文件在主编辑器标题工具栏中也有预览按钮。',
        '主侧栏采用可折叠分区，可以同时展开多个；Secondary Side Bar（辅助侧栏）采用横向标签栏。每个终端都有独立进程。',
        '点击齿轮设置启动终端。父级 … 菜单提供 Usage、About、打开启动配置及重启当前终端等操作。',
      ] },
      { id: 'tabs', title: '标签操作', items: [
        '子标签按钮依次为新建、查找、关闭。右键查找可搜索所有已打开标签；右键关闭可关闭当前标签或该侧栏的全部标签。',
        '右键标签可重命名、修改标识、查找、重启／刷新、关闭及导出／另存副本。文稿的 Save a copy… 复制原始文件，不会改写源文件。',
        '拖动标题调整顺序。键盘排序：主侧栏 Alt+Shift+↑/↓，辅助侧栏 Alt+Shift+←/→。标签获得焦点后，F2 重命名，Delete 或鼠标中键关闭。',
        '双击辅助侧栏标签栏的空白区域可新建终端。折叠分区或隐藏侧栏不会停止终端进程。',
        '空闲或已经退出的终端直接关闭。检测到命令正在运行，或无法确认空闲状态时会询问；重启运行中的终端也会询问。',
      ] },
      { id: 'find', title: '查找与链接', paragraphs: [
        '在终端或预览内按 macOS 的 Cmd+F，或 Windows/Linux 的 Ctrl+F。支持上一处／下一处、区分大小写、全字匹配、正则表达式、匹配计数与高亮。Esc 关闭查找并恢复焦点。终端输出不提供替换功能。',
        '“Find in all open tabs” 搜索两个侧栏：终端保留的缓冲区、PDF 全部页面的文字、渲染后的 Markdown/HTML，以及格式化源码。点击结果跳转到对应标签。结果是快照；输出或文件变化后，重新打开全局查找以更新结果。',
        '纯图片扫描 PDF 需要其他工具添加文字层才能查找。过大的搜索和耗时的正则表达式会受到限制，以保持界面响应。',
        '在终端 Cmd+点击／Ctrl+点击可打开 HTTP(S) 链接及支持的文件位置，例如 `src/app.ts:12:3`。相对路径以最后获知的工作目录为基准，并非所有报错格式都能识别。',
      ] },
      { id: 'documents', title: '打开与阅读文稿', paragraphs: [
        '使用编辑器标题的预览按钮、文件右键菜单，或命令 “Terminal Sidebar: Preview in Sidebar Terminal”。支持 PDF、Markdown、LaTeX、HTML/HTM、CSS、JSON、JSONC。预览与终端共用排序和标识，不会创建启动终端配置。',
        '文字预览提供按一屏滚动、放大／100%／缩小、倍率选择、打开源文件与刷新。Markdown 和 HTML 还有标题目录。Cmd/Ctrl+滚轮或 Cmd/Ctrl +/-/0 控制缩放；预览获得焦点时，j/k 滚动，g/G 跳转开头／末尾。',
        '保存源文件会刷新预览，包括 Vim、Neovim 的保存。文字文件需使用 UTF-8，大小不超过 4 MiB；本地资源必须位于源文件所在目录或其子目录。阅读位置会被记住。',
      ] },
      { id: 'markdown', title: 'Markdown、HTML 与格式化源码', paragraphs: [
        'Markdown 支持常用 CommonMark/GFM 语法：标题、列表、表格、围栏代码、链接、本地图片、删除线、任务列表和脚注。KaTeX 数学公式支持 `$…$`、`$$…$$`、`\\(…\\)`、`\\[…\\]` 和 math 围栏代码块。原始 HTML 显示为文字；不支持或过大的公式保留可读源码，并不涵盖所有第三方 Markdown 方言。',
        'Change preview font 修改 Markdown 阅读字体。Default 跟随 VS Code，Editor font 跟随编辑器字体。用户设置 `terminalSidebar.markdownFontFamily` 在启用 Settings Sync 时同步；自定义字体仍需在每台设备安装。',
        'HTML 是带本地图片与样式表的静态预览；脚本、表单、嵌入框架及远程资源不会执行或加载。CSS、JSON、JSONC 显示格式化源码，并保留 JSONC 注释。语法无效或格式化耗时过长时显示原文，不改写源文件。',
      ] },
      { id: 'pdf', title: 'PDF 与 LaTeX', paragraphs: [
        'PDF 工具栏提供目录、上一页／下一页或按一屏滚动、缩放、页码与刷新。齿轮菜单选择连续滚动（默认）、单页、双页和深色阅读。深色阅读也会反转图片颜色；查看原始颜色时请关闭。',
        'Cmd/Ctrl+滚轮及 Cmd/Ctrl +/-/0 调整缩放；h/l 翻页，j/k 滚动。仅渲染附近页面。页码、倍率和浏览偏好按工作区记忆。重新编译 PDF 会自动刷新；输出暂时不完整时保留上一份有效预览。',
        '打开 .tex 会根据根文档注释、LaTeX Workshop 输出目录及常见目录查找已编译 PDF。找到多个时供你选择；尚未生成时请先编译或手动选择 PDF。本扩展不会运行编译器或项目构建脚本。',
        '双击 PDF 中的位置可通过 SyncTeX 返回 LaTeX 源码。编译时使用 `-synctex=1`，保留配套 `.synctex` 或 `.synctex.gz`，并在扩展宿主安装 synctex。可用 `latex-workshop.synctex.path` 指定程序。定位取决于编译器映射，可能落在最近的源码行。',
      ] },
      { id: 'startup', title: '启动配置', paragraphs: [
        '齿轮打开主侧栏和辅助侧栏独立的启动列表。Name 是标签名称；Command 在终端启动时执行一次；Shell 是可执行程序。Command 留空打开交互式 shell，Shell 留空使用默认 shell。圆形刷新按钮重新检测已安装的 shell。',
        'Save 保存两侧列表；Cancel 放弃草稿；Return to terminals 保留草稿和撤销记录，返回终端。临时新增或关闭标签不改变启动列表；修改启动设置不会中断现有进程。',
        '用户设置 `terminalSidebar.sidebars` 还支持 `args` 参数数组与 `env` 环境变量。不要把参数写进 Shell 路径。省略 args 保留默认参数，`[]` 清空参数；环境变量值 `null` 表示移除该变量。可视化编辑器会保留这些字段。',
        '公开配置键 left/right 始终表示主侧栏／辅助侧栏，不受实际屏幕位置影响。重命名或排序时保留稳定的 profile ID。每侧最多 32 个启动配置和 32 个额外普通终端。',
        '启动命令、参数和环境变量可能通过 VS Code Settings Sync 同步。凭据请放在本地凭据存储或工具自己的登录中；工具、字体和凭据需要在每台设备单独配置。',
      ], code: startup_example },
      { id: 'memory', title: '标识、状态与记忆', paragraphs: [
        'Change tab marker 提供 bookmark、tag、flag、star、ask，以及 Others 中可搜索的全部图标。颜色取自主题终端调色板或标签前景色。非激活图标与正常前景色混合，标签文字保留原主题颜色。',
        '启动配置的标识按侧栏和稳定 profile ID 跨仓库记忆；文稿标识跟随同一文件，可跨工作区和侧栏；临时终端标识仅在当前工作区记忆。移除共享标识也会被记住。',
        '标签圆点表示 shell 报告的最近命令：运行中、失败或完成。查看已完成标签后完成圆点消失；后台响铃提示也会在查看后清除。底部状态保留最近结果。颜色跟随主题，不会根据输出暂停推断命令完成。',
        '每个工作区记忆标签顺序、名称、激活标签、展开分区、阅读位置及上报的工作目录。重载或关闭 VS Code 会结束终端进程；恢复时创建新进程，不会重放手动输入的命令。启动配置仍会重新打开，即使上次关闭过对应标签。',
        '目录和命令状态依赖受支持的 shell integration，属于尽力恢复。原目录不存在时回退到工作区或主目录。输入与输出不作为布局记忆保存，也不会持续记录终端输出日志。',
      ] },
      { id: 'export', title: '导出与保存', items: [
        '右键终端标签 → Export… → HTML、PDF、Markdown 或 Plain text。导出的是仍保留的缓冲区，不是无限历史。',
        'HTML 保留颜色，不含脚本或活动链接。在浏览器打印可生成可选中文字的 PDF；启用背景图形以保留颜色。',
        'PDF 将渲染后的颜色、字体和 Unicode 保存为页面图片，因此其中的文字不可选择或搜索。',
        'Markdown 嵌入清理后的 HTML；GitHub 等阅读器可能移除内联颜色。Plain text 不保留格式。',
        '纯文本上限为 1 Mi 个 UTF-16 代码单元，HTML/Markdown 为 8 Mi。PDF 上限为 16 MiB、100 页和一百万个终端单元格。超限会提示错误。',
        '文稿标签使用 Save a copy… 将原始 PDF 或源码复制到指定位置。HTML 副本不会自动打包关联资源。',
      ] },
      { id: 'compatibility', title: '兼容性与排查', paragraphs: [
        '需要 VS Code 1.106+、桌面或远程 Node.js 扩展宿主及可信工作区。不支持纯浏览器或虚拟工作区。使用 SSH、WSL、Dev Containers 时，工具及匹配平台的扩展包需安装到远程宿主。',
        '找不到预览图标时，先打开已保存且受支持的文件，并检查编辑器 … 菜单；工具栏拥挤时操作可能移入该菜单。命令面板始终可调用预览命令。LaTeX 没有预览时，先确认 PDF 已编译。',
        '字符缺失时，请安装包含对应字形的字体，并在终端／编辑器字体设置中选择。未支持的 shell 或自定义参数可能导致自动 shell integration 不可用，从而影响状态圆点、关闭提示及目录记忆。',
        'About 显示实际安装版本、作者、仓库和许可证。本使用说明可离线阅读，语言选择在本机记忆。',
      ] },
    ],
  },
  ja: {
    title: '使い方', summary: 'エディターの隣で使うターミナル、プレビュー、検索のガイド。', contents: '目次',
    sections: [
      { id: 'start', title: 'はじめに', items: [
        'Primary Side Bar（プライマリ サイド バー）で Side Terminals を開くか、コマンドパレットから “Terminal Sidebar: Open Secondary Terminal” を実行します。タイトルの矢印で反対側を開けます。',
        '+ をクリックするとターミナルを作成します。+ の右クリックから “Preview in Sidebar Terminal” を選ぶと文書を開けます。対応するソースエディターのタイトルにもプレビューボタンがあります。',
        'プライマリ側は複数展開できる折りたたみ式、Secondary Side Bar（セカンダリ サイド バー）は横並びタブです。各ターミナルは独立したプロセスを使います。',
        '歯車は起動設定です。親の … メニューには Usage、About、保存したプロファイル、アクティブなターミナルの再起動があります。',
      ] },
      { id: 'tabs', title: 'タブ操作', items: [
        '子タブのボタンは新規作成、検索、閉じるの順です。検索を右クリックすると全タブ検索、閉じるを右クリックすると現在のタブまたはそのサイドバーの全タブを閉じられます。',
        'タブの右クリックには Rename、Change tab marker、検索、再起動／再読み込み、閉じる、Export…／Save a copy… があります。文書のコピー保存は元のファイルをコピーし、ソースは変更しません。',
        '見出しをドラッグして並べ替えます。キーボードではプライマリ側で Alt+Shift+↑/↓、セカンダリ側で Alt+Shift+←/→。タブにフォーカスして F2 で名前変更、Delete または中クリックで閉じます。',
        'セカンダリ側のタブバーの空白をダブルクリックすると新しいターミナルを作成します。折りたたみやサイドバーの非表示ではプロセスは終了しません。',
        '待機中または終了済みのターミナルは直接閉じます。実行中のコマンドがある場合や待機状態を確認できない場合は確認します。実行中の再起動にも確認があります。',
      ] },
      { id: 'find', title: '検索とリンク', paragraphs: [
        'ターミナルやプレビューで macOS は Cmd+F、Windows/Linux は Ctrl+F を押します。前後の一致、大文字と小文字、単語単位、正規表現、件数、ハイライトに対応します。Esc で閉じてフォーカスを戻します。ターミナル出力の置換はありません。',
        '“Find in all open tabs” は両側のタブを検索します。対象は残っているターミナルバッファ、PDF 全ページの文字、描画された Markdown/HTML、整形済みソースです。結果を選ぶと該当タブへ移動します。結果はスナップショットなので、変更後は全タブ検索を開き直してください。',
        '画像だけのスキャン PDF は、他のツールでテキスト層を追加する必要があります。大規模な検索や処理の重い正規表現には、応答性を保つための制限があります。',
        'ターミナルで Cmd+クリック／Ctrl+クリックすると HTTP(S) リンクや `src/app.ts:12:3` などの対応するファイル位置を開きます。相対パスは最後に取得した作業ディレクトリを使います。すべての診断形式を認識するわけではありません。',
      ] },
      { id: 'documents', title: '文書を開いて読む', paragraphs: [
        'エディターのプレビューアイコン、ファイルのコンテキストメニュー、または “Terminal Sidebar: Preview in Sidebar Terminal” を使います。PDF、Markdown、LaTeX、HTML/HTM、CSS、JSON、JSONC に対応します。プレビューは並べ替えやマーカーを共有し、起動プロファイルは作成しません。',
        'テキストプレビューには画面単位のスクロール、拡大／100%／縮小、倍率選択、ソースを開く、再読み込みがあります。Markdown と HTML には見出しの目次もあります。Cmd/Ctrl+ホイールまたは Cmd/Ctrl +/-/0 でズームします。フォーカス時は j/k でスクロール、g/G で先頭／末尾へ移動します。',
        'Vim や Neovim を含め、ソースを保存するとプレビューを更新します。テキストは UTF-8、4 MiB 以下が必要です。ローカル素材は文書と同じディレクトリか、その配下に置きます。閲覧位置は保存されます。',
      ] },
      { id: 'markdown', title: 'Markdown・HTML・整形済みソース', paragraphs: [
        'Markdown は一般的な CommonMark/GFM 構文に対応します。見出し、リスト、表、フェンス付きコード、リンク、ローカル画像、取り消し線、タスクリスト、脚注を使えます。KaTeX 数式は `$…$`、`$$…$$`、`\\(…\\)`、`\\[…\\]`、math コードブロックに対応します。生の HTML は文字として表示します。未対応・大きすぎる数式はソースを残し、すべての独自構文には対応しません。',
        'Change preview font で Markdown の表示フォントを選択します。Default は VS Code、Editor font はエディター設定に従います。ユーザー設定 `terminalSidebar.markdownFontFamily` は Settings Sync が有効なら同期されます。独自フォントは各端末にインストールしてください。',
        'HTML はローカル画像とスタイルシートを使う静的表示です。スクリプト、フォーム、埋め込みフレーム、リモート素材は動作・読み込みしません。CSS・JSON・JSONC は整形して表示し、JSONC のコメントも保持します。無効な構文や時間のかかる整形では原文に戻り、ソース自体は変更しません。',
      ] },
      { id: 'pdf', title: 'PDF と LaTeX', paragraphs: [
        'PDF には目次、前後のページまたは画面単位のスクロール、ズーム、ページ番号、再読み込みがあります。歯車から連続スクロール（既定）、単ページ、見開き、ダーク表示を選択します。ダーク表示は画像も反転するため、元の色を確認するときは無効にしてください。',
        'Cmd/Ctrl+ホイールと Cmd/Ctrl +/-/0 でズーム、h/l でページ移動、j/k でスクロールします。近くのページだけを描画します。ページ・倍率・表示設定はワークスペース単位で記憶します。再ビルド時は自動更新し、出力が不完全な間は前の有効な表示を保持します。',
        '.tex を開くと、ルート文書コメント、LaTeX Workshop の出力先、一般的なフォルダーから既存の PDF を探します。複数あれば選択し、なければ先にコンパイルするか PDF を指定します。本拡張機能はコンパイラーやプロジェクトのビルドスクリプトを実行しません。',
        'PDF 内をダブルクリックすると SyncTeX で LaTeX ソースに戻れます。`-synctex=1` でコンパイルし、対応する `.synctex`／`.synctex.gz` を残して、拡張機能ホストに synctex をインストールしてください。`latex-workshop.synctex.path` で実行ファイルを指定できます。コンパイラーの対応付けにより、近いソース行へ移動する場合があります。',
      ] },
      { id: 'startup', title: '起動設定', paragraphs: [
        '歯車で両側の独立した起動リストを編集します。Name はタブ名、Command は起動時に一度実行するコマンド、Shell は実行ファイルです。空の Command は対話型シェル、空の Shell は既定シェルです。丸い更新ボタンはインストール済みシェルを再検出します。',
        'Save は両側を保存し、Cancel は下書きを破棄します。Return to terminals は下書きと取り消し履歴を残して戻ります。使用中のタブ追加・削除は起動リストを変更せず、起動設定の変更も既存プロセスを停止しません。',
        'ユーザー設定 `terminalSidebar.sidebars` では `args` 配列と `env` の上書きも指定できます。Shell のパスに引数を含めないでください。args の省略は既定値を維持し、`[]` は引数を消します。環境変数の `null` はその変数を削除します。ビジュアルエディターはこれらの項目を保持します。',
        '公開設定キー left/right は表示位置にかかわらずプライマリ／セカンダリを表します。名前変更や並べ替えでもプロファイル ID は保ってください。各側で起動プロファイル 32 個と追加の通常ターミナル 32 個まで作成できます。',
        '起動コマンド、引数、環境変数は Settings Sync で同期される場合があります。認証情報はローカルの資格情報ストアやツール自身のログインで管理してください。ツール、フォント、認証情報は各端末で別途設定が必要です。',
      ], code: startup_example },
      { id: 'memory', title: 'マーカー・状態・記憶', paragraphs: [
        'Change tab marker には bookmark、tag、flag、star、ask と、Others の検索可能な一覧があります。色はテーマのターミナル配色またはタブ前景色です。非アクティブなアイコンは通常の前景色と混合し、タブ名の色は変更しません。',
        '起動プロファイルのマーカーは側と固定 ID によって別のリポジトリにも引き継がれます。文書マーカーは同じファイルに従い、側やワークスペースをまたいで保持します。一時ターミナルはワークスペース内だけです。共有マーカーを削除した状態も保存します。',
        'タブの点はシェルが報告した直近のコマンドの実行中・失敗・完了を表します。完了タブを見ると完了点を消し、バックグラウンドのベル通知も閲覧で消します。下部には直近の結果が残ります。色はテーマに従い、出力停止から完了を推測することはありません。',
        'タブ順、名前、選択、展開状態、閲覧位置、報告された作業ディレクトリをワークスペースごとに記憶します。VS Code の再読み込み・終了でプロセスは終了し、復元時は新しく起動します。手入力したコマンドは再実行しません。前回タブを閉じた起動プロファイルも次回は開きます。',
        'ディレクトリとコマンド状態は対応するシェル統合に依存し、取得できない場合があります。元のディレクトリがなければワークスペースかホームに戻ります。入力・出力はレイアウト記憶に含まず、ターミナル出力を継続的に記録しません。',
      ] },
      { id: 'export', title: '書き出しと保存', items: [
        'ターミナルタブを右クリック → Export… → HTML、PDF、Markdown、Plain text。対象は保持されているバッファで、無制限の履歴ではありません。',
        'HTML は色を保持し、スクリプトや有効なリンクを含みません。ブラウザーから印刷すると選択可能な文字の PDF を作れます。色を残すには背景の印刷を有効にします。',
        'PDF は色・フォント・Unicode をページ画像として保存するため、その文字は選択・検索できません。',
        'Markdown は無害化した HTML を埋め込みます。GitHub などではインラインの色が除去される場合があります。Plain text は書式を取り除きます。',
        'テキスト上限は 1 Mi UTF-16 コード単位、HTML/Markdown は 8 Mi。PDF は 16 MiB、100 ページ、100 万セルまでで、超過時はエラーを表示します。',
        '文書タブの Save a copy… は元の PDF またはソースを指定先へコピーします。HTML にリンクされた素材はまとめて保存されません。',
      ] },
      { id: 'compatibility', title: '動作環境とトラブル対処', paragraphs: [
        'VS Code 1.106 以降、デスクトップまたはリモートの Node.js 拡張機能ホスト、信頼済みワークスペースが必要です。ブラウザーのみ・仮想ワークスペースは非対応です。SSH、WSL、Dev Containers ではツールと対応プラットフォームの拡張機能をリモート側へ入れてください。',
        'プレビューアイコンが見えなければ、保存済みの対応ファイルを開き、エディターの … メニューも確認してください。混雑したツールバーではそちらへ移る場合があります。コマンドパレットからも実行できます。LaTeX では PDF のコンパイル済みを確認してください。',
        '文字が欠ける場合は対応するグリフを持つフォントをインストールし、ターミナル／エディターの設定で選びます。非対応シェルや独自引数は自動シェル統合を無効にする場合があり、状態の点、閉じる確認、ディレクトリ記憶に影響します。',
        'About でインストール済みのバージョン、作者、リポジトリ、ライセンスを確認できます。このガイドはオフラインで使え、言語選択はこの端末に保存します。',
      ] },
    ],
  },
};
