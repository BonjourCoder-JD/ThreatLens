import { getAuthToken } from 'deepspace'

/**
 * Minimal client for POSTing to a server action, per the server-actions
 * guide's documented call pattern. One helper so every call site handles
 * the response shape (`{ success, data } | { success, error }`) the same
 * way instead of re-implementing the fetch.
 */
export async function callAction<T = unknown>(
  name: string,
  params: Record<string, unknown>,
): Promise<{ success: true; data: T } | { success: false; error: string }> {
  const token = await getAuthToken()
  const res = await fetch(`/api/actions/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token ?? ''}`,
    },
    body: JSON.stringify(params),
  })
  return (await res.json()) as { success: true; data: T } | { success: false; error: string }
}
