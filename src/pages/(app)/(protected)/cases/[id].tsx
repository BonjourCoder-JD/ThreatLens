/**
 * Case detail — status/priority/assignment, linked events with their
 * detection explanations, and a chronological note thread.
 *
 * Status/priority/assignedTo changes go through the `transitionCase`
 * server action, NOT a direct `useMutations.put` — this is the
 * incident-management extension's actual security boundary.
 * `src/schemas/cases-schema.ts`'s `member.writableFields` now excludes
 * these fields, so a direct client write to any of them is rejected by
 * the Durable Object itself; `transitionCase` is the only path that can
 * still change them, specifically because it goes through the
 * RBAC-bypassing `X-App-Action` mechanism and records an activity entry
 * for every change. `summary` and notes remain plain client mutations —
 * nothing about THEM needed to become server-mediated. See
 * docs/ARCHITECTURE.md ("Incident-management extension") for the full
 * rationale and docs/CODE_WALKTHROUGH.md for the data flow.
 */

import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutations, useUsers, useUserLookup, useAuth, useUser } from 'deepspace'
import {
  Badge,
  Button,
  Textarea,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Label,
  ConfirmModal,
  useToast,
} from '@/components/ui'
import { EventReasons } from '@/components/EventReasons'
import { callAction } from '@/lib/call-action'

interface CaseRecord {
  title: string
  status: string
  priority: string
  assignedTo?: string
  relatedEventIds?: string[]
  summary?: string
}

interface NoteRecord {
  caseId: string
  body: string
}

interface AuthEventRecord {
  timestamp: number
  actorId: string
  city: string
  country: string
  device: string
  eventType: string
  success: number
  statAnomalyScore?: number
  statReasons?: string[]
}

const STATUS_OPTIONS = ['open', 'investigating', 'resolved', 'false_positive']
const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  investigating: 'Investigating',
  resolved: 'Resolved',
  false_positive: 'False positive',
}
const PRIORITY_OPTIONS = ['low', 'medium', 'high']

