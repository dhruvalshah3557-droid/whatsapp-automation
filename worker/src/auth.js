// Colourdiam secure login + user-management system for the Cloudflare Worker.
// Users, sessions, tasks and the audit log live in the AUTH KV namespace.
// Passwords are hashed with PBKDF2-SHA256 (Web Crypto — Workers have no scrypt).
//
// Auth model (mirrors server/auth.js):
//   - Every record carries ownerId / userId. Regular users can only read/write
//     their own records; admins may read/write all records.
//   - Sessions are random 256-bit bearer tokens with a TTL, persisted in KV.
//     Login attempts are rate-limited in memory.
//   - Audit log is append-only: there is no endpoint to edit or delete entries.
//
// Bootstrap: on first request an admin is created from ADMIN_EMAIL /
// ADMIN_PASSWORD, or the documented default below (force password change).

const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 1000 * 60 * 10;
const MAX_AUDIT = 2000;
const DEFAULT_ITERATIONS = 100000;

const TASK_STATUS = ["not_started", "in_progress", "blocked", "completed"];
const PRIORITY = ["low", "medium", "high", "urgent"];

const loginAttempts = new Map();

function randomBytes(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function uid() {
  return bytesToHex(randomBytes(16));
}

function token() {
  return bytesToHex(randomBytes(32));
}

function timingSafeEqualHex(a, b) {
  const ab = hexToBytes(a);
  const bb = hexToBytes(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function deriveKey(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(password)),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(salt), iterations, hash: "SHA-256" },
    keyMaterial,
    512
  );
  return bytesToHex(new Uint8Array(bits));
}

async function hashPassword(password, env) {
  const iterations = Number((env && env.AUTH_ITERATIONS) || DEFAULT_ITERATIONS);
  const salt = bytesToHex(randomBytes(16));
  const hash = await deriveKey(password, salt, iterations);
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

async function verifyPassword(password, stored, env) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const hash = parts[3];
  const candidate = await deriveKey(password, salt, iterations);
  return timingSafeEqualHex(candidate, hash);
}

async function kvGet(env, key, fallback) {
  try {
    if (!env || !env.AUTH) return fallback;
    const raw = await env.AUTH.get(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    console.error("auth kvGet failed for " + key + ":", err && err.message);
    return fallback;
  }
}

async function kvPut(env, key, value) {
  if (!env || !env.AUTH) return;
  await env.AUTH.put(key, JSON.stringify(value));
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    active: u.active,
    mustChangePassword: !!u.mustChangePassword,
    lastLogin: u.lastLogin || null,
    createdAt: u.createdAt || null,
  };
}

export function isAdmin(user) {
  return !!(user && user.role === "admin");
}

export function clientIp(request) {
  const fwd = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  return fwd || "";
}

export async function ensureBootstrap(env) {
  const users = await kvGet(env, "users", []);
  if (users.length) return;
  const admin = {
    id: uid(),
    name: "Administrator",
    email: String(env.ADMIN_EMAIL || "admin@colourdiam.com").toLowerCase().trim(),
    role: "admin",
    active: true,
    passwordHash: await hashPassword(env.ADMIN_PASSWORD || "Admin2026!", env),
    mustChangePassword: true,
    lastLogin: null,
    createdAt: new Date().toISOString(),
  };
  users.push(admin);
  await kvPut(env, "users", users);
  await auditLog(env, admin.id, "system_bootstrap", { email: admin.email });
}

export async function findUserByEmail(env, email) {
  const e = String(email || "").toLowerCase().trim();
  const users = await kvGet(env, "users", []);
  return users.find((u) => u.email === e) || null;
}

export async function findUserById(env, id) {
  const users = await kvGet(env, "users", []);
  return users.find((u) => u.id === id) || null;
}

export async function listUsers(env) {
  const users = await kvGet(env, "users", []);
  return users.map(publicUser);
}

