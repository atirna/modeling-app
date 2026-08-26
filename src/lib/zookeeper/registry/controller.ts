import { effect, signal, type ReadonlySignal } from '@preact/signals-core'
import { BillingTransition } from '@src/lib/billing'
import { getParentAbsolutePath } from '@src/lib/paths'
import type { Project } from '@src/lib/project'
import { reportRejection, trap } from '@src/lib/trap'
import { activeFileRelativeToProject } from '@src/lib/zookeeper/zookeeperPromptRequest'
import {
  zookeeperConversationStore,
  type ZookeeperConversationStore,
} from '@src/lib/zookeeper/zookeeperConversationStore'
import {
  createZookeeperManagerActor,
  type MlCopilotModeId,
  stopZookeeperManagerActor,
  updateZookeeperManagerAuthToken,
  type ZookeeperManagerActor,
  ZookeeperManagerStates,
  ZookeeperManagerTransitions,
} from '@src/lib/zookeeper/zookeeperManagerMachine'
import { zookeeperPromptRunningSignal } from '@src/lib/zookeeper/zookeeperPromptState'
import { collectProjectFiles } from '@src/machines/systemIO/utils'
import { S } from '@src/machines/utils'
import { IS_STAGING_OR_DEBUG } from '@src/routes/utils'
import type { BillingRegistryService } from '@src/lib/billing/registry/contract'
import type { ProjectRuntimeRegistryService } from '@src/registry/contracts/projectRuntime'
import type { DebugRegistryService } from '@src/registry/contracts/debug'
import type { SettingsRegistryService } from '@src/registry/contracts/settings'
import type { SystemIORegistryService } from '@src/registry/contracts/systemIO'
import { NIL as uuidNIL } from 'uuid'
import type { SnapshotFrom, Subscription } from 'xstate'
import { ZookeeperEditPatchHistory } from '@src/lib/zookeeper/registry/ZookeeperEditPatchHistory'
import { ZookeeperFileRequestProcessor } from '@src/lib/zookeeper/registry/ZookeeperFileRequestProcessor'

export interface ZookeeperSessionControllerDependencies {
  apiToken: string
  billing: BillingRegistryService
  conversationStore?: ZookeeperConversationStore
  debug?: DebugRegistryService
  projectPath: string
  projectRuntime: ProjectRuntimeRegistryService
  settings: SettingsRegistryService
  systemIO: SystemIORegistryService
}

export interface QueuedMessage {
  id: string
  text: string
  mode?: MlCopilotModeId
  attachments: File[]
}

export interface ZookeeperSessionController {
  readonly actor: ZookeeperManagerActor
  readonly isClearingChat: ReadonlySignal<boolean>
  readonly projectPath: string
  readonly queue: ReadonlySignal<readonly QueuedMessage[]>
  readonly showManualConnect: ReadonlySignal<boolean>
  cancel(): void
  clearConversation(): Promise<void>
  dispose(): void
  reconnect(): void
  removeQueued(id: string): void
  sendOrQueue(
    prompt: string,
    mode: MlCopilotModeId | undefined,
    attachments: File[]
  ): void
  steer(id: string): void
  updateAuthToken(apiToken: string): void
}

type ZookeeperSnapshot = SnapshotFrom<ZookeeperManagerActor>

class SessionController implements ZookeeperSessionController {
  readonly actor: ZookeeperManagerActor
  readonly projectPath: string

  private readonly queueSignal = signal<QueuedMessage[]>([])
  readonly queue: ReadonlySignal<readonly QueuedMessage[]> = this.queueSignal

  private readonly isClearingChatSignal = signal(false)
  readonly isClearingChat: ReadonlySignal<boolean> = this.isClearingChatSignal

  private readonly showManualConnectSignal = signal(
    typeof navigator !== 'undefined' && navigator.onLine === false
  )
  readonly showManualConnect: ReadonlySignal<boolean> =
    this.showManualConnectSignal

  private apiToken: string
  private active = true
  private actorSubscription: Subscription | undefined
  private clearSubscription: Subscription | undefined
  private clearOperationGeneration = 0
  private continueCheckInFlight = false
  private continueCheckGeneration = 0
  private isSubmittingFromQueue = false
  private lastSavedConversationId: string | undefined
  private lookupGeneration = 0
  private lookupLoaded = false
  private lookupProjectId: string | undefined | null = null
  private reconnectAfterLookup = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private savedConversationId: string | undefined
  private steeredId: string | null = null
  private stopSettingsEffect: (() => void) | undefined
  private wasPromptRunning = false

