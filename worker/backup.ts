// JSON backup export/import for the panel.
//
// Two scopes exist, mirroring the "مرکز بکاپ و بازیابی اطلاعات" screen:
//   • user   — everything a signed-in account owns: deployments (panel/worker
//              records), Cloudflare token rows, worker members, injector jobs
//              and group subs. Deployment links are kept by name so imports
//              work across Cloudflare accounts.
//   • system — the whole D1 database, every table, admin only. Restoring it
//              replaces the table contents with the backup's rows.
//
// User restores match deployments by id first then by name; existing rows are
// reused. A system restore deletes children before parents and re-inserts in
// dependency order, so foreign keys stay satisfied.

import type { Env } from './env'
import { apiError, json, nowIso } from './util'

interface BackupMember {
  deployment_ref: { id: string; name: string }
  name: string
  token: string
  enabled: number
  expires_at: string | null
  quota_bytes: number | null
  request_quota: number | null
  ip_limit: number | null
  start_on_connect: number
  reset_period_days: number | null
  settings: Record<string, unknown>
}

interface BackupInjector {
  name: string
  source: string
  ips: string[]
  proxies: unknown[]
  sub_token: string
  rotate_minutes: number | null
}

interface BackupDeployment {
  name: string
  uuid: string | null
  method: string
  worker_source: string
  status: string
  custom_path: string | null
  panel_url: string | null
  sub_url: string | null
  created_at: string
}

interface BackupToken {
  name: string
  token: string
  status: string
}

interface BackupGroup {
  name: string
  deployment_refs: { id: string; name: string }[]
  sub_token: string
  inject?: number
  ips?: string[]
  proxies?: unknown[]
  /** Output format of the served subscription (base64/clash/singbox/plain). */
  format?: string
  /** Extra hand-pasted node links merged into the group — must survive a backup. */
  extra_links?: string[]
}