export async function createUser(env, { name, email, role, password }) {
  const e = String(email || "").toLowerCase().trim();
  if (!name || !e || !password) return { error: "name, email and password are required" };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { error: "invalid email address" };
  if (await findUserByEmail(env, e)) return { error: "a user with that email already exists" };
  if (String(password).length < 8) return { error: "password must be at least 8 characters" };
  const user = {
    id: uid(),
    name: String(name).trim(),
    email: e,
    role: role === "admin" ? "admin" : "user",
    active: true,
    passwordHash: await hashPassword(password, env),
    mustChangePassword: true,
    lastLogin: null,
    createdAt: new Date().toISOString(),
  };
  const users = await kvGet(env, "users", []);
  users.push(user);
  await kvPut(env, "users", users);
  return { user: publicUser(user) };
}

export async function setUserActive(env, id, active) {
  const users = await kvGet(env, "users", []);
  const u = users.find((x) => x.id === id);
  if (!u) return { error: "user not found" };
  if (u.role === "admin" && users.filter((x) => x.role === "admin" && x.active).length <= 1 && !active) {
    return { error: "cannot suspend the last active admin" };
  }
  u.active = !!active;
  u.updatedAt = new Date().toISOString();
  await kvPut(env, "users", users);
  return { user: publicUser(u) };
}

export async function setUserRole(env, id, role) {
  const users = await kvGet(env, "users", []);
  const u = users.find((x) => x.id === id);
  if (!u) return { error: "user not found" };
  if (u.role === "admin" && role !== "admin" && users.filter((x) => x.role === "admin").length <= 1) {
    return { error: "cannot demote the last admin" };
  }
  u.role = role === "admin" ? "admin" : "user";
  u.updatedAt = new Date().toISOString();
  await kvPut(env, "users", users);
  return { user: publicUser(u) };
}

export async function resetUserPassword(env, id, password) {
  const users = await kvGet(env, "users", []);
  const u = users.find((x) => x.id === id);
  if (!u) return { error: "user not found" };
  if (String(password).length < 8) return { error: "password must be at least 8 characters" };
  u.passwordHash = await hashPassword(password, env);
  u.mustChangePassword = true;
  u.updatedAt = new Date().toISOString();
  await kvPut(env, "users", users);
  return { user: publicUser(u) };
}

export async function issueSession(env, userId, ip) {
  const t = token();
  const sessions = await kvGet(env, "sessions", {});
  sessions[t] = { userId, ip: ip || "", expires: Date.now() + SESSION_TTL_MS };
  await kvPut(env, "sessions", sessions);
  return t;
}

export async function destroySession(env, t) {
  const sessions = await kvGet(env, "sessions", {});
  if (sessions[t]) {
    delete sessions[t];
    await kvPut(env, "sessions", sessions);
  }
}

export async function sessionUser(request, env) {
  const header = request.headers.get("authorization") || "";
  const t = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!t) return null;
  const sessions = await kvGet(env, "sessions", {});
  const s = sessions[t];
  if (!s) return null;
  if (Number(s.expires) <= Date.now()) {
    delete sessions[t];
    await kvPut(env, "sessions", sessions);
    return null;
  }
  const users = await kvGet(env, "users", []);
  const u = users.find((x) => x.id === s.userId);
  if (!u || !u.active) return null;
  return u;
}

export async function auditLog(env, userId, action, detail = {}) {
  const target = await findUserById(env, userId);
  const entry = {
    id: uid(),
    userId,
    userName: (target || {}).name || "unknown",
    action,
    detail: { ...detail },
    ip: detail.ip || "",
    at: new Date().toISOString(),
  };
  delete entry.detail.ip;
  const audit = await kvGet(env, "audit", []);
  audit.push(entry);
  const trimmed = audit.length > MAX_AUDIT ? audit.slice(audit.length - MAX_AUDIT) : audit;
  await kvPut(env, "audit", trimmed);
  return entry;
}

