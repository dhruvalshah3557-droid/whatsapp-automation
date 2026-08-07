// Colourdiam secure login + user-management system.
// Users, sessions, tasks and the audit log are stored as JSON files in the
// server data directory (git-ignored). Passwords are hashed with scrypt.
//
// Auth model:
//   - Every record carries ownerId / userId. Regular users can only read/write
//     their own records; admins may read/write all records.
//   - Sessions are random 256-bit bearer tokens with a TTL, persisted across
//     restarts. Login attempts are rate-limited in memory.
//   - Audit log is append-only: there is no endpoint to edit or delete entries.
//
// Bootstrap: on first start an admin is created from ADMIN_EMAIL /
// ADMIN_PASSWORD, or the documented default below (force password change).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.AUTH_DATA_DIR || __dirname;
const USERS_FILE = process.env.USERS_FILE || path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = process.env.SESSIONS_FILE || path.join(DATA_DIR, "sessions.json");
const TASKS_FILE = process.env.TASKS_FILE || path.join(DATA_DIR, "tasks.json");
const AUDIT_FILE = process.env.AUDIT_FILE || path.join(DATA_DIR, "audit.json");

const SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS || 1000 * 60 * 60 * 12);
const MAX_ATTEMPTS = Number(process.env.AUTH_MAX_ATTEMPTS || 5);
const LOCK_MS = Number(process.env.AUTH_LOCK_MS || 1000 * 60 * 10);
const MAX_AUDIT = Number(process.env.AUTH_MAX_AUDIT || 2000);

const DEFAULT_ADMIN = {
  email: process.env.ADMIN_EMAIL || "admin@colourdiam.com",
  password: process.env.ADMIN_PASSWORD || "Admin2026!",
};

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch (err) {
    console.error("could not load " + path.basename(file) + ":", err.message);
  }
  return fallback;
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("could not save " + path.basename(file) + ":", err.message);
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hash] = parts;
  const candidate = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function uid() {
  return crypto.randomBytes(16).toString("hex");
}

function token() {
  return crypto.randomBytes(32).toString("hex");
}

let users = loadJson(USERS_FILE, []);
let sessions = loadJson(SESSIONS_FILE, {});
let tasks = loadJson(TASKS_FILE, []);
let audit = loadJson(AUDIT_FILE, []);
const loginAttempts = new Map();

function saveUsers() { saveJson(USERS_FILE, users); }
function saveSessions() { saveJson(SESSIONS_FILE, sessions); }
function saveTasks() { saveJson(TASKS_FILE, tasks); }
function saveAudit() { saveJson(AUDIT_FILE, audit); }

