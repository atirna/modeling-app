import {
  defineRegistryItemFactory,
  defineRuntimeRegistryItem,
  provide,
} from '@kittycad/registry'
import {
  computed,
  effect,
  signal,
  type ReadonlySignal,
} from '@preact/signals-core'
import { useSignals } from '@preact/signals-react/runtime'
import type { BillingRegistryService } from '@src/lib/billing'
import {
  AreaType,
  type AreaTypeComponentProps,
  type Layout,
  type LayoutService,
  LayoutType,
} from '@src/lib/layout/types'
import type {
  ZookeeperSessionController,
  ZookeeperSessionControllerDependencies,
} from '@src/lib/zookeeper/registry/controller'
import { zookeeperPromptRunningSignal } from '@src/lib/zookeeper/zookeeperPromptState'
import {
  authService,
  type AuthRegistryService,
} from '@src/registry/contracts/auth'
import { billingService } from '@src/registry/contracts/billing'
import {
  debugService,
  type DebugRegistryService,
} from '@src/registry/contracts/debug'
import {
  layoutAreaLibraryValueSpec,
  layoutService,
} from '@src/registry/contracts/layout'
import {
  projectRuntimeService,
  type ProjectRuntimeRegistryService,
} from '@src/registry/contracts/projectRuntime'
import {
  settingsService,
  type SettingsRegistryService,
} from '@src/registry/contracts/settings'
import {
  systemIOService,
  type SystemIORegistryService,
} from '@src/registry/contracts/systemIO'
import { lazy, Suspense } from 'react'

const ZookeeperConversationPaneWrapper = lazy(async () => {
  const { ZookeeperConversationPaneWrapper } = await import(
    '@src/lib/zookeeper/components/ZookeeperConversationPaneWrapper'
  )
  return { default: ZookeeperConversationPaneWrapper }
})

type ZookeeperRuntime = ReturnType<typeof createZookeeperRuntime>

type ZookeeperRuntimeServices = {
  auth: ReadonlySignal<AuthRegistryService | undefined>
  billing: ReadonlySignal<BillingRegistryService | undefined>
  debug?: ReadonlySignal<DebugRegistryService | undefined>
  layout: ReadonlySignal<LayoutService | undefined>
  projectRuntime: ReadonlySignal<ProjectRuntimeRegistryService | undefined>
  settings: ReadonlySignal<SettingsRegistryService | undefined>
  systemIO: ReadonlySignal<SystemIORegistryService | undefined>
}

type ZookeeperSessionControllerModule = {
  createZookeeperSessionController: (
    deps: ZookeeperSessionControllerDependencies
  ) => ZookeeperSessionController
}

type ZookeeperActivation = {
  apiToken: string
  controller?: ZookeeperSessionController
  projectPath: string
}

const loadZookeeperSessionController = () =>
  import('@src/lib/zookeeper/registry/controller')

export function hasOpenZookeeperPane(rootLayout: Layout | undefined): boolean {
  if (!rootLayout) {
    return false
  }

  if (rootLayout.type === LayoutType.Simple) {
    return rootLayout.areaType === AreaType.Zookeeper
  }

  const children =
    rootLayout.type === LayoutType.Panes
      ? rootLayout.activeIndices.map((index) => rootLayout.children[index])
      : rootLayout.children
  return children.some(hasOpenZookeeperPane)
}

