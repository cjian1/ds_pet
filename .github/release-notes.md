> ds_pet 基于 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT）二次创作。
> ds_pet is a remix of [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) (MIT).

## 1.2.0 更新 / What's new

- 新增一键更新：设置 › 关于 里「检查更新」→「一键更新」，下载、校验、安装、重启全自动，设置和聊天记录都保留。
  One-click updates: Settings › About → Check for updates → Update now downloads, verifies, installs and restarts for you. Settings and chat history are kept.
- 有新版本时她会提醒你，菜单栏图标和右键菜单里点「更新到 x.y.z」就能更新；自动检查可以在设置里关掉。
  She'll tell you when a new version is out, and Update to x.y.z in the menu bar or her right-click menu installs it. Automatic checks can be turned off in Settings.
- 从 1.1.1 或更早版本升级：这一次请手动下载安装，之后的版本就能一键更新了。
  Coming from 1.1.1 or earlier? Install this version manually once; after that, updates take one click.

## 下载哪个？ / Which file?

| 你的 Mac / Your Mac | 下载 / Download |
|---|---|
| Apple 芯片 Apple silicon（M1 / M2 / M3 / M4…） | `ds_pet-…-arm64.dmg` |
| Intel 芯片 Intel | `ds_pet-…-x64.dmg` |

不确定？点屏幕左上角  →「关于本机」看「芯片」。Not sure?  → About This Mac → Chip.
需要 macOS 12 或更新版本 / Requires macOS 12 or later.

## 安装 / Install

1. 双击 `.dmg`，把 ds_pet 拖进 Applications。 Open the `.dmg` and drag ds_pet into Applications.
2. **第一次打开被拦住**：系统设置 › 隐私与安全性 → 点「仍要打开」。
   **Blocked on first launch**: System Settings › Privacy & Security → click **Open Anyway**.
   提示「已损坏」/ If it says "damaged":
   `xattr -dr com.apple.quarantine /Applications/ds_pet.app`
3. 在设置里选一家 AI 服务（默认 DeepSeek，也支持 OpenAI、Claude、Gemini、Kimi、智谱、通义、Ollama 等），填上 API Key 就能和她聊天。
   Pick an AI provider in Settings (DeepSeek by default; OpenAI, Claude, Gemini, Kimi, Qwen, Ollama and more are supported) and add an API key to chat with her.
