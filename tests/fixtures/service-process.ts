import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RuntimeCheckpoint } from "../../src/kernel/runtime-checkpoint.ts";

export type StopPoint = Parameters<RuntimeCheckpoint>[0]["point"];

const message = z.object({ point: z.string(), port: z.int().positive().optional(), submissionId: z.uuid().optional() });
type Message = z.infer<typeof message>;

export async function launchReadingProcess(file: string, options: {
  now: number; evaluateAutomatically: boolean; stopAt?: StopPoint;
}) {
  const worker = fileURLToPath(new URL("./reading-worker.ts", import.meta.url));
  const child = spawn(process.execPath, [worker, JSON.stringify({ file, ...options })], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  assert.ok(child.stdout && child.stderr);
  let diagnostics = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { diagnostics += chunk; });
  const exited = new Promise<string>(resolve => {
    child.once("error", error => resolve(error.message));
    child.once("close", (code, signal) => resolve(`code=${String(code)} signal=${String(signal)} ${diagnostics}`));
  });
  const checkpoints = new Map<string, ReturnType<typeof Promise.withResolvers<Message>>>();
  function slot(point: string) {
    const entry = checkpoints.get(point) ?? Promise.withResolvers<Message>();
    checkpoints.set(point, entry);
    return entry;
  }
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    const event = message.parse(JSON.parse(line));
    slot(event.point).resolve(event);
  });
  const waitFor = (point: string) => Promise.race([
    slot(point).promise,
    exited.then(reason => { throw new Error(`服务未到达 ${point} 即退出，${reason}`); }),
    delay(6000, undefined, { ref: false }).then(() => { throw new Error(`等候服务到达 ${point} 超时，${diagnostics}`); }),
  ]);
  const stop = async () => {
    if (!options.stopAt && child.connected) {
      child.send("stop", error => { if (error) child.kill("SIGKILL"); });
      await Promise.race([exited, delay(2000, undefined, { ref: false })]);
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  };
  try {
    const port = (await waitFor("listening")).port;
    if (!port) throw new Error("子进程未报告 HTTP 端口");
    return { origin: `http://127.0.0.1:${port}`, waitFor, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
