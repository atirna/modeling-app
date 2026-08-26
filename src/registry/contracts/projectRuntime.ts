import { defineContract, defineService } from '@kittycad/registry'
import type { ReadonlySignal } from '@preact/signals-core'
import type { KclManager, ZDSProject } from '@src/lang/KclManager'

export interface ProjectRuntimeRegistryService {
  readonly current: ReadonlySignal<ZDSProject | undefined>
  readonly kclManager: KclManager
}

export const projectRuntimeContract = defineContract({
  projectRuntimeService:
    defineService<ProjectRuntimeRegistryService>('project-runtime'),
})

export const { projectRuntimeService } = projectRuntimeContract
