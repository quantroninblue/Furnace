import { promises as fs } from "node:fs";
import os from "node:os";

const GiB = 1024 ** 3;
export async function availableMemory() {
  if (process.platform === "linux") {
    try {
      const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(await fs.readFile("/proc/meminfo", "utf8"));
      if (match) return Number(match[1]) * 1024;
    } catch { /* Use the conservative portable free-memory reading. */ }
  }
  return os.freemem();
}

// This guards the opt-in developer check, not normal app requests. Disk size is
// only a rough lower bound for runtime requirements; passing is no safety guarantee.
export async function preflightModel(model: string | undefined, available: number, fetcher: typeof fetch = fetch) {
  if (!model?.trim()) throw new Error("Choose an installed model explicitly: npx tsx scripts/check-model.ts <model> [discuss,plan,build,research]. No default model is loaded.");
  const response = await fetcher("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error("Cannot inspect the installed Ollama models. No inference started.");
  const data = await response.json() as { models?: { name: string; size: number }[] };
  const installed = data.models?.find(item => item.name === model);
  if (!installed) throw new Error(`Model ${model} is not installed. No model was downloaded or loaded.`);
  if (!Number.isFinite(installed.size) || installed.size <= 0 || !Number.isFinite(available) || available <= 0)
    throw new Error("Cannot estimate available memory for this model. No inference started.");
  const estimated = installed.size * 1.25 + 3 * GiB;
  if (estimated > available)
    throw new Error(`Live check refused: approximately ${(estimated / GiB).toFixed(1)} GiB of available memory is required by this conservative estimate; ${(available / GiB).toFixed(1)} GiB is available. Use a smaller model and run the check separately from builds.`);
}
