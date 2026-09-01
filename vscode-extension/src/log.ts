import * as fs from "fs";
import { LOG_DIR, LOG_FILE } from "./paths";

let outputChannel: { appendLine(msg: string): void } | undefined;

/* branche optionnellement un vscode.OutputChannel — evite de faire dependre
   ce module de l'API vscode pour rester testable en pur Node. */
export function setLogSink(sink: { appendLine(msg: string): void } | undefined): void {
  outputChannel = sink;
}

export function log(msg: string): void {
  const ts = new Date().toISOString().replace("T", " ").replace(/\..+/, "");
  const line = `${ts} — ${msg}`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch (e) {
    // le log ne doit jamais faire planter la synchro elle-meme
  }
  if (outputChannel) outputChannel.appendLine(line);
}