  private readonly history: ZookeeperEditPatchHistory
  private readonly fileRequestProcessor: ZookeeperFileRequestProcessor

  constructor(private readonly deps: ZookeeperSessionControllerDependencies) {
    this.apiToken = deps.apiToken
    this.projectPath = deps.projectPath
    this.actor = createZookeeperManagerActor(deps.apiToken)
    if (IS_STAGING_OR_DEBUG) {
      deps.debug?.set('zookeeperManagerActor', this.actor)
    }
    this.history = new ZookeeperEditPatchHistory(deps.projectRuntime.kclManager)
    this.fileRequestProcessor = new ZookeeperFileRequestProcessor({
      getProject: () => this.getProject(),
      history: this.history,
      isSessionCurrent: () => this.active,
      kclManager: deps.projectRuntime.kclManager,
      systemIOActor: deps.systemIO.actor,
    })

    this.actorSubscription = this.actor.subscribe((snapshot) => {
      this.handleSnapshot(snapshot)
    })

    if (typeof window !== 'undefined') {
      window.addEventListener('offline', this.handleOffline)
      window.addEventListener('online', this.handleOnline)
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.actor.send({ type: ZookeeperManagerTransitions.NetworkOffline })
    }

    this.stopSettingsEffect = effect(() => {
      const projectId = deps.settings.current.value.meta.id.current
      this.startConversationLookup(projectId)
      this.saveConversationId(this.actor.getSnapshot())
    })

    this.handleSnapshot(this.actor.getSnapshot())
  }

  updateAuthToken(apiToken: string) {
    if (!this.active || this.apiToken === apiToken) {
      return
    }
    this.apiToken = apiToken
    updateZookeeperManagerAuthToken(this.actor, apiToken)
  }

  sendOrQueue(
    prompt: string,
    mode: MlCopilotModeId | undefined,
    attachments: File[]
  ) {
    if (!this.active || this.isClearingChatSignal.peek()) {
      return
    }

    if (
      this.actor.getSnapshot().context.awaitingResponse ||
      this.isSubmittingFromQueue
    ) {
      this.queueSignal.value = [
        ...this.queueSignal.peek(),
        {
          id: crypto.randomUUID(),
          text: prompt,
          mode,
          attachments,
        },
      ]
      return
    }

    void this.process(prompt, mode, attachments).catch(reportRejection)
  }

  removeQueued(id: string) {
    if (this.steeredId === id) {
      this.steeredId = null
    }
    this.queueSignal.value = this.queueSignal
      .peek()
      .filter((message) => message.id !== id)
  }

  steer(id: string) {
    if (!this.active) {
      return
    }
    this.steeredId = id
    this.actor.send({ type: ZookeeperManagerTransitions.Interrupt })
  }

  cancel() {
    if (this.active) {
      this.actor.send({ type: ZookeeperManagerTransitions.Cancel })
    }
  }

  reconnect = () => {
    if (!this.active || this.isClearingChatSignal.peek()) {
      return
    }

    this.showManualConnectSignal.value = false
    const snapshot = this.actor.getSnapshot()
    if (snapshot.context.cachedSetup !== undefined) {
      return
    }
    const actorConversationId = snapshot.context.conversationId
    const actorConversationMatchesProject =
      this.projectPath === this.getProject()?.path

    if (
      (!actorConversationMatchesProject || actorConversationId === undefined) &&
      !this.lookupLoaded
    ) {
      this.reconnectAfterLookup = true
      return
    }

    this.reconnectAfterLookup = false
    const conversationId =
      actorConversationMatchesProject && actorConversationId !== undefined
        ? actorConversationId
        : this.savedConversationId
    if (conversationId === uuidNIL) {
      return
    }

    this.actor.send({
      type: ZookeeperManagerTransitions.CacheSetupAndConnect,
      refParentSend: this.actor.send,
      conversationId,
    })
  }

