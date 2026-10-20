import { expect, mock, test } from 'claude-code/testing'

const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const answer = (text: string) => ({ isAnswered: true, text, usage })
const summary = { role: 'user', text: 'summary of the chat', toolUses: [] }

// Registers the engine's side: the judge's replies in order, the context size, and a request that runs the model it is sent.
const setup = ($: any, on: any, judge: object[], contextTokens: number) => {
  const sent: { model: string; effort?: unknown }[] = []
  // The model the API reports as having answered; unset, the one requested.
  let ranAs: string | undefined
  const status: (string | undefined)[] = []
  const asked: string[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('model.complete', (_$: any, e: any) => {
    asked.push(e.prompt)
    const reply = judge.shift()
    if (reply instanceof Error) throw reply
    return { value: reply }
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: contextTokens, window: 200_000 }, rateLimits: [] } }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('ui.status', (_$: any, e: any) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('turn.step', async function* (_$: any, e: any) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...usage, model: ranAs ?? e.model } }
  })

  // One prompt and one request of a turn on the session's model (Opus unless given).
  const turn = async (turnId: string, session = 'claude-opus-5-5', prompt: object = { text: `task for ${turnId}` }) => {
    await $.prompt.submit(prompt)
    return step({ turnId, index: 0, model: session, effort: 'high', messageCount: 1 })
  }
  const step = async (input: object) => {
    for await (const _ of $.turn.step(input)) void _
    return sent.at(-1)
  }
  const runAs = (model: string) => {
    ranAs = model
  }
  // The end of a turn with its final answer, on the main loop unless an agentId is given.
  const complete = (turnId: string, answer: string, agentId?: string) =>
    $.turn.complete({ turnId, answer, durationMs: 1, isAborted: false, reason: 'completed', agentId })

  return { clock, status, asked, turn, step, runAs, complete }
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

test('falls back when the judge rambles instead of answering in the format', async ($, on) => {
  const { status, turn } = setup($, on, [answer('opus high (haiku would be too weak)')], 0)
  expect(await turn('t1')).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  expect(status).toContain('right-size: no pick, using session default')
})

test('accepts a well-formed answer with any case and a trailing period', async ($, on) => {
  const { turn } = setup($, on, [answer(' Sonnet Medium normal.\n')], 0)
  expect(await turn('t1')).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
})

test('a judge that throws drops the previous pick and says so', async ($, on) => {
  const { status, turn } = setup($, on, [answer('sonnet low normal'), new Error('network down')], 0)
  expect(await turn('t1')).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })

  expect(await turn('t2')).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  expect(status.at(-1)).toBe('right-size: no pick, using session default')
})

// The /config menu's mode row, as config.set writes it and config.list reads it.
const configRow = (on: any, mode = 'model-and-effort') => {
  on('config.set', (_$: any, e: any) => {
    mode = e.value
    return { value: e.value }
  })
  on('config.list', () => ({ value: [{ key: 'right-size.mode', label: 'Mode', kind: 'choice', value: mode, provider: { kind: 'plugin', name: 'right-size' } }] }))
}

test('/right-size-mode takes effect on the next turn and shows the new mode', async ($, on) => {
  configRow(on)
  const { turn } = setup($, on, [answer('sonnet low normal')], 0)
  await $.command.run({ command: 'right-size-mode', args: 'effort-only' })

  expect(await turn('t1')).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
  const { text } = await $.command.run({ command: 'right-size-mode', args: '' })
  expect(text).toBe('right-size mode: effort-only. Set it with /right-size-mode model-and-effort or effort-only.')
})

test('/clear forgets the pick and the hot cache', async ($, on) => {
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  const { clock, asked, status, turn } = setup($, on, [answer('opus high normal'), answer('sonnet low normal')], 100_000)
  await turn('t1')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(60_000)

  // "ok" would reuse the old pick; after /clear it is judged, and the old model's cache doesn't hold the new chat.
  expect(await turn('t2', 'claude-opus-5-5', { text: 'ok' })).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
  expect(asked).toHaveLength(2)
  expect(status.at(-1)).toBe('sonnet · low')
})

test('compaction forgets the hot cache but keeps the pick', async ($, on) => {
  on('session.compact', () => ({ messages: [summary] }))
  const { clock, turn } = setup($, on, [answer('opus high normal'), answer('sonnet low normal')], 100_000)
  await turn('t1')
  await $.session.compact({ trigger: 'manual', messages: [summary] })
  await clock.advance(60_000)

  expect(await turn('t2')).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
})

