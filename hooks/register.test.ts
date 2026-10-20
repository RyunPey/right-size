import { expect, mock, test } from 'claude-code/testing'

const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const answer = (text: string) => ({ isAnswered: true, text, usage })

// Registers the engine's side: the judge's replies in order, the context size, and a request that runs the model it is sent.
const setup = ($: any, on: any, judge: object[], contextTokens: number) => {
  const sent: { model: string; effort?: unknown }[] = []
  const status: (string | undefined)[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('model.complete', () => ({ value: judge.shift() }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: contextTokens, window: 200_000 }, rateLimits: [] } }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('ui.status', (_$: any, e: any) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('turn.step', async function* (_$: any, e: any) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: e.model } }
  })

  // One prompt and one request of a turn on the session's Opus.
  const turn = async (turnId: string) => {
    await $.prompt.submit({ text: `task for ${turnId}` })
    const stream = $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })
    for await (const _ of stream) void _
    return sent.at(-1)
  }

  return { clock, status, turn }
}

test('applies the judge pick', async ($, on) => {
  const { turn } = setup($, on, [answer('sonnet medium')], 0)
  expect(await turn('t1')).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
})

test('stays on the current model while a big chat is hot, changing effort only', async ($, on) => {
  const { clock, status, turn } = setup($, on, [answer('opus high'), answer('sonnet low')], 100_000)
  await turn('t1')
  await clock.advance(60_000)

  expect(await turn('t2')).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
  expect(status.at(-1)).toBe('opus · low (kept: cache hot)')
})

test('switches when the chat is small', async ($, on) => {
  const { clock, turn } = setup($, on, [answer('opus high'), answer('sonnet low')], 10_000)
  await turn('t1')
  await clock.advance(60_000)

  expect(await turn('t2')).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
})

test('switches when the cache has gone cold', async ($, on) => {
  const { clock, turn } = setup($, on, [answer('opus high'), answer('sonnet low')], 100_000)
  await turn('t1')
  await clock.advance(2 * 60 * 60 * 1000)

  expect(await turn('t2')).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
})

test('leaves the request alone when the judge fails', async ($, on) => {
  const { turn } = setup($, on, [{ isAnswered: false, reason: 'empty-reply', usage }], 0)
  expect(await turn('t1')).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
})