  async clearConversation() {
    if (!this.active || this.isClearingChatSignal.peek()) {
      return
    }

    this.isClearingChatSignal.value = true
    this.reconnectAfterLookup = false
    this.reconcileReconnect(this.actor.getSnapshot())
    const generation = ++this.clearOperationGeneration
    const isCurrentOperation = () =>
      this.active &&
      this.clearOperationGeneration === generation &&
      this.isClearingChatSignal.peek()
    const projectId = this.lookupProjectId

    try {
      if (
        projectId !== null &&
        projectId !== undefined &&
        projectId !== uuidNIL
      ) {
        await (
          this.deps.conversationStore ?? zookeeperConversationStore
        ).deleteProjectConversationId(projectId)
      }
    } catch (error: unknown) {
      if (!isCurrentOperation()) {
        return
      }
      this.isClearingChatSignal.value = false
      this.reconcileReconnect(this.actor.getSnapshot())
      trap(error instanceof Error ? error : new Error(String(error)), {
        altErr: new Error('Could not clear chat. Please try again.'),
      })
      return
    }

    if (!isCurrentOperation()) {
      return
    }

    this.steeredId = null
    this.queueSignal.value = []
    this.lookupLoaded = true
    this.savedConversationId = undefined

    const startFreshConversation = () => {
      this.clearSubscription?.unsubscribe()
      this.clearSubscription = undefined
      if (!isCurrentOperation()) {
        return
      }
      this.fileRequestProcessor.reset()
      this.history.reset()
      this.actor.send({
        type: ZookeeperManagerTransitions.CacheSetupAndConnect,
        refParentSend: this.actor.send,
        conversationId: undefined,
      })
      this.isClearingChatSignal.value = false
      this.reconcileReconnect(this.actor.getSnapshot())
    }

    this.clearSubscription = this.actor.subscribe((snapshot) => {
      if (snapshot.matches(S.Await)) {
        startFreshConversation()
      }
    })
    this.actor.send({
      type: ZookeeperManagerTransitions.ConversationClose,
    })
    if (this.actor.getSnapshot().matches(S.Await)) {
      startFreshConversation()
    }
  }

  dispose() {
    if (!this.active) {
      return
    }

    this.active = false
    this.clearOperationGeneration += 1
    this.continueCheckGeneration += 1
    this.lookupGeneration += 1
    this.clearReconnectTimer()
    this.clearSubscription?.unsubscribe()
    this.actorSubscription?.unsubscribe()
    this.stopSettingsEffect?.()
    if (typeof window !== 'undefined') {
      window.removeEventListener('offline', this.handleOffline)
      window.removeEventListener('online', this.handleOnline)
    }

    if (this.wasPromptRunning) {
      this.wasPromptRunning = false
      this.deps.billing.send({ type: BillingTransition.UsageEnded })
      this.deps.billing.send({
        type: BillingTransition.Update,
        apiToken: this.apiToken,
      })
    }
    zookeeperPromptRunningSignal.value = false
    if (IS_STAGING_OR_DEBUG) {
      this.deps.debug?.clear('zookeeperManagerActor', this.actor)
    }
    this.fileRequestProcessor.dispose()
    this.history.dispose()
    stopZookeeperManagerActor(this.actor)
  }

  private getProject(): Project | undefined {
    const project = this.deps.projectRuntime.current.value
    const projectIO = project?.projectIORefSignal.value
    return projectIO?.path === this.projectPath ? projectIO : undefined
  }

  private getLoaderFile() {
    const project = this.deps.projectRuntime.current.value
    return project?.path === this.projectPath
      ? project.executingFileEntry.value
      : undefined
  }

  private async process(
    prompt: string,
    mode: MlCopilotModeId | undefined,
    attachments: File[]
  ) {
    const project = this.getProject()
    const loaderFile = this.getLoaderFile()
    if (!project) {
      console.warn('theProject is `undefined` - should not be possible')
      return
    }
    if (!loaderFile) {
      console.warn('loaderFile is `undefined` - should not be possible')
      return
    }

    const kclManager = this.deps.projectRuntime.kclManager
    const projectFiles = await collectProjectFiles({
      selectedFileContents: kclManager.code,
      selectedFilePath: kclManager.path,
      fileNames: kclManager.execState.filenames,
      projectContext: project,
    })
    if (!this.active || this.getProject()?.path !== project.path) {
      return
    }

    this.actor.send({
      type: ZookeeperManagerTransitions.MessageSend,
      prompt,
      projectForPromptOutput: project,
      applicationProjectDirectory: getParentAbsolutePath(project.path),
      fileSelectedDuringPrompting: {
        entry: loaderFile,
        content: kclManager.code,
      },
      projectFiles,
      selections: kclManager.modelingState?.context.selectionRanges ?? null,
      artifactGraph: kclManager.artifactGraph,
      kclManager,
      engineCommandManager: kclManager.engineCommandManager,
      wasmInstance: kclManager.wasmInstance,
      mode,
      additionalFiles: attachments,
    })
  }