function loginKey(email, ip) {
  return String(email || "").toLowerCase().trim() + "|" + (ip || "");
}

function attemptAllowed(email, ip) {
  const key = loginKey(email, ip);
  const rec = loginAttempts.get(key);
  if (!rec) return true;
  if (Date.now() > rec.until) {
    loginAttempts.delete(key);
    return true;
  }
  return rec.count < MAX_ATTEMPTS;
}

function recordFailed(email, ip) {
  const key = loginKey(email, ip);
  const rec = loginAttempts.get(key) || { count: 0, until: 0 };
  rec.count += 1;
  rec.until = Date.now() + LOCK_MS;
  loginAttempts.set(key, rec);
}

export async function attemptLogin(env, email, password, ip) {
  if (!attemptAllowed(email, ip)) {
    return { error: "Too many failed attempts. Try again in a few minutes." };
  }
  const u = await findUserByEmail(env, email);
  if (!u || !(await verifyPassword(password, u.passwordHash, env))) {
    recordFailed(email, ip);
    return { error: "Invalid email or password" };
  }
  if (!u.active) {
    return { error: "This account is suspended. Contact the administrator." };
  }
  u.lastLogin = new Date().toISOString();
  const users = await kvGet(env, "users", []);
  const idx = users.findIndex((x) => x.id === u.id);
  if (idx !== -1) users[idx] = u;
  await kvPut(env, "users", users);
  const t = await issueSession(env, u.id, ip);
  await auditLog(env, u.id, "login", { ip, email: u.email });
  return { token: t, user: publicUser(u) };
}

export async function changePassword(env, user, oldPassword, newPassword) {
  if (!(await verifyPassword(oldPassword, user.passwordHash, env))) return { error: "Current password is incorrect" };
  if (String(newPassword).length < 8) return { error: "New password must be at least 8 characters" };
  user.passwordHash = await hashPassword(newPassword, env);
  user.mustChangePassword = false;
  user.updatedAt = new Date().toISOString();
  const users = await kvGet(env, "users", []);
  const idx = users.findIndex((x) => x.id === user.id);
  if (idx !== -1) users[idx] = user;
  await kvPut(env, "users", users);
  await auditLog(env, user.id, "password_change", { email: user.email });
  return { ok: true };
}

export async function issueResetToken(env, email) {
  const u = await findUserByEmail(env, email);
  if (!u || !u.active) return { error: "If that email exists, a reset link was sent." };
  u.resetToken = token();
  u.resetExpires = Date.now() + 1000 * 60 * 30;
  const users = await kvGet(env, "users", []);
  const idx = users.findIndex((x) => x.id === u.id);
  if (idx !== -1) users[idx] = u;
  await kvPut(env, "users", users);
  await auditLog(env, u.id, "password_reset_requested", { email: u.email });
  return { ok: true, resetToken: u.resetToken };
}

export async function consumeResetToken(env, email, resetToken, newPassword) {
  const u = await findUserByEmail(env, email);
  if (!u || !u.resetToken || u.resetToken !== resetToken || !u.resetExpires || Date.now() > u.resetExpires) {
    return { error: "Reset token is invalid or has expired" };
  }
  if (String(newPassword).length < 8) return { error: "Password must be at least 8 characters" };
  u.passwordHash = await hashPassword(newPassword, env);
  u.mustChangePassword = false;
  u.resetToken = null;
  u.resetExpires = null;
  u.updatedAt = new Date().toISOString();
  const users = await kvGet(env, "users", []);
  const idx = users.findIndex((x) => x.id === u.id);
  if (idx !== -1) users[idx] = u;
  await kvPut(env, "users", users);
  await auditLog(env, u.id, "password_reset", { email: u.email });
  return { ok: true };
}

/* ------------------------- Tasks ------------------------- */

