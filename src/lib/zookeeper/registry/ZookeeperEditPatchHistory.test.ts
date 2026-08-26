import type { KclManager } from '@src/lang/KclManager'
import { ZookeeperEditPatchHistory } from '@src/lib/zookeeper/registry/ZookeeperEditPatchHistory'
import type { ZookeeperManagerActor } from '@src/lib/zookeeper/zookeeperManagerMachine'
import type { ZookeeperEditPatch } from '@src/lib/zookeeper/zookeeperEditPatch'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(async () => 'updated contents'),
}))

vi.mock('@src/lib/fs-zds', () => ({
  default: {
    join: (root: string, ...parts: string[]) =>
      parts.reduce((path, part) => `${path}/${part}`, root),
    readFile: mocks.readFile,
    relative: (from: string, to: string) =>
      to.startsWith(`${from}/`) ? to.slice(from.length + 1) : to,
  },
}))

vi.mock('@src/lib/zookeeper/editorPlugin', () => ({
  zookeeperEditPatchHistoryEvent: vi.fn((value) => value),
}))

const projectPath = '/workspace/demo'
const activeFilePath = `${projectPath}/main.kcl`
const patch: ZookeeperEditPatch = {
  run_id: 'run-1',
  changed_files: [
    {
      path: 'main.kcl',
      status: 'created',
      contents: 'updated contents',
    },
  ],
}

function createKclManager() {
  const state = {
    addGlobalHistoryEvent: vi.fn(),
    addGlobalHistoryEventWithCodeChange: vi.fn(),
    code: 'editor contents',
    path: `${projectPath}/other.kcl`,
    zookeeperHistoryRecordingInProgress: false,
  }

  return {
    manager: state as unknown as KclManager,
    state,
  }
}

function endOfStreamSnapshot(
  lastMessageId: number,
  exchangeCount = 1
): ReturnType<ZookeeperManagerActor['getSnapshot']> {
  return {
    context: {
      conversation: {
        exchanges: Array.from({ length: exchangeCount }, () => ({})),
      },
      lastMessageId,
      lastMessageType: 'end_of_stream',
    },
  } as unknown as ReturnType<ZookeeperManagerActor['getSnapshot']>
}

async function completeWrite(
  history: ZookeeperEditPatchHistory,
  editPatch = patch
) {
  await history.complete({
    activeFileDeleted: false,
    activeFilePath,
    exchangeId: 0,
    patch: editPatch,
    projectPath,
    requestIsCurrent: () => true,
  })
}

describe('ZookeeperEditPatchHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('flushes a completed write only after the exchange ends', async () => {
    const { manager, state } = createKclManager()
    const history = new ZookeeperEditPatchHistory(manager)

    history.reserve({ activeFilePath, exchangeId: 0, projectPath })
    await completeWrite(history)

    expect(state.zookeeperHistoryRecordingInProgress).toBe(true)
    expect(state.addGlobalHistoryEvent).not.toHaveBeenCalled()

    history.handleActorSnapshot(endOfStreamSnapshot(1))

    expect(state.addGlobalHistoryEvent).toHaveBeenCalledOnce()
    expect(state.zookeeperHistoryRecordingInProgress).toBe(false)
  })

  it('clears an unused reservation when the write is cancelled', () => {
    const { manager, state } = createKclManager()
    const history = new ZookeeperEditPatchHistory(manager)

    history.reserve({ activeFilePath, exchangeId: 0, projectPath })
    expect(state.zookeeperHistoryRecordingInProgress).toBe(true)

    history.cancel({ exchangeId: 0 })

    expect(state.addGlobalHistoryEvent).not.toHaveBeenCalled()
    expect(state.zookeeperHistoryRecordingInProgress).toBe(false)
  })

  it('does not carry interrupted history into a fresh conversation', async () => {
    const { manager, state } = createKclManager()
    const history = new ZookeeperEditPatchHistory(manager)

    history.reserve({ activeFilePath, exchangeId: 0, projectPath })
    await completeWrite(history)
    history.reset()
    await completeWrite(history)

    expect(state.zookeeperHistoryRecordingInProgress).toBe(false)

    const nextPatch: ZookeeperEditPatch = {
      ...patch,
      run_id: 'run-2',
    }
    history.reserve({ activeFilePath, exchangeId: 0, projectPath })
    await completeWrite(history, nextPatch)
    history.handleActorSnapshot(endOfStreamSnapshot(2))

    expect(state.addGlobalHistoryEvent).toHaveBeenCalledOnce()
    expect(state.addGlobalHistoryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ run_id: 'run-2' }),
      })
    )
    expect(state.zookeeperHistoryRecordingInProgress).toBe(false)
  })

  it('clears the recording flag when recording the history event throws', async () => {
    const { manager, state } = createKclManager()
    const history = new ZookeeperEditPatchHistory(manager)
    const error = new Error('history failed')
    state.addGlobalHistoryEvent.mockImplementationOnce(() => {
      throw error
    })

    history.reserve({ activeFilePath, exchangeId: 0, projectPath })
    await completeWrite(history)

    expect(() => history.handleActorSnapshot(endOfStreamSnapshot(1))).toThrow(
      error
    )
    expect(state.zookeeperHistoryRecordingInProgress).toBe(false)
  })

  it('drops pending and late work when disposed', async () => {
    const { manager, state } = createKclManager()
    const history = new ZookeeperEditPatchHistory(manager)

    history.reserve({ activeFilePath, exchangeId: 0, projectPath })
    history.dispose()
    history.dispose()
    await completeWrite(history)
    history.handleActorSnapshot(endOfStreamSnapshot(1))

    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(state.addGlobalHistoryEvent).not.toHaveBeenCalled()
    expect(state.zookeeperHistoryRecordingInProgress).toBe(false)
  })
})
