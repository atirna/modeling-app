import { signal } from '@preact/signals-core'
import type { KclManager, ZDSProject } from '@src/lang/KclManager'
import type { BillingRegistryService } from '@src/lib/billing'
import {
  AreaType,
  type Layout,
  type LayoutService,
  LayoutType,
} from '@src/lib/layout/types'
import type { Project } from '@src/lib/project'
import type {
  ZookeeperSessionController,
  ZookeeperSessionControllerDependencies,
} from '@src/lib/zookeeper/registry/controller'
import { createZookeeperRuntime } from '@src/lib/zookeeper/registry/runtime'
import type { AuthRegistryService } from '@src/registry/contracts/auth'
import type { ProjectRuntimeRegistryService } from '@src/registry/contracts/projectRuntime'
import type { SettingsRegistryService } from '@src/registry/contracts/settings'
import type { SystemIORegistryService } from '@src/registry/contracts/systemIO'
import { describe, expect, it, vi } from 'vitest'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createProject(path: string): ZDSProject {
  return {
    projectIORefSignal: signal({ path } as Project),
  } as ZDSProject
}

function zookeeperPaneLayout(isOpen: boolean): Layout {
  return {
    id: 'custom-pane',
    label: 'Custom pane',
    type: LayoutType.Panes,
    side: 'inline-end',
    activeIndices: isOpen ? [0] : [],
    sizes: [100],
    splitOrientation: 'block',
    children: [
      {
        id: 'custom-zookeeper-child',
        label: 'Zookeeper',
        type: LayoutType.Simple,
        areaType: AreaType.Zookeeper,
        icon: 'sparkles',
      },
    ],
  }
}

function createServices({
  apiToken = 'token',
  projectPath = '/project',
}: {
  apiToken?: string
  projectPath?: string
} = {}) {
  const token = signal(apiToken)
  const isLoggedIn = signal(true)
  const currentProject = signal<ZDSProject | undefined>(
    createProject(projectPath)
  )
  const layoutSignal = signal(zookeeperPaneLayout(false))
  const projectRuntime: ProjectRuntimeRegistryService = {
    current: currentProject,
    kclManager: {} as KclManager,
  }

  return {
    currentProject,
    layoutSignal,
    services: {
      auth: signal({ isLoggedIn, token } as AuthRegistryService),
      billing: signal({} as BillingRegistryService),
      layout: signal({ signal: layoutSignal } as LayoutService),
      projectRuntime: signal(projectRuntime),
      settings: signal({} as SettingsRegistryService),
      systemIO: signal({} as SystemIORegistryService),
    },
    isLoggedIn,
    token,
  }
}

function createController(projectPath: string) {
  const dispose = vi.fn()
  const updateAuthToken = vi.fn()
  const controller = {
    dispose,
    projectPath,
    updateAuthToken,
  } as unknown as ZookeeperSessionController

  return { controller, dispose, updateAuthToken }
}

function createControllerLoader() {
  const controllers: ReturnType<typeof createController>[] = []
  const createZookeeperSessionController = vi.fn(
    (deps: ZookeeperSessionControllerDependencies) => {
      const controller = createController(deps.projectPath)
      controllers.push(controller)
      return controller.controller
    }
  )
  const loadController = vi.fn(async () => ({
    createZookeeperSessionController,
  }))

  return { controllers, createZookeeperSessionController, loadController }
}