function taskOwned(task, user, includeAdmin) {
  return (includeAdmin && isAdmin(user)) || task.ownerId === user.id || task.assignedTo === user.id;
}

export async function listTasks(env, user, opts = {}) {
  const tasks = await kvGet(env, "tasks", []);
  let list = tasks;
  if (!isAdmin(user)) list = tasks.filter((t) => t.ownerId === user.id || t.assignedTo === user.id);
  if (opts.assignedTo) list = list.filter((t) => t.assignedTo === opts.assignedTo);
  if (opts.status) list = list.filter((t) => t.status === opts.status);
  return list
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function getTask(env, id, user) {
  const tasks = await kvGet(env, "tasks", []);
  const task = tasks.find((t) => t.id === id);
  if (!task) return { error: "task not found" };
  if (!taskOwned(task, user, true)) return { error: "not allowed" };
  return { task };
}

export async function createTask(env, data, user) {
  const title = String(data.title || "").trim();
  if (!title) return { error: "task title is required" };
  const assignedId = data.assignedTo && (await findUserById(env, data.assignedTo)) ? data.assignedTo : user.id;
  const task = {
    id: uid(),
    ownerId: user.id,
    assignedTo: assignedId,
    title,
    description: String(data.description || "").trim(),
    status: TASK_STATUS.includes(data.status) ? data.status : "not_started",
    progress: Math.min(100, Math.max(0, Number(data.progress || 0) || 0)),
    priority: PRIORITY.includes(data.priority) ? data.priority : "medium",
    startDate: data.startDate || null,
    dueDate: data.dueDate || null,
    notes: String(data.notes || "").trim(),
    attachments: Array.isArray(data.attachments) ? data.attachments.map(String) : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const tasks = await kvGet(env, "tasks", []);
  tasks.push(task);
  await kvPut(env, "tasks", tasks);
  await auditLog(env, user.id, "task_created", { taskId: task.id, title: task.title });
  return { task };
}

export async function updateTask(env, id, patch, user) {
  const tasks = await kvGet(env, "tasks", []);
  const task = tasks.find((t) => t.id === id);
  if (!task) return { error: "task not found" };
  if (!taskOwned(task, user, true)) return { error: "not allowed" };
  const before = { status: task.status, progress: task.progress, assignedTo: task.assignedTo };
  if (patch.title !== undefined) {
    const title = String(patch.title).trim();
    if (!title) return { error: "task title is required" };
    task.title = title;
  }
  if (patch.description !== undefined) task.description = String(patch.description).trim();
  if (patch.status !== undefined) {
    if (!TASK_STATUS.includes(patch.status)) return { error: "invalid status" };
    task.status = patch.status;
    if (task.status === "completed") task.progress = 100;
  }
  if (patch.progress !== undefined) {
    const p = Number(patch.progress);
    if (Number.isFinite(p)) task.progress = Math.min(100, Math.max(0, p));
    if (task.progress >= 100) task.status = "completed";
  }
  if (patch.priority !== undefined && PRIORITY.includes(patch.priority)) task.priority = patch.priority;
  if (patch.startDate !== undefined) task.startDate = patch.startDate || null;
  if (patch.dueDate !== undefined) task.dueDate = patch.dueDate || null;
  if (patch.notes !== undefined) task.notes = String(patch.notes).trim();
  if (patch.attachments !== undefined && Array.isArray(patch.attachments)) task.attachments = patch.attachments.map(String);
  if (patch.assignedTo !== undefined && (await findUserById(env, patch.assignedTo))) {
    if (!isAdmin(user)) return { error: "only admins can reassign tasks" };
    task.assignedTo = patch.assignedTo;
  }
  task.updatedAt = new Date().toISOString();
  await kvPut(env, "tasks", tasks);
  await auditLog(env, user.id, "task_updated", {
    taskId: task.id,
    title: task.title,
    changed: {
      status: before.status === task.status ? undefined : [before.status, task.status],
      progress: before.progress === task.progress ? undefined : [before.progress, task.progress],
      assignedTo: before.assignedTo === task.assignedTo ? undefined : [before.assignedTo, task.assignedTo],
    },
  });
  return { task };
}

export async function deleteTask(env, id, user) {
  const tasks = await kvGet(env, "tasks", []);
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return { error: "task not found" };
  if (!taskOwned(tasks[idx], user, true)) return { error: "not allowed" };
  const [task] = tasks.splice(idx, 1);
  await kvPut(env, "tasks", tasks);
  await auditLog(env, user.id, "task_deleted", { taskId: task.id, title: task.title });
  return { ok: true };
}

/* ------------------------- Admin reporting ------------------------- */

function taskStatsFor(tasks, userId) {
  const mine = tasks.filter((t) => t.assignedTo === userId);
  const overdue = mine.filter((t) => t.status !== "completed" && t.dueDate && new Date(t.dueDate) < new Date());
  return {
    total: mine.length,
    not_started: mine.filter((t) => t.status === "not_started").length,
    in_progress: mine.filter((t) => t.status === "in_progress").length,
    blocked: mine.filter((t) => t.status === "blocked").length,
    completed: mine.filter((t) => t.status === "completed").length,
    pending: mine.filter((t) => t.status !== "completed").length,
    overdue: overdue.length,
  };
}

function avgProgress(tasks, userId) {
  const mine = tasks.filter((t) => t.assignedTo === userId);
  if (!mine.length) return 0;
  return Math.round(mine.reduce((sum, t) => sum + (t.progress || 0), 0) / mine.length);
}

export async function adminStats(env) {
  const users = await kvGet(env, "users", []);
  const tasks = await kvGet(env, "tasks", []);
  const audit = await kvGet(env, "audit", []);
  const active = users.filter((u) => u.active);
  const byUser = active.map((u) => ({
    ...publicUser(u),
    ...taskStatsFor(tasks, u.id),
    avgProgress: avgProgress(tasks, u.id),
    createdCount: audit.filter((a) => a.userId === u.id && (a.action === "task_created" || a.action === "record_created")).length,
    updatedCount: audit.filter((a) => a.userId === u.id && (a.action === "task_updated" || a.action === "record_updated")).length,
  }));
  const all = taskStatsFor(tasks, "");
  return {
    users: byUser,
    totals: {
      users: users.length,
      active: active.length,
      suspended: users.length - active.length,
      tasks: tasks.length,
      tasksCompleted: tasks.filter((t) => t.status === "completed").length,
      tasksPending: tasks.filter((t) => t.status !== "completed").length,
      tasksOverdue: tasks.filter((t) => t.status !== "completed" && t.dueDate && new Date(t.dueDate) < new Date()).length,
      audit: audit.length,
    },
  };
}

export async function adminReport(env) {
  const users = await kvGet(env, "users", []);
  const tasks = await kvGet(env, "tasks", []);
  const byUser = users.map((u) => ({
    ...publicUser(u),
    tasks: tasks.filter((t) => t.assignedTo === u.id).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    ...taskStatsFor(tasks, u.id),
    avgProgress: avgProgress(tasks, u.id),
  }));
  return { users: byUser };
}

export async function activityFor(env, userId) {
  const audit = await kvGet(env, "audit", []);
  return audit.filter((a) => a.userId === userId).slice().reverse().slice(0, 200);
}

export async function adminAudit(env, opts = {}) {
  let list = (await kvGet(env, "audit", [])).slice();
  if (opts.userId) list = list.filter((a) => a.userId === opts.userId);
  if (opts.action) list = list.filter((a) => a.action === opts.action);
  return list.slice().reverse().slice(0, Number(opts.limit || 300));
}

export async function recentActivity(env, limit = 20) {
  return (await kvGet(env, "audit", [])).slice().reverse().slice(0, limit);
}
