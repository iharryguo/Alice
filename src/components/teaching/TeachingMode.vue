<template>
  <div v-if="store.visible" class="teaching-root">
    <header class="tm-head">
      <div class="tm-head-left">
        <button class="tm-back" @click="handleBack">←</button>
        <div>
          <div class="tm-title">英语课堂</div>
          <div class="tm-sub">{{ headSub }}</div>
        </div>
      </div>
      <div class="tm-head-right">
        <span v-if="store.isInClass" class="tm-live">上课中</span>
        <button class="tm-ghost" @click="store.close()">收起</button>
      </div>
    </header>

    <!-- 课程库 -->
    <section v-if="store.step === 'library'" class="tm-body library">
      <div class="tm-actions">
        <button class="tm-primary" :disabled="store.busy" @click="store.importMaterial()">
          {{ store.busy ? '正在处理…' : '导入教案 / 教材' }}
        </button>
        <span class="tm-hint">支持 PDF、DOCX、PPTX 与图片；转成 PDF 后按页锚点同步</span>
      </div>

      <div v-if="store.resumableSessions.length" class="tm-resume">
        <div>
          <strong>上次的课还没上完</strong>
          <div class="tm-hint">
            从最后讲到的地方接着上；已经讲完的句子不会重复，只从没讲完的那句开头重讲。
          </div>
        </div>
        <button
          class="tm-primary small"
          :disabled="store.busy"
          @click="store.resumeSession(store.resumableSessions[0])"
        >
          继续上课
        </button>
      </div>

      <p v-if="store.compileError" class="tm-error">{{ store.compileError }}</p>

      <div v-if="store.materials.length === 0" class="tm-empty">
        还没有材料。导入一份教案，Alice 会先给出课程大纲让你确认，再开始上课。
      </div>

      <ul v-else class="tm-list">
        <li v-for="material in store.materials" :key="material.id" class="tm-card">
          <div class="tm-card-main">
            <div class="tm-card-title">{{ material.title }}</div>
            <div class="tm-card-meta">
              <span class="tm-tag">{{ formatSource(material.sourceType) }}</span>
              <span>{{ material.pageCount }} 页</span>
              <span :class="['tm-status', material.status.toLowerCase()]">
                {{ formatStatus(material.status) }}
              </span>
            </div>
            <p v-if="material.errorMessage" class="tm-error small">
              {{ material.errorMessage }}
            </p>
            <p
              v-else-if="material.quality?.reasons?.length"
              class="tm-reasons"
            >
              {{ material.quality.reasons.join('；') }}
            </p>
          </div>
          <div class="tm-card-actions">
            <button
              class="tm-primary small"
              :disabled="store.compiling || material.status === 'IMPORT_FAILED'"
              @click="store.compile(material)"
            >
              备课
            </button>
          </div>
        </li>
      </ul>

      <div v-if="store.compiling" class="tm-overlay-note">
        <span class="spinner"></span>
        {{ store.compileStage || '正在编译课程…' }}
      </div>
    </section>

    <!-- 备课确认 -->
    <section v-else-if="store.step === 'prep'" class="tm-body prep">
      <div class="tm-prep-grid">
        <div class="tm-panel">
          <h3 class="tm-panel-title">课程大纲</h3>
          <div class="tm-course-title">{{ store.course?.title }}</div>
          <div class="tm-objectives">
            <div v-for="(objective, index) in store.course?.objectives || []" :key="index">
              · {{ objective }}
            </div>
          </div>

          <table class="tm-table">
            <thead>
              <tr>
                <th>#</th>
                <th>节点目标</th>
                <th>时长</th>
                <th>必学</th>
                <th>锚点</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(node, nodeIdx) in store.outline?.nodes || []" :key="node.objective">
                <td>{{ nodeIdx + 1 }}</td>
                <td>{{ node.objective }}</td>
                <td>{{ node.minutes }} 分钟</td>
                <td>{{ node.required ? '必学' : '可选' }}</td>
                <td>{{ node.pages.length ? `第 ${node.pages.join('、')} 页` : '无（仅板书）' }}</td>
              </tr>
            </tbody>
          </table>

          <p
            v-if="store.anchorCoverage.totalNodes > 0"
            :class="[
              'tm-coverage',
              store.anchorCoverage.nodesWithAnchors === 0 ? 'warn' : '',
            ]"
          >
            锚点覆盖：{{ store.anchorCoverage.nodesWithAnchors }} /
            {{ store.anchorCoverage.totalNodes }} 个节点能精确定位到原文
            <span v-if="store.anchorCoverage.nodesWithAnchors === 0">
              （材料没有文字层，本课只能按页码展示，不能逐句高亮）
            </span>
          </p>

          <p class="tm-usage">
            本次备课：{{ store.compileUsage.calls }} 次模型调用，
            输入约 {{ Math.round(store.compileUsage.inputChars / 1000) }}k 字符
          </p>
        </div>

        <div class="tm-panel">
          <h3 class="tm-panel-title">课堂契约</h3>
          <p class="tm-hint">
            契约只影响这一节课的教学方式，不改动课程内容；以后改严格度会生成新契约版本。
          </p>

          <label class="tm-field">
            <span>课时长度</span>
            <select v-model.number="duration">
              <option :value="15">15 分钟</option>
              <option :value="25">25 分钟</option>
              <option :value="45">45 分钟</option>
            </select>
          </label>

          <label class="tm-field">
            <span>节奏策略</span>
            <select v-model="pacePolicy">
              <option value="balanced">平衡（默认）</option>
              <option value="time-first">时间优先</option>
              <option value="mastery-first">掌握优先</option>
            </select>
          </label>

          <label class="tm-field">
            <span>语言策略</span>
            <select v-model="languagePolicy">
              <option value="english-with-chinese-rescue">英语为主，中文救场</option>
              <option value="immersion">全英文</option>
              <option value="chinese-led">中文讲解为主</option>
            </select>
          </label>

          <label class="tm-field">
            <span>严格度</span>
            <select v-model="strictness">
              <option value="gentle">温和</option>
              <option value="standard">标准</option>
              <option value="firm">坚定</option>
            </select>
          </label>

          <label class="tm-field">
            <span>展示模式</span>
            <select v-model="presentationMode">
              <option value="DOCUMENT_SYNC">文档同步</option>
              <option value="BOARD_ONLY">纯讲解（无原文同步）</option>
            </select>
          </label>

          <div class="tm-actions-row">
            <button class="tm-ghost" @click="store.step = 'library'">返回</button>
            <button class="tm-primary" :disabled="store.busy" @click="handleStart">
              {{ store.busy ? '正在开课…' : '确认并开始上课' }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 课堂 -->
    <section v-else-if="store.step === 'classroom'" class="tm-body classroom">
      <div class="tm-doc">
        <PdfPageView
          :bytes="store.materialBytes"
          :is-pdf="store.isPdf"
          :page-index="store.currentPage"
          :scale="1.15"
          :highlights="store.currentHighlights"
        />
      </div>

      <aside class="tm-class-panel">
        <div class="tm-status-row">
          <span class="tm-phase">{{ phaseLabel }}</span>
          <span class="tm-node">
            节点 {{ (store.view?.nodeIndex ?? 0) + 1 }} / {{ store.view?.totalNodes ?? 0 }}
          </span>
          <button
            v-if="store.view?.presentationState === 'FREE_BROWSE'"
            class="tm-link"
            @click="store.followLesson()"
          >
            回到授课位置
          </button>
        </div>

        <div v-if="store.ttsDegraded" class="tm-tts-warn">
          语音合成没有成功，这一节只有字幕。可以在设置里换一个 TTS 供应商，或检查网络后重开一课。
        </div>

        <div class="tm-objective">{{ store.view?.nodeObjective }}</div>

        <div class="tm-sentence">
          {{ store.view?.sentenceText || '…' }}
        </div>

        <div class="tm-pager">
          <button class="tm-ghost" :disabled="store.currentPage <= 1" @click="turnPage(-1)">‹ 上一页</button>
          <span>第 {{ store.currentPage }} 页</span>
          <button class="tm-ghost" @click="turnPage(1)">下一页 ›</button>
        </div>

        <div class="tm-debt">
          <span>计划 {{ Math.round((store.view?.plannedElapsedSec ?? 0) / 60) }} 分钟</span>
          <span>实际 {{ Math.round((store.view?.actualElapsedSec ?? 0) / 60) }} 分钟</span>
          <span v-if="(store.view?.timeDebtSec ?? 0) > 60" class="over">
            超时 {{ Math.round((store.view?.timeDebtSec ?? 0) / 60) }} 分钟
          </span>
        </div>

        <div class="tm-transcript" ref="transcriptRef">
          <div
            v-for="(item, index) in store.view?.transcript || []"
            :key="index"
            :class="['tm-line', item.role]"
          >
            <span class="tm-role">{{ item.role === 'teacher' ? 'Alice' : item.role === 'student' ? '你' : '系统' }}</span>
            <span>{{ item.text }}</span>
          </div>
        </div>

        <div v-if="store.view?.parkedTopics?.length" class="tm-parked">
          停车场：{{ parkedSummary }}
        </div>

        <div class="tm-input">
          <input
            v-model="utterance"
            placeholder="插话、提问，或说「跳过」「再说一遍」"
            @keydown.enter.prevent="send"
          />
          <button class="tm-primary small" :disabled="store.busy" @click="send">发言</button>
        </div>

        <div class="tm-controls">
          <button class="tm-ghost" @click="store.pause()">暂停</button>
          <button class="tm-ghost" @click="store.resume()">继续</button>
          <button class="tm-ghost" @click="store.repeat()">重复</button>
          <button class="tm-ghost" @click="store.skip()">跳过</button>
          <button class="tm-danger" @click="store.endLesson()">下课</button>
        </div>
      </aside>
    </section>

    <!-- 课后报告 -->
    <section v-else class="tm-body report">
      <div class="tm-report-grid">
        <div class="tm-panel">
          <h3 class="tm-panel-title">这一节课</h3>
          <div class="tm-stats">
            <div>
              <strong>{{ store.report?.nodesCompleted ?? 0 }}</strong>
              <span>完成节点</span>
            </div>
            <div>
              <strong>{{ store.report?.totalNodes ?? 0 }}</strong>
              <span>计划节点</span>
            </div>
            <div>
              <strong>{{ store.report?.actualMinutes ?? 0 }}</strong>
              <span>实际分钟</span>
            </div>
            <div>
              <strong>{{ Math.max(0, Math.round((store.report?.timeDebtSec ?? 0) / 60)) }}</strong>
              <span>超时分钟</span>
            </div>
          </div>
          <p class="tm-hint">
            「完成节点」只表示内容讲完，不代表已经掌握；掌握度看下面对应的练习结果。
          </p>
        </div>

        <div class="tm-panel">
          <h3 class="tm-panel-title">需要处理</h3>
          <p v-if="!store.report?.skippedObjectives?.length && !store.report?.parkedTopics?.length" class="tm-hint">
            没有跳过的内容，也没有课后话题。
          </p>
          <div v-if="store.report?.skippedObjectives?.length">
            <div class="tm-sub-title">跳过的目标（记为未掌握）</div>
            <div v-for="item in store.report?.skippedObjectives" :key="item" class="tm-line">
              · {{ item }}
            </div>
          </div>
          <div v-if="store.reportAttempts.length" class="tm-sub-title">作答与评分依据</div>
          <div v-for="attempt in store.reportAttempts" :key="attempt.attemptId" class="tm-attempt">
            <div class="tm-attempt-input">{{ attempt.studentInput || '（未作答）' }}</div>
            <div class="tm-attempt-score">
              {{ scoreLabel(attempt.score?.status) }} · {{ attempt.feedback || '无评语' }}
            </div>
          </div>

          <div v-if="store.report?.parkedTopics?.length" class="tm-sub-title">课后话题</div>
          <div v-for="item in store.report?.parkedTopics || []" :key="item.at" class="tm-line">
            · {{ item.text }}
          </div>
        </div>
      </div>

      <div class="tm-actions-row">
        <button class="tm-ghost" @click="store.step = 'library'">回到课程库</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import PdfPageView from './PdfPageView.vue'
import { useTeachingStore } from '../../stores/teachingStore'

const store = useTeachingStore()
const utterance = ref('')
const transcriptRef = ref<HTMLDivElement | null>(null)

const duration = computed({
  get: () => store.contract?.targetDurationMin ?? 25,
  set: value => {
    store.contract = {
      ...(store.contract as any),
      targetDurationMin: value,
    } as any
  },
})

const pacePolicy = computed({
  get: () => store.contract?.pacePolicy ?? 'balanced',
  set: value => {
    store.contract = { ...(store.contract as any), pacePolicy: value } as any
  },
})

const languagePolicy = computed({
  get: () => store.contract?.languagePolicy ?? 'english-with-chinese-rescue',
  set: value => {
    store.contract = { ...(store.contract as any), languagePolicy: value } as any
  },
})

const strictness = computed({
  get: () => store.contract?.strictness ?? 'standard',
  set: value => {
    store.contract = { ...(store.contract as any), strictness: value } as any
  },
})

const presentationMode = computed({
  get: () => store.contract?.presentationMode ?? 'DOCUMENT_SYNC',
  set: value => {
    store.contract = { ...(store.contract as any), presentationMode: value } as any
  }
})

const headSub = computed(() => {
  switch (store.step) {
    case 'library':
      return '选材与备课'
    case 'prep':
      return '确认大纲与课堂契约'
    case 'classroom':
      return store.course?.title ?? '上课中'
    default:
      return '课后报告'
  }
})

const phaseLabel = computed(() => {
  const map: Record<string, string> = {
    OPENING: '开场',
    REVIEW: '复习',
    NARRATING: '讲解',
    CHECKING: '答疑',
    PRACTICING: '练习',
    SUMMARIZING: '总结',
    COMPLETED: '已下课',
  }
  return map[store.view?.phase ?? 'OPENING'] ?? '上课'
})

const parkedSummary = computed(() =>
  (store.view?.parkedTopics ?? []).map(topic => topic.text).join(' / ')
)

function formatSource(source: string): string {
  return (
    { pdf: 'PDF', docx: 'Word', pptx: 'PPT', image: '图片' }[source] ??
    source
  )
}

function formatStatus(status: string): string {
  return (
    {
      READY: '可用',
      NEEDS_REVIEW: '需确认',
      PARSING: '解析中',
      IMPORT_FAILED: '导入失败',
      DRAFT: '草稿',
    }[status] ?? status
  )
}

function handleBack(): void {
  if (store.step === 'prep') {
    store.step = 'library'
    return
  }
  if (store.step === 'classroom') {
    store.close()
    return
  }
  store.step = 'library'
}

async function handleStart(): Promise<void> {
  await store.startLesson()
  await nextTick()
}

function turnPage(delta: number): void {
  const next = Math.max(1, store.currentPage + delta)
  store.setViewport(next)
}

function scoreLabel(status?: string): string {
  return (
    { passed: '通过', 'needs-review': '需复习', skipped: '跳过', pending: '待评估' }[
      status ?? ''
    ] ?? '未评估'
  )
}

async function send(): Promise<void> {
  const text = utterance.value.trim()
  if (!text) return
  utterance.value = ''
  await store.handleUtterance(text)
}

watch(
  () => store.view?.transcript?.length,
  async () => {
    await nextTick()
    if (transcriptRef.value) {
      transcriptRef.value.scrollTop = transcriptRef.value.scrollHeight
    }
  }
)
</script>

<style scoped>
.teaching-root {
  position: absolute;
  inset: 32px 0 0 0;
  background: #f7f7f8;
  color: #111827;
  display: flex;
  flex-direction: column;
  z-index: 40;
  font-size: 13px;
}
.tm-head {
  height: 52px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
}
.tm-head-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tm-back {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
  background: #fff;
  cursor: pointer;
}
.tm-title {
  font-size: 14px;
  font-weight: 600;
}
.tm-sub {
  font-size: 11px;
  color: #6b7280;
}
.tm-head-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.tm-live {
  font-size: 11px;
  color: #047857;
  background: #ecfdf5;
  border-radius: 999px;
  padding: 2px 8px;
}
.tm-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}
.tm-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.tm-hint {
  color: #6b7280;
  font-size: 12px;
}
.tm-primary {
  background: #111827;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 8px 14px;
  cursor: pointer;
}
.tm-primary.small {
  padding: 5px 10px;
  font-size: 12px;
}
.tm-primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.tm-ghost,
.tm-danger,
.tm-link {
  border: 1px solid #e5e7eb;
  background: #fff;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
}
.tm-danger {
  color: #b91c1c;
  border-color: #fecaca;
}
.tm-link {
  border: none;
  color: #2563eb;
  background: transparent;
  padding: 0;
}
.tm-resume {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.tm-empty {
  border: 1px dashed #d1d5db;
  border-radius: 12px;
  padding: 32px;
  text-align: center;
  color: #6b7280;
}
.tm-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tm-card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 12px 14px;
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.tm-card-title {
  font-weight: 600;
  margin-bottom: 4px;
}
.tm-card-meta {
  display: flex;
  gap: 10px;
  color: #6b7280;
  font-size: 12px;
  align-items: center;
}
.tm-tag {
  background: #eef2ff;
  color: #3730a3;
  border-radius: 6px;
  padding: 1px 6px;
}
.tm-status.ready {
  color: #047857;
}
.tm-status.needs_review {
  color: #b45309;
}
.tm-status.import_failed {
  color: #b91c1c;
}
.tm-reasons {
  color: #b45309;
  font-size: 12px;
  margin: 6px 0 0;
}
.tm-error {
  color: #b91c1c;
  font-size: 12px;
}
.tm-error.small {
  margin: 6px 0 0;
}
.tm-overlay-note {
  position: fixed;
  right: 24px;
  bottom: 24px;
  background: #111827;
  color: #fff;
  border-radius: 10px;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.spinner {
  width: 10px;
  height: 10px;
  border: 2px solid rgb(255 255 255 / 35%);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.tm-prep-grid,
.tm-report-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(280px, 1fr);
  gap: 16px;
}
.tm-panel {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 16px;
}
.tm-panel-title {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 10px;
}
.tm-course-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 8px;
}
.tm-objectives {
  color: #374151;
  line-height: 1.7;
  margin-bottom: 12px;
}
.tm-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.tm-table th,
.tm-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid #f3f4f6;
  vertical-align: top;
}
.tm-table th {
  color: #6b7280;
  font-weight: 500;
}
.tm-coverage {
  margin-top: 10px;
  font-size: 12px;
  color: #374151;
}
.tm-coverage.warn {
  color: #b45309;
}
.tm-usage {
  font-size: 11px;
  color: #9ca3af;
  margin-top: 8px;
}
.tm-field {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin: 10px 0;
  font-size: 12px;
}
.tm-field select,
.tm-input input {
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 6px 8px;
  background: #fff;
  font-size: 12px;
}
.tm-actions-row {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
.classroom {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 16px;
  padding: 16px;
}
.tm-doc {
  overflow: auto;
  display: flex;
  justify-content: center;
  align-items: flex-start;
}
.tm-class-panel {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.tm-status-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: #6b7280;
}
.tm-phase {
  background: #111827;
  color: #fff;
  border-radius: 999px;
  padding: 2px 8px;
}
.tm-tts-warn {
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 11px;
  margin-top: 8px;
  line-height: 1.5;
}
.tm-objective {
  margin: 10px 0 6px;
  font-weight: 600;
}
.tm-sentence {
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.6;
  min-height: 44px;
}
.tm-pager {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #6b7280;
  margin-top: 8px;
}
.tm-attempt {
  border-top: 1px solid #f3f4f6;
  padding: 6px 0;
  font-size: 12px;
}
.tm-attempt-input {
  color: #111827;
}
.tm-attempt-score {
  color: #6b7280;
  font-size: 11px;
  margin-top: 2px;
}
.tm-debt {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: #6b7280;
  margin: 10px 0;
}
.tm-debt .over {
  color: #b45309;
}
.tm-transcript {
  flex: 1;
  min-height: 120px;
  overflow: auto;
  border-top: 1px solid #f3f4f6;
  padding-top: 8px;
  font-size: 12px;
  line-height: 1.7;
}
.tm-line {
  display: flex;
  gap: 6px;
  margin-bottom: 4px;
}
.tm-line.student {
  color: #1d4ed8;
}
.tm-line.system {
  color: #6b7280;
}
.tm-role {
  flex: 0 0 38px;
  color: #9ca3af;
}
.tm-parked {
  font-size: 11px;
  color: #92400e;
  background: #fffbeb;
  border-radius: 6px;
  padding: 4px 6px;
  margin-top: 6px;
}
.tm-input {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.tm-input input {
  flex: 1;
}
.tm-controls {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.tm-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 10px;
}
.tm-stats div {
  background: #f9fafb;
  border-radius: 10px;
  padding: 10px;
  text-align: center;
}
.tm-stats strong {
  display: block;
  font-size: 20px;
}
.tm-stats span {
  font-size: 11px;
  color: #6b7280;
}
.tm-sub-title {
  font-size: 12px;
  font-weight: 600;
  margin: 10px 0 4px;
}
</style>
