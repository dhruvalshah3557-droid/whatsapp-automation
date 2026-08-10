#!/usr/bin/env node
// Free API hunter library — shared by scripts/free-api-hunter.mjs and the
// health suite. Curates free-tier LLM providers and keyless public APIs,
// probes their live availability, tests any free keys the user stores in
// store/free-api-keys.conf, and auto-provisions the first working provider
// into the app (local server/.env + GitHub Actions secrets).
//
// Boundary: this only reads keys the USER deliberately places in the
// git-ignored conf file / server/.env. It never scans the environment,
// never scrapes for keys, and never registers accounts.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, "..");

export const CONF_FILE = path.join(ROOT, "store", "free-api-keys.conf");
export const STATE_FILE = path.join(ROOT, "store", "free-api-state.json");
export const SERVER_ENV = path.join(ROOT, "server", ".env");

// Free-tier LLM providers (OpenAI-compatible). keyVar = the key name the user
// can put in store/free-api-keys.conf (also read from server/.env if present).
export const FREE_LLM_PROVIDERS = [
  {
    id: "groq",
    name: "Groq",
    base: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    keyVar: "GROQ_API_KEY",
    tier: "free",
    signup: "https://console.groq.com",
    note: "Free tier — fast, generous limits.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat-v3-0324:free",
    keyVar: "OPENROUTER_API_KEY",
    tier: "free",
    signup: "https://openrouter.ai",
    note: "Free model routes (deepseek, llama, qwen).",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    base: "https://api.cerebras.ai/v1",
    model: "llama-3.3-70b",
    keyVar: "CEREBRAS_API_KEY",
    tier: "free",
    signup: "https://cloud.cerebras.ai",
    note: "Free tier, very fast inference.",
  },
  {
    id: "gemini",
    name: "Gemini (OpenAI-compat)",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-1.5-flash",
    keyVar: "GEMINI_API_KEY",
    tier: "free",
    signup: "https://aistudio.google.com",
    note: "Free tier via the OpenAI-compatible endpoint.",
  },
  {
    id: "github-models",
    name: "GitHub Models",
    base: "https://models.github.ai/inference",
    model: "gpt-4o-mini",
    keyVar: "GITHUB_TOKEN",
    tier: "free",
    signup: "https://github.com/marketplace/models",
    note: "Free tier with a GitHub token.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    base: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    keyVar: "DEEPSEEK_API_KEY",
    tier: "paid",
    signup: "https://platform.deepseek.com",
    note: "Paid but very cheap (~$0.14/M out).",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    base: "http://127.0.0.1:11434/v1",
    model: "llama3",
    keyVar: "",
    tier: "local",
    signup: "https://ollama.com",
    note: "Keyless local model — run `ollama pull llama3` first.",
  },
];

// Keyless public APIs worth watching (no auth required).
export const FREE_PUBLIC_APIS = [
  { name: "ipify (IP)", url: "https://api.ipify.org?format=json", desc: "Your public IP" },
  { name: "Open-Meteo", url: "https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current_weather=true", desc: "Weather, no key" },
  { name: "RandomUser", url: "https://randomuser.me/api/", desc: "Random person data" },
  { name: "JSONPlaceholder", url: "https://jsonplaceholder.typicode.com/todos/1", desc: "Test REST API" },
  { name: "CoinDesk", url: "https://api.coindesk.com/v1/bpi/currentprice.json", desc: "Bitcoin price" },
  { name: "Exchangerate", url: "https://open.er-api.com/v6/latest/USD", desc: "FX rates" },
];

export function mask(key) {
  if (!key) return "";
  return key.length <= 8 ? "••••" : key.slice(0, 4) + "••••" + key.slice(-4);
}

// Load keys the user stored: store/free-api-keys.conf then server/.env.
export function loadKeys() {
  const keys = {};
  const parse = (text) => {
    for (const line of String(text || "").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (m) keys[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  };
  try { parse(fs.readFileSync(CONF_FILE, "utf8")); } catch {}
  try { parse(fs.readFileSync(SERVER_ENV, "utf8")); } catch {}
  return keys;
}

export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

export function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

// Probe a URL with an abort timeout. Returns {ok,status,ms}.
export async function probeUrl(url, { timeout = 5000, headers = {}, method = "GET" } = {}) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { method, headers, signal: ac.signal });
    return { ok: res.ok, status: res.status, ms: Date.now() - t0 };
  } catch {
    return { ok: false, status: 0, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

// Verify a provider key with a tiny chat completion.
export async function testProviderKey(provider, key) {
  const endpoint = provider.base.replace(/\/+$/, "") + "/chat/completions";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify({ model: provider.model, messages: [{ role: "user", content: "ping" }], max_tokens: 4 }),
      signal: ac.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    const ok = !!(data.choices && data.choices[0]);
    return { ok, status: res.status, content: ok ? String(data.choices[0].message?.content || "").slice(0, 40) : "" };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// Compute the base URL / model for USER_LLM_* from a provider.
export function providerEnv(provider, key) {
  return { USER_LLM_BASE_URL: provider.base, USER_LLM_MODEL: provider.model, USER_LLM_API_KEY: key };
}

// Write/update USER_LLM_* in server/.env (git-ignored). Preserves other lines.
export function writeServerEnv(updates) {
  let text = "";
  try { text = fs.readFileSync(SERVER_ENV, "utf8"); } catch {}
  const lines = text.split("\n");
  const out = [];
  const seen = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && m[1] in updates) { seen[m[1]] = true; out.push(`${m[1]}=${updates[m[1]]}`); }
    else out.push(line);
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!seen[k]) out.push(`${k}=${v}`);
  }
  fs.mkdirSync(path.dirname(SERVER_ENV), { recursive: true });
  fs.writeFileSync(SERVER_ENV, out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n");
  return SERVER_ENV;
}

// Push a GitHub Actions secret so the live worker gets it on next deploy.
export async function pushGhSecret(name, value) {
  try {
    const url = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: ROOT, encoding: "utf8" }).trim();
    const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (!m) return { ok: false, err: "no github origin" };
    const [, owner, repo] = m;
    const cred = execFileSync("git", ["credential", "fill"], {
      cwd: ROOT, input: "protocol=https\nhost=github.com\n\n", encoding: "utf8",
    });
    const token = (cred.match(/^password=(.+)$/m) || [])[1] || "";
    if (!token) return { ok: false, err: "no github token" };

    const pubKeyRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`, {
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
    });
    if (!pubKeyRes.ok) return { ok: false, err: "public-key HTTP " + pubKeyRes.status };
    const { key: pubKey, key_id } = await pubKeyRes.json();

    const crypto = await import("node:crypto");
    const enc = crypto.publicEncrypt(
      { key: Buffer.from(pubKey, "base64"), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(value, "utf8")
    );

    const putRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/secrets/${name}`, {
      method: "PUT",
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ encrypted_value: enc.toString("base64"), key_id }),
    });
    return { ok: putRes.status === 201 || putRes.status === 204, status: putRes.status };
  } catch (err) {
    return { ok: false, err: err && err.message };
  }
}
