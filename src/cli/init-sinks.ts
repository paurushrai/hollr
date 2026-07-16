/**
 * Pure sink-configuration steps for `kelbrin init`: per-event modes, voice, sound,
 * quiet hours, and the webhook loop. Every prompt goes through the injected
 * {@link InitIo} so the whole flow is scripted-answer testable — @clack never
 * appears here (it lives only in the `init.ts` shell). Voice enumeration is
 * injected too, so tests never spawn a process.
 *
 * The result is a complete {@link KelbrinConfig} built from {@link DEFAULTS} plus
 * the user's answers; `init-steps.ts` writes it to disk.
 */

import type {
  EventConfig,
  EventName,
  KelbrinConfig,
  Mode,
  QuietHoursWebhooks,
  VoiceConfig,
  WebhookProvider,
  WebhookTarget,
} from "../core/config.ts";
import type { InitIo } from "./init-steps.ts";

/** Sentinel select value meaning "use the OS-configured default voice". */
const OS_DEFAULT_VOICE = "__os_default__";
/** Cap on re-prompts for a validated field, so a misbehaving io cannot loop forever. */
const MAX_PROMPT_ATTEMPTS = 5;
const HTTPS_SCHEME = "https:";
const HTTP_SCHEME = "http:";
const PUSHOVER_PROVIDER: WebhookProvider = "pushover";

const EVENT_NAMES: readonly EventName[] = ["done", "blocked", "error"];
const MODES: readonly Mode[] = ["announce", "readaloud", "notify", "silent"];
const PROVIDERS: readonly WebhookProvider[] = ["ntfy", "pushover", "slack", "generic"];
const QUIET_HOURS_OPTIONS: readonly QuietHoursWebhooks[] = ["fire", "suppress"];

/** A full "HH:MM-HH:MM" window (matches the loader's per-part `HHMM` grammar). */
const QUIET_HOURS_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/** Injected voice enumeration: real impl spawns + parses; tests return a fixed list. */
export type EnumerateVoices = () => string[];

/** Ask for the markdown-open command only when read-aloud is the done mode. */
async function collectOpenCommand(
  io: InitIo,
  events: Record<EventName, EventConfig>,
  existing: KelbrinConfig,
  defaultOpen: string,
): Promise<string> {
  if (events.done.mode !== "readaloud") {
    return existing.readaloud.openCommand;
  }
  io.note(
    "Read-aloud keeps responses suitable for listening; code and extra detail " +
      "open in your markdown viewer instead of being spoken.",
  );
  const seed = existing.readaloud.openCommand.length > 0
    ? existing.readaloud.openCommand
    : defaultOpen;
  const raw = (
    await io.text({ message: "Command to open a markdown file", initialValue: seed })
  ).trim();
  return raw.length === 0 ? seed : raw;
}

/** Ask the mode for every event, seeded from the user's current config. */
async function collectModes(
  io: InitIo,
  existing: KelbrinConfig,
): Promise<Record<EventName, EventConfig>> {
  const events = structuredClone(existing.events);
  for (const event of EVENT_NAMES) {
    const mode = await io.select<Mode>({
      message: `How should "${event}" events be announced?`,
      options: MODES.map((value) => ({ value, label: value })),
      initialValue: existing.events[event].mode,
    });
    events[event] = { mode };
  }
  return events;
}

/** Offer OS-default voice or a live-enumerated pick; seeded from the current voice. */
async function collectVoice(
  io: InitIo,
  enumerate: EnumerateVoices,
  existing: KelbrinConfig,
): Promise<VoiceConfig> {
  const voice = structuredClone(existing.voice);
  const pickInstalled = await io.confirm({
    message: "Choose from installed voices? (otherwise the OS default voice is used)",
    initialValue: existing.voice.name !== null,
  });
  if (!pickInstalled) {
    voice.name = null;
    return voice;
  }
  const names = enumerate();
  if (names.length === 0) {
    io.note("No installed voices found; using the OS default voice.");
    return voice;
  }
  const chosen = await io.select<string>({
    message: "Voice",
    options: [
      { value: OS_DEFAULT_VOICE, label: "OS default" },
      ...names.map((name) => ({ value: name, label: name })),
    ],
    initialValue: existing.voice.name ?? OS_DEFAULT_VOICE,
  });
  voice.name = chosen === OS_DEFAULT_VOICE ? null : chosen;
  return voice;
}

/** A notification sound name, or `null` when the user leaves it blank. */
async function collectSound(io: InitIo, existing: KelbrinConfig): Promise<string | null> {
  const name = (
    await io.text({
      message: "Notification sound name (leave blank for none)",
      initialValue: existing.notify.sound ?? "",
    })
  ).trim();
  return name.length === 0 ? null : name;
}

/** Prompt (and re-prompt) for a valid quiet-hours window; blank means disabled. */
async function promptQuietHours(io: InitIo, existing: KelbrinConfig): Promise<string | null> {
  const seed = existing.quietHours ?? "";
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
    const raw = (
      await io.text({
        message: "Quiet hours as HH:MM-HH:MM (leave blank for none)",
        initialValue: seed,
      })
    ).trim();
    if (raw.length === 0) {
      return null;
    }
    if (QUIET_HOURS_RE.test(raw)) {
      return raw;
    }
    io.note("Invalid format; expected HH:MM-HH:MM (e.g. 22:00-08:00).");
  }
  return null;
}

