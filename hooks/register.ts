import type { EngineInterface, ModelEffort, Register } from "claude-code";

type Tier = "haiku" | "sonnet" | "opus";
type Pick = { tier: Tier; effort: ModelEffort; urgent: boolean };

const TIERS: readonly Tier[] = ["haiku", "sonnet", "opus"];
const EFFORTS: readonly ModelEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const IDS: Record<Tier, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};
const NAMES = ["haiku", "sonnet", "opus", "fable"];
const MODES = ["model-and-effort", "effort-only"];
const NO_PICK = "right-size: no pick, using session default";

// Defaults for the cacheTtlMinutes and smallContextTokens options.
// How long a model's prompt cache stays warm after its last request. Claude Code
// subscriptions mostly get one hour; set 5 minutes for the API's default cache.
const CACHE_TTL_MINUTES = 60;
// Below this many context tokens, re-caching the chat on another model is cheap.
const SMALL_CONTEXT_TOKENS = 40_000;

const FOLLOW_UP =
  /^(ok(ay)?|go( on)?|yes|yep|y|continue|do it|proceed|sure|thanks?|ty|k)[.!]*$/i;

const SYSTEM = `You route coding-assistant prompts. Pick the cheapest model and lowest effort that will still do the task well.
Models: haiku (trivial: lookups, renames, small edits, quick questions), sonnet (normal coding work, features, bug fixes), opus (hard: architecture, tricky debugging, large refactors, subtle reasoning).
Efforts: low, medium, high, xhigh, max.
The first line names the model the chat is on now. Urgent means the prompt is too hard for that model: answer urgent only then, to switch up now even if the chat is mid-cache. Otherwise answer normal.
Answer with exactly three words: <model> <effort> <urgent|normal>. Nothing else.`;

// Rank of the session's model, so a pick never goes above what the person chose.
// An id no family matches ranks above them all, so it never caps a pick.
const rankOf = (model: string) => {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return 0;
  if (m.includes("sonnet")) return 1;
  if (m.includes("opus")) return 2;
  if (m.includes("fable")) return 3;
  return 4;
};
const nameOf = (model: string) => NAMES[rankOf(model)] ?? model;

// Accepts only the exact answer format, so a reply that rambles falls back instead of guessing.
const ANSWER = new RegExp(
  `^(${TIERS.join("|")})\\s+(${EFFORTS.join("|")})(?:\\s+(urgent|normal))?[.!]?$`,
  "i",
);
const parse = (text: string): Pick | undefined => {
  const m = text.trim().match(ANSWER);
  if (!m) return undefined;
  return {
    tier: m[1].toLowerCase() as Tier,
    effort: m[2].toLowerCase() as ModelEffort,
    urgent: m[3]?.toLowerCase() === "urgent",
  };
};

type Limits = { cacheTtlMs: number; smallContextTokens: number };

// Stays on the current model while its cache is warm and the chat is too big to re-cache cheaply,
// unless the judge marked the prompt urgent and the switch goes up. Never picks above the session's model.
async function choose(
  $: EngineInterface,
  wanted: string,
  session: string,
  urgent: boolean,
  current: string | undefined,
  lastUsed: ReadonlyMap<number, number>,
  limits: Limits,
) {
  const target = rankOf(wanted) > rankOf(session) ? session : wanted;
  if (!current || rankOf(current) === rankOf(target)) return { model: target, isKept: false };
  if (urgent && rankOf(target) > rankOf(current)) return { model: target, isKept: false };

  const now = await $.clock.now();
  const isHot = now - (lastUsed.get(rankOf(current)) ?? -Infinity) < limits.cacheTtlMs;
  const { context } = await $.session.usage();
  const isBig = (context.tokens ?? 0) >= limits.smallContextTokens;

  return isHot && isBig ? { model: current, isKept: true } : { model: target, isKept: false };
}

// The mode as /config holds it now, so a change made after this module loaded counts on the next turn;
// the loaded option when the menu can't be read. effort-only keeps the session's model on every turn.
async function modeOf($: EngineInterface, loaded: unknown) {
  const row = await $.config
    .list()
    .then((rows) => rows.find((r) => r.key === "right-size.mode"))
    .catch(() => undefined);
  return (row?.value ?? loaded) === "effort-only" ? "effort-only" : "model-and-effort";
}

