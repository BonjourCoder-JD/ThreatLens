import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import { createCaseFromEvents, transitionCase, confirmIncident } from './case-actions'

export const actions: Record<string, ActionHandler<Env>> = {
  createCaseFromEvents,
  transitionCase,
  confirmIncident,
}