function publicUser(u) {
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

export { publicUser };

export function initAuth() {
  if (!users.length) {
    const admin = {
      id: uid(),
      name: "Administrator",
      email: String(DEFAULT_ADMIN.email).toLowerCase().trim(),
      role: "admin",
      active: true,
      passwordHash: hashPassword(DEFAULT_ADMIN.password),
      mustChangePassword: true,
      lastLogin: null,
      createdAt: new Date().toISOString(),
    };
    users.push(admin);
    saveUsers();
    console.log("[auth] bootstrapped admin account " + admin.email + " (change password on first login)");
  }
  const now = Date.now();
  for (const [t, s] of Object.entries(sessions)) {
    if (Number(s.expires) <= now) delete sessions[t];
  }
  if (Object.keys(sessions).length) saveSessions();
}

export function findUserByEmail(email) {
  const e = String(email || "").toLowerCase().trim();
  return users.find((u) => u.email === e) || null;
}

export function findUserById(id) {
  return users.find((u) => u.id === id) || null;
}

export function listUsers() {
  return users.map(publicUser);
}

export function createUser({ name, email, role, password }) {
  const e = String(email || "").toLowerCase().trim();
  if (!name || !e || !password) return { error: "name, email and password are required" };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { error: "invalid email address" };
  if (findUserByEmail(e)) return { error: "a user with that email already exists" };
  if (String(password).length < 8) return { error: "password must be at least 8 characters" };
  const user = {
    id: uid(),
    name: String(name).trim(),
    email: e,
    role: role === "admin" ? "admin" : "user",
    active: true,
    passwordHash: hashPassword(password),
    mustChangePassword: true,
    lastLogin: null,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers();
  return { user: publicUser(user) };
}

export function setUserActive(id, active) {
  const u = findUserById(id);
  if (!u) return { error: "user not found" };
  if (u.role === "admin" && users.filter((x) => x.role === "admin" && x.active).length <= 1 && !active) {
    return { error: "cannot suspend the last active admin" };
  }
  u.active = !!active;
  u.updatedAt = new Date().toISOString();
  saveUsers();
  return { user: publicUser(u) };
}

export function setUserRole(id, role) {
  const u = findUserById(id);
  if (!u) return { error: "user not found" };
  if (u.role === "admin" && role !== "admin" && users.filter((x) => x.role === "admin").length <= 1) {
    return { error: "cannot demote the last admin" };
  }
  u.role = role === "admin" ? "admin" : "user";
  u.updatedAt = new Date().toISOString();
  saveUsers();
  return { user: publicUser(u) };
}

export function resetUserPassword(id, password) {
  const u = findUserById(id);
  if (!u) return { error: "user not found" };
  if (String(password).length < 8) return { error: "password must be at least 8 characters" };
  u.passwordHash = hashPassword(password);
  u.mustChangePassword = true;
  u.updatedAt = new Date().toISOString();
  saveUsers();
  return { user: publicUser(u) };
}

export function issueSession(userId, ip) {
  const t = token();
  sessions[t] = { userId, ip: ip || "", expires: Date.now() + SESSION_TTL_MS };
  saveSessions();
  return t;
}

export function destroySession(t) {
  if (sessions[t]) {
    delete sessions[t];
    saveSessions();
  }
}

export function sessionUser(req) {
  const header = req.headers.authorization || "";
  const t = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!t || !sessions[t]) return null;
  const s = sessions[t];
  if (Number(s.expires) <= Date.now()) {
    delete sessions[t];
    saveSessions();
    return null;
  }
  const u = findUserById(s.userId);
  if (!u || !u.active) return null;
  return u;
}

export function isAdmin(user) {
  return !!(user && user.role === "admin");
}

export function auditLog(userId, action, detail = {}) {
  const entry = {
    id: uid(),
    userId,
    userName: (findUserById(userId) || {}).name || "unknown",
    action,
    detail,
    ip: detail.ip || "",
    at: new Date().toISOString(),
  };
  delete entry.detail.ip;
  audit.push(entry);
  if (audit.length > MAX_AUDIT) audit = audit.slice(audit.length - MAX_AUDIT);
  saveAudit();
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

export function clientIp(req) {
  const fwd = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "";
}

export function attemptLogin(email, password, ip) {
  if (!attemptAllowed(email, ip)) {
    return { error: "Too many failed attempts. Try again in a few minutes." };
  }
  const u = findUserByEmail(email);
  if (!u || !verifyPassword(password, u.passwordHash)) {
    recordFailed(email, ip);
    return { error: "Invalid email or password" };
  }
  if (!u.active) {
    return { error: "This account is suspended. Contact the administrator." };
  }
  u.lastLogin = new Date().toISOString();
  saveUsers();
  const t = issueSession(u.id, ip);
  auditLog(u.id, "login", { ip, email: u.email });
  return { token: t, user: publicUser(u) };
}

export function changePassword(user, oldPassword, newPassword) {
  if (!verifyPassword(oldPassword, user.passwordHash)) return { error: "Current password is incorrect" };
  if (String(newPassword).length < 8) return { error: "New password must be at least 8 characters" };
  user.passwordHash = hashPassword(newPassword);
  user.mustChangePassword = false;
  user.updatedAt = new Date().toISOString();
  saveUsers();
  auditLog(user.id, "password_change", { email: user.email });
  return { ok: true };
}

export function issueResetToken(email) {
  const u = findUserByEmail(email);
  if (!u || !u.active) return { error: "If that email exists, a reset link was sent." };
  u.resetToken = token();
  u.resetExpires = Date.now() + 1000 * 60 * 30;
  saveUsers();
  auditLog(u.id, "password_reset_requested", { email: u.email });
  return { ok: true, resetToken: u.resetToken };
}

export function consumeResetToken(email, resetToken, newPassword) {
  const u = findUserByEmail(email);
  if (!u || !u.resetToken || u.resetToken !== resetToken || !u.resetExpires || Date.now() > u.resetExpires) {
    return { error: "Reset token is invalid or has expired" };
  }
  if (String(newPassword).length < 8) return { error: "Password must be at least 8 characters" };
  u.passwordHash = hashPassword(newPassword);
  u.mustChangePassword = false;
  u.resetToken = null;
  u.resetExpires = null;
  u.updatedAt = new Date().toISOString();
  saveUsers();
  auditLog(u.id, "password_reset", { email: u.email });
  return { ok: true };
}

/* ------------------------- Tasks ------------------------- */

const TASK_STATUS = ["not_started", "in_progress", "blocked", "completed"];

function taskOwned(task, user, includeAdmin) {
  return (includeAdmin && isAdmin(user)) || task.ownerId === user.id || task.assignedTo === user.id;
}

export function listTasks(user, opts = {}) {
  let list = tasks;
  if (!isAdmin(user)) list = tasks.filter((t) => t.ownerId === user.id || t.assignedTo === user.id);
  if (opts.assignedTo) list = list.filter((t) => t.assignedTo === opts.assignedTo);
  if (opts.status) list = list.filter((t) => t.status === opts.status);
  return list
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function getTask(id, user) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return { error: "task not found" };
  if (!taskOwned(task, user, true)) return { error: "not allowed" };
  return { task };
}

export function createTask(data, user) {
  const title = String(data.title || "").trim();
  if (!title) return { error: "task title is required" };
  const assignedId = (data.assignedTo && findUserById(data.assignedTo)) ? data.assignedTo : user.id;
  const task = {
    id: uid(),
    ownerId: user.id,
    assignedTo: assignedId,
    title,
    description: String(data.description || "").trim(),
    status: TASK_STATUS.includes(data.status) ? data.status : "not_started",
    progress: Math.min(100, Math.max(0, Number(data.progress || 0) || 0)),
    priority: ["low", "medium", "high", "urgent"].includes(data.priority) ? data.priority : "medium",
    startDate: data.startDate || null,
    dueDate: data.dueDate || null,
    notes: String(data.notes || "").trim(),
    attachments: Array.isArray(data.attachments) ? data.attachments.map(String) : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  tasks.push(task);
  saveTasks();
  auditLog(user.id, "task_created", { taskId: task.id, title: task.title });
  return { task };
}

export function updateTask(id, patch, user) {
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
  if (patch.priority !== undefined && ["low", "medium", "high", "urgent"].includes(patch.priority)) task.priority = patch.priority;
  if (patch.startDate !== undefined) task.startDate = patch.startDate || null;
  if (patch.dueDate !== undefined) task.dueDate = patch.dueDate || null;
  if (patch.notes !== undefined) task.notes = String(patch.notes).trim();
  if (patch.attachments !== undefined && Array.isArray(patch.attachments)) task.attachments = patch.attachments.map(String);
  if (patch.assignedTo !== undefined && findUserById(patch.assignedTo)) {
    if (!isAdmin(user)) return { error: "only admins can reassign tasks" };
    task.assignedTo = patch.assignedTo;
  }
  task.updatedAt = new Date().toISOString();
  saveTasks();
  auditLog(user.id, "task_updated", {
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

export function deleteTask(id, user) {
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return { error: "task not found" };
  if (!taskOwned(tasks[idx], user, true)) return { error: "not allowed" };
  const [task] = tasks.splice(idx, 1);
  saveTasks();
  auditLog(user.id, "task_deleted", { taskId: task.id, title: task.title });
  return { ok: true };
}

/* ------------------------- Admin reporting ------------------------- */

function taskStatsFor(userId) {
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

function avgProgress(userId) {
  const mine = tasks.filter((t) => t.assignedTo === userId);
  if (!mine.length) return 0;
  return Math.round(mine.reduce((sum, t) => sum + (t.progress || 0), 0) / mine.length);
}

export function adminStats() {
  const active = users.filter((u) => u.active);
  const byUser = active.map((u) => ({
    ...publicUser(u),
    ...taskStatsFor(u.id),
    avgProgress: avgProgress(u.id),
    createdCount: audit.filter((a) => a.userId === u.id && (a.action === "task_created" || a.action === "record_created")).length,
    updatedCount: audit.filter((a) => a.userId === u.id && (a.action === "task_updated" || a.action === "record_updated")).length,
  }));
  const all = taskStatsFor("");
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

export function adminReport() {
  const byUser = users.map((u) => ({
    ...publicUser(u),
    tasks: tasks.filter((t) => t.assignedTo === u.id).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    ...taskStatsFor(u.id),
    avgProgress: avgProgress(u.id),
  }));
  return { users: byUser };
}

export function activityFor(userId) {
  return audit.filter((a) => a.userId === userId).slice().reverse().slice(0, 200);
}

export function adminAudit(opts = {}) {
  let list = audit.slice();
  if (opts.userId) list = list.filter((a) => a.userId === opts.userId);
  if (opts.action) list = list.filter((a) => a.action === opts.action);
  return list.slice().reverse().slice(0, Number(opts.limit || 300));
}

export function recentActivity(limit = 20) {
  return audit.slice().reverse().slice(0, limit);
}