describe('Zookeeper runtime', () => {
  it('starts lazily only after the pane is opened and auth is hydrated', async () => {
    const { layoutSignal, services, token } = createServices({ apiToken: '' })
    const { createZookeeperSessionController, loadController } =
      createControllerLoader()
    const runtime = createZookeeperRuntime(services, loadController)

    await Promise.resolve()
    expect(loadController).not.toHaveBeenCalled()

    layoutSignal.value = zookeeperPaneLayout(true)
    await Promise.resolve()
    expect(loadController).not.toHaveBeenCalled()

    token.value = 'hydrated-token'

    await vi.waitFor(() => {
      expect(createZookeeperSessionController).toHaveBeenCalledOnce()
    })
    expect(createZookeeperSessionController).toHaveBeenCalledWith(
      expect.objectContaining({
        apiToken: 'hydrated-token',
        projectPath: '/project',
      })
    )

    runtime.dispose()
  })

  it('retains the same controller when the pane closes and reopens', async () => {
    const { layoutSignal, services } = createServices()
    const { controllers, createZookeeperSessionController, loadController } =
      createControllerLoader()
    const runtime = createZookeeperRuntime(services, loadController)

    layoutSignal.value = zookeeperPaneLayout(true)
    await vi.waitFor(() => {
      expect(createZookeeperSessionController).toHaveBeenCalledOnce()
    })
    expect(runtime.session.value).toBe(controllers[0]?.controller)
    const session = runtime.session.value

    layoutSignal.value = zookeeperPaneLayout(false)
    expect(controllers[0]?.dispose).not.toHaveBeenCalled()

    layoutSignal.value = zookeeperPaneLayout(true)

    expect(runtime.session.value).toBe(session)
    expect(loadController).toHaveBeenCalledOnce()
    expect(createZookeeperSessionController).toHaveBeenCalledOnce()
    expect(controllers[0]?.dispose).not.toHaveBeenCalled()

    runtime.dispose()
    expect(controllers[0]?.dispose).toHaveBeenCalledOnce()
  })

  it('updates auth in place without replacing the controller', async () => {
    const { layoutSignal, services, token } = createServices()
    const { controllers, createZookeeperSessionController, loadController } =
      createControllerLoader()
    const runtime = createZookeeperRuntime(services, loadController)

    layoutSignal.value = zookeeperPaneLayout(true)
    await vi.waitFor(() => {
      expect(createZookeeperSessionController).toHaveBeenCalledOnce()
    })
    expect(runtime.session.value).toBe(controllers[0]?.controller)
    const session = runtime.session.value

    token.value = 'rotated-token'

    await vi.waitFor(() => {
      expect(controllers[0]?.updateAuthToken).toHaveBeenCalledWith(
        'rotated-token'
      )
    })
    expect(runtime.session.value).toBe(session)
    expect(createZookeeperSessionController).toHaveBeenCalledOnce()

    runtime.dispose()
  })

  it('retains an active controller through a transient blank token', async () => {
    const { layoutSignal, services, token } = createServices()
    const { controllers, createZookeeperSessionController, loadController } =
      createControllerLoader()
    const runtime = createZookeeperRuntime(services, loadController)

    layoutSignal.value = zookeeperPaneLayout(true)
    await vi.waitFor(() => {
      expect(createZookeeperSessionController).toHaveBeenCalledOnce()
    })
    const session = runtime.session.value

    token.value = ''
    await vi.waitFor(() => {
      expect(controllers[0]?.updateAuthToken).toHaveBeenCalledWith('')
    })
    expect(runtime.session.value).toBe(session)
    expect(controllers[0]?.dispose).not.toHaveBeenCalled()

    token.value = 'refreshed-token'
    await vi.waitFor(() => {
      expect(controllers[0]?.updateAuthToken).toHaveBeenLastCalledWith(
        'refreshed-token'
      )
    })
    expect(runtime.session.value).toBe(session)
    expect(createZookeeperSessionController).toHaveBeenCalledOnce()

    runtime.dispose()
  })

  it('stops on auth loss and starts fresh after login', async () => {
    const { isLoggedIn, layoutSignal, services } = createServices()
    const { controllers, createZookeeperSessionController, loadController } =
      createControllerLoader()
    const runtime = createZookeeperRuntime(services, loadController)

    layoutSignal.value = zookeeperPaneLayout(true)
    await vi.waitFor(() => {
      expect(createZookeeperSessionController).toHaveBeenCalledOnce()
    })

    isLoggedIn.value = false
    await vi.waitFor(() => {
      expect(controllers[0]?.dispose).toHaveBeenCalledOnce()
    })
    expect(runtime.session.value).toBeUndefined()

    isLoggedIn.value = true
    await vi.waitFor(() => {
      expect(createZookeeperSessionController).toHaveBeenCalledTimes(2)
    })
    expect(runtime.session.value).toBe(controllers[1]?.controller)

    runtime.dispose()
  })

  it('stops a stale project and waits to start the hidden replacement', async () => {
    const { currentProject, layoutSignal, services } = createServices({
      projectPath: '/first',
    })
    const { controllers, createZookeeperSessionController, loadController } =
      createControllerLoader()
    const runtime = createZookeeperRuntime(services, loadController)

    layoutSignal.value = zookeeperPaneLayout(true)
    await vi.waitFor(() => {
      expect(createZookeeperSessionController).toHaveBeenCalledOnce()
    })
    expect(runtime.session.value).toBe(controllers[0]?.controller)
    layoutSignal.value = zookeeperPaneLayout(false)
    currentProject.value = createProject('/second')

    await vi.waitFor(() => {
      expect(controllers[0]?.dispose).toHaveBeenCalledOnce()
    })
    expect(runtime.session.value).toBeUndefined()
    expect(createZookeeperSessionController).toHaveBeenCalledOnce()

    layoutSignal.value = zookeeperPaneLayout(true)

    await vi.waitFor(() => {
      expect(createZookeeperSessionController).toHaveBeenCalledTimes(2)
    })
    expect(runtime.session.value).toBe(controllers[1]?.controller)

    runtime.dispose()
    expect(controllers[1]?.dispose).toHaveBeenCalledOnce()
  })

  it('does not create a controller when disposed during its lazy load', async () => {
    const { layoutSignal, services } = createServices()
    const controllerModule = deferred<{
      createZookeeperSessionController: (
        deps: ZookeeperSessionControllerDependencies
      ) => ZookeeperSessionController
    }>()
    const createZookeeperSessionController = vi.fn(
      (deps: ZookeeperSessionControllerDependencies) =>
        createController(deps.projectPath).controller
    )
    const loadController = vi.fn(() => controllerModule.promise)
    const runtime = createZookeeperRuntime(services, loadController)

    layoutSignal.value = zookeeperPaneLayout(true)
    await Promise.resolve()
    expect(loadController).toHaveBeenCalledOnce()

    runtime.dispose()
    controllerModule.resolve({ createZookeeperSessionController })
    await Promise.resolve()
    await Promise.resolve()

    expect(createZookeeperSessionController).not.toHaveBeenCalled()
    expect(runtime.session.value).toBeUndefined()
  })
})
