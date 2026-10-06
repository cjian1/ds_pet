'use strict';
/**
 * AI 服务商目录。
 *
 * 绝大多数服务商都提供「OpenAI 兼容」接口（POST {baseUrl}/chat/completions，Bearer 鉴权，SSE 流式），
 * 只是地址和模型名不同；Claude 用的是 Anthropic 自己的 Messages 接口。所以这里只有两种接口格式：
 *   type: 'openai'     OpenAI 兼容（DeepSeek / OpenAI / Gemini / Kimi / 智谱 / 通义 / 硅基流动 / 豆包 / OpenRouter / Ollama …）
 *   type: 'anthropic'  Anthropic Messages（Claude，以及提供 Anthropic 兼容接口的服务）
 *
 * 其余字段：
 *   baseUrl   默认接口地址（用户可以改，比如走代理）
 *   model     默认模型（拉到模型列表后可以换）
 *   keyUrl    「去哪里创建 API Key」的页面
 *   effort    支持的思考深度参数（把界面上的 快速/均衡/深思 映射成服务商的取值）；没有 = 不发这个参数
 *   balance   能查余额（目前只有 DeepSeek 有公开接口）
 *   modalities 模型列表里带 input_modalities（能据此判断能不能看图）
 *   keyCheck  校验 Key 用的接口（模型列表不校验 Key 的服务商才需要）
 *   noKey     不需要 API Key（本地模型）
 *   custom    用户自己填地址、选接口格式
 */
const PROVIDERS = {
  deepseek: {
    type: 'openai',
    name: ['DeepSeek', 'DeepSeek'],
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    effort: { low: 'low', high: 'high', max: 'max' },
    balance: true,
    modalities: true,
  },
  openai: {
    type: 'openai',
    name: ['OpenAI', 'OpenAI'],
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    effort: { low: 'low', high: 'medium', max: 'high' },
  },
  anthropic: {
    type: 'anthropic',
    name: ['Claude（Anthropic）', 'Claude (Anthropic)'],
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-haiku-4-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  gemini: {
    type: 'openai',
    name: ['Google Gemini', 'Google Gemini'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    effort: { low: 'low', high: 'medium', max: 'high' },
  },
  moonshot: {
    type: 'openai',
    name: ['月之暗面 Kimi', 'Moonshot Kimi'],
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-latest',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  zhipu: {
    type: 'openai',
    name: ['智谱 GLM', 'Zhipu GLM'],
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/',
  },
  qwen: {
    type: 'openai',
    name: ['通义千问（阿里云百炼）', 'Qwen (Alibaba Cloud)'],
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/',
  },
  siliconflow: {
    type: 'openai',
    name: ['硅基流动 SiliconFlow', 'SiliconFlow'],
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  doubao: {
    type: 'openai',
    name: ['豆包（火山方舟）', 'Doubao (Volcengine Ark)'],
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '',
    keyUrl: 'https://console.volcengine.com/ark',
  },
  openrouter: {
    type: 'openai',
    name: ['OpenRouter', 'OpenRouter'],
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    keyUrl: 'https://openrouter.ai/keys',
    // 模型列表是公开的（不校验 Key），测试 Key 要专门调这个
    keyCheck: '/key',
  },
  ollama: {
    type: 'openai',
    name: ['Ollama（本地模型）', 'Ollama (local models)'],
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    keyUrl: 'https://ollama.com/download',
    noKey: true,
  },
  custom: {
    type: 'openai',
    name: ['自定义接口', 'Custom endpoint'],
    baseUrl: '',
    model: '',
    custom: true,
  },
};

const PROVIDER_IDS = Object.keys(PROVIDERS);
const API_TYPES = ['openai', 'anthropic'];

function info(id) {
  return PROVIDERS[id] || PROVIDERS.deepseek;
}

function displayName(id, lang) {
  return info(id).name[lang === 'en' ? 1 : 0];
}

/** 规整一个地址：去掉末尾的 /；不是 http(s) 就当没填 */
function cleanBaseUrl(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s]+$/i.test(u) ? u : '';
}

module.exports = { PROVIDERS, PROVIDER_IDS, API_TYPES, info, displayName, cleanBaseUrl };
