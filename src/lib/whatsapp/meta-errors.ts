/**
 * Phase 1: preserve Meta's machine-readable failure metadata.
 * A retry candidate is not permission to resend: a future durable worker
 * must also check consent, eligibility, idempotency and rate limits.
 */
export type MetaFailureKind =
  | 'rate_limited'
  | 'policy_blocked'
  | 'authentication'
  | 'template_or_window'
  | 'rejected'
  | 'unknown_outcome'

export class MetaApiError extends Error {
  readonly kind: MetaFailureKind

  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message)
    this.name = 'MetaApiError'
    this.kind = classifyMetaFailure(httpStatus, code)
  }
}

export function classifyMetaFailure(
  httpStatus: number,
  code?: number,
): MetaFailureKind {
  // A policy restriction is never an automatic retry candidate.
  if (code === 131049 || code === 131048) return 'policy_blocked'
  if (code === 190 || httpStatus === 401 || httpStatus === 403)
    return 'authentication'
  if (code === 131047 || (code !== undefined && code >= 132000 && code < 133000))
    return 'template_or_window'
  // Ambiguous gateway/server responses may hide an accepted send.
  if (httpStatus >= 500 || httpStatus === 408 || httpStatus < 400)
    return 'unknown_outcome'
  // Require an explicit Meta rate-limit error, not just a proxy HTTP 429.
  if (code === 130429 || code === 131056 || code === 80007)
    return 'rate_limited'
  return 'rejected'
}

export async function readMetaApiError(
  response: Response,
  fallback: string,
): Promise<MetaApiError> {
  let message = fallback
  let code: number | undefined
  let subcode: number | undefined
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown; code?: unknown; error_subcode?: unknown }
    } | null
    if (typeof body?.error?.message === 'string' && body.error.message)
      message = body.error.message
    if (typeof body?.error?.code === 'number') code = body.error.code
    if (typeof body?.error?.error_subcode === 'number')
      subcode = body.error.error_subcode
  } catch {
    // Non-JSON response: retain the fallback and HTTP status.
  }
  return new MetaApiError(message, response.status, code, subcode)
}

/** Bounded exponential backoff for explicit rate-limit rejections only.
 * failedAttempts includes the initial failed send. No scheduling occurs here.
 * null means stop and require review; never use this for network timeouts.
 */
export function retryDelayMs(
  error: unknown,
  failedAttempts: number,
): number | null {
  if (
    !(error instanceof MetaApiError) ||
    error.kind !== 'rate_limited' ||
    !Number.isInteger(failedAttempts) ||
    failedAttempts < 1 ||
    failedAttempts >= 4
  ) return null
  return 60_000 * 2 ** (failedAttempts - 1)
}
