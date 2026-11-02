<p align="center">
  <img src="docs/icon.png" width="128" alt="ds_pet">
</p>

<h1 align="center">ds_pet</h1>

<p align="center">
  住在桌面上的蓝毛小女仆（macOS / Windows）：能拖、能甩、会碎碎念，还能陪你聊天、帮你看图。<br>
  <b>简体中文</b> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/cjian1/ds_pet/releases/latest"><b>⬇︎ 下载最新版</b></a>
</p>

> [!NOTE]
> **ds_pet 基于 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 二次创作。**
> 桌宠角色、动画、美术、物理与玩法均来自原项目（MIT 协议）；ds_pet 把它做成了独立的桌面应用（macOS 与 Windows），并加入了聊天面板、设置界面和中英双语。感谢原作者！详见 [NOTICE.md](NOTICE.md)。

<p align="center">
  <img src="docs/screenshot-desktop.png" alt="桌面效果：聊天面板与桌宠" width="800">
</p>

## 安装

到 [Releases](https://github.com/cjian1/ds_pet/releases/latest) 下载适合你电脑的安装包：

| 你的电脑 | 下载这个 |
|---|---|
| Mac：Apple 芯片（M1 / M2 / M3 / M4…，2020 年底以后的大多数 Mac） | `ds_pet-<版本>-arm64.dmg` |
| Mac：Intel 芯片 | `ds_pet-<版本>-x64.dmg` |
| Windows 10 / 11（绝大多数电脑） | `ds_pet-<版本>-win-x64-setup.exe` |
| Windows on ARM（骁龙等 ARM 电脑） | `ds_pet-<版本>-win-arm64-setup.exe` |

> 不确定是哪种？Mac：点屏幕左上角  →「关于本机」，看「芯片」那一行（需要 macOS 12 或更新版本）。
> Windows：设置 › 系统 › 系统信息，「系统类型」里写着「基于 ARM」才选 arm64（需要 64 位的 Windows 10 或 11）。
> 不想安装？还有免安装的便携版 `ds_pet-<版本>-win-x64.zip`：解压后双击里面的 `ds_pet.exe`（便携版不能一键更新）。

### macOS

1. **安装** —— 双击下载好的 `.dmg`，把 ds_pet 拖进 Applications（应用程序）文件夹。
2. **第一次打开** —— 去「应用程序」里双击 ds_pet。因为没有付费的苹果开发者签名，macOS 第一次会拦一下，放行一次就好：
   - 提示「无法验证开发者」：点「完成」→ 打开 **系统设置 › 隐私与安全性**，往下翻，点「**仍要打开**」→ 再双击一次。
   - 提示「已损坏，无法打开」：打开「终端」，粘贴下面这行回车，再双击一次：

     ```bash
     xattr -dr com.apple.quarantine /Applications/ds_pet.app
     ```

打开后她会出现在桌面右下角，右上角菜单栏多一个 🐳 小鲸鱼图标。

### Windows

1. **安装** —— 双击下载好的 `…-setup.exe`，一路「下一步」。只装给当前用户（装在 `%LOCALAPPDATA%\Programs\ds_pet`），不需要管理员权限，开始菜单里会有 ds_pet。
2. **第一次打开被拦住** —— 因为没有付费的代码签名证书，Windows 会提示「Windows 已保护你的电脑」：点「**更多信息**」→「**仍要运行**」，之后不会再问。

打开后她会站在任务栏上面、桌面右下角，任务栏右下角多一个小鲸鱼图标（Windows 11 默认把新图标收起来了，点「^」就能看到，也可以把它拖到任务栏上常驻）。

### 想和她聊天？选一家 AI 服务

第一次打开会自动弹出设置窗口：在「AI 对话」里选一家服务商，填上它的 API Key 点「保存」就行（保存前会自动测试，并帮你选好模型）。默认是 [DeepSeek](https://platform.deepseek.com/api_keys)。

| 服务商 | 说明 |
|---|---|
| **DeepSeek**（默认） | 支持看图、思考深度、余额提醒 |
| OpenAI | 支持思考深度 |
| Claude（Anthropic） | 使用 Anthropic 官方接口 |
| Google Gemini | 支持思考深度 |
| 月之暗面 Kimi · 智谱 GLM · 通义千问 · 硅基流动 · OpenRouter | 填 Key 即可 |
| 豆包（火山方舟） | 模型名处填接入点 ID 或模型名 |
| Ollama（本地模型） | 不需要 Key，数据不出电脑 |
| 自定义接口 | 任何 OpenAI 兼容或 Anthropic 兼容的接口（LM Studio、各类中转服务等） |

每家的 Key、接口地址、模型分开保存，切换服务商不会丢掉之前填的。要走代理或中转，改「接口地址」就行。

不填也能玩：拖她、甩她、戳她、点播 100 多段动画都不需要联网。

## 怎么玩

| 操作 | 效果 |
|---|---|
| 按住她拖动 | 拖到屏幕任何地方（多屏也行），松手后会**记住位置** |
| 拖着快速一甩 | 飞出去 → 撞墙反弹 → 落地 Q 弹一下 |
| 单击 | 摸摸头，她会有反应 |
| **右键** | 聊天、说句话、给她看图、查余额、点播动作、调大小、隐藏、设置、退出 |
| 把图片拖到她身上 | 她会告诉你这是什么，再问你想让她做什么 |
| 菜单栏 🐳 图标（Windows：任务栏右下角） | 显示/隐藏、聊天、大小、自动碎碎念、开机启动、设置、退出 |
| **⌃⌥P**（Windows：**Ctrl+Alt+P**） | 在任何应用里一键显示/隐藏她（开会、共享屏幕时好用；可在设置里改） |

点她、拖她不会打断你正在用的应用；她周围的透明区域会把点击直接透给下面的窗口。

**聊天面板** 会贴在她身边：回复一个字一个字冒出来，还会配表情包。Enter 发送、Shift+Enter 换行，可以 ⌘V（Windows：Ctrl+V）直接粘贴截图给她看，Esc 收起。

## 设置

右键她 →「设置…」，或点菜单栏（Windows：任务栏右下角）的小鲸鱼 →「设置…」。改了**立即生效**。

<p align="center"><img src="docs/screenshot-settings.png" alt="设置窗口" width="640"></p>

- **桌宠**：名字、大小、初始位置、自己走动、活跃程度、甩出去的力度、自动碎碎念（频率/配图）、定时报告余额
- **AI 对话**：服务商、API Key、接口地址、模型（可从列表选，也可直接输入）、思考深度、记住几轮对话、清空聊天记录、人设
- **通用**：语言（跟随系统 / 简体中文 / English）、登录时自动打开、程序坞图标、全屏应用上方是否显示（这两项只在 macOS 上有）、显示/隐藏快捷键
- **关于**：版本、检查更新 / 一键更新、自动检查更新

## 常见问题

<details>
<summary><b>她挡住我点东西了怎么办？</b></summary>

只有她身体上能点到，周围透明区域会穿透到下面。实在碍事：右键 →「大小」调小，或按 <b>⌃⌥P</b>（Windows：<b>Ctrl+Alt+P</b>）暂时藏起来，再按一次叫回来。
</details>

<details>
<summary><b>API Key 安全吗？会花很多钱吗？</b></summary>

Key 只保存在你自己电脑上（macOS：<code>~/Library/Application Support/ds_pet/settings.json</code>，仅你的账户可读；Windows：<code>%APPDATA%\ds_pet\settings.json</code>），只会发给你选的那家服务商的接口地址。应用没有任何统计或上报。<br>
自动碎碎念默认每 15 分钟一句，你离开电脑 5 分钟以上就不说了；嫌费额度可以在设置里调低频率或关掉。
</details>

<details>
<summary><b>她会很耗电吗？</b></summary>

她看得见的时候，主要开销是播放动画视频。藏起来（<b>⌃⌥P</b>）或锁屏时，动画、碎碎念和余额查询全部暂停；你离开电脑 5 分钟以上，她把手上的动作做完就歇着、不再播放，碰一下键盘或鼠标就醒。
</details>

<details>
<summary><b>怎么更新到新版本？</b></summary>

设置 › 关于 →「检查更新」→「一键更新」。有新版本时她也会提醒你，菜单栏小鲸鱼和她的右键菜单里会多出「⬆︎ 更新到 x.y.z」，点一下就行。<br>
会从 GitHub 下载适合你电脑芯片的安装包（约 200 MB），校验无误后自动替换并重启，设置和聊天记录都会保留。需要 ds_pet 放在「应用程序」文件夹里、并且你有权限替换它；不满足时设置页会说明原因，到 <a href="https://github.com/cjian1/ds_pet/releases/latest">Releases</a> 手动下载安装即可。<br>
Windows 上用安装版（setup.exe 装的）就能一键更新：下载新的安装程序，退出后在后台静默装好再重新打开；便携版请到 Releases 下载新的 zip。<br>
「自动检查更新」只会访问 GitHub 看有没有新版本，只提醒、不会自己装；不想联网检查可以在设置 › 关于 里关掉。
</details>

<details>
<summary><b>怎么切换成英文？</b></summary>

设置 → 通用 →「语言」。默认跟随系统语言；切换后界面、菜单和她说话都会换成对应语言。
</details>

<details>
<summary><b>她说话太频繁 / 太安静？</b></summary>

设置 → 桌宠 →「碎碎念频率」和「活跃程度」。
</details>

<details>
<summary><b>怎么完全退出？怎么卸载？</b></summary>

退出：右键她 →「退出 ds_pet」，或菜单栏小鲸鱼 →「退出」。<br>
卸载（macOS）：先在设置 → 通用里关掉「登录时自动打开」，退出后把「应用程序」里的 ds_pet 移到废纸篓。想连数据一起删，再删除 <code>~/Library/Application Support/ds_pet</code>。<br>
卸载（Windows）：在「设置 › 应用 › 已安装的应用」里找到 ds_pet 卸载，卸载时会问要不要连设置和聊天记录一起删；便携版退出后直接删掉文件夹，数据在 <code>%APPDATA%\ds_pet</code>。
</details>

<details>
<summary><b>能换成别的动画吗？</b></summary>

把同名的 <code>.webm</code> 放进 <code>~/Library/Application Support/ds_pet/animations/</code>（Windows：<code>%APPDATA%\ds_pet\animations\</code>），会优先用你的版本（文件名见 <code>desktop/assets/webm/</code>）。
</details>

<details>
<summary><b>Windows 版和 Mac 版有什么不一样？</b></summary>

功能一样：聊天、看图、碎碎念、一键更新都有。几处按 Windows 的习惯来：小鲸鱼图标在任务栏右下角；快捷键是 <b>Ctrl+Alt+P</b>；她始终在最上层（没有「全屏应用上方也显示」「程序坞图标」这两个设置）。<br>
另外，右键她弹出的菜单按 Esc 关不掉，点别处就关：她从不抢你正在用的窗口的焦点，键盘也就还在你原来的应用里。需要 64 位的 Windows 10 或 11。
</details>

<details>
<summary><b>装过 DSH 的 dsh-pet 插件？</b></summary>

第一次打开时会自动导入那边的 DeepSeek API Key、桌宠设置和聊天记录，不用重新填。
</details>

## 从源码运行

需要 [Node.js](https://nodejs.org/) 20 或更新版本。

```bash
git clone https://github.com/cjian1/ds_pet.git
cd ds_pet
npm install
npm start
```

第一次 `npm start` 会自动下载 Electron（约 100 MB）。

打包成安装包：

```bash
npm run dist          # 本机架构 → dist/ds_pet-<版本>-<arch>.dmg
npm run dist:all      # Apple 芯片 + Intel 两个都打
npm run install-app   # 打包并直接装进「应用程序」
```

打包只用到 macOS 自带的工具（`ditto` / `codesign` / `hdiutil`），不需要苹果开发者账号。

打包 Windows 版（在 macOS、Linux、Windows 上都能打）：

```bash
npm run dist:win      # x64 + ARM → dist/ds_pet-<版本>-win-<arch>-setup.exe 和便携版 .zip
```

安装程序用 [NSIS](https://nsis.sourceforge.io/) 生成（macOS：`brew install makensis`；Windows：`choco install nsis`），没装就只打便携版；exe 的图标和版本信息用 [resedit](https://github.com/jet2jet/resedit-js) 写入，不需要 Wine。

测试：

```bash
npm run check             # 语法检查
npm test                  # 单元测试（设置规整、各家 AI 接口的请求与流式解析、本地服务、点击穿透判定、中英文案与素材）
npm run test:real-input   # 用真实的系统鼠标把桌宠交互走一遍（点击、穿透、拖拽、右键、拖图、甩出去）
npm run test:real-input:win   # Windows 版的同一套（另外盯着点她、拖她会不会抢走别的窗口的焦点、Ctrl+Alt+P、--quit）
npm run test:update       # 一键更新端到端：打包后在临时目录里走一遍「旧版本 → 下载 → 替换 → 重启成新版本」
```

`npm test` 不需要启动 Electron，推送版本 tag 时 GitHub Actions 会先跑它再打包。`test:real-input` 会接管鼠标半分钟左右，
需要先在「系统设置 › 隐私与安全性 › 辅助功能」里给运行它的终端开权限；它在临时数据目录里启动开发版，不会动你的设置和聊天记录。

<details>
<summary>项目结构</summary>

```
desktop/                 应用本体（打包时原样放进 .app；Windows 版放进 resources\app）
  main/                  主进程：菜单栏、窗口、快捷键、登录项、AI 调用（providers.js 是服务商目录）、数据存储
  pet/                   桌宠页面：动画、拖拽甩抛物理、气泡（来自 dsh-pet）
  chat/                  聊天面板
  settings/              设置窗口
  i18n/                  中英文案
  assets/                106 段动画、表情包、字体、默认配置（来自 dsh-pet）
  resources/             应用图标、菜单栏图标（.icns / 模板图）、Windows 图标（.ico）
scripts/
  build-mac.sh           macOS 打包脚本（--dmg / --arch arm64|x64 / --install）
  build-win.mjs          Windows 打包脚本（--arch x64|arm64|all；安装程序 + 便携版）
  win-installer.nsi      Windows 安装程序（NSIS）；win-readme.txt 是便携版附带的说明
  make-icons.js          重新生成图标（npm run icons）
  dmg-readme.txt         安装镜像里附带的说明
  debug/                 开发调试小工具（读页面状态、截图、真实鼠标测试 real-input.mjs + mouse.swift，Windows 版 win-real-input.mjs + mouse.ps1）
test/                    单元测试（node --test，不需要 Electron）
.github/workflows/       推送版本 tag 后先跑测试，再自动打包并发布到 Releases
```

`npm run dev` 会带上调试端口启动：主进程 9334、页面 9333。新增界面文字请同时写进 `desktop/i18n/i18n.js` 的中英两栏。
</details>

### 发布新版本

1. 改 `desktop/package.json` 里的 `version`（比如 `1.0.1`）；
2. 把 `.github/release-notes.md` 最上面「更新 / What's new」那一段改成这一版的内容（中英各一行；设置页的一键更新会显示这一段）；
3. 提交后打 tag 并推送：`git tag v1.0.1 && git push origin main v1.0.1`；
4. GitHub Actions 会先在 macOS 和 Windows 上各跑一遍测试，再打包 Mac（Apple 芯片 / Intel）和 Windows（x64 / ARM）版，一起发布到 Releases。已安装的用户会在设置 › 关于 或菜单里看到「一键更新」。

## 致谢与许可

- **原项目**：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT）。桌宠角色、动画、美术、物理与玩法均来自原项目，角色与美术素材版权归原作者所有；原许可证全文见 [`desktop/LICENSE.dsh-pet`](desktop/LICENSE.dsh-pet)，详细出处见 [NOTICE.md](NOTICE.md)。
- **本项目**代码以 [MIT](LICENSE) 协议开源。
- 对话由你选择的 AI 服务商提供（默认 [DeepSeek](https://platform.deepseek.com/)）。本项目是个人作品，与各服务商官方无关。
