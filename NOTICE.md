# NOTICE / 出处声明

**ds_pet** is a derivative work (remix) of **[dsh-pet](https://github.com/PC2005-cloud/dsh-pet)** by
[PC2005-cloud](https://github.com/PC2005-cloud), released under the MIT License.

**ds_pet** 基于 **[dsh-pet](https://github.com/PC2005-cloud/dsh-pet)**（作者 [PC2005-cloud](https://github.com/PC2005-cloud)，MIT 协议）二次创作。

## 来自原项目 / From the original project

- 桌宠角色、全部动画（`desktop/assets/webm/`）、表情包（`desktop/assets/memes/`）、光标与提示图（`desktop/assets/pic/`）、默认配置与人设（`desktop/assets/config.jsonc`）
- 桌宠页面的核心逻辑：动画调度、拖拽与甩抛物理、点击穿透判定、气泡渲染（`desktop/pet/`，含 `shared-core.js`）
- The pet character, all animations, stickers, cursors and default config/persona
- Core pet logic: animation scheduling, drag & fling physics, click-through hit testing, speech bubbles (`desktop/pet/`, including `shared-core.js`)

Artwork and character copyright belong to the original authors. / 角色与美术素材版权归原作者所有。

## ds_pet 新增 / Added in ds_pet

- 独立的 macOS 应用外壳：菜单栏图标、原生右键菜单、开机自启、全局快捷键、位置记忆（`desktop/main/`）
- 聊天面板、设置窗口、中英双语界面（`desktop/chat/`、`desktop/settings/`、`desktop/i18n/`）
- 支持多家 AI 服务（DeepSeek、OpenAI、Claude、Gemini、Kimi、智谱、通义、Ollama 及任意 OpenAI / Anthropic 兼容接口）的流式对话、看图、碎碎念与余额查询（`desktop/main/llm.js`、`desktop/main/providers.js`）
- 打包与发布脚本（`scripts/`、`.github/workflows/`）
- A standalone macOS app shell, chat panel, settings window, bilingual UI, streaming chat with multiple AI providers (OpenAI- and Anthropic-compatible), and build/release tooling.

The original license text is kept in [`desktop/LICENSE.dsh-pet`](desktop/LICENSE.dsh-pet).
原项目许可证全文保留在 [`desktop/LICENSE.dsh-pet`](desktop/LICENSE.dsh-pet)。

ds_pet is not affiliated with DeepSeek. / ds_pet 与 DeepSeek 官方无关。