export async function exportBackup(env: Env, userId: string): Promise<Response> {
  const deps = await env.DB.prepare(
    `SELECT id, name FROM deployments WHERE user_id = ?`
  ).bind(userId).all<{ id: string; name: string }>()
  const depById = new Map((deps.results ?? []).map((d) => [d.id, d]))

  const members = await env.DB.prepare(
    `SELECT * FROM worker_members WHERE owner_user_id = ? ORDER BY created_at`
  ).bind(userId).all<Record<string, unknown>>()

  const injectors = await env.DB.prepare(
    `SELECT name, source, ips, proxies, sub_token, rotate_minutes FROM injector_jobs WHERE user_id = ? ORDER BY created_at`
  ).bind(userId).all<{ name: string; source: string; ips: string; proxies: string; sub_token: string; rotate_minutes: number | null }>()

  const groups = await env.DB.prepare(
    `SELECT * FROM sub_groups WHERE user_id = ? ORDER BY created_at`
  ).bind(userId).all<Record<string, unknown>>()

  const userDeps = await env.DB.prepare(
    `SELECT name, uuid, method, worker_source, status, custom_path, panel_url, sub_url, created_at
       FROM deployments WHERE user_id = ? ORDER BY created_at`
  ).bind(userId).all<BackupDeployment>()

  const tokens = await env.DB.prepare(
    `SELECT name, token, status FROM cf_tokens WHERE user_id = ? ORDER BY created_at`
  ).bind(userId).all<BackupToken>()

  const payload = {
    app: 'miliconfig',
    scope: 'user',
    version: 2,
    exported_at: nowIso(),
    deployments: userDeps.results ?? [],
    cf_tokens: tokens.results ?? [],
    members: (members.results ?? []).map((m) => {
      const dep = depById.get(String(m.deployment_id))
      return {
        deployment_ref: dep ? { id: dep.id, name: dep.name } : { id: '', name: String(m.deployment_id) },
        name: m.name,
        token: m.token,
        enabled: m.enabled,
        expires_at: m.expires_at,
        quota_bytes: m.quota_bytes,
        request_quota: m.request_quota,
        ip_limit: m.ip_limit,
        start_on_connect: m.start_on_connect,
        reset_period_days: m.reset_period_days,
        settings: safeObj(m.settings),
      }
    }) as BackupMember[],
    injectors: (injectors.results ?? []).map((j) => ({
      name: j.name,
      source: j.source,
      ips: safeArr(j.ips),
      proxies: safeArr(j.proxies),
      sub_token: j.sub_token,
      rotate_minutes: j.rotate_minutes,
    })) as BackupInjector[],
    groups: (groups.results ?? []).map((g) => {
      const ids = safeArr(g.deployment_ids) as string[]
      return {
        name: g.name,
        deployment_refs: ids.map((id) => {
          const d = depById.get(id)
          return d ? { id: d.id, name: d.name } : { id, name: id }
        }),
        sub_token: g.sub_token,
        inject: g.inject as number | undefined,
        ips: safeArr(g.ips as string),
        proxies: safeArr(g.proxies as string),
        format: (g.format as string | null) ?? 'base64',
        extra_links: safeArr(g.extra_links as string) as string[],
      }
    }) as BackupGroup[],
  }

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="miliconfig-backup-${nowIso().slice(0, 10)}.json"`,
    },
  })
}

function genBackupId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

function safeObj(v: unknown): Record<string, unknown> {
  try { return typeof v === 'string' ? JSON.parse(v) : (v as Record<string, unknown>) ?? {} } catch { return {} }
}
function safeArr(v: unknown): unknown[] {
  try { return typeof v === 'string' ? JSON.parse(v) : Array.isArray(v) ? v : [] } catch { return [] }
}

export async function importBackup(env: Env, userId: string, request: Request): Promise<Response> {
  type UserBackupBody = {
    members?: BackupMember[]
    injectors?: BackupInjector[]
    groups?: BackupGroup[]
    deployments?: BackupDeployment[]
    cf_tokens?: BackupToken[]
    mode?: 'merge' | 'replace'
  }
  let body: UserBackupBody
  try { body = await request.json() } catch { return apiError('JSON نامعتبر است', 400) }
  const mode = body.mode === 'replace' ? 'replace' : 'merge'

  if (mode === 'replace') {
    // Only delete rows owned by this user — never other users' data.
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM worker_members WHERE owner_user_id = ?`).bind(userId),
      env.DB.prepare(`DELETE FROM injector_jobs WHERE user_id = ?`).bind(userId),
      env.DB.prepare(`DELETE FROM sub_groups WHERE user_id = ?`).bind(userId),
    ])
  }

  const deps = await env.DB.prepare(`SELECT id, name FROM deployments WHERE user_id = ?`)
    .bind(userId).all<{ id: string; name: string }>()
  const depByName = new Map((deps.results ?? []).map((d) => [d.name.toLowerCase(), d.id]))
  const depById = new Set((deps.results ?? []).map((d) => d.id))

  // ── deployment + token records first: members/groups resolve against them ──
  let addedDeployments = 0, skippedDeployments = 0
  for (const d of body.deployments ?? []) {
    const name = String(d?.name ?? '').trim()
    if (!name) { skippedDeployments++; continue }
    const exists = await env.DB.prepare(`SELECT 1 FROM deployments WHERE user_id = ? AND name = ?`)
      .bind(userId, name).first()
    if (exists) { skippedDeployments++; continue }
    await env.DB.prepare(
      `INSERT INTO deployments (id, user_id, name, status, uuid, method, worker_source, custom_path, panel_url, sub_url, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`
    ).bind(
      genBackupId(), userId, name, d.status || 'deployed', d.uuid ?? null,
      d.method === 'pages' ? 'pages' : 'workers', d.worker_source || 'edgetunnel',
      d.custom_path ?? null, d.panel_url ?? null, d.sub_url ?? null, d.created_at || nowIso(),
    ).run()
    addedDeployments++
  }

  let addedTokens = 0, skippedTokens = 0
  for (const t of body.cf_tokens ?? []) {
    const name = String(t?.name ?? '').trim()
    if (!name || !t?.token) { skippedTokens++; continue }
    const exists = await env.DB.prepare(`SELECT 1 FROM cf_tokens WHERE user_id = ? AND name = ?`)
      .bind(userId, name).first()
    if (exists) { skippedTokens++; continue }
    await env.DB.prepare(
      `INSERT INTO cf_tokens (id, user_id, name, token, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(genBackupId(), userId, name, t.token, t.status === 'inactive' ? 'inactive' : 'active', nowIso()).run()
    addedTokens++
  }

  let addedMembers = 0, skippedMembers = 0
  for (const m of body.members ?? []) {
    const depId = m.deployment_ref && depById.has(m.deployment_ref.id)
      ? m.deployment_ref.id
      : depByName.get((m.deployment_ref?.name ?? '').toLowerCase())
    if (!depId) { skippedMembers++; continue }
    const exists = await env.DB.prepare(`SELECT 1 FROM worker_members WHERE token = ?`).bind(m.token).first()
    if (exists) { skippedMembers++; continue }
    await env.DB.prepare(
      `INSERT INTO worker_members (id, owner_user_id, deployment_id, name, token, enabled, expires_at, quota_bytes, request_quota, ip_limit, start_on_connect, reset_period_days, settings, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
    ).bind(
      crypto.randomUUID().replaceAll('-', ''), userId, depId, m.name, m.token,
      m.enabled === 0 ? 0 : 1, m.expires_at ?? null, m.quota_bytes ?? null,
      m.request_quota ?? null, m.ip_limit ?? null, m.start_on_connect ? 1 : 0,
      m.reset_period_days ?? null, JSON.stringify(m.settings ?? {}), nowIso(),
    ).run()
    addedMembers++
  }

  let addedInjectors = 0, skippedInjectors = 0
  for (const j of body.injectors ?? []) {
    const exists = await env.DB.prepare(`SELECT 1 FROM injector_jobs WHERE sub_token = ?`).bind(j.sub_token).first()
    if (exists) { skippedInjectors++; continue }
    await env.DB.prepare(
      `INSERT INTO injector_jobs (id, user_id, name, source, ips, proxies, sub_token, rotate_minutes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`
    ).bind(crypto.randomUUID().replaceAll('-', ''), userId, j.name, j.source || 'custom',
      JSON.stringify(j.ips ?? []), JSON.stringify(j.proxies ?? []), j.sub_token, j.rotate_minutes ?? null, nowIso()).run()
    addedInjectors++
  }

  let addedGroups = 0, skippedGroups = 0
  for (const g of body.groups ?? []) {
    const ids = (g.deployment_refs ?? [])
      .map((r) => (depById.has(r.id) ? r.id : depByName.get(r.name.toLowerCase())))
      .filter((x): x is string => !!x)
    if (ids.length === 0 && (g.deployment_refs ?? []).length > 0) { skippedGroups++; continue }
    const exists = await env.DB.prepare(`SELECT 1 FROM sub_groups WHERE sub_token = ?`).bind(g.sub_token).first()
    if (exists) { skippedGroups++; continue }
    await env.DB.prepare(
      `INSERT INTO sub_groups (id, user_id, name, deployment_ids, sub_token, inject, ips, proxies, format, extra_links, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, 0), COALESCE(?7, '[]'), COALESCE(?8, '[]'), COALESCE(?9, 'base64'), COALESCE(?10, '[]'), ?11)`
    ).bind(crypto.randomUUID().replaceAll('-', ''), userId, g.name, JSON.stringify(ids), g.sub_token,
      g.inject ?? 0, JSON.stringify(g.ips ?? []), JSON.stringify(g.proxies ?? []),
      g.format ?? null, g.extra_links ? JSON.stringify(g.extra_links) : null, nowIso()).run()
    addedGroups++
  }

  return json({ ok: true, mode,
    deployments_added: addedDeployments, deployments_skipped: skippedDeployments,
    tokens_added: addedTokens, tokens_skipped: skippedTokens,
    members_added: addedMembers, members_skipped: skippedMembers,
    injectors_added: addedInjectors, injectors_skipped: skippedInjectors,
    groups_added: addedGroups, groups_skipped: skippedGroups })
}