export function createZookeeperRuntime(
  services: ZookeeperRuntimeServices,
  loadController: () => Promise<ZookeeperSessionControllerModule> = loadZookeeperSessionController
) {
  const session = signal<ZookeeperSessionController | undefined>(undefined)
  const currentProject = computed(
    () => services.projectRuntime.value?.current.value?.projectIORefSignal.value
  )
  let activation: ZookeeperActivation | undefined
  let disposed = false
  let stopObserver: (() => void) | undefined

  const deactivate = () => {
    const previous = activation
    activation = undefined
    session.value = undefined
    previous?.controller?.dispose()
  }

  const reconcile = () => {
    if (disposed) {
      return
    }

    const auth = services.auth.value
    const billing = services.billing.value
    const debug = services.debug?.value
    const layout = services.layout.value
    const projectRuntime = services.projectRuntime.value
    const settings = services.settings.value
    const systemIO = services.systemIO.value
    const projectPath =
      projectRuntime?.current.value?.projectIORefSignal.value.path
    const apiToken = auth?.token.value ?? ''
    const isLoggedIn = auth?.isLoggedIn.value ?? false

    if (activation && activation.projectPath !== projectPath) {
      deactivate()
    }
    const currentActivation = activation
    if (currentActivation && currentActivation.projectPath === projectPath) {
      if (!isLoggedIn) {
        deactivate()
        return
      }
      if (currentActivation.apiToken !== apiToken) {
        currentActivation.apiToken = apiToken
        currentActivation.controller?.updateAuthToken(apiToken)
      }
      return
    }

    if (
      !projectPath ||
      !hasOpenZookeeperPane(layout?.signal.value) ||
      !isLoggedIn ||
      !apiToken.trim() ||
      !auth ||
      !billing ||
      !projectRuntime ||
      !settings ||
      !systemIO
    ) {
      return
    }

    const next: ZookeeperActivation = { apiToken, projectPath }
    activation = next
    void loadController()
      .then(({ createZookeeperSessionController }) => {
        if (disposed || activation !== next) {
          return
        }

        const controller = createZookeeperSessionController({
          apiToken: next.apiToken,
          billing,
          debug,
          projectPath,
          projectRuntime,
          settings,
          systemIO,
        })
        if (disposed || activation !== next) {
          controller.dispose()
          return
        }
        next.controller = controller
        session.value = controller
      })
      .catch((error: unknown) => {
        if (disposed || activation !== next) {
          return
        }
        activation = undefined
        console.error('Failed to start the Zookeeper session.', error)
      })
  }

  const observe = () => {
    if (disposed || stopObserver) {
      return
    }
    stopObserver = effect(reconcile)
  }

  // Runtime services are installed after registry items are flattened.
  queueMicrotask(observe)

  return {
    currentProject,
    session,
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      stopObserver?.()
      deactivate()
    },
  }
}

function ZookeeperPaneOutlet({
  areaConfig,
  layout,
  onClose,
  runtime,
}: AreaTypeComponentProps & { runtime: ZookeeperRuntime }) {
  useSignals()
  const project = runtime.currentProject.value
  const controller = runtime.session.value
  const projectPath = project?.path

  if (!project || !controller || controller.projectPath !== projectPath) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <ZookeeperConversationPaneWrapper
        areaConfig={areaConfig}
        layout={layout}
        onClose={onClose}
        controller={controller}
        theProject={project}
      />
    </Suspense>
  )
}

export const zookeeperPaneRuntimeRegistryItem = defineRegistryItemFactory(
  (ctx) => {
    const runtime = createZookeeperRuntime({
      auth: ctx.services.signal(authService),
      billing: ctx.services.signal(billingService),
      debug: ctx.services.signal(debugService),
      layout: ctx.services.signal(layoutService),
      projectRuntime: ctx.services.signal(projectRuntimeService),
      settings: ctx.services.signal(settingsService),
      systemIO: ctx.services.signal(systemIOService),
    })

    const PaneOutlet = (props: AreaTypeComponentProps) => (
      <ZookeeperPaneOutlet {...props} runtime={runtime} />
    )

    return {
      item: defineRuntimeRegistryItem({
        id: 'zookeeper.pane-runtime',
        provides: [
          provide(layoutAreaLibraryValueSpec, {
            [AreaType.Zookeeper]: {
              hide: () => false,
              shortcut: 'Ctrl + T',
              cssClassOverrides: {
                button:
                  'bg-ml-green pressed:bg-transparent dark:!text-chalkboard-100 hover:dark:!text-inherit dark:pressed:!text-inherit',
              },
              getIcon(isOpen) {
                return !isOpen && zookeeperPromptRunningSignal.value
                  ? 'loading'
                  : undefined
              },
              Component: PaneOutlet,
            },
          }),
        ],
        dispose: () => runtime.dispose(),
      }),
    }
  },
  'zookeeper.pane-runtime'
)
