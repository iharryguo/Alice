import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import eventBus from '../utils/eventBus'
import { useGeneralStore } from './generalStore'
import { useConversationStore } from './conversationStore'
import * as teachingService from '../services/teachingService'
import {
  compileCourse,
  type CourseOutline,
} from '../modules/teaching/courseCompiler'
import {
  LessonRuntime,
  type LessonViewState,
} from '../modules/teaching/lessonRuntime'
import {
  classifyIntent,
  evaluateAnswer,
} from '../modules/teaching/teacherBrain'
import {
  transcribeBlankPages,
  transcribePageImage,
} from '../modules/teaching/pageVision'
import {
  answerInClass,
  composeNarration,
  confirmAction,
  controlPhrase,
  scaffoldAnswer,
} from '../modules/teaching/teacherVoice'
import { logLesson } from '../modules/teaching/lessonLog'
import type {
  ClassContract,
  ClassSession,
  ContentAnchor,
  CourseVersionRecord,
  DocumentPage,
  MaterialRecord,
} from '../../electron/main/teaching/types'

/**
 * 教师模式的界面状态。
 *
 * 课堂运行时本身是纯 TS（modules/teaching/lessonRuntime），这个 store 只做三件事：
 * 把运行时接到真实的语音、持久化、模型调用上；保存界面需要的响应式状态；
 * 承接从 Main.vue 转过来的学生语音。
 */

export type TeachingStep = 'library' | 'prep' | 'classroom' | 'report'

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function guessMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  return 'image/webp'
}