export const register: Register = (on, options) => {
  const limits: Limits = {
    cacheTtlMs: Number(options?.cacheTtlMinutes ?? CACHE_TTL_MINUTES) * 60 * 1000,
    smallContextTokens: Number(options?.smallContextTokens ?? SMALL_CONTEXT_TOKENS),
  };

  // /right-size-mode switches the mode from any surface, the desktop app included.
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "right-size-mode",
      description: "Show or set right-size's mode: model-and-effort or effort-only",
      argumentHint: MODES.join(" | "),
    });
    return next(e);
  });

  on("command.run", { command: "right-size-mode" }, async ($, e) => {
    const value = e.args.trim();
    const now = await modeOf($, options?.mode);
    if (!MODES.includes(value)) {
      return { text: `right-size mode: ${now}. Set it with /right-size-mode ${MODES.join(" or ")}.` };
    }
    const { deny } = await $.config.set({ key: "right-size.mode", value });
    return { text: deny ? `right-size mode not changed: ${deny}` : `right-size mode set to ${value}.` };
  });

  let pick: Pick | undefined;
  // Last time each model family answered on the main loop, and the model that last ran.
  const lastUsed = new Map<number, number>();
  let current: string | undefined;
  // The model chosen for the running turn: every step of a turn stays on it.
  let turn: { id: string; model: string; isKept: boolean } | undefined;

  // /clear starts a new conversation in the same process: nothing of the old one carries over.
  on("session.end", async ($, e, next) => {
    if (e.reason === "clear") {
      pick = undefined;
      turn = undefined;
      current = undefined;
      lastUsed.clear();
    }
    return next(e);
  });

  // Compaction replaces the chat, so no model's cache holds it any more. The pick and the
  // running turn stay: an auto-compaction mid-turn must not drop the turn back to the default.
  on("session.compact", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined && e.trigger !== "precompute" && !("skip" in result)) {
      current = undefined;
      lastUsed.clear();
    }
    return result;
  }).catch(($, e, next) => next(e));

  on("prompt.submit", async ($, e, next) => {
    if (e.command || e.isMeta) return next(e);

    const text = e.text.trim();
    if (pick && FOLLOW_UP.test(text)) return next(e);

    const r = await $.model.complete({
      model: "haiku",
      system: SYSTEM,
      prompt: `Current model: ${current ?? "none yet"}\n\n${text.slice(0, 4000)}`,
      maxTokens: 16,
      effort: "low",
      timeoutMs: 5000,
    });
    pick = r.isAnswered ? parse(r.text) : undefined;
    $.ui.status(pick ? undefined : NO_PICK);

    return next(e);
  }).catch(($, e, next) => {
    // A judge that throws must not leave the last turn's pick in place.
    pick = undefined;
    $.ui.status(NO_PICK);
    return next(e);
  });

  on("turn.step", async function* ($, e, next) {
    if (e.agentId !== undefined || !pick) return yield* next(e);

    if (turn?.id !== e.turnId) {
      turn = {
        id: e.turnId,
        ...((await modeOf($, options?.mode)) === "effort-only"
          ? { model: e.model, isKept: false }
          : await choose($, IDS[pick.tier], e.model, pick.urgent, current, lastUsed, limits)),
      };
    }
    const { model, isKept } = turn;
    const effort = rankOf(model) === 0 ? undefined : pick.effort;
    const label = (id: string) => (effort ? `${nameOf(id)} · ${effort}` : nameOf(id));

    const result = yield* next({ ...e, model, effort });

    const ran = result.usage?.model ?? model;
    current = ran;
    lastUsed.set(rankOf(ran), await $.clock.now());

    // The API reports which model answered; show that, flagging a request the engine did not honor.
    if (e.index === 0) {
      const note = rankOf(ran) !== rankOf(model) ? ` (ran ${ran})` : isKept ? " (kept: cache hot)" : "";
      $.ui.status(label(ran) + note);
    }

    return result;
  });
};
