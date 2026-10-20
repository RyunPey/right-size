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

// How long a model's prompt cache stays warm after its last request. Claude Code
// subscriptions mostly get one hour; set 5 minutes for the API's default cache.
const CACHE_TTL_MS = 60 * 60 * 1000;
// Below this many context tokens, re-caching the chat on another model is cheap.
const SMALL_CONTEXT_TOKENS = 40_000;const FOLLOW_UP =
  /^(ok(ay)?|go( on)?|yes|yep|y|continue|do it|proceed|sure|thanks?|ty|k)[.!]*$/i;

const SYSTEM = `You route coding-assistant prompts. Pick the cheapest model and lowest effort that will still do the task well.
Models: haiku (trivial: lookups, renames, small edits, quick questions), sonnet (normal coding work, features, bug fixes), opus (hard: architecture, tricky debugging, large refactors, subtle reasoning).
Efforts: low, medium, high, xhigh, max.
The first line names the model the chat is on now. Urgent means the prompt is too hard for that model: answer urgent only then, to switch up now even if the chat is mid-cache. Otherwise answer normal.
Answer with exactly three words: <model> <effort> <urgent|normal>. Nothing else.`;

// Rank of the session's model, so a pick never goes above what the person chose.
const rankOf = (model: string) => {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return 0;
  if (m.includes("sonnet")) return 1;
  if (m.includes("opus")) return 2;
  return 3;
};

const parse = (text: string): Pick | undefined => {
  const words: string[] = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const tier = TIERS.find((t) => words.includes(t));
  const effort = EFFORTS.find((x) => words.includes(x));
  return tier && effort ? { tier, effort, urgent: words.includes("urgent") } : undefined;
};

// Stays on the current model while its cache is warm and the chat is too big to re-cache cheaply,
// unless the judge marked the prompt urgent and the switch goes up. Never picks above the session's model.
async function choose(
  $: EngineInterface,
  wanted: string,
  session: string,
  urgent: boolean,
  current: string | undefined,
  lastUsed: ReadonlyMap<number, number>,
) {
  const target = rankOf(wanted) > rankOf(session) ? session : wanted;
  if (!current || rankOf(current) === rankOf(target)) return { model: target, isKept: false };
  if (urgent && rankOf(target) > rankOf(current)) return { model: target, isKept: false };

  const now = await $.clock.now();
  const isHot = now - (lastUsed.get(rankOf(current)) ?? -Infinity) < CACHE_TTL_MS;
  const { context } = await $.session.usage();
  const isBig = (context.tokens ?? 0) >= SMALL_CONTEXT_TOKENS;

  return isHot && isBig ? { model: current, isKept: true } : { model: target, isKept: false };
}

export const register: Register = (on, options) => {
  // effort-only keeps the session's model on every turn, so no cache is ever lost.
  const isEffortOnly = options?.mode === "effort-only";

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
    const now = isEffortOnly ? "effort-only" : "model-and-effort";
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
    $.ui.status(
      pick ? undefined : "right-size: no pick, using session default",
    );

    return next(e);
  }).catch(($, e, next) => next(e));

  on("turn.step", async function* ($, e, next) {
    if (e.agentId !== undefined || !pick) return yield* next(e);

    if (turn?.id !== e.turnId) {
      turn = {
        id: e.turnId,
        ...(isEffortOnly
          ? { model: e.model, isKept: false }
          : await choose($, IDS[pick.tier], e.model, pick.urgent, current, lastUsed)),
      };
    }
    const { model, isKept } = turn;
    const effort = rankOf(model) === 0 ? undefined : pick.effort;
    const label = (id: string) => {
      const name = NAMES[rankOf(id)] ?? id;
      return effort ? `${name} · ${effort}` : name;
    };

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
