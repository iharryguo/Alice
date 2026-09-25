<template>
  <div>
    <div class="mb-3">
      <h2 class="text-2xl font-semibold mb-2">Choose Voice & Memory Mode</h2>
      <p class="text-base-content/70">
        Pick a first-run default for speech, audio, and memory embeddings. You
        can tune individual providers, voices, and local model choices later in
        Settings.
      </p>
    </div>

    <!-- Local vs Cloud Toggle -->
    <div class="bg-base-300/50 p-3 rounded-lg mb-3">
      <div class="form-control">
        <label class="label w-full cursor-pointer">
          <div class="flex-1 pr-4">
            <span class="label-text font-medium text-lg">Use Local Models</span>
            <div class="text-sm text-base-content/60 mt-1">
              Use the bundled local backend for voice and memory features.
            </div>
          </div>
          <input
            type="checkbox"
            class="toggle toggle-primary toggle-lg flex-shrink-0"
            :checked="formData.useLocalModels"
            @change="
              $emit('toggle-local', ($event.target as HTMLInputElement).checked)
            "
          />
        </label>
      </div>
    </div>

    <div v-if="formData.useLocalModels">
      <!-- Local Models Information -->
      <div class="space-y-3">
        <div class="alert alert-success text-sm py-3">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            class="stroke-current shrink-0 w-5 h-5"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div>
            <p class="font-medium">Local mode sets these defaults:</p>
            <ul class="list-disc list-inside mt-1 space-y-0.5">
              <li>Speech-to-text runs through the local backend</li>
              <li>Text-to-speech uses local Piper voices</li>
              <li>Embeddings are stored with the local MiniLM model</li>
              <li>Voice downloads happen on first use</li>
              <li>Voice and model details stay editable in Settings</li>
            </ul>
          </div>
        </div>

        <div class="bg-base-200 p-3 rounded-lg space-y-2">
          <h3 class="font-medium text-base-content/90">Local defaults:</h3>

          <div class="grid grid-cols-1 gap-2 text-sm">
            <div
              class="flex justify-between items-center p-2 bg-base-100 rounded"
            >
              <span class="flex items-center">
                <svg
                  class="w-4 h-4 mr-2 text-primary"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a5 5 0 1110 0v6a3 3 0 01-3 3z"
                  />
                </svg>
                Speech-to-Text
              </span>
              <span class="text-base-content/60"
                >Local Whisper (Go Backend)</span
              >
            </div>

            <div
              class="flex justify-between items-center p-2 bg-base-100 rounded"
            >
              <span class="flex items-center">
                <svg
                  class="w-4 h-4 mr-2 text-primary"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 14.142M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
                  />
                </svg>
                Text-to-Speech
              </span>
              <div class="text-right">
                <div class="text-base-content/90 font-medium">
                  Local Piper TTS (Go Backend)
                </div>
                <div class="text-xs text-base-content/60">
                  30+ voices, 20+ languages
                </div>
              </div>
            </div>

            <div
              class="flex justify-between items-center p-2 bg-base-100 rounded"
            >
              <span class="flex items-center">
                <svg
                  class="w-4 h-4 mr-2 text-primary"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
                  />
                </svg>
                Embeddings
              </span>
              <span class="text-base-content/60"
                >Local MiniLM (Go Backend)</span
              >
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else>
      <!-- Cloud Models Configuration -->
      <div class="space-y-4">
        <!-- STT -->
        <div class="bg-base-200/60 p-4 rounded-lg space-y-3">
          <h3 class="font-medium text-base-content/90">① 语音转文字 (STT)</h3>
          <div class="form-control">
            <label class="label">
              <span class="label-text">提供商</span>
            </label>
            <select
              v-model="formData.sttProvider"
              class="select select-bordered w-full focus:select-primary focus:outline-none"
            >
              <option value="openai">OpenAI</option>
              <option value="groq">Groq</option>
              <option value="google">Google</option>
              <option value="doubao">豆包 Doubao (火山方舟)</option>
              <option value="qwen">通义 Qwen (阿里百炼)</option>
              <option value="local">本地 (Go 后端 Whisper)</option>
            </select>
          </div>

          <div v-if="formData.sttProvider === 'openai'" class="form-control">
            <label class="label">
              <span class="label-text">API Key</span>
            </label>
            <input
              type="password"
              v-model="formData.VITE_OPENAI_API_KEY"
              placeholder="sk-..."
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">模型 ID</span>
            </label>
            <input
              type="text"
              v-model="formData.openaiSttModel"
              placeholder="gpt-4o-transcribe"
              class="input input-bordered w-full focus:input-primary"
            />
          </div>

          <div v-else-if="formData.sttProvider === 'groq'" class="form-control">
            <label class="label">
              <span class="label-text">API Key</span>
            </label>
            <input
              type="password"
              v-model="formData.VITE_GROQ_API_KEY"
              placeholder="gsk_..."
              class="input input-bordered w-full focus:input-primary"
            />
            <p class="text-xs text-base-content/60 mt-1">
              使用内置模型 whisper-large-v3。
            </p>
          </div>

          <div
            v-else-if="formData.sttProvider === 'google'"
            class="form-control"
          >
            <label class="label">
              <span class="label-text">API Key</span>
            </label>
            <input
              type="password"
              v-model="formData.VITE_GOOGLE_API_KEY"
              placeholder="AIza..."
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">Language</span>
            </label>
            <select
              v-model="formData.localSttLanguage"
              class="select select-bordered w-full focus:select-primary"
            >
              <option value="auto">Auto-detect</option>
              <option value="en">English</option>
              <option value="zh">Chinese</option>
              <option value="ja">Japanese</option>
              <option value="ko">Korean</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
            </select>
          </div>

          <div
            v-else-if="formData.sttProvider === 'doubao'"
            class="form-control"
          >
            <label class="label">
              <span class="label-text">API Key</span>
            </label>
            <input
              type="password"
              v-model="formData.VITE_DOUBAO_API_KEY"
              placeholder="火山方舟 API Key"
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">模型 ID</span>
            </label>
            <input
              type="text"
              v-model="formData.doubaoSttModel"
              placeholder="例如 ep-2024xxxxxx 或模型名称"
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">请求地址 (Base URL)</span>
            </label>
            <input
              type="text"
              v-model="formData.doubaoBaseUrl"
              placeholder="https://ark.cn-beijing.volces.com/api/v3"
              class="input input-bordered w-full focus:input-primary"
            />
          </div>

          <div
            v-else-if="formData.sttProvider === 'qwen'"
            class="form-control"
          >
            <label class="label">
              <span class="label-text">API Key</span>
            </label>
            <input
              type="password"
              v-model="formData.VITE_QWEN_API_KEY"
              placeholder="sk-..."
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">模型 ID</span>
            </label>
            <input
              type="text"
              v-model="formData.qwenSttModel"
              placeholder="qwen3-asr-flash"
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">请求地址 (Base URL)</span>
            </label>
            <input
              type="text"
              v-model="formData.qwenBaseUrl"
              placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
              class="input input-bordered w-full focus:input-primary"
            />
          </div>

          <p v-else class="text-xs text-base-content/60">
            使用本地 Go 后端的 Whisper 模型，模型规格可在 Settings 中选择。
          </p>
        </div>

        <!-- TTS -->
        <div class="bg-base-200/60 p-4 rounded-lg space-y-3">
          <h3 class="font-medium text-base-content/90">② 文字转语音 (TTS)</h3>
          <div class="form-control">
            <label class="label">
              <span class="label-text">提供商</span>
            </label>
            <select
              v-model="formData.ttsProvider"
              class="select select-bordered w-full focus:select-primary focus:outline-none"
            >
              <option value="openai">OpenAI</option>
              <option value="google">Google</option>
              <option value="doubao">豆包 Doubao (火山方舟)</option>
              <option value="qwen">通义 Qwen (阿里百炼)</option>
              <option value="local">本地 (Piper)</option>
            </select>
          </div>

          <div v-if="formData.ttsProvider === 'openai'" class="form-control">
            <label class="label">
              <span class="label-text">API Key</span>
            </label>
            <input
              type="password"
              v-model="formData.VITE_OPENAI_API_KEY"
              placeholder="sk-..."
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">模型 ID</span>
            </label>
            <input
              type="text"
              v-model="formData.openaiTtsModel"
              placeholder="gpt-4o-mini-tts"
              class="input input-bordered w-full focus:input-primary"
            />
          </div>

          <div
            v-else-if="formData.ttsProvider === 'google'"
            class="form-control"
          >
            <label class="label">
              <span class="label-text">API Key</span>
            </label>
            <input
              type="password"
              v-model="formData.VITE_GOOGLE_API_KEY"
              placeholder="AIza..."
              class="input input-bordered w-full focus:input-primary"
            />
            <p class="text-xs text-base-content/60 mt-1">
              音色可在 Settings 中选择。
            </p>
          </div>

          <div
            v-else-if="formData.ttsProvider === 'doubao'"
            class="form-control"
          >
            <label class="label">
              <span class="label-text">API Key</span>
            </label>
            <input
              type="password"
              v-model="formData.VITE_DOUBAO_API_KEY"
              placeholder="火山方舟 API Key"
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">模型 ID</span>
            </label>
            <input
              type="text"
              v-model="formData.doubaoTtsModel"
              placeholder="例如 ep-2024xxxxxx 或模型名称"
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">请求地址 (Base URL)</span>
            </label>
            <input
              type="text"
              v-model="formData.doubaoBaseUrl"
              placeholder="https://ark.cn-beijing.volces.com/api/v3"
              class="input input-bordered w-full focus:input-primary"
            />
          </div>

          <div
            v-else-if="formData.ttsProvider === 'qwen'"
            class="form-control"
          >
            <label class="label">
              <span class="label-text">API Key</span>
            </label>
            <input
              type="password"
              v-model="formData.VITE_QWEN_API_KEY"
              placeholder="sk-..."
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">模型 ID</span>
            </label>
            <input
              type="text"
              v-model="formData.qwenTtsModel"
              placeholder="qwen-tts-latest"
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">请求地址 (Base URL)</span>
            </label>
            <input
              type="text"
              v-model="formData.qwenBaseUrl"
              placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
              class="input input-bordered w-full focus:input-primary"
            />
            <p class="text-xs text-base-content/60 mt-1">
              Qwen-Audio-TTS / CosyVoice 系列模型需填写工作空间专属地址，例如
              https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1
            </p>
          </div>

          <p v-else class="text-xs text-base-content/60">
            使用本地 Piper 语音，音色可在 Settings 中选择。
          </p>
        </div>

        <!-- Embedding -->
        <div class="bg-base-200/60 p-4 rounded-lg space-y-3">
          <h3 class="font-medium text-base-content/90">
            ③ Embedding (记忆向量化)
          </h3>
          <div class="form-control">
            <label class="label">
              <span class="label-text">提供商</span>
            </label>
            <select
              v-model="formData.embeddingProvider"
              class="select select-bordered w-full focus:select-primary focus:outline-none"
            >
              <option value="openai">OpenAI</option>
              <option value="doubao">豆包 Doubao (火山方舟)</option>
              <option value="qwen">通义 Qwen (阿里百炼)</option>
              <option value="local">本地 (Go 后端 E5)</option>
            </select>
          </div>

          <div
            v-if="formData.embeddingProvider === 'openai'"
            class="form-control"
          >
            <label class="label">
              <span class="label-text">API Key</span>
            </label>
            <input
              type="password"
              v-model="formData.VITE_OPENAI_API_KEY"
              placeholder="sk-..."
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">模型 ID</span>
            </label>
            <input
              type="text"
              v-model="formData.openaiEmbeddingModel"
              placeholder="text-embedding-ada-002"
              class="input input-bordered w-full focus:input-primary"
            />
          </div>

          <div
            v-else-if="formData.embeddingProvider === 'doubao'"
            class="form-control"
          >
            <label class="label">
              <span class="label-text">API Key</span>
            </label>
            <input
              type="password"
              v-model="formData.VITE_DOUBAO_API_KEY"
              placeholder="火山方舟 API Key"
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">模型 ID</span>
            </label>
            <input
              type="text"
              v-model="formData.doubaoEmbeddingModel"
              placeholder="doubao-embedding-vision-251215"
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">请求地址 (Base URL)</span>
            </label>
            <input
              type="text"
              v-model="formData.doubaoBaseUrl"
              placeholder="https://ark.cn-beijing.volces.com/api/v3"
              class="input input-bordered w-full focus:input-primary"
            />
            <p class="text-xs text-base-content/60 mt-1">
              使用模型原生维度（doubao-embedding-large 为 4096 维），主进程会自动建立对应维度的向量索引。
            </p>
          </div>

          <div
            v-else-if="formData.embeddingProvider === 'qwen'"
            class="form-control"
          >
            <label class="label">
              <span class="label-text">API Key</span>
            </label>
            <input
              type="password"
              v-model="formData.VITE_QWEN_API_KEY"
              placeholder="sk-..."
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">模型 ID</span>
            </label>
            <input
              type="text"
              v-model="formData.qwenEmbeddingModel"
              placeholder="text-embedding-v4"
              class="input input-bordered w-full focus:input-primary"
            />
            <label class="label mt-2">
              <span class="label-text">请求地址 (Base URL)</span>
            </label>
            <input
              type="text"
              v-model="formData.qwenBaseUrl"
              placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
              class="input input-bordered w-full focus:input-primary"
            />
          </div>

          <p v-else class="text-xs text-base-content/60">
            使用本地 Go 后端的 multilingual-e5-small 模型，无需任何 Key。
          </p>
        </div>

        <div class="bg-base-200 p-4 rounded-lg space-y-2">
          <h3 class="font-medium text-base-content/90">
            Current Configuration:
          </h3>
          <div class="text-sm space-y-1">
            <div class="flex justify-between">
              <span class="text-base-content/60">Speech-to-Text:</span>
              <span class="capitalize">{{ formData.sttProvider }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-base-content/60">Text-to-Speech:</span>
              <span>{{ providerLabel(formData.ttsProvider) }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-base-content/60">Embeddings:</span>
              <span>{{ providerLabel(formData.embeddingProvider) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  formData: any
}>()

defineEmits<{
  'toggle-local': [useLocal: boolean]
}>()

const providerLabel = (provider: string) => {
  const labels: Record<string, string> = {
    google: 'Google',
    local: 'Local',
    openai: 'OpenAI',
    doubao: 'Doubao (火山方舟)',
    qwen: 'Qwen (阿里百炼)',
  }

  return labels[provider] || provider
}
</script>
