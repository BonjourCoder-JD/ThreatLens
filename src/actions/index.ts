import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { createCaseFromEvents } from './case-actions'

export const actions: Record<string, ActionHandler<Env>> = {
  createCaseFromEvents,
}