export default function CaseDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { error: toastError, success: toastSuccess } = useToast()
  const { userId } = useAuth()
  const { user } = useUser()
  const isAdmin = user?.role === 'admin'

  const { records: cases, status: casesStatus } = useQuery<CaseRecord>('cases', { limit: 500 })
  const { records: authEvents } = useQuery<AuthEventRecord>('authEvents', { limit: 2000 })
  const { records: notes, status: notesStatus } = useQuery<NoteRecord>('caseNotes', {
    where: { caseId: id },
    orderBy: 'createdAt',
    orderDir: 'asc',
    limit: 500,
  })

  const { users } = useUsers()
  const { getName } = useUserLookup()
  const { removeConfirmed } = useMutations<CaseRecord>('cases')
  const { createConfirmed } = useMutations<NoteRecord>('caseNotes')

  const [noteText, setNoteText] = useState('')
  const [submittingNote, setSubmittingNote] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function handleTransition(field: 'status' | 'severity' | 'priority' | 'assignedTo', value: string) {
    const result = await callAction('transitionCase', { caseId: id, field, value })
    if (!result.success) {
      toastError(`Could not change ${field}`, result.error)
      return
    }
    const data = result.data as { activityRecorded: boolean }
    if (!data.activityRecorded) {
      // The change itself succeeded — only the activity-log write failed.
      // Non-atomic by design (see src/actions/case-actions.ts); surfaced
      // honestly rather than silently dropped.
      toastError('Change saved, but the activity record failed to save', 'See the Activity tab for a possible gap.')
    }
  }

  if (casesStatus === 'loading') {
    return <div className="flex h-64 items-center justify-center text-muted-foreground">Loading case…</div>
  }

  const theCase = cases.find((c) => c.recordId === id)
  if (!theCase) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-20">
        <EmptyState
          title="Case not found"
          description="It may have been deleted, or you may not have access to it."
          action={{ label: 'Back to cases', onClick: () => navigate('/cases') }}
        />
      </div>
    )
  }

  const linkedEvents = authEvents.filter((e) => theCase.data.relatedEventIds?.includes(e.recordId))
  const canDelete = isAdmin || theCase.createdBy === userId

  async function handleAddNote() {
    const body = noteText.trim()
    if (!body || !id) return
    setSubmittingNote(true)
    try {
      await createConfirmed({ caseId: id, body })
      setNoteText('')
    } catch (e) {
      toastError('Could not add note', e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setSubmittingNote(false)
    }
  }

  async function handleDelete() {
    if (!id) return
    setDeleting(true)
    try {
      await removeConfirmed(id)
      toastSuccess('Case deleted')
      navigate('/cases')
    } catch (e) {
      toastError('Could not delete case', e instanceof Error ? e.message : 'Unknown error')
      setDeleting(false)
      setConfirmingDelete(false)
    }
  }

  return (
    <div className="min-h-full text-foreground">
      <div className="mx-auto max-w-4xl px-6 py-12">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">{theCase.data.title}</h1>
            {theCase.data.summary && <p className="mt-2 text-sm text-muted-foreground">{theCase.data.summary}</p>}
          </div>
          {canDelete && (
            <Button variant="destructive" size="sm" onClick={() => setConfirmingDelete(true)}>
              Delete case
            </Button>
          )}
        </div>

        <div className="mb-6 grid grid-cols-1 gap-4 rounded-xl border border-border bg-card p-5 shadow-[0_1px_3px_0_rgba(23,37,84,0.08)] sm:grid-cols-3">
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Status</Label>
            <Select value={theCase.data.status} onValueChange={(v) => void handleTransition('status', v)}>
              <SelectTrigger data-testid="case-status-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Priority</Label>
            <Select value={theCase.data.priority} onValueChange={(v) => void handleTransition('priority', v)}>
              <SelectTrigger data-testid="case-priority-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITY_OPTIONS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p[0].toUpperCase() + p.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Assigned to</Label>
            <Select
              value={theCase.data.assignedTo || 'unassigned'}
              onValueChange={(v) => void handleTransition('assignedTo', v === 'unassigned' ? '' : v)}
            >
              <SelectTrigger data-testid="case-assignee-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <section className="mb-6">
          <h2 className="mb-3 text-sm font-semibold text-foreground">
            Linked events ({linkedEvents.length})
          </h2>
          {linkedEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events are linked to this case.</p>
          ) : (
            <div className="space-y-3" data-testid="case-linked-events">
              {linkedEvents.map((e) => (
                <div
                  key={e.recordId}
                  className="rounded-xl border border-border bg-card p-4 shadow-[0_1px_3px_0_rgba(23,37,84,0.08)]"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{e.data.actorId}</span>
                    <span className="text-muted-foreground">{new Date(e.data.timestamp * 1000).toLocaleString()}</span>
                    <Badge variant={e.data.success ? 'secondary' : 'destructive'} size="sm">
                      {e.data.eventType}
                    </Badge>
                    <span className="text-muted-foreground">
                      {e.data.city}, {e.data.country} · {e.data.device}
                    </span>
                  </div>
                  <EventReasons reasons={e.data.statReasons ?? []} />
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold text-foreground">Notes</h2>
          <div className="mb-4 space-y-3" data-testid="case-notes">
            {notesStatus === 'loading' ? (
              <p className="text-sm text-muted-foreground">Loading notes…</p>
            ) : notes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No notes yet. Be the first to add context.</p>
            ) : (
              notes.map((n) => (
                <div key={n.recordId} data-testid="case-note" className="rounded-xl border border-border bg-card p-4">
                  <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{getName(n.createdBy) ?? 'Unknown analyst'}</span>
                    <span>{new Date(n.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{n.data.body}</p>
                </div>
              ))
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-4 shadow-[0_1px_3px_0_rgba(23,37,84,0.08)]">
            <Textarea
              data-testid="case-note-input"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Add a note for the next analyst…"
              rows={3}
              maxLength={4000}
            />
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                data-testid="case-note-submit"
                onClick={handleAddNote}
                loading={submittingNote}
                disabled={!noteText.trim()}
              >
                Add note
              </Button>
            </div>
          </div>
        </section>
      </div>

      <ConfirmModal
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        onConfirm={handleDelete}
        title="Delete this case?"
        description="This removes the case permanently. Linked events and their scores are not affected."
        confirmText="Delete"
        loading={deleting}
      />
    </div>
  )
}