async function collectQuietHours(
  io: InitIo,
  existing: KelbrinConfig,
): Promise<{ spec: string | null; webhooks: QuietHoursWebhooks }> {
  const spec = await promptQuietHours(io, existing);
  if (spec === null) {
    return { spec: null, webhooks: existing.quietHoursWebhooks };
  }
  const webhooks = await io.select<QuietHoursWebhooks>({
    message: "During quiet hours, webhooks should",
    options: QUIET_HOURS_OPTIONS.map((value) => ({ value, label: value })),
    initialValue: existing.quietHoursWebhooks,
  });
  return { spec, webhooks };
}

/** The URL scheme, or `null` when the string is not a parseable URL. */
function urlScheme(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/** Prompt for an https URL; an http URL is accepted only on explicit opt-in. */
async function promptWebhookUrl(
  io: InitIo,
): Promise<{ url: string; allowHttp: boolean } | null> {
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
    const url = (await io.text({ message: "Webhook URL (https)" })).trim();
    const scheme = urlScheme(url);
    if (scheme === HTTPS_SCHEME) {
      return { url, allowHttp: false };
    }
    if (scheme === HTTP_SCHEME) {
      const allow = await io.confirm({
        message: "That URL is insecure http — send events over http anyway?",
        initialValue: false,
      });
      if (allow) {
        return { url, allowHttp: true };
      }
      io.note("Enter an https:// URL instead.");
      continue;
    }
    io.note("Invalid URL; it must start with https:// (or http:// if you opt in).");
  }
  return null;
}

/** Collect optional request headers (auth tokens live here) as a key/value map. */
async function collectHeaders(io: InitIo): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  let more = await io.confirm({ message: "Add request headers?", initialValue: false });
  while (more) {
    const key = (await io.text({ message: "Header name (blank to finish)" })).trim();
    if (key.length === 0) {
      break;
    }
    headers[key] = await io.text({ message: `Value for "${key}"` });
    more = await io.confirm({ message: "Add another header?", initialValue: false });
  }
  return headers;
}

/** Gather one webhook target, or `null` when no valid URL was supplied. */
async function collectOneWebhook(io: InitIo): Promise<WebhookTarget | null> {
  const provider = await io.select<WebhookProvider>({
    message: "Webhook provider",
    options: PROVIDERS.map((value) => ({ value, label: value })),
    initialValue: "ntfy",
  });
  const name = (await io.text({ message: "A name for this webhook", initialValue: provider })).trim();
  const resolved = await promptWebhookUrl(io);
  if (resolved === null) {
    io.note("No valid URL provided; skipping this webhook.");
    return null;
  }
  const events = await io.multiselect<EventName>({
    message: "Which events fire this webhook?",
    options: EVENT_NAMES.map((value) => ({ value, label: value })),
    initialValues: [...EVENT_NAMES],
    required: true,
  });
  if (provider === PUSHOVER_PROVIDER) {
    io.note('Pushover: put your app "token" and "user" key in headers.');
  }
  const headers = await collectHeaders(io);
  const target: WebhookTarget = {
    name: name.length === 0 ? provider : name,
    provider,
    url: resolved.url,
    events,
  };
  if (Object.keys(headers).length > 0) {
    target.headers = headers;
  }
  // The http opt-in is scoped to THIS target, never a config-wide flag, so
  // opting one insecure endpoint in can never silently permit another.
  if (resolved.allowHttp) {
    target.allowHttp = true;
  }
  return target;
}

/**
 * Loop the webhook builder until the user declines to add another. Seeded with
 * the user's existing targets (add-only) so re-running init never drops the
 * webhooks — and their auth headers — they already configured. Each target
 * carries its own `allowHttp`; there is no config-wide http flag to widen.
 */
async function collectWebhooks(
  io: InitIo,
  existing: KelbrinConfig,
): Promise<WebhookTarget[]> {
  const targets: WebhookTarget[] = existing.webhooks.map((target) => structuredClone(target));
  let add = await io.confirm({ message: "Add a webhook?", initialValue: false });
  while (add) {
    const built = await collectOneWebhook(io);
    if (built !== null) {
      targets.push(built);
    }
    add = await io.confirm({ message: "Add another webhook?", initialValue: false });
  }
  return targets;
}

/**
 * Drive every sink prompt and fold the answers into a complete config, starting
 * from the user's `existing` config so a re-run preserves everything it does not
 * re-ask (voice rate, readaloud, notify.desktop) and seeds every prompt from the
 * current value. Pure: the only effects are the injected io calls.
 */
export async function collectSinkConfig(
  io: InitIo,
  enumerate: EnumerateVoices,
  existing: KelbrinConfig,
  defaultOpen: string,
): Promise<KelbrinConfig> {
  const config = structuredClone(existing);
  config.events = await collectModes(io, existing);
  config.readaloud = {
    ...config.readaloud,
    openCommand: await collectOpenCommand(io, config.events, existing, defaultOpen),
  };
  config.voice = await collectVoice(io, enumerate, existing);
  config.notify = { ...config.notify, sound: await collectSound(io, existing) };
  const quiet = await collectQuietHours(io, existing);
  config.quietHours = quiet.spec;
  config.quietHoursWebhooks = quiet.webhooks;
  // Per-target `allowHttp` now carries the opt-in; the root flag stays as the
  // cloned `existing` value (a legacy fallback only) and is never widened here.
  config.webhooks = await collectWebhooks(io, existing);
  return config;
}
