> ds_pet 基于 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT）二次创作。
> ds_pet is a remix of [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) (MIT).

## 1.2.1 更新 / What's new

- 更省电：你离开电脑 5 分钟，她把手上的动作做完就歇着，不再播放动画，碰一下键盘或鼠标就醒；藏起来或锁屏时一切暂停。
  Uses less power: after you've been away for 5 minutes she finishes what she's doing and rests without playing anything; touch the keyboard or mouse and she wakes up. Everything pauses while she's hidden or the screen is locked.
- 改名字、走动、活跃度、甩出去的力度等设置立即生效，她不会再从头闪一下。
  Changing her name, roaming, liveliness, throw strength and similar settings now applies instantly without reloading her.
- 聊天回复更快出现；回复到一半点「停止」会保留已经说出的部分，不再提示失败。
  Chat replies start showing sooner; pressing Stop halfway keeps what she already said instead of reporting an error.
- 修正：她藏着时在聊天里回话，叫回来后会定格不动；藏着启动后从菜单栏点「说句话」没反应；窗口被系统改了大小后不复位。
  Fixed: she could freeze after replying in chat while hidden; "Say something" from the menu bar did nothing if she started hidden; her window didn't recover after the system resized it.
- 从 1.1.1 或更早版本升级：请手动下载安装一次，之后就能一键更新了。
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
