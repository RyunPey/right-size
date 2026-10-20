import { expect, mock, test } from 'claude-code/testing'

const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const answer = (text: string) => ({ isAnswered: true, text, usage })

// Registers the engine's side: the judge's replies in order, the context size, and a request that runs the model it is sent.
const setup = ($: any, on: any, judge: object[], contextTokens: number) => {
  const sent: { model: string; effort?: unknown }[] = []
  const status: (string | undefined)[] = []
  const asked: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('model.complete', (_$: any, e: any) => {
    asked.push(e.prompt)
    return { value: judge.shift() }
  })
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

  // One prompt and one request of a turn on the session's model (Opus unless given).
  const turn = async (turnId: string, session = 'claude-opus-5-5') => {
    await $.prompt.submit({ text: `task for ${turnId}` })
    const stream = $.turn.step({ turnId, index: 0, model: session, effort: 'high', messageCount: 1 })
    for await (const _ of stream) void _
    return sent.at(-1)
  }

  return { clock, status, asked, turn }
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

test('an urgent pick overrides the cache rule and switches up', async ($, on) => {
  const { clock, turn } = setup($, on, [answer('sonnet low normal'), answer('opus high urgent')], 100_000)
  await turn('t1')
  await clock.advance(60_000)

  expect(await turn('t2')).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
})

test('a normal pick still keeps the hot model', async ($, on) => {
  const { clock, status, turn } = setup($, on, [answer('sonnet low normal'), answer('opus high normal')], 100_000)
  await turn('t1')
  await clock.advance(60_000)

  expect(await turn('t2')).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' })
  expect(status.at(-1)).toBe('sonnet · high (kept: cache hot)')
})

test('the judge is told the model the chat is on', async ($, on) => {
  const { clock, asked, turn } = setup($, on, [answer('sonnet low normal'), answer('opus high normal')], 100_000)
  await turn('t1')
  await clock.advance(60_000)
  await turn('t2')

  expect(asked[0].startsWith('Current model: none yet')).toBe(true)
  expect(asked[1].startsWith('Current model: claude-sonnet-5-5')).toBe(true)
})

test('an urgent pick does not switch down over a hot cache', async ($, on) => {
  const { clock, status, turn } = setup($, on, [answer('opus high normal'), answer('sonnet low urgent')], 100_000)
  await turn('t1')
  await clock.advance(60_000)

  expect(await turn('t2')).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
  expect(status.at(-1)).toBe('opus · low (kept: cache hot)')
})

test('never picks above the session model, even when urgent', async ($, on) => {
  const { turn } = setup($, on, [answer('opus high urgent')], 0)
  expect(await turn('t1', 'claude-sonnet-5-5')).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' })
})

test('effort-only keeps the session model and applies the effort', { options: { mode: 'effort-only' } }, async ($, on) => {
  const { turn } = setup($, on, [answer('haiku low normal')], 0)
  expect(await turn('t1')).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
})

test('effort-only ignores an urgent pick for the model', { options: { mode: 'effort-only' } }, async ($, on) => {
  const { turn } = setup($, on, [answer('opus xhigh urgent')], 0)
  expect(await turn('t1', 'claude-sonnet-5-5')).toEqual({ model: 'claude-sonnet-5-5', effort: 'xhigh' })
})

test('/right-size-mode sets the mode option', async ($, on) => {
  const set: unknown[] = []
  on('config.set', (_$: any, e: any) => {
    set.push([e.key, e.value])
    return { value: e.value }
  })
  const { text } = await $.command.run({ command: 'right-size-mode', args: 'effort-only' })
  expect(text).toBe('right-size mode set to effort-only.')
  expect(set).toEqual([['right-size.mode', 'effort-only']])
})

test('/right-size-mode without a value shows the mode', async ($) => {
  const { text } = await $.command.run({ command: 'right-size-mode', args: '' })
  expect(text).toBe('right-size mode: model-and-effort. Set it with /right-size-mode model-and-effort or effort-only.')
})

test('leaves the request alone when the judge fails', async ($, on) => {
  const { turn } = setup($, on, [{ isAnswered: false, reason: 'empty-reply', usage }], 0)
  expect(await turn('t1')).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
})