// ── whole-system backup (admin only) ─────────────────────────────────────────

/**
 * Every table of the panel database, in dependency order (parents first).
 * A restore deletes in reverse order and inserts in this order, so foreign
 * keys never block the operation. `sessions` goes last: restoring it can only
 * remove stale sessions, never break a row that another table points at.
 */
export const SYSTEM_TABLES = [
  'users',
  'cf_tokens',
  'render_tokens',
  'railway_tokens',
  'deployments',
  'railway_deploys',
  'render_deploys',
  'bot_config',
  'bot_users',
  'activity_logs',
  'optimizer_jobs',
  'sub_groups',
  'injector_jobs',
  'worker_members',
  'bot_sessions',
  'bot_tenants',
  'app_settings',
  'db_meta',
  'sessions',
] as const

/** Whole D1 dump: every row of every panel table, as JSON. */
export async function exportSystemBackup(env: Env): Promise<Response> {
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const table of SYSTEM_TABLES) {
    const rows = await env.DB.prepare(`SELECT * FROM "${table}"`).all<Record<string, unknown>>()
    tables[table] = rows.results ?? []
  }

  const payload = {
    app: 'miliconfig',
    scope: 'system',
    version: 2,
    exported_at: nowIso(),
    counts: Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, rows.length])),
    tables,
  }
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="miliconfig-system-backup-${nowIso().slice(0, 10)}.json"`,
    },
  })
}

/**
 * Replace the database contents with a system backup.
 *
 * Admin-only (enforced by the route). The caller's own session is carried over
 * so the admin is not signed out the moment the restore lands.
 */
export async function importSystemBackup(env: Env, request: Request, sessionToken: string): Promise<Response> {
  let body: { tables?: Record<string, unknown[]>; mode?: string }
  try { body = await request.json() } catch { return apiError('JSON نامعتبر است', 400) }
  if (!body?.tables || typeof body.tables !== 'object') {
    return apiError('فایل بکاپ جامع معتبر نیست — بخش tables پیدا نشد', 400)
  }

  // Remember the caller's session row before the tables are wiped.
  const keepSession = sessionToken
    ? await env.DB.prepare(`SELECT token, user_id, created_at, expires_at FROM sessions WHERE token = ?`)
        .bind(sessionToken).first<{ token: string; user_id: string; created_at: string; expires_at: string }>()
    : null

  const incoming = new Map<string, Record<string, unknown>[]>()
  for (const table of SYSTEM_TABLES) {
    const rows = body.tables[table]
    if (Array.isArray(rows)) incoming.set(table, rows.filter((r) => r && typeof r === 'object') as Record<string, unknown>[])
  }
  if (incoming.size === 0) return apiError('هیچ جدول شناخته‌شده‌ای در فایل بکاپ نبود', 400)

  const chunk = <T,>(items: T[], size: number): T[][] => {
    const out: T[][] = []
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
    return out
  }

  // 1) children first (reverse dependency order)
  for (const table of [...SYSTEM_TABLES].reverse()) {
    if (!incoming.has(table)) continue
    await env.DB.prepare(`DELETE FROM "${table}"`).run()
  }

  // 2) parents first
  let restored = 0
  for (const table of SYSTEM_TABLES) {
    const rows = incoming.get(table)
    if (!rows || rows.length === 0) continue
    const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r))))
    if (columns.length === 0) continue
    const sql = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    for (const part of chunk(rows, 40)) {
      await env.DB.batch(part.map((row) => env.DB.prepare(sql).bind(...columns.map((c) => row[c] ?? null))))
      restored += part.length
    }
  }

  // 3) never sign the restoring admin out
  if (keepSession) {
    await env.DB.prepare(`INSERT OR IGNORE INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
      .bind(keepSession.token, keepSession.user_id, keepSession.created_at, keepSession.expires_at).run()
  }

  return json({ ok: true, tables: incoming.size, rows: restored, session_preserved: !!keepSession })
}
