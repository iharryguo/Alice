<template>
  <div class="pdf-stage" ref="stageRef">
    <canvas v-show="isPdf" ref="canvasRef" class="pdf-canvas"></canvas>
    <img
      v-if="!isPdf && imageUrl"
      :src="imageUrl"
      class="pdf-canvas"
      alt="教学材料"
    />
    <div class="highlight-layer">
      <div
        v-for="(box, index) in highlights"
        :key="index"
        class="highlight-box"
        :style="{
          left: `${box.x * 100}%`,
          top: `${box.y * 100}%`,
          width: `${box.width * 100}%`,
          height: `${box.height * 100}%`,
        }"
      ></div>
    </div>
    <div v-if="loading" class="stage-hint">正在载入页面…</div>
    <div v-else-if="error" class="stage-hint error">{{ error }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerSrc

const props = defineProps<{
  bytes: Uint8Array | null
  isPdf: boolean
  pageIndex: number
  scale: number
  highlights: Array<{ x: number; y: number; width: number; height: number }>
}>()

const stageRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const loading = ref(false)
const error = ref('')
const imageUrl = ref('')

let documentProxy: PDFDocumentProxy | null = null
let loadedBytes: Uint8Array | null = null
let renderTask: { cancel: () => void } | null = null

const isPdf = computed(() => props.isPdf)

async function ensureDocument(): Promise<PDFDocumentProxy | null> {
  if (!props.bytes) return null
  if (documentProxy && loadedBytes === props.bytes) return documentProxy

  documentProxy?.destroy()
  documentProxy = null
  loadedBytes = props.bytes

  const task = getDocument({ data: props.bytes.slice() })
  documentProxy = await task.promise
  return documentProxy
}

async function renderPage(): Promise<void> {
  if (!props.isPdf) {
    if (props.bytes && !imageUrl.value) {
      const blob = new Blob([props.bytes.slice()], {
        type: guessMime(props.bytes),
      })
      imageUrl.value = URL.createObjectURL(blob)
    }
    return
  }

  loading.value = true
  error.value = ''

  try {
    const pdf = await ensureDocument()
    const canvas = canvasRef.value
    if (!pdf || !canvas) return

    const page = await pdf.getPage(Math.max(1, props.pageIndex))
    const viewport = page.getViewport({ scale: props.scale })

    renderTask?.cancel()
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建画布')

    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.floor(viewport.width * ratio)
    canvas.height = Math.floor(viewport.height * ratio)
    canvas.style.width = `${viewport.width}px`
    canvas.style.height = `${viewport.height}px`

    const task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    } as any)
    renderTask = task as unknown as { cancel: () => void }
    await task.promise
  } catch (err) {
    if ((err as Error)?.name !== 'RenderingCancelledException') {
      error.value = `这一页渲染失败：${(err as Error).message}`
    }
  } finally {
    loading.value = false
  }
}

function guessMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  return 'image/webp'
}

watch(
  () => [props.bytes, props.pageIndex, props.scale],
  () => {
    void renderPage()
  },
  { immediate: true }
)

onUnmounted(() => {
  renderTask?.cancel()
  documentProxy?.destroy()
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
})
</script>

<style scoped>
.pdf-stage {
  position: relative;
  display: inline-block;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 8px 30px rgb(0 0 0 / 12%);
  overflow: hidden;
  max-width: 100%;
}
.pdf-canvas {
  display: block;
  max-width: 100%;
  height: auto;
}
.highlight-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.highlight-box {
  position: absolute;
  border-radius: 3px;
  background: rgb(250 204 21 / 28%);
  box-shadow: 0 0 0 1px rgb(250 204 21 / 55%);
  transition: all 120ms ease-out;
}
.stage-hint {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  font-size: 12px;
  color: #6b7280;
  background: rgb(255 255 255 / 85%);
  padding: 4px 10px;
  border-radius: 999px;
}
.stage-hint.error {
  color: #b91c1c;
}
</style>
