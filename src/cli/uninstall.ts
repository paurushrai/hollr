/**
 * `hollr uninstall`: reverse every wired change through the ledger, then offer
 * to delete `HOLLR_HOME` (config, logs, ledger). Every wire is byte-reversible
 * because `apply()` recorded the prior file, so unwiring restores each agent's
 * config exactly — or removes a file hollr created.
 *
 * The flow is pure over an injected {@link InitIo}, so it is scripted-answer
 * testable against a temp `HOLLR_HOME`; @clack lives only in the shell.
 */

import { rmSync } from "node:fs";

import { listWiredKeys, unwireFromLedger } from "../adapters/diffwire.ts";
import { byId } from "../adapters/registry.ts";
import type { AdapterDeps } from "../adapters/types.ts";
import { hollrHome } from "../core/config.ts";
import type { InitIo } from "./init-steps.ts";

const EXIT_OK = 0;
/** Ledger key suffix for the read-aloud injection, still ledger-driven (Task 6 brief). */
const READALOUD_SUFFIX = ":readaloud";

/** Map a ledger key (`<id>:<suffix>`) to its adapter title, else the raw key. */
function keyLabel(key: string): string {
  const id = key.split(":")[0] ?? key;
  return byId(id)?.title ?? key;
}

/**
 * Reverse every wired change, then (on a second confirm) delete `HOLLR_HOME`.
 * Declining the first confirm is a no-op that leaves everything in place.
 *
 * Reversal is routed through each matched adapter's surgical `unwire(deps)`
 * (once per adapter id, deduped) so edits a user makes to a config file after
 * wiring survive; the read-aloud marker key and any unmatched/unknown key
 * still go through the generic ledger-driven {@link unwireFromLedger}.
 */
export async function runUninstall(io: InitIo, deps: AdapterDeps): Promise<number> {
  const keys = listWiredKeys();
  if (keys.length === 0) {
    io.note("No wired integrations found.");
  } else {
    io.note(keys.map((key) => `- ${keyLabel(key)} (${key})`).join("\n"), "Will unwire");
  }
  const proceed = await io.confirm({
    message: "Reverse every hollr integration?",
    initialValue: false,
  });
  if (!proceed) {
    io.note("Nothing changed.");
    return EXIT_OK;
  }
  const seen = new Set<string>();
  for (const key of keys) {
    const id = key.split(":")[0] ?? key;
    const adapter = byId(id);
    if (adapter !== undefined && !key.endsWith(READALOUD_SUFFIX)) {
      if (!seen.has(id)) {
        seen.add(id);
        await adapter.unwire(deps);
      }
    } else {
      unwireFromLedger(key);
    }
    io.note(`Unwired ${keyLabel(key)}.`);
  }
  const deleteHome = await io.confirm({
    message: "Also delete hollr's config, logs, and ledger (HOLLR_HOME)?",
    initialValue: false,
  });
  if (deleteHome) {
    rmSync(hollrHome(), { recursive: true, force: true });
    io.note("Deleted HOLLR_HOME.");
  }
  return EXIT_OK;
}
