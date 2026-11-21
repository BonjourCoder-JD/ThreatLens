/**
 * Opens a case from one or more event ids via the `createCaseFromEvents`
 * server action (src/actions/case-actions.ts). Used from both the
 * dashboard's multi-select bar and its single-event detail modal.
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Input, Textarea, Label, Modal } from '@/components/ui'
import { useToast } from '@/components/ui'
import { callAction } from '@/lib/call-action'

export function CreateCaseModal({ eventIds, onClose }: { eventIds: string[]; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const { success: toastSuccess } = useToast()

  async function handleSubmit() {
    setError(null)
    if (!title.trim()) {
      setError('A case title is required.')
      return
    }
    setSubmitting(true)
    const result = await callAction<{ caseId: string }>('createCaseFromEvents', {
      title: title.trim(),
      summary: summary.trim(),
      eventIds,
    })
    setSubmitting(false)
    if (!result.success) {
      setError(result.error)
      return
    }
    toastSuccess('Case opened', `Linked ${eventIds.length} event${eventIds.length === 1 ? '' : 's'}.`)
    onClose()
    navigate(`/cases/${result.data.caseId}`)
  }

  return (
    <Modal open onClose={onClose} size="md">
      <Modal.Header>
        <Modal.Title>Open a case</Modal.Title>
        <Modal.Description>
          Linking {eventIds.length} event{eventIds.length === 1 ? '' : 's'}.
        </Modal.Description>
      </Modal.Header>
      <Modal.Body>
        <div className="space-y-4">
          <div>
            <Label htmlFor="case-title" className="mb-1 block text-xs text-muted-foreground">
              Title
            </Label>
            <Input
              id="case-title"
              data-testid="case-title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Suspicious burst from user_045"
              maxLength={200}
            />
          </div>
          <div>
            <Label htmlFor="case-summary" className="mb-1 block text-xs text-muted-foreground">
              Summary (optional)
            </Label>
            <Textarea
              id="case-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What should the next analyst know?"
              rows={3}
              maxLength={4000}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" data-testid="create-case-error">
              {error}
            </p>
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} loading={submitting} data-testid="create-case-submit">
          Open case
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