  private handleSnapshot(snapshot: ZookeeperSnapshot) {
    if (!this.active) {
      return
    }

    this.history.handleActorSnapshot(snapshot)
    this.fileRequestProcessor.handleActorSnapshot(snapshot)
    this.updateBilling(snapshot.context.awaitingResponse)
    this.saveConversationId(snapshot)
    this.continueCheck(snapshot)
    this.finishClearIfConversationStarted(snapshot)
    this.tryConnectWhenIdle(snapshot)
    this.reconcileReconnect(snapshot)
    this.flushQueue(snapshot)
  }

  private updateBilling(isPromptRunning: boolean) {
    zookeeperPromptRunningSignal.value = isPromptRunning
    if (isPromptRunning === this.wasPromptRunning) {
      return
    }

    this.wasPromptRunning = isPromptRunning
    if (isPromptRunning) {
      this.deps.billing.send({ type: BillingTransition.UsageStarted })
      return
    }

    this.deps.billing.send({ type: BillingTransition.UsageEnded })
    this.deps.billing.send({
      type: BillingTransition.Update,
      apiToken: this.apiToken,
    })
  }

  private saveConversationId(snapshot: ZookeeperSnapshot) {
    const projectId = this.lookupProjectId
    const conversationId = snapshot.context.conversationId
    if (
      projectId === null ||
      projectId === undefined ||
      projectId === uuidNIL ||
      conversationId === undefined ||
      conversationId === this.lastSavedConversationId
    ) {
      return
    }

    this.lastSavedConversationId = conversationId
    void (this.deps.conversationStore ?? zookeeperConversationStore)
      .saveProjectConversationId({ projectId, conversationId })
      .catch(reportRejection)
  }

  private startConversationLookup(projectId: string | undefined) {
    if (projectId === this.lookupProjectId) {
      return
    }

    // A session belongs to one project path and, once known, one project ID.
    // Route loading can publish the next project's settings before its path;
    // never let that transient state remap the current actor's conversation.
    if (
      this.lookupProjectId !== null &&
      this.lookupProjectId !== undefined &&
      this.lookupProjectId !== uuidNIL
    ) {
      this.cancelClearForScopeChange()
      return
    }

    if (this.lookupProjectId !== null) {
      this.cancelClearForScopeChange()
    }

    const generation = ++this.lookupGeneration
    this.lookupProjectId = projectId
    this.lookupLoaded = false
    this.savedConversationId = undefined
    this.lastSavedConversationId =
      this.actor.getSnapshot().context.conversationId

    const finish = (conversationId: string | undefined) => {
      if (
        !this.active ||
        this.lookupGeneration !== generation ||
        this.lookupLoaded
      ) {
        return
      }
      this.lookupLoaded = true
      this.savedConversationId = conversationId
      if (this.reconnectAfterLookup) {
        this.reconnect()
        return
      }
      this.tryConnectWhenIdle(this.actor.getSnapshot())
    }

    if (projectId === undefined || projectId === uuidNIL) {
      finish(undefined)
      return
    }

    void (this.deps.conversationStore ?? zookeeperConversationStore)
      .getProjectConversationId(projectId)
      .then(finish)
      .catch((error: unknown) => {
        if (
          !this.active ||
          this.lookupGeneration !== generation ||
          this.lookupLoaded
        ) {
          return
        }
        reportRejection(error)
        finish(undefined)
      })
  }

  private cancelClearForScopeChange() {
    this.clearOperationGeneration += 1
    this.clearSubscription?.unsubscribe()
    this.clearSubscription = undefined
    this.reconnectAfterLookup = false
    if (this.isClearingChatSignal.peek()) {
      this.isClearingChatSignal.value = false
      this.reconcileReconnect(this.actor.getSnapshot())
    }
  }

  private tryConnectWhenIdle(snapshot: ZookeeperSnapshot) {
    if (
      !this.active ||
      this.isClearingChatSignal.peek() ||
      this.showManualConnectSignal.peek() ||
      !this.lookupLoaded ||
      this.lookupProjectId === uuidNIL ||
      this.savedConversationId === uuidNIL ||
      snapshot.context.cachedSetup !== undefined
    ) {
      return
    }

    const isIdle =
      snapshot.matches({
        [ZookeeperManagerStates.Ready]: {
          [ZookeeperManagerStates.Request]: S.Await,
        },
      }) || snapshot.value === S.Await
    if (
      !isIdle ||
      snapshot.context.conversation !== undefined ||
      snapshot.context.abruptlyClosed ||
      this.getProject() === undefined
    ) {
      return
    }

    this.actor.send({
      type: ZookeeperManagerTransitions.CacheSetupAndConnect,
      refParentSend: this.actor.send,
      conversationId: this.savedConversationId,
    })
  }

