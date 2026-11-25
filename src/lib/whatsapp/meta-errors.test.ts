import { describe, expect, it, vi } from 'vitest'
import { classifyMetaFailure, MetaApiError, readMetaApiError, retryDelayMs } from './meta-errors'
import { sendTextMessage } from './meta-api'

describe('Phase 1 Meta error handling', () => {
  it.each([
    [400, 131049, 'policy_blocked'],
    [429, 131048, 'policy_blocked'],
    [400, 130429, 'rate_limited'],
    [429, 131056, 'rate_limited'],
    [400, 80007, 'rate_limited'],
    [401, 190, 'authentication'],
    [400, 131047, 'template_or_window'],
    [400, 132001, 'template_or_window'],
    [503, 130429, 'unknown_outcome'],
    [408, undefined, 'unknown_outcome'],
    [429, undefined, 'rejected'],
    [400, undefined, 'rejected'],
  ] as const)('classifies %s / %s as %s', (status, code, expected) => {
    expect(classifyMetaFailure(status, code)).toBe(expected)
  })

  it('preserves the API message, HTTP status, code and subcode', async () => {
    const response = new Response(JSON.stringify({
      error: { message: 'Restricted', code: 131049, error_subcode: 42 },
    }), { status: 400 })
    const error = await readMetaApiError(response, 'Fallback')
    expect(error).toMatchObject({
      message: 'Restricted', httpStatus: 400, code: 131049,
      subcode: 42, kind: 'policy_blocked',
    })
    expect(error).toBeInstanceOf(Error)
  })

  it('handles a non-JSON response without losing its status', async () => {
    const error = await readMetaApiError(
      new Response('Bad gateway', { status: 502 }), 'Fallback',
    )
    expect(error).toMatchObject({ message: 'Fallback', kind: 'unknown_outcome' })
  })

  it('bounds retries to explicit rate-limit failures', () => {
    const error = new MetaApiError('Rate limited', 429, 130429)
    expect([1, 2, 3, 4].map(n => retryDelayMs(error, n)))
      .toEqual([60_000, 120_000, 240_000, null])
    expect(retryDelayMs(error, 0)).toBeNull()
    expect(retryDelayMs(error, 1.5)).toBeNull()
    expect(retryDelayMs(new MetaApiError('Policy', 400, 131049), 1)).toBeNull()
    expect(retryDelayMs(new MetaApiError('Gateway', 502), 1)).toBeNull()
    expect(retryDelayMs(new Error('Network timeout'), 1)).toBeNull()
  })

  it('keeps the existing send path single-attempt and surfaces structured errors', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'Policy restriction', code: 131049 } }),
      { status: 400 },
    ))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(sendTextMessage({
        phoneNumberId: 'test', accessToken: 'test', to: '1234567890', text: 'test',
      })).rejects.toMatchObject({
        message: 'Policy restriction', code: 131049, kind: 'policy_blocked',
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