test('a skipped compaction keeps the cache hot', async ($, on) => {
  on('session.compact', () => ({ skip: 'not now' }))
  const { clock, turn } = setup($, on, [answer('opus high normal'), answer('sonnet low normal')], 100_000)
  await turn('t1')
  await $.session.compact({ trigger: 'manual', messages: [summary] })
  await clock.advance(60_000)

  expect(await turn('t2')).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
})

test('a follow-up skips the judge and keeps the last pick', async ($, on) => {
  const { asked, turn } = setup($, on, [answer('sonnet low normal')], 0)
  await turn('t1')

  expect(await turn('t2', 'claude-opus-5-5', { text: 'Go on!' })).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
  expect(asked).toHaveLength(1)
})

test('slash commands and meta prompts are never judged', async ($, on) => {
  const { asked } = setup($, on, [], 0)
  await $.prompt.submit({ text: '/review the diff', command: { name: 'review', args: 'the diff' } })
  await $.prompt.submit({ text: 'a hidden prompt', isMeta: true })

  expect(asked).toHaveLength(0)
})

test('leaves subagent steps alone', async ($, on) => {
  const { turn, step } = setup($, on, [answer('haiku low normal')], 0)
  await turn('t1')

  expect(await step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', effort: 'high', messageCount: 3, agentId: 'a1' }))
    .toEqual({ model: 'claude-opus-5-5', effort: 'high' })
})

test('a haiku pick sends no effort and labels the model alone', async ($, on) => {
  const { status, turn } = setup($, on, [answer('haiku high normal')], 0)
  expect(await turn('t1')).toEqual({ model: 'claude-haiku-5-5', effort: undefined })
  expect(status.at(-1)).toBe('haiku')
})

test('flags a request the engine ran on another model', async ($, on) => {
  const { status, turn, runAs } = setup($, on, [answer('sonnet medium normal')], 0)
  runAs('claude-opus-5-5')
  await turn('t1')

  expect(status.at(-1)).toBe('opus · medium (ran claude-opus-5-5)')
})

test('labels a model id no family matches by the id itself', async ($, on) => {
  const { status, turn, runAs } = setup($, on, [answer('sonnet medium normal')], 0)
  runAs('custom-model-1')
  await turn('t1')

  expect(status.at(-1)).toBe('custom-model-1 · medium (ran custom-model-1)')
})

test('a shorter cache lifetime lets a big chat switch sooner', { options: { cacheTtlMinutes: 5 } }, async ($, on) => {
  const { clock, turn } = setup($, on, [answer('opus high normal'), answer('sonnet low normal')], 100_000)
  await turn('t1')
  await clock.advance(10 * 60 * 1000)

  expect(await turn('t2')).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
})

test('a larger small-chat size lets a hot chat switch', { options: { smallContextTokens: 200_000 } }, async ($, on) => {
  const { clock, turn } = setup($, on, [answer('opus high normal'), answer('sonnet low normal')], 100_000)
  await turn('t1')
  await clock.advance(60_000)

  expect(await turn('t2')).toEqual({ model: 'claude-sonnet-5-5', effort: 'low' })
})

test('the first judge call has no conversation context', async ($, on) => {
  const { asked, turn } = setup($, on, [answer('sonnet low normal')], 0)
  await turn('t1')
  expect(asked[0]).toBe('Current model: none yet\n\ntask for t1')
})

test('the judge reads the previous pick and the start of the last answer', async ($, on) => {
  const { asked, turn, complete } = setup($, on, [answer('sonnet low normal'), answer('sonnet low normal')], 0)
  await turn('t1')
  await complete('t1', `Here   is\nthe fix. ${'x'.repeat(400)}`)
  await turn('t2')

  const lines = asked[1].split('\n')
  expect(lines[1]).toBe('Previous pick: sonnet low')
  expect(lines[2]).toBe(`Last answer: Here is the fix. ${'x'.repeat(300 - 'Here is the fix. '.length)}`)
  expect(asked[1].endsWith('\n\ntask for t2')).toBe(true)
})

test("a subagent's answer is not the last answer", async ($, on) => {
  const { asked, turn, complete } = setup($, on, [answer('sonnet low normal'), answer('sonnet low normal')], 0)
  await turn('t1')
  await complete('t1', 'main answer')
  await complete('a1', 'subagent report', 'agent-1')
  await turn('t2')
  expect(asked[1]).toContain('Last answer: main answer')
})

test('/clear drops the previous pick and the last answer from the judge', async ($, on) => {
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  const { asked, turn, complete } = setup($, on, [answer('sonnet low normal'), answer('sonnet low normal')], 0)
  await turn('t1')
  await complete('t1', 'old answer')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await turn('t2')
  expect(asked[1]).toBe('Current model: none yet\n\ntask for t2')
})
