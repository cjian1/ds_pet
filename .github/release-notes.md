> ds_pet 基于 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT）二次创作。
> ds_pet is a remix of [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) (MIT).

## 1.1.1 更新 / What's new

- 点她、拖她、右键她之后，焦点会自动还给你原来在用的应用，正在打字的窗口不会再丢光标。
  Clicking, dragging or right-clicking her no longer steals focus from the app you were using.
- 她身边的透明区域不再挡住下面应用的点击，只有点在她身上才算点她。
  The transparent area around her no longer blocks clicks to the apps underneath; only her body is clickable.
- 设置文件被写坏时不再启动失败；修正旧版设置迁移的一个问题。
  A damaged settings file no longer stops the app from starting; fixed an issue when migrating old settings.

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