  private continueCheck(snapshot: ZookeeperSnapshot) {
    if (!snapshot.matches(ZookeeperManagerStates.WaitForContinueCheck)) {
      this.continueCheckInFlight = false
      return
    }
    if (this.continueCheckInFlight) {
      return
    }

    const project = this.getProject()
    if (!project) {
      return
    }
    this.continueCheckInFlight = true
    const generation = ++this.continueCheckGeneration
    const loaderFile = this.getLoaderFile()
    const kclManager = this.deps.projectRuntime.kclManager
    void collectProjectFiles({
      selectedFileContents: kclManager.code,
      selectedFilePath: kclManager.path,
      fileNames: kclManager.execState.filenames,
      projectContext: project,
    })
      .then((projectFiles) => {
        if (
          !this.active ||
          this.continueCheckGeneration !== generation ||
          this.getProject()?.path !== project.path ||
          !this.actor
            .getSnapshot()
            .matches(ZookeeperManagerStates.WaitForContinueCheck)
        ) {
          return
        }
        this.actor.send({
          type: ZookeeperManagerStates.ContinueCheck,
          projectName: project.name,
          projectFiles,
          engineApiCallId: kclManager.engineCommandManager.apiCallId,
          activeFile: loaderFile
            ? activeFileRelativeToProject({
                currentFileEntry: loaderFile,
                applicationProjectDirectory: getParentAbsolutePath(
                  project.path
                ),
              })
            : undefined,
        })
      })
      .catch((error: unknown) => {
        if (
          !this.active ||
          this.continueCheckGeneration !== generation ||
          this.getProject()?.path !== project.path
        ) {
          return
        }
        this.continueCheckInFlight = false
        reportRejection(error)
      })
  }

  private finishClearIfConversationStarted(snapshot: ZookeeperSnapshot) {
    if (
      this.isClearingChatSignal.peek() &&
      snapshot.context.conversationId !== undefined &&
      snapshot.context.conversation !== undefined
    ) {
      this.isClearingChatSignal.value = false
    }
  }

  private flushQueue(snapshot: ZookeeperSnapshot) {
    if (
      !this.active ||
      !snapshot.matches(ZookeeperManagerStates.Ready) ||
      snapshot.context.awaitingResponse ||
      this.isClearingChatSignal.peek() ||
      this.isSubmittingFromQueue ||
      this.queueSignal.peek().length === 0
    ) {
      return
    }

    this.isSubmittingFromQueue = true
    const queue = this.queueSignal.peek()
    const steeredIndex =
      this.steeredId === null
        ? -1
        : queue.findIndex((message) => message.id === this.steeredId)
    this.steeredId = null
    const nextIndex = steeredIndex === -1 ? 0 : steeredIndex
    const next = queue[nextIndex]
    this.queueSignal.value = queue.filter((_, index) => index !== nextIndex)

    void this.process(next.text, next.mode, next.attachments)
      .catch(reportRejection)
      .finally(() => {
        this.isSubmittingFromQueue = false
        this.flushQueue(this.actor.getSnapshot())
      })
  }

  private handleOffline = () => {
    if (!this.active) {
      return
    }
    this.reconnectAfterLookup = false
    this.showManualConnectSignal.value = true
    this.actor.send({ type: ZookeeperManagerTransitions.NetworkOffline })
  }

  private handleOnline = () => {
    if (!this.active) {
      return
    }
    this.showManualConnectSignal.value = false
    this.reconnect()
  }

  private reconcileReconnect(snapshot: ZookeeperSnapshot) {
    const shouldReconnect =
      snapshot.context.abruptlyClosed &&
      !snapshot.context.setupFailed &&
      !this.showManualConnectSignal.peek() &&
      !this.isClearingChatSignal.peek()

    if (!shouldReconnect) {
      this.clearReconnectTimer()
      return
    }
    if (this.reconnectTimer !== undefined) {
      return
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.reconnect()
    }, 3000)
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer === undefined) {
      return
    }
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }
}

export function createZookeeperSessionController(
  dependencies: ZookeeperSessionControllerDependencies
): ZookeeperSessionController {
  return new SessionController(dependencies)
}
