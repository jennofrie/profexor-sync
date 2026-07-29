import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { AppConfig } from "../core/types.ts";
import type { StateStore } from "../core/state.ts";
import type { SyncEngine } from "../core/engine.ts";
import { App } from "./App.tsx";

export async function launchTui(
  config: AppConfig,
  state: StateStore,
  engine: SyncEngine,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("The TUI requires an interactive terminal");
  }
  await new Promise<void>(async (resolve) => {
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      clearOnShutdown: true,
      targetFps: 30,
      maxFps: 60,
      backgroundColor: "#08111f",
      onDestroy: resolve,
    });
    createRoot(renderer).render(<App config={config} state={state} engine={engine} />);
  });
}
