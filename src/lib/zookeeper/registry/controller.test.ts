import { signal } from '@preact/signals-core'
import type * as ZookeeperManagerMachineModule from '@src/lib/zookeeper/zookeeperManagerMachine'
import type { ZookeeperManagerActor } from '@src/lib/zookeeper/zookeeperManagerMachine'
import type { ZookeeperConversationStore } from '@src/lib/zookeeper/zookeeperConversationStore'
import type * as SystemIOUtilsModule from '@src/machines/systemIO/utils'
import { S } from '@src/machines/utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NIL as uuidNIL } from 'uuid'

const managerMocks = vi.hoisted(() => ({
  create: vi.fn(),
  stop: vi.fn(),
  updateAuthToken: vi.fn(),
}))

const projectFilesMocks = vi.hoisted(() => ({
  collect: vi.fn(),
}))

const workerMocks = vi.hoisted(() => ({
  histories: [] as Array<{
    dispose: ReturnType<typeof vi.fn>
    handleActorSnapshot: ReturnType<typeof vi.fn>
    reset: ReturnType<typeof vi.fn>
  }>,
  processors: [] as Array<{
    dispose: ReturnType<typeof vi.fn>
    handleActorSnapshot: ReturnType<typeof vi.fn>
    reset: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock(
  '@src/lib/zookeeper/zookeeperManagerMachine',
  async (importOriginal) => ({
    ...(await importOriginal<typeof ZookeeperManagerMachineModule>()),
    createZookeeperManagerActor: managerMocks.create,
    stopZookeeperManagerActor: managerMocks.stop,
    updateZookeeperManagerAuthToken: managerMocks.updateAuthToken,
  })
)

vi.mock('@src/machines/systemIO/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemIOUtilsModule>()),
  collectProjectFiles: projectFilesMocks.collect,
}))

vi.mock('@src/lib/zookeeper/registry/ZookeeperEditPatchHistory', () => ({
  ZookeeperEditPatchHistory: class MockZookeeperEditPatchHistory {
    readonly dispose = vi.fn()
    readonly handleActorSnapshot = vi.fn()
    readonly reset = vi.fn()

    constructor() {
      workerMocks.histories.push(this)
    }
  },
}))

vi.mock('@src/lib/zookeeper/registry/ZookeeperFileRequestProcessor', () => ({
  ZookeeperFileRequestProcessor: class MockZookeeperFileRequestProcessor {
    readonly dispose = vi.fn()
    readonly handleActorSnapshot = vi.fn()
    readonly reset = vi.fn()

    constructor() {
      workerMocks.processors.push(this)
    }
  },
}))

import { BillingTransition } from '@src/lib/billing'
import {
  createZookeeperSessionController,
  type ZookeeperSessionController,
  type ZookeeperSessionControllerDependencies,
} from '@src/lib/zookeeper/registry/controller'
import {
  ZookeeperManagerStates,
  ZookeeperManagerTransitions,
} from '@src/lib/zookeeper/zookeeperManagerMachine'
import { zookeeperPromptRunningSignal } from '@src/lib/zookeeper/zookeeperPromptState'

type TestState =
  | 'other'
  | 'await'
  | 'ready'
  | 'ready-await'
  | 'wait-for-continue-check'

type ActorSnapshot = ReturnType<ZookeeperManagerActor['getSnapshot']>
type SnapshotContext = ActorSnapshot['context']

function createSnapshot(
  state: TestState,
  context: Partial<SnapshotContext> = {}
): ActorSnapshot {
  return {
    context: {
      abruptlyClosed: false,
      awaitingResponse: false,
      conversation: undefined,
      conversationId: undefined,
      lastMessageId: undefined,
      lastMessageType: undefined,
      setupFailed: false,
      ...context,
    },
    matches: (expected: unknown) => {
      if (typeof expected === 'object' && expected !== null) {
        return state === 'ready-await'
      }
      if (expected === S.Await) {
        return state === 'await'
      }
      if (expected === ZookeeperManagerStates.Ready) {
        return state === 'ready' || state === 'ready-await'
      }
      if (expected === ZookeeperManagerStates.WaitForContinueCheck) {
        return state === 'wait-for-continue-check'
      }
      return false
    },
    value: state === 'await' ? S.Await : state,
  } as ActorSnapshot
}

class TestActor {
  private listeners = new Set<(snapshot: ActorSnapshot) => void>()
  private snapshot = createSnapshot('other')

  readonly send = vi.fn()

  get listenerCount() {
    return this.listeners.size
  }

  getSnapshot = () => this.snapshot

  subscribe = (listener: (snapshot: ActorSnapshot) => void) => {
    this.listeners.add(listener)
    return {
      unsubscribe: () => {
        this.listeners.delete(listener)
      },
    }
  }

  setSnapshot(state: TestState, context: Partial<SnapshotContext> = {}) {
    this.snapshot = createSnapshot(state, context)
  }

  emit(state: TestState, context: Partial<SnapshotContext> = {}) {
    this.setSnapshot(state, context)
    for (const listener of [...this.listeners]) {
      listener(this.snapshot)
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const projectId = '24d8709c-8d07-4855-9357-f20d7d35a499'
const otherProjectId = 'cba9f0c5-5552-4b50-af44-0fa6fb548a3b'
const projectPath = '/projects/bracket'

function createHarness({
  actorState = 'other',
  actorContext,
  apiToken = 'initial-token',
  initialProjectId = projectId,
  storeGet = Promise.resolve(undefined),
}: {
  actorState?: TestState
  actorContext?: Partial<SnapshotContext>
  apiToken?: string
  initialProjectId?: string | undefined
  storeGet?: Promise<string | undefined>
} = {}) {
  const actor = new TestActor()
  actor.setSnapshot(actorState, actorContext)
  managerMocks.create.mockReturnValue(actor)

  const billingSend = vi.fn()
  const conversationStore: ZookeeperConversationStore = {
    deleteProjectConversationId: vi.fn().mockResolvedValue(undefined),
    getProjectConversationId: vi.fn().mockReturnValue(storeGet),
    saveProjectConversationId: vi.fn().mockResolvedValue(undefined),
  }
  const settings = signal({
    meta: { id: { current: initialProjectId } },
  })
  const project = {
    children: [],
    name: 'bracket',
    path: projectPath,
  }
  const loaderFile = {
    children: [],
    name: 'main.kcl',
    path: `${projectPath}/main.kcl`,
  }
  const kclManager = {
    artifactGraph: new Map(),
    code: 'cube = startSketchOn(XY)',
    engineCommandManager: {
      apiCallId: 'engine-call-id',
      modelingSend: vi.fn(),
    },
    execState: { filenames: {} },
    modelingState: { context: { selectionRanges: null } },
    path: loaderFile.path,
    wasmInstance: {},
    zookeeperHistoryRecordingInProgress: false,
  }
  const projectRuntime = signal({
    executingFileEntry: signal(loaderFile),
    path: projectPath,
    projectIORefSignal: signal(project),
  })
  const dependencies = {
    apiToken,
    billing: { send: billingSend },
    conversationStore,
    projectPath,
    projectRuntime: {
      current: projectRuntime,
      kclManager,
    },
    settings: { current: settings },
    systemIO: { actor: {} },
  } as unknown as ZookeeperSessionControllerDependencies
  const controller = createZookeeperSessionController(dependencies)
  activeControllers.add(controller)

  return {
    actor,
    billingSend,
    controller,
    conversationStore,
    kclManager,
    project,
    projectRuntime,
    settings,
  }
}

function sentEvents(actor: TestActor, type: string) {
  return actor.send.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === type)
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

const activeControllers = new Set<ZookeeperSessionController>()
let online = true

describe('Zookeeper session controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workerMocks.histories.length = 0
    workerMocks.processors.length = 0
    projectFilesMocks.collect.mockResolvedValue([])
    online = true
    vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(() => online)
  })

  afterEach(() => {
    for (const controller of activeControllers) {
      controller.dispose()
    }
    activeControllers.clear()
    zookeeperPromptRunningSignal.value = false
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('owns billing transitions and auth rotation without a mounted pane', () => {
    const { actor, billingSend, controller, conversationStore } =
      createHarness()

    actor.emit('other', {
      awaitingResponse: true,
      conversationId: 'conversation-id',
    })
    controller.updateAuthToken('rotated-token')
    actor.emit('other', { awaitingResponse: false })

    expect(managerMocks.create).toHaveBeenCalledOnce()
    expect(managerMocks.create).toHaveBeenCalledWith('initial-token')
    expect(managerMocks.updateAuthToken).toHaveBeenCalledOnce()
    expect(managerMocks.updateAuthToken).toHaveBeenCalledWith(
      actor,
      'rotated-token'
    )
    expect(controller.actor).toBe(actor)
    expect(conversationStore.saveProjectConversationId).toHaveBeenCalledWith({
      projectId,
      conversationId: 'conversation-id',
    })
    expect(billingSend.mock.calls.map(([event]) => event)).toEqual([
      { type: BillingTransition.UsageStarted },
      { type: BillingTransition.UsageEnded },
      { type: BillingTransition.Update, apiToken: 'rotated-token' },
    ])
  })

  it('submits a queued prompt when the persistent actor becomes ready', async () => {
    const { actor, controller, kclManager, project } = createHarness({
      actorContext: { awaitingResponse: true },
    })
    const attachment = new File(['notes'], 'notes.txt')

    controller.sendOrQueue('add two holes', undefined, [attachment])
    expect(controller.queue.value).toHaveLength(1)

    actor.emit('ready', { awaitingResponse: false })

    await vi.waitFor(() => {
      expect(
        sentEvents(actor, ZookeeperManagerTransitions.MessageSend)
      ).toHaveLength(1)
    })
    expect(controller.queue.value).toHaveLength(0)
    expect(projectFilesMocks.collect).toHaveBeenCalledWith({
      fileNames: kclManager.execState.filenames,
      projectContext: project,
      selectedFileContents: kclManager.code,
      selectedFilePath: kclManager.path,
    })
    expect(
      sentEvents(actor, ZookeeperManagerTransitions.MessageSend)[0]
    ).toMatchObject({
      additionalFiles: [attachment],
      prompt: 'add two holes',
      projectFiles: [],
      type: ZookeeperManagerTransitions.MessageSend,
    })
  })

  it('waits for the saved conversation lookup and for the browser to be online', async () => {
    online = false
    const lookup = deferred<string | undefined>()
    const { actor } = createHarness({
      actorState: 'ready-await',
      storeGet: lookup.promise,
    })

    expect(actor.send).toHaveBeenCalledWith({
      type: ZookeeperManagerTransitions.NetworkOffline,
    })
    expect(
      sentEvents(actor, ZookeeperManagerTransitions.CacheSetupAndConnect)
    ).toHaveLength(0)

    lookup.resolve('saved-conversation')
    await flushPromises()

    expect(
      sentEvents(actor, ZookeeperManagerTransitions.CacheSetupAndConnect)
    ).toHaveLength(0)

    online = true
    window.dispatchEvent(new Event('online'))

    expect(
      sentEvents(actor, ZookeeperManagerTransitions.CacheSetupAndConnect)
    ).toEqual([
      expect.objectContaining({
        conversationId: 'saved-conversation',
        type: ZookeeperManagerTransitions.CacheSetupAndConnect,
      }),
    ])
  })

  it('does not connect to a stored nil conversation', async () => {
    const { actor } = createHarness({
      actorState: 'ready-await',
      storeGet: Promise.resolve(uuidNIL),
    })

    await flushPromises()

    expect(
      sentEvents(actor, ZookeeperManagerTransitions.CacheSetupAndConnect)
    ).toHaveLength(0)
  })

  it('does not repeat setup while the actor waits for auth hydration', async () => {
    const { actor } = createHarness({
      actorState: 'ready-await',
      actorContext: {
        cachedSetup: {},
      },
    })

    await flushPromises()

    expect(
      sentEvents(actor, ZookeeperManagerTransitions.CacheSetupAndConnect)
    ).toHaveLength(0)
  })

  it('reconnects abrupt closures after a delay and supports manual reconnect', () => {
    vi.useFakeTimers()
    const { actor, controller } = createHarness({
      actorContext: { conversationId: 'active-conversation' },
      initialProjectId: undefined,
    })

    actor.emit('other', {
      abruptlyClosed: true,
      conversationId: 'active-conversation',
    })
    vi.advanceTimersByTime(2999)
    expect(
      sentEvents(actor, ZookeeperManagerTransitions.CacheSetupAndConnect)
    ).toHaveLength(0)

    vi.advanceTimersByTime(1)
    expect(
      sentEvents(actor, ZookeeperManagerTransitions.CacheSetupAndConnect)
    ).toHaveLength(1)

    online = false
    window.dispatchEvent(new Event('offline'))
    expect(controller.showManualConnect.value).toBe(true)

    controller.reconnect()

    expect(controller.showManualConnect.value).toBe(false)
    expect(
      sentEvents(actor, ZookeeperManagerTransitions.CacheSetupAndConnect)
    ).toHaveLength(2)
  })

  it('deletes persisted state before closing and starts one fresh conversation', async () => {
    const lookup = deferred<string | undefined>()
    const deletion = deferred<undefined>()
    const { actor, controller, conversationStore } = createHarness({
      actorContext: { awaitingResponse: true },
      storeGet: lookup.promise,
    })
    vi.mocked(
      conversationStore.deleteProjectConversationId
    ).mockReturnValueOnce(deletion.promise)
    controller.sendOrQueue('queued before clear', undefined, [])

    const clearPromise = controller.clearConversation()

    expect(controller.isClearingChat.value).toBe(true)
    expect(
      sentEvents(actor, ZookeeperManagerTransitions.ConversationClose)
    ).toHaveLength(0)

    deletion.resolve(undefined)
    await clearPromise

    expect(conversationStore.deleteProjectConversationId).toHaveBeenCalledWith(
      projectId
    )
    expect(
      sentEvents(actor, ZookeeperManagerTransitions.ConversationClose)
    ).toHaveLength(1)

    actor.emit('await')

    expect(controller.queue.value).toHaveLength(0)
    expect(controller.isClearingChat.value).toBe(false)
    expect(workerMocks.processors[0].reset).toHaveBeenCalledOnce()
    expect(workerMocks.histories[0].reset).toHaveBeenCalledOnce()
    expect(
      sentEvents(actor, ZookeeperManagerTransitions.CacheSetupAndConnect)
    ).toEqual([
      expect.objectContaining({
        conversationId: undefined,
        type: ZookeeperManagerTransitions.CacheSetupAndConnect,
      }),
    ])
  })

  it('does not finish clearing after the project settings scope changes', async () => {
    const deletion = deferred<undefined>()
    const { actor, controller, conversationStore, settings } = createHarness()
    vi.mocked(
      conversationStore.deleteProjectConversationId
    ).mockReturnValueOnce(deletion.promise)

    const clearPromise = controller.clearConversation()
    settings.value = {
      meta: { id: { current: otherProjectId } },
    }
    deletion.resolve(undefined)
    await clearPromise

    expect(controller.isClearingChat.value).toBe(false)
    expect(
      sentEvents(actor, ZookeeperManagerTransitions.ConversationClose)
    ).toHaveLength(0)
    expect(
      sentEvents(actor, ZookeeperManagerTransitions.CacheSetupAndConnect)
    ).toHaveLength(0)
  })

  it('keeps conversation persistence bound to the controller project', async () => {
    const { actor, controller, conversationStore, settings } = createHarness({
      actorContext: { conversationId: 'conversation-a' },
    })
    await flushPromises()
    vi.mocked(conversationStore.saveProjectConversationId).mockClear()

    settings.value = {
      meta: { id: { current: otherProjectId } },
    }
    actor.emit('other', { conversationId: 'conversation-b' })
    await controller.clearConversation()

    expect(conversationStore.getProjectConversationId).not.toHaveBeenCalledWith(
      otherProjectId
    )
    expect(conversationStore.saveProjectConversationId).toHaveBeenCalledWith({
      projectId,
      conversationId: 'conversation-b',
    })
    expect(conversationStore.deleteProjectConversationId).toHaveBeenCalledWith(
      projectId
    )
  })

  it('drops a stale ContinueCheck after project ownership changes', async () => {
    const collectedFiles = deferred<[]>()
    projectFilesMocks.collect.mockReturnValueOnce(collectedFiles.promise)
    const harness = createHarness()

    harness.actor.emit('wait-for-continue-check')
    expect(projectFilesMocks.collect).toHaveBeenCalledOnce()

    harness.projectRuntime.value = {
      ...harness.projectRuntime.value,
      path: '/projects/other',
      projectIORefSignal: signal({
        ...harness.project,
        path: '/projects/other',
      }),
    }
    collectedFiles.resolve([])
    await flushPromises()

    expect(
      sentEvents(harness.actor, ZookeeperManagerStates.ContinueCheck)
    ).toHaveLength(0)
  })

  it('can retry ContinueCheck after collecting project files fails', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    projectFilesMocks.collect
      .mockRejectedValueOnce(new Error('could not collect files'))
      .mockResolvedValueOnce([])
    const { actor } = createHarness()

    actor.emit('wait-for-continue-check')
    await flushPromises()
    actor.emit('wait-for-continue-check')
    await flushPromises()

    expect(projectFilesMocks.collect).toHaveBeenCalledTimes(2)
    expect(
      sentEvents(actor, ZookeeperManagerStates.ContinueCheck)
    ).toHaveLength(1)
    expect(consoleError).toHaveBeenCalled()
  })

  it('cancels subscriptions, workers, reconnects, and active billing on dispose', () => {
    vi.useFakeTimers()
    const { actor, billingSend, controller, conversationStore, settings } =
      createHarness()
    actor.emit('other', {
      abruptlyClosed: true,
      awaitingResponse: true,
      conversationId: 'active-conversation',
    })
    const lookupCount = vi.mocked(conversationStore.getProjectConversationId)
      .mock.calls.length
    actor.send.mockClear()
    billingSend.mockClear()

    controller.dispose()
    settings.value = {
      meta: { id: { current: otherProjectId } },
    }
    online = false
    window.dispatchEvent(new Event('offline'))
    vi.advanceTimersByTime(3000)
    actor.emit('other', { awaitingResponse: false })
    controller.updateAuthToken('ignored-after-dispose')

    expect(actor.listenerCount).toBe(0)
    expect(managerMocks.stop).toHaveBeenCalledOnce()
    expect(managerMocks.stop).toHaveBeenCalledWith(actor)
    expect(managerMocks.updateAuthToken).not.toHaveBeenCalled()
    expect(workerMocks.histories[0].dispose).toHaveBeenCalledOnce()
    expect(workerMocks.processors[0].dispose).toHaveBeenCalledOnce()
    expect(actor.send).not.toHaveBeenCalled()
    expect(conversationStore.getProjectConversationId).toHaveBeenCalledTimes(
      lookupCount
    )
    expect(billingSend.mock.calls.map(([event]) => event)).toEqual([
      { type: BillingTransition.UsageEnded },
      { type: BillingTransition.Update, apiToken: 'initial-token' },
    ])
    expect(zookeeperPromptRunningSignal.value).toBe(false)
  })
})
