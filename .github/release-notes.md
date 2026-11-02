> ds_pet 基于 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT）二次创作。
> ds_pet is a remix of [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) (MIT).

## 1.3.0 更新 / What's new

- 新增 Windows 版（Windows 10 / 11，x64 和 ARM 电脑都有）：安装版能一键更新，也有免安装的便携版。
  New: ds_pet for Windows (Windows 10 / 11, for both x64 and ARM PCs). The installer version updates in one click, and there's a portable zip too.
- 在 Windows 上点她、拖她、右键她，都不会抢走你正在用的窗口的焦点；她站在任务栏上面，Ctrl+Alt+P 随时藏起来。
  On Windows, clicking, dragging or right-clicking her never steals focus from the window you're using; she stands on the taskbar, and Ctrl+Alt+P hides her anytime.
- 一键更新更稳：下载中途出错（比如磁盘满了）不会再卡住，没下完的文件会清理干净。
  Sturdier updates: a download that fails halfway (say, on a full disk) no longer gets stuck, and the partial file is cleaned up.

## 下载哪个？ / Which file?

| 你的电脑 / Your computer | 下载 / Download |
|---|---|
| Mac：Apple 芯片 Apple silicon（M1 / M2 / M3 / M4…） | `ds_pet-…-arm64.dmg` |
| Mac：Intel 芯片 Intel | `ds_pet-…-x64.dmg` |
| Windows（绝大多数电脑 / most PCs） | `ds_pet-…-win-x64-setup.exe`（安装版 installer） |
| Windows ARM（骁龙等 / Snapdragon etc.） | `ds_pet-…-win-arm64-setup.exe` |
| Windows 免安装 / portable | `ds_pet-…-win-x64.zip`、`ds_pet-…-win-arm64.zip` |

Mac 不确定？点屏幕左上角  →「关于本机」看「芯片」。Not sure?  → About This Mac → Chip. 需要 macOS 12 或更新版本 / Requires macOS 12 or later.
Windows 不确定？设置 › 系统 › 系统信息 →「系统类型」写着「基于 ARM」才选 arm64。On Windows, pick arm64 only if Settings › System › About says "ARM-based processor". 需要 64 位 Windows 10 或 11 / Requires 64-bit Windows 10 or 11.

## 安装 / Install

**macOS**

1. 双击 `.dmg`，把 ds_pet 拖进 Applications。 Open the `.dmg` and drag ds_pet into Applications.
2. **第一次打开被拦住**：系统设置 › 隐私与安全性 → 点「仍要打开」。
   **Blocked on first launch**: System Settings › Privacy & Security → click **Open Anyway**.
   提示「已损坏」/ If it says "damaged":
   `xattr -dr com.apple.quarantine /Applications/ds_pet.app`

**Windows**

1. 双击 `…-setup.exe` 安装（只装给你自己，不需要管理员权限）。 Run the `…-setup.exe` (it installs just for you, no admin rights needed).
2. **提示「Windows 已保护你的电脑」**：点「更多信息」→「仍要运行」（没有付费的代码签名证书，第一次会这样）。
   **"Windows protected your PC"**: click **More info** → **Run anyway** (the app has no paid code-signing certificate).
3. 她会出现在桌面右下角，任务栏右下角多一个小鲸鱼图标（找不到就点「^」）。 She appears in the bottom-right corner, with a little whale in the taskbar corner (click ^ if it's tucked away).

**然后 / Then**：在设置里选一家 AI 服务（默认 DeepSeek，也支持 OpenAI、Claude、Gemini、Kimi、智谱、通义、Ollama 等），填上 API Key 就能和她聊天。
Pick an AI provider in Settings (DeepSeek by default; OpenAI, Claude, Gemini, Kimi, Qwen, Ollama and more are supported) and add an API key to chat with her.