export const useTeachingStore = defineStore('teaching', () => {
  const visible = ref(false)
  const step = ref<TeachingStep>('library')
  const materials = ref<MaterialRecord[]>([])
  const selectedMaterial = ref<MaterialRecord | null>(null)
  const pages = ref<DocumentPage[]>([])
  const anchors = ref<ContentAnchor[]>([])
  const materialBytes = ref<Uint8Array | null>(null)
  const isPdf = ref(true)
  const compiling = ref(false)
  const compileStage = ref('')
  const compileError = ref('')
  const course = ref<CourseVersionRecord | null>(null)
  const outline = ref<CourseOutline | null>(null)
  const anchorCoverage = ref({ nodesWithAnchors: 0, totalNodes: 0 })
  const compileUsage = ref({ calls: 0, inputChars: 0 })
  const contract = ref<ClassContract | null>(null)
  const sessionId = ref<string | null>(null)
  const view = ref<LessonViewState | null>(null)
  const currentPage = ref(1)
  const currentHighlights = ref<
    Array<{ x: number; y: number; width: number; height: number }>
  >([])
  const report = ref<ReturnType<LessonRuntime['report']> | null>(null)
  const resumableSessions = ref<ClassSession[]>([])
  /** TTS 连续失败时置位：界面据此提示"只有字幕"，而不是让人对着没声音的课猜 */
  const ttsDegraded = ref(false)
  /** 老师此刻是否在收音：课堂界面要明确显示"在听你说" */
  const listeningState = ref(false)
  /** 已保存的课程版本：重启后不必重新备课 */
  const preparedCourses = ref<CourseVersionRecord[]>([])
  const reportAttempts = ref<
    Array<{
      attemptId: string
      exerciseId: string
      studentInput: string
      score: { status?: string; feedback?: string } | null
      feedback: string | null
    }>
  >([])
  const busy = ref(false)

  let runtime: LessonRuntime | null = null
  let speechStartUnsubscribe: (() => void) | null = null

  /**
   * 是否在课堂里。
   * 原来的 computed 依赖非响应式的 runtime 变量，runtime 建好时不会触发重算，
   * 结果学生一开口被判定"不在上课"，整句话掉进普通聊天——这就是上课上到一半
   * 突然开始聊天的原因。改成显式 ref，进课时置位、下课时清除。
   */
  const inLesson = ref(false)
  /** 最近一次识别到的学生原话：界面上必须立刻可见，不能被静默吞掉 */
  const heardText = ref('')
  const anchorById = computed(() => {
    const map = new Map<string, ContentAnchor>()
    for (const anchor of anchors.value) map.set(anchor.anchorId, anchor)
    return map
  })
  const anchorPageById = computed(() => {
    const map = new Map<string, number>()
    for (const anchor of anchors.value) map.set(anchor.anchorId, anchor.pageIndex)
    return map
  })

  function reset(): void {
    visible.value = false
    step.value = 'library'
    selectedMaterial.value = null
    pages.value = []
    anchors.value = []
    materialBytes.value = null
    compiling.value = false
    compileStage.value = ''
    compileError.value = ''
    course.value = null
    outline.value = null
    contract.value = null
    sessionId.value = null
    view.value = null
    report.value = null
    runtime = null
    speechStartUnsubscribe?.()
    speechStartUnsubscribe = null
  }

  function open(): void {
    visible.value = true
    logLesson('panel.open', { step: step.value })
    void refreshMaterials()
    void refreshResumable()
    void refreshPrepared()
  }

  async function refreshPrepared(): Promise<void> {
    preparedCourses.value = await teachingService.listCourseVersions()
  }

  /**
   * 打开已保存的备课结果：课程版本与契约都从库里读，不再调模型。
   * 这是"备课只做一次"的入口。
   */
  async function openPrepared(courseVersionId: string): Promise<void> {
    busy.value = true
    try {
      const version = await teachingService.getCourseVersion(courseVersionId)
      if (!version) {
        compileError.value = '这个课程版本已经不存在了'
        return
      }
      course.value = version
      anchorCoverage.value = {
        nodesWithAnchors: version.nodes.filter(node => node.anchorIds.length > 0)
          .length,
        totalNodes: version.nodes.length,
      }
      const saved = await teachingService.getLatestContract(courseVersionId)
      if (saved) contract.value = saved
      outline.value = {
        title: version.title,
        objectives: version.objectives,
        prerequisites: version.prerequisites,
        nodes: version.nodes.map(node => ({
          objective: node.objective,
          required: node.required,
          minutes: Math.round(node.plannedDurationSec / 60),
          pages: node.anchorIds
            .map(id => anchorPageById.value.get(id) ?? 0)
            .filter(page => page > 0),
        })),
      }

      const material = await teachingService.getMaterial(version.materialId)
      if (material) await selectMaterial(material)

      step.value = 'prep'
    } finally {
      busy.value = false
    }
  }

  async function refreshResumable(): Promise<void> {
    resumableSessions.value = await teachingService.listResumableSessions()
  }

  /**
   * 接着上次的课上。
   * 依据最后一条已提交的教学步骤定位：同节点同句，已提交就从下一句开始，
   * 没提交就从句首重讲——这也是崩溃恢复的唯一规则，不做半个词拼接。
   */
  async function resumeSession(session: ClassSession): Promise<void> {
    if (session.status === 'COMPLETED') {
      compileError.value = '这节课已经结束了，不能再继续。'
      await refreshResumable()
      return
    }
    busy.value = true
    try {
      const courseVersion = await teachingService.getCourseVersion(
        session.courseVersionId
      )
      const activeContract = await teachingService.getLatestContract(
        session.courseVersionId
      )
      if (!courseVersion || !activeContract) {
        compileError.value = '这条会话对应的课程版本已不存在，无法继续'
        return
      }

      course.value = courseVersion
      contract.value = activeContract
      sessionId.value = session.sessionId

      const material = await teachingService.getMaterial(courseVersion.materialId)
      if (material) await selectMaterial(material)

      const lastStep = (await teachingService.getLatestStep(
        session.sessionId
      )) as {
        nodeId?: string | null
        sentenceIndex?: number
        sentenceCommitted?: boolean
      } | null

      const nodeIndex = Math.max(
        0,
        courseVersion.nodes.findIndex(node => node.nodeId === lastStep?.nodeId)
      )

      resetStagePosition()

      runtime = buildRuntime(courseVersion, activeContract, {
        nodeIndex,
        segmentIndex: Math.max(0, lastStep?.sentenceIndex ?? 0),
        committed: !!lastStep?.sentenceCommitted,
      })

      step.value = 'classroom'
      speechStartUnsubscribe?.()
      const onSpeechStart = () => {
        runtime?.onUserSpeechStart()
      }
      eventBus.on('cancel-llm-stream', onSpeechStart)
      speechStartUnsubscribe = () => {
        eventBus.off('cancel-llm-stream', onSpeechStart)
      }

      logLesson('material.context', {
        resumed: true,
        materialId: courseVersion.materialId,
        title: selectedMaterial.value?.title ?? courseVersion.title,
        sourcePath: selectedMaterial.value?.sourcePath,
        documentPath: selectedMaterial.value?.documentPath,
        pageCount: pages.value.length,
        courseVersionId: courseVersion.courseVersionId,
        contractVersionId: activeContract.contractVersionId,
      })
      logLesson('lesson.resume', {
        sessionId: session.sessionId,
        nodeIndex,
        segmentIndex: lastStep?.sentenceIndex ?? 0,
        committed: !!lastStep?.sentenceCommitted,
      })

      inLesson.value = true
      startClassroomMic()
      await runtime.continueFromSnapshot()
    } finally {
      busy.value = false
    }
  }

  function close(): void {
    // 关面板不等于下课：还在上课就保持运行时，回来能继续
    visible.value = false
    logLesson('panel.close', { inLesson: inLesson.value, step: step.value })
  }

  async function refreshMaterials(): Promise<void> {
    materials.value = await teachingService.listMaterials()
  }

  async function importMaterial(): Promise<void> {
    busy.value = true
    compileError.value = ''
    try {
      const result = await teachingService.pickAndImportMaterial()
      if (result.cancelled) return
      if (!result.success || !result.material) {
        compileError.value = result.error || '导入失败'
        return
      }
      await refreshMaterials()
      await selectMaterial(result.material)
    } finally {
      busy.value = false
    }
  }

  async function selectMaterial(material: MaterialRecord): Promise<void> {
    selectedMaterial.value = material
    pages.value = await teachingService.getMaterialPages(material.id)
    anchors.value = await teachingService.getMaterialAnchors(material.id)
    materialBytes.value = null
    const blob = await teachingService.getMaterialBlob(material.id)
    if (blob) {
      materialBytes.value = blob.bytes
      isPdf.value = blob.isPdf
    }
  }

  async function compile(target?: MaterialRecord | null): Promise<void> {
    const material = target ?? selectedMaterial.value
    if (!material) return

    compiling.value = true
    compileError.value = ''
    compileStage.value = '正在读取材料'
    try {
      await selectMaterial(material)

      // 没有文字层的页面交给模型读图：先补文字，再走同一条编译管线
      await fillBlankPagesWithVision(material)

      const compiled = await compileCourse({
        material,
        pages: pages.value,
        anchors: anchors.value,
        targetMinutes: 25,
        onProgress: stage => {
          compileStage.value = stage
        },
      })

      course.value = compiled.course
      anchorCoverage.value = compiled.anchorCoverage
      compileUsage.value = compiled.usage
      outline.value = {
        title: compiled.course.title,
        objectives: compiled.course.objectives,
        prerequisites: compiled.course.prerequisites,
        nodes: compiled.course.nodes.map(node => ({
          objective: node.objective,
          required: node.required,
          minutes: Math.round(node.plannedDurationSec / 60),
          pages: node.anchorIds
            .map(id => anchorPageById.value.get(id) ?? 0)
            .filter(page => page > 0),
        })),
      }

      await teachingService.createCourseVersion(compiled.course)
      await refreshPrepared()
      step.value = 'prep'
    } catch (error) {
      compileError.value = (error as Error).message
    } finally {
      compiling.value = false
      compileStage.value = ''
    }
  }

  /**
   * 把图片页读成文字。
   * 只处理没有文字层的页，且一次导入最多读 12 页，避免一节课的备课成本失控。
   */
  async function fillBlankPagesWithVision(
    material: MaterialRecord
  ): Promise<void> {
    const bytes = materialBytes.value
    if (!bytes) return

    const blankPages = pages.value
      .filter(page => page.textSource === 'none' || page.charCount === 0)
      .map(page => page.pageIndex)

    if (blankPages.length === 0) return

    try {
      if (!isPdf.value) {
        compileStage.value = '正在读图 1/1'
        const base64 = toBase64(bytes)
        const text = await transcribePageImage(
          `data:${guessMime(bytes)};base64,${base64}`,
          1
        )
        if (text) {
          await teachingService.updatePageText(material.id, 1, text)
          pages.value = await teachingService.getMaterialPages(material.id)
        }
        return
      }

      compileStage.value = `正在读图 0/${blankPages.length}`
      const results = await transcribeBlankPages({
        bytes,
        blankPages,
        onProgress: (done, total) => {
          compileStage.value = `正在读图 ${done}/${total}`
        },
      })

      for (const item of results) {
        await teachingService.updatePageText(material.id, item.pageIndex, item.text)
      }

      if (results.length > 0) {
        pages.value = await teachingService.getMaterialPages(material.id)
        anchors.value = await teachingService.getMaterialAnchors(material.id)
      }
    } catch (error) {
      console.warn('[Teaching] 读图失败，按纯文本继续:', error)
    }
  }

  function buildContract(
    courseVersionId: string,
    version: number
  ): ClassContract {
    return {
      contractVersionId: `ct-${Date.now()}`,
      courseVersionId,
      version,
      targetDurationMin: contract.value?.targetDurationMin ?? 25,
      pacePolicy: contract.value?.pacePolicy ?? 'balanced',
      presentationMode: contract.value?.presentationMode ?? 'DOCUMENT_SYNC',
      languagePolicy:
        contract.value?.languagePolicy ?? 'english-with-chinese-rescue',
      correctionPolicy: contract.value?.correctionPolicy ?? 'balanced',
      strictness: contract.value?.strictness ?? 'standard',
      wanderThreshold: contract.value?.wanderThreshold ?? {
        windowMinutes: 3,
        strikes: 2,
      },
      createdAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
    }
  }

  let micWasEnabled = false

  /**
   * 进课堂就开麦：这是实时对话，不是聊天框。
   * 关课时恢复用户原来的麦克风设置，不偷偷改他的偏好。
   */
  function startClassroomMic(): void {
    const generalStore = useGeneralStore()
    micWasEnabled = generalStore.isRecordingRequested
    logLesson('mic.open.request', { wasEnabled: micWasEnabled })
    generalStore.isRecordingRequested = true
    if (generalStore.audioState === 'IDLE') {
      generalStore.setAudioState('LISTENING')
    }
  }

  /**
   * 下课后不要悄悄把麦克风关掉。
   * 之前这里恢复成"上课前的设置"，而上课前麦克风通常是关的——于是用户下课回到
   * 聊天窗口一说话，既没反应也没有任何提示，看起来就像坏了。
   * 这个产品说话是主路径，下课后保持开麦，并把音频状态拉回可收音。
   */
  function stopClassroomMic(): void {
    const generalStore = useGeneralStore()
    logLesson('mic.after_lesson', {
      previous: micWasEnabled,
      keepRecording: true,
    })
    generalStore.isRecordingRequested = true
    generalStore.setAudioState('LISTENING')
    listeningState.value = false
  }

  /**
   * 空格打断：不依赖 VAD 的灵敏度，按下就停老师、立刻进入收音。
   * 麦克风没开时不做静默失败，日志里留一条原因。
   */
  let lastBargeinAt = 0

  function interruptByKey(): void {
    const generalStore = useGeneralStore()
    if (!runtime || !inLesson.value) return
    if (!generalStore.isRecordingRequested) {
      logLesson('bargein.blocked', { reason: 'mic-off' })
      return
    }
    // 连按空格只算一次。日志里出现过 3 秒内连按四次，
    // 每按一次都把刚合成好的回复掐掉，听起来就是"一直没声音"。
    const now = Date.now()
    if (now - lastBargeinAt < 1500) return

    const audioState = generalStore.audioState
    // 老师本来就没在出声时，按空格只是准备说话，不该去停一个已经停了的播放
    if (audioState === 'IDLE' || audioState === 'LISTENING') {
      logLesson('bargein.idle', { audioState })
      generalStore.setAudioState('LISTENING')
      return
    }

    lastBargeinAt = now
    logLesson('bargein.key', {
      audioState,
      nodeIndex: view.value?.nodeIndex ?? 0,
    })
    runtime.onUserSpeechStart()
    generalStore.setAudioState('LISTENING')
  }

  async function startLesson(): Promise<void> {
    const activeCourse = course.value
    if (!activeCourse) return

    busy.value = true
    try {
      // 契约独立版本化：改严格度只派生新的 contractVersion，不动课程内容
      const previousContract = await teachingService.getLatestContract(
        activeCourse.courseVersionId
      )
      const activeContract = buildContract(
        activeCourse.courseVersionId,
        (previousContract?.version ?? 0) + 1
      )
      contract.value = activeContract
      await teachingService.saveContract(activeContract)
      await teachingService.confirmCourse(activeCourse.courseVersionId)

      const id = `ls-${Date.now()}`
      sessionId.value = id
      await teachingService.createSession({
        sessionId: id,
        courseVersionId: activeCourse.courseVersionId,
        contractVersionId: activeContract.contractVersionId,
        phase: 'OPENING',
        turnState: 'IDLE',
        presentationState: 'FOLLOW_LESSON',
        currentNodeId: activeCourse.nodes[0]?.nodeId ?? null,
        teacherTurnId: null,
        studentTurnId: null,
        cancelTeacherTurnId: null,
        lessonAnchor: null,
        viewport: { pageIndex: 1 },
        timeDebtSec: 0,
        status: 'IN_SESSION',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })

      // 新的一节课从第一页开始：上一节停在第 9 页，不重置会一直停在那一页
      resetStagePosition()

      runtime = buildRuntime(activeCourse, activeContract)

      step.value = 'classroom'
      speechStartUnsubscribe?.()
      const onSpeechStart = () => {
        runtime?.onUserSpeechStart()
      }
      eventBus.on('cancel-llm-stream', onSpeechStart)
      speechStartUnsubscribe = () => {
        eventBus.off('cancel-llm-stream', onSpeechStart)
      }

      inLesson.value = true
      logLesson('material.context', {
        materialId: activeCourse.materialId,
        title: selectedMaterial.value?.title ?? activeCourse.title,
        sourceType: selectedMaterial.value?.sourceType,
        sourcePath: selectedMaterial.value?.sourcePath,
        documentPath: selectedMaterial.value?.documentPath,
        pageCount: pages.value.length,
        anchors: anchors.value.length,
        courseVersionId: activeCourse.courseVersionId,
        contractVersionId: activeContract.contractVersionId,
      })

      inLesson.value = true
      startClassroomMic()
      await runtime.start()
    } finally {
      busy.value = false
    }
  }

  /** 把运行时接到真实依赖上：语音、持久化、模型判断 */
  function buildRuntime(
    activeCourse: CourseVersionRecord,
    activeContract: ClassContract,
    resume?: { nodeIndex: number; segmentIndex: number; committed: boolean }
  ): LessonRuntime {
    return new LessonRuntime(
      {
        course: activeCourse,
        contract: activeContract,
        speak: speakSentence,
        stopSpeaking: () => {
          const conversationStore = useConversationStore()
          conversationStore.stopSpeaking()
        },
        showAnchor: (anchorIds, _pointIndex, page) => {
          applyHighlight(anchorIds, page)
        },
        setListening: listening => {
          listeningState.value = listening
        },
        composeNarration: node =>
          composeNarration({
            course: activeCourse,
            node,
            contract: activeContract,
            // 只有第一个节点才问好，后续节点用过渡句
            isFirstNode: node.sequence === 1,
          }),
        scaffold: args =>
          scaffoldAnswer({ ...args, contract: activeContract }),
        phrase: key => controlPhrase(activeContract, key),
        poster: patch => {
          if (sessionId.value) {
            void teachingService.updateSession(sessionId.value, patch)
          }
        },
        persistStep: step => {
          void teachingService.appendStep({
            ...step,
            sessionId: sessionId.value ?? '',
          })
        },
        // 每条课堂日志都附上当时讲到的页，出问题时能对齐"说到哪句/看到哪页"
        log: (event, data) =>
          logLesson(event, {
            ...data,
            page: currentPage.value,
            pageTotal: pages.value.length,
          }),
        classify: classifyIntent,
        answer: (text, context) => answerInClass(text, context, activeContract),
        confirm: (kind, context) =>
          confirmAction({ kind, contract: activeContract, context }),
        evaluate: (answer, prompt, rubric) =>
          evaluateAnswer(answer, prompt, rubric, activeContract),
        saveAttempt: attempt => {
          void teachingService.saveAttempt({
            attemptId: `at-${Date.now()}`,
            exerciseId: attempt.exerciseId,
            sessionId: sessionId.value ?? '',
            studentInput: attempt.studentInput,
            audioPath: null,
            score: attempt.score,
            feedback: attempt.score.feedback ?? null,
            createdAt: new Date().toISOString(),
          })
        },
        onState: next => {
          view.value = next
          if (next.finished && inLesson.value) {
            inLesson.value = false
            stopClassroomMic()
            void buildReport()
            // 已完成的课不该再出现在"上次还没上完"里
            void refreshResumable()
          }
        },
            },
      resume
    )
  }

  /**
   * 讲解翻页。
   *
   * 教师只在往前讲，所以页面只允许前进：日志里出现过 3 → 1 的回跳，
   * 那是第二个要点的锚点落在第 1 页导致的，学生看到的就是"讲第三页、屏幕还在第一页"。
   * 手动翻页走 setViewport，不受这里的限制。
   */
  let lessonPageFloor = 0
  let pageFloorNodeIndex = -1

  /** 开课/续课时清掉翻页下限，避免继承上一节的页码 */
  function resetStagePosition(): void {
    lessonPageFloor = 0
    pageFloorNodeIndex = -1
    currentPage.value = 1
    currentHighlights.value = []
  }

  function applyHighlight(anchorIds: string[], pageHint?: number): void {
    const boxes = anchorIds
      .map(id => anchorById.value.get(id))
      .filter((anchor): anchor is ContentAnchor => !!anchor)
      .map(anchor => ({
        x: anchor.x,
        y: anchor.y,
        width: anchor.width,
        height: anchor.height,
      }))
    currentHighlights.value = boxes

    if (view.value && view.value.nodeIndex !== pageFloorNodeIndex) {
      pageFloorNodeIndex = view.value.nodeIndex
      lessonPageFloor = 0
    }

    const anchorPage = anchorIds
      .map(id => anchorPageById.value.get(id))
      .find(pageIndex => typeof pageIndex === 'number')

    // 锚点来自 PDF 解析，页码是硬证据；模型现场生成的 page 只是猜测。
    // 两者取较大值：既纠正"讲第 4 页却显示第 1 页"，也不会因为猜小而倒退。
    const wanted = Math.max(pageHint ?? 0, anchorPage ?? 0)
    if (!wanted || wanted <= 0) return

    const next = Math.max(wanted, lessonPageFloor)
    lessonPageFloor = next
    if (next !== currentPage.value) {
      currentPage.value = next
      logLesson('stage.page', {
        page: next,
        of: pages.value.length,
        wanted,
      })
    }
  }

  /**
   * 逐句朗读。
   *
   * 关键在"什么时候算这句讲完了"：必须真的看到进入 SPEAKING、再看到回到空闲。
   * 之前只判断"当前不是 SPEAKING"，而 TTS 还没出声时状态本来就是 IDLE，
   * 于是每句只等 360ms 就往下走，下一句的 speakText 又会先清空播放队列，
   * 结果每一句都被下一句掐掉——听起来就是响了一下然后彻底没声。
   */
  async function speakSentence(text: string): Promise<void> {
    const conversationStore = useConversationStore()
    const generalStore = useGeneralStore()
    const estimate = Math.min(45000, Math.max(1500, text.length * 90))
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

    // 关掉朗读时不要白发请求，按语速估时推进（纯字幕课堂）
    if (!generalStore.isTTSEnabled) {
      await delay(estimate)
      return
    }

    // 被打断和合成失败要分开处理：
    // 学生一开口就会 abort 正在合成的句子，那不是故障，不能因此把整节课标成"只有字幕"。
    const first = await conversationStore
      .speakText(text)
      .catch(error => ({ ok: false, aborted: false, error: String(error) }))
    if (!first.ok) {
      if (first.aborted) {
        logLesson('tts.aborted', { text })
        return
      }
      // 一次重试：云端 TTS 偶发超时，直接放弃会让整段没声
      const second = await conversationStore
        .speakText(text)
        .catch(error => ({ ok: false, aborted: false, error: String(error) }))
      if (!second.ok) {
        if (second.aborted) {
          logLesson('tts.aborted', { text })
          return
        }
        ttsDegraded.value = true
        logLesson('tts.failed', {
          text,
          estimate,
          error: second.error ?? first.error,
        })
        await delay(estimate)
        return
      }
    }
    ttsDegraded.value = false

    const startedAt = Date.now()
    const deadline = startedAt + estimate + 15000
    let sawSpeaking = false
    let idleTicks = 0

    while (Date.now() < deadline) {
      await delay(100)
      const state = generalStore.audioState

      if (state === 'SPEAKING') {
        sawSpeaking = true
        idleTicks = 0
        continue
      }

      if (!sawSpeaking) {
        // 三秒还没出声，多半是合成失败或服务没返回，别再等
        if (Date.now() - startedAt > 3000) return
        continue
      }

      if (state === 'PROCESSING_AUDIO' || state === 'WAITING_FOR_RESPONSE') {
        idleTicks = 0
        continue
      }

      idleTicks += 1
      if (idleTicks >= 4) return
    }
  }

  async function handleUtterance(text: string): Promise<void> {
    const cleaned = String(text || '').trim()
    if (!cleaned) return
    heardText.value = cleaned
    if (!runtime) return
    busy.value = true
    try {
      await runtime.onUserUtterance(cleaned)
    } finally {
      busy.value = false
    }
  }

  async function pause(): Promise<void> {
    if (!runtime) return
    runtime.pauseByUser()
  }

  async function resume(): Promise<void> {
    if (!runtime) return
    await runtime.resumeLesson()
  }

  async function skip(): Promise<void> {
    await handleUtterance('跳过')
  }

  async function repeat(): Promise<void> {
    await handleUtterance('再说一遍')
  }

  async function endLesson(): Promise<void> {
    if (!runtime) return
    await runtime.endByUser()
    inLesson.value = false
    stopClassroomMic()
  }

  async function buildReport(): Promise<void> {
    if (!runtime) return
    report.value = runtime.report()
    if (sessionId.value) {
      const attempts = (await teachingService.listAttempts(sessionId.value)) as any[]
      reportAttempts.value = attempts.map(item => ({
        attemptId: String(item?.attemptId ?? ''),
        exerciseId: String(item?.exerciseId ?? ''),
        studentInput: String(item?.studentInput ?? ''),
        score: item?.score ?? null,
        feedback: item?.feedback ?? item?.score?.feedback ?? null,
      }))
      const passed = attempts.filter(
        (item: any) => item?.score?.status === 'passed'
      ).length
      if (course.value) {
        for (const node of course.value.nodes) {
          await teachingService.upsertMastery({
            objectiveId: node.nodeId,
            courseId: course.value.courseId,
            level: passed > 0 ? 'learning' : 'unknown',
            evidenceAttemptIds: attempts
              .filter((item: any) => item?.exerciseId === node.exercises[0]?.exerciseId)
              .map((item: any) => item.attemptId),
          })
        }
      }
    }
    step.value = 'report'
  }

  function followLesson(): void {
    runtime?.followLesson()
  }

  function setViewport(pageIndex: number): void {
    currentPage.value = pageIndex
    runtime?.setViewport(pageIndex)
  }

  return {
    visible,
    step,
    materials,
    selectedMaterial,
    pages,
    anchors,
    materialBytes,
    isPdf,
    compiling,
    compileStage,
    compileError,
    course,
    outline,
    anchorCoverage,
    compileUsage,
    contract,
    sessionId,
    view,
    currentPage,
    currentHighlights,
    report,
    reportAttempts,
    ttsDegraded,
    inLesson,
    heardText,
    resumableSessions,
    preparedCourses,
    listeningState,
    busy,
    isInClass: inLesson,
    open,
    close,
    reset,
    refreshMaterials,
    importMaterial,
    selectMaterial,
    compile,
    startLesson,
    resumeSession,
    refreshResumable,
    refreshPrepared,
    openPrepared,
    stopClassroomMic,
    interruptByKey,
    handleUtterance,
    pause,
    resume,
    skip,
    repeat,
    endLesson,
    buildReport,
    followLesson,
    setViewport,
  }
})
