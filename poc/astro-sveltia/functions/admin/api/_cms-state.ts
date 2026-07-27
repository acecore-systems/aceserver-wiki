import type { CmsRuntimeEnv } from './_cms-policy.ts'

const RATE_LIMIT_WINDOW_SECONDS = 10 * 60
const RATE_LIMIT_MAX_MUTATIONS = 12
const PROCESSING_LEASE_SECONDS = 5 * 60
const REPLAY_RETENTION_SECONDS = 7 * 24 * 60 * 60
const UNKNOWN_RETENTION_SECONDS = 30 * 24 * 60 * 60
const RATE_LIMIT_RETENTION_SECONDS = 24 * 60 * 60
const RETENTION_DELETE_LIMIT = 100
const MAX_STORED_RESPONSE_BYTES = 1024 * 1024

type MutationState = 'processing' | 'unknown' | 'succeeded' | 'failed'

type MutationStateRow = {
  state: MutationState
  response_json: string | null
  http_status: number | null
  request_id: string
  audit_id: string
  lease_expires_at: number | null
  publication_branch: string
  commit_marker: string
  expected_head_oid: string
}

export type CmsMutationReservation = {
  auditId: string
  idempotencyKey: string
  requestId: string
  publicationBranch: string
  commitMarker: string
  expectedHeadOid: string
}

export type CmsMutationStart =
  | {
      kind: 'reserved'
      reservation: CmsMutationReservation
    }
  | {
      kind: 'reconcile'
      reservation: CmsMutationReservation
    }
  | {
      kind: 'replay'
      requestId: string
      response: unknown
      status: number
    }

export class CmsStateError extends Error {
  status: number
  retryAfterSeconds?: number

  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message)
    this.name = 'CmsStateError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export async function beginCmsMutation({
  bodyText,
  discordId,
  discordRoleIds,
  env,
  expectedHeadOid,
  paths,
  request,
}: {
  bodyText: string
  discordId: string
  discordRoleIds: string[]
  env: CmsRuntimeEnv
  expectedHeadOid: string
  paths: string[]
  request: Request
}): Promise<CmsMutationStart> {
  const database = requireCmsDatabase(env)
  const now = Math.floor(Date.now() / 1000)
  const requestId = getRequestId(request)
  const idempotencyKey = await sha256Hex(
    `cms-mutation-v2\n${env.CMS_PUBLICATION_MODE}\n${discordId}\n${bodyText}`,
  )
  const publicationBranch = `cms/pending/${idempotencyKey}`
  const commitMarker = `CMS-Idempotency-Key: ${idempotencyKey}`

  try {
    await cleanupCmsState(database, now)

    const ban = await database
      .prepare(
        `SELECT reason, expires_at
         FROM cms_bans
         WHERE discord_id = ?
           AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
      )
      .bind(discordId, now)
      .first<{ reason: string; expires_at: number | null }>()

    if (ban) {
      throw new CmsStateError(
        ban.expires_at
          ? 'このDiscordユーザーの編集権限は一時停止されています。'
          : 'このDiscordユーザーの編集権限は停止されています。',
        403,
      )
    }

    let existing = await getMutation(database, idempotencyKey)
    const replay = parseSuccessfulReplay(existing)

    if (replay) return replay

    if (existing?.state === 'succeeded') {
      throw new CmsStateError('保存済み応答の監査データが壊れています。', 503)
    }

    if (existing?.state === 'unknown') {
      return {
        kind: 'reconcile',
        reservation: reservationFromRow(idempotencyKey, existing),
      }
    }

    if (existing?.state === 'processing') {
      if (
        typeof existing.lease_expires_at === 'number' &&
        existing.lease_expires_at > now
      ) {
        throw new CmsStateError(
          `同じ保存処理を確認中です。request ID: ${existing.request_id}`,
          409,
        )
      }

      await transitionStaleMutationToUnknown({
        database,
        idempotencyKey,
        row: existing,
        now,
      })
      existing = await getMutation(database, idempotencyKey)

      if (existing?.state === 'unknown') {
        return {
          kind: 'reconcile',
          reservation: reservationFromRow(idempotencyKey, existing),
        }
      }

      const racedReplay = parseSuccessfulReplay(existing)

      if (racedReplay) return racedReplay

      throw new CmsStateError(
        `同じ保存処理が更新されました。request ID: ${
          existing?.request_id || requestId
        }`,
        409,
      )
    }

    const windowStart = now - (now % RATE_LIMIT_WINDOW_SECONDS)
    const rate = await database
      .prepare(
        `INSERT INTO cms_rate_limits (
           scope, actor_id, window_start, hit_count
         ) VALUES ('mutation', ?, ?, 1)
         ON CONFLICT(scope, actor_id, window_start)
         DO UPDATE SET hit_count = hit_count + 1
         RETURNING hit_count`,
      )
      .bind(discordId, windowStart)
      .first<{ hit_count: number }>()

    if (!rate || !Number.isInteger(rate.hit_count)) {
      throw new Error('D1 rate limit result is invalid')
    }

    if (rate.hit_count > RATE_LIMIT_MAX_MUTATIONS) {
      const retryAfterSeconds = windowStart + RATE_LIMIT_WINDOW_SECONDS - now

      throw new CmsStateError(
        '保存回数が上限に達しました。少し待ってから再試行してください。',
        429,
        Math.max(1, retryAfterSeconds),
      )
    }

    const auditId = crypto.randomUUID()
    const leaseExpiresAt = now + PROCESSING_LEASE_SECONDS
    const mutationStatement =
      existing?.state === 'failed'
        ? database
            .prepare(
              `UPDATE cms_mutations
               SET request_id = ?,
                   audit_id = ?,
                   state = 'processing',
                   response_json = NULL,
                   http_status = NULL,
                   lease_expires_at = ?,
                   publication_branch = ?,
                   commit_marker = ?,
                   expected_head_oid = ?,
                   commit_oid = NULL,
                   updated_at = ?
               WHERE idempotency_key = ? AND state = 'failed'`,
            )
            .bind(
              requestId,
              auditId,
              leaseExpiresAt,
              publicationBranch,
              commitMarker,
              expectedHeadOid,
              now,
              idempotencyKey,
            )
        : database
            .prepare(
              `INSERT OR IGNORE INTO cms_mutations (
                 idempotency_key,
                 actor_discord_id,
                 request_id,
                 audit_id,
                 state,
                 lease_expires_at,
                 publication_branch,
                 commit_marker,
                 expected_head_oid,
                 created_at,
                 updated_at
               ) VALUES (?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              idempotencyKey,
              discordId,
              requestId,
              auditId,
              leaseExpiresAt,
              publicationBranch,
              commitMarker,
              expectedHeadOid,
              now,
              now,
            )
    const results = await database.batch([
      mutationStatement,
      database
        .prepare(
          `INSERT INTO cms_audit_events (
             id,
             occurred_at,
             actor_discord_id,
             discord_role_ids_json,
             request_id,
             action,
             status,
             paths_json
           )
           SELECT ?, ?, ?, ?, ?, 'mutation', 'attempted', ?
           WHERE EXISTS (
             SELECT 1
             FROM cms_mutations
             WHERE idempotency_key = ?
               AND audit_id = ?
               AND state = 'processing'
           )`,
        )
        .bind(
          auditId,
          now,
          discordId,
          JSON.stringify(discordRoleIds),
          requestId,
          JSON.stringify(paths),
          idempotencyKey,
          auditId,
        ),
    ])

    if (!hasExactlyOneChange(results[0]) || !hasExactlyOneChange(results[1])) {
      if (hasExactlyOneChange(results[0]) !== hasExactlyOneChange(results[1])) {
        throw new Error(
          'CMS mutation reservation and audit were not changed as a pair',
        )
      }

      const raced = await getMutation(database, idempotencyKey)
      const racedReplay = parseSuccessfulReplay(raced)

      if (racedReplay) return racedReplay

      throw new CmsStateError(
        `同じ保存処理がすでに開始されています。request ID: ${
          raced?.request_id || requestId
        }`,
        409,
      )
    }

    return {
      kind: 'reserved',
      reservation: {
        auditId,
        idempotencyKey,
        requestId,
        publicationBranch,
        commitMarker,
        expectedHeadOid,
      },
    }
  } catch (error) {
    if (error instanceof CmsStateError) throw error

    logStateError('CMS mutation state initialization failed', {
      error,
      requestId,
    })
    throw new CmsStateError(
      'CMSのBAN、rate limit、監査ログを確認できません。',
      503,
    )
  }
}

export async function resumeCmsMutation({
  env,
  reservation,
}: {
  env: CmsRuntimeEnv
  reservation: CmsMutationReservation
}) {
  const database = requireCmsDatabase(env)
  const now = Math.floor(Date.now() / 1000)

  try {
    const results = await database.batch([
      database
        .prepare(
          `UPDATE cms_mutations
           SET state = 'processing',
               lease_expires_at = ?,
               updated_at = ?
           WHERE idempotency_key = ?
             AND audit_id = ?
             AND state = 'unknown'
             AND EXISTS (
               SELECT 1
               FROM cms_audit_events
               WHERE id = ? AND status = 'unknown'
             )`,
        )
        .bind(
          now + PROCESSING_LEASE_SECONDS,
          now,
          reservation.idempotencyKey,
          reservation.auditId,
          reservation.auditId,
        ),
      database
        .prepare(
          `UPDATE cms_audit_events
           SET status = 'attempted',
               detail = 'reconciled: no external commit was found; retrying'
           WHERE id = ?
             AND status = 'unknown'
             AND EXISTS (
               SELECT 1
               FROM cms_mutations
               WHERE idempotency_key = ?
                 AND audit_id = ?
                 AND state = 'processing'
             )`,
        )
        .bind(
          reservation.auditId,
          reservation.idempotencyKey,
          reservation.auditId,
        ),
    ])

    assertPairedStateChange(
      results,
      'CMS mutation reconciliation could not resume',
      reservation.requestId,
    )
  } catch (error) {
    throwStateOperationError(
      'CMS mutation reconciliation resume failed',
      reservation.requestId,
      error,
    )
  }
}

export async function completeCmsMutation({
  branch,
  commitOid,
  env,
  reservation,
  response,
  status,
}: {
  branch: string
  commitOid: string
  env: CmsRuntimeEnv
  reservation: CmsMutationReservation
  response: unknown
  status: number
}) {
  const database = requireCmsDatabase(env)
  const responseJson = JSON.stringify(response)

  if (
    new TextEncoder().encode(responseJson).byteLength >
    MAX_STORED_RESPONSE_BYTES
  ) {
    throw new CmsStateError(
      'CMS保存結果が監査ログの上限を超えたため、成功を確定できません。',
      503,
    )
  }

  try {
    const now = Math.floor(Date.now() / 1000)
    const results = await database.batch([
      database
        .prepare(
          `UPDATE cms_mutations
           SET state = 'succeeded',
               response_json = ?,
               http_status = ?,
               lease_expires_at = NULL,
               publication_branch = ?,
               commit_oid = ?,
               updated_at = ?
           WHERE idempotency_key = ?
             AND audit_id = ?
             AND state IN ('processing', 'unknown')
             AND EXISTS (
               SELECT 1
               FROM cms_audit_events
               WHERE id = ? AND status IN ('attempted', 'unknown')
             )`,
        )
        .bind(
          responseJson,
          status,
          branch,
          commitOid,
          now,
          reservation.idempotencyKey,
          reservation.auditId,
          reservation.auditId,
        ),
      database
        .prepare(
          `UPDATE cms_audit_events
           SET status = 'succeeded',
               branch = ?,
               commit_oid = ?,
               http_status = ?,
               detail = NULL
           WHERE id = ?
             AND status IN ('attempted', 'unknown')
             AND EXISTS (
               SELECT 1
               FROM cms_mutations
               WHERE idempotency_key = ?
                 AND audit_id = ?
                 AND state = 'succeeded'
                 AND commit_oid = ?
             )`,
        )
        .bind(
          branch,
          commitOid,
          status,
          reservation.auditId,
          reservation.idempotencyKey,
          reservation.auditId,
          commitOid,
        ),
    ])

    assertPairedStateChange(
      results,
      'CMS mutation completion changed an unexpected number of rows',
      reservation.requestId,
    )
  } catch (error) {
    throwStateOperationError(
      'CMS mutation audit completion failed',
      reservation.requestId,
      error,
    )
  }
}

export async function failCmsMutation({
  env,
  message,
  reservation,
  status,
}: {
  env: CmsRuntimeEnv
  message: string
  reservation: CmsMutationReservation
  status: number
}) {
  const database = requireCmsDatabase(env)

  try {
    const now = Math.floor(Date.now() / 1000)
    const results = await database.batch([
      database
        .prepare(
          `UPDATE cms_mutations
           SET state = 'failed',
               http_status = ?,
               lease_expires_at = NULL,
               updated_at = ?
           WHERE idempotency_key = ?
             AND audit_id = ?
             AND state IN ('processing', 'unknown')
             AND EXISTS (
               SELECT 1
               FROM cms_audit_events
               WHERE id = ? AND status IN ('attempted', 'unknown')
             )`,
        )
        .bind(
          status,
          now,
          reservation.idempotencyKey,
          reservation.auditId,
          reservation.auditId,
        ),
      database
        .prepare(
          `UPDATE cms_audit_events
           SET status = 'failed',
               http_status = ?,
               detail = ?
           WHERE id = ?
             AND status IN ('attempted', 'unknown')
             AND EXISTS (
               SELECT 1
               FROM cms_mutations
               WHERE idempotency_key = ?
                 AND audit_id = ?
                 AND state = 'failed'
             )`,
        )
        .bind(
          status,
          singleLine(message).slice(0, 300),
          reservation.auditId,
          reservation.idempotencyKey,
          reservation.auditId,
        ),
    ])

    assertPairedStateChange(
      results,
      'CMS mutation failure changed an unexpected number of rows',
      reservation.requestId,
    )
  } catch (error) {
    throwStateOperationError(
      'CMS mutation audit failure recording failed',
      reservation.requestId,
      error,
    )
  }
}

export async function markCmsMutationUnknown({
  env,
  message,
  reservation,
}: {
  env: CmsRuntimeEnv
  message: string
  reservation: CmsMutationReservation
}) {
  const database = requireCmsDatabase(env)

  try {
    const now = Math.floor(Date.now() / 1000)
    const results = await database.batch([
      database
        .prepare(
          `UPDATE cms_mutations
           SET state = 'unknown',
               lease_expires_at = NULL,
               updated_at = ?
           WHERE idempotency_key = ?
             AND audit_id = ?
             AND state = 'processing'
             AND EXISTS (
               SELECT 1
               FROM cms_audit_events
               WHERE id = ? AND status = 'attempted'
             )`,
        )
        .bind(
          now,
          reservation.idempotencyKey,
          reservation.auditId,
          reservation.auditId,
        ),
      database
        .prepare(
          `UPDATE cms_audit_events
           SET status = 'unknown',
               detail = ?
           WHERE id = ?
             AND status = 'attempted'
             AND EXISTS (
               SELECT 1
               FROM cms_mutations
               WHERE idempotency_key = ?
                 AND audit_id = ?
                 AND state = 'unknown'
             )`,
        )
        .bind(
          singleLine(message).slice(0, 300),
          reservation.auditId,
          reservation.idempotencyKey,
          reservation.auditId,
        ),
    ])

    if (hasExactlyOneChange(results[0]) && hasExactlyOneChange(results[1])) {
      return
    }

    const current = await getMutation(database, reservation.idempotencyKey)

    if (
      current?.audit_id === reservation.auditId &&
      (current.state === 'unknown' || current.state === 'succeeded')
    ) {
      return
    }

    throw new Error('CMS mutation could not be marked unknown')
  } catch (error) {
    throwStateOperationError(
      'CMS mutation unknown-state recording failed',
      reservation.requestId,
      error,
    )
  }
}

function requireCmsDatabase(env: CmsRuntimeEnv) {
  if (!env.CMS_DATABASE) {
    throw new CmsStateError('CMS監査データベースが設定されていません。', 503)
  }

  return env.CMS_DATABASE
}

async function cleanupCmsState(database: D1Database, now: number) {
  await database.batch([
    database
      .prepare(
        `DELETE FROM cms_rate_limits
         WHERE rowid IN (
           SELECT rowid
           FROM cms_rate_limits
           WHERE window_start < ?
           ORDER BY window_start
           LIMIT ?
         )`,
      )
      .bind(now - RATE_LIMIT_RETENTION_SECONDS, RETENTION_DELETE_LIMIT),
    database
      .prepare(
        `DELETE FROM cms_mutations
         WHERE idempotency_key IN (
           SELECT idempotency_key
           FROM cms_mutations
           WHERE state IN ('succeeded', 'failed')
             AND updated_at < ?
           ORDER BY updated_at
           LIMIT ?
         )`,
      )
      .bind(now - REPLAY_RETENTION_SECONDS, RETENTION_DELETE_LIMIT),
    database
      .prepare(
        `DELETE FROM cms_mutations
         WHERE idempotency_key IN (
           SELECT idempotency_key
           FROM cms_mutations
           WHERE state = 'unknown'
             AND updated_at < ?
           ORDER BY updated_at
           LIMIT ?
         )`,
      )
      .bind(now - UNKNOWN_RETENTION_SECONDS, RETENTION_DELETE_LIMIT),
  ])
}

async function transitionStaleMutationToUnknown({
  database,
  idempotencyKey,
  now,
  row,
}: {
  database: D1Database
  idempotencyKey: string
  now: number
  row: MutationStateRow
}) {
  const results = await database.batch([
    database
      .prepare(
        `UPDATE cms_mutations
         SET state = 'unknown',
             lease_expires_at = NULL,
             updated_at = ?
         WHERE idempotency_key = ?
           AND audit_id = ?
           AND state = 'processing'
           AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
           AND EXISTS (
             SELECT 1
             FROM cms_audit_events
             WHERE id = ? AND status = 'attempted'
           )`,
      )
      .bind(now, idempotencyKey, row.audit_id, now, row.audit_id),
    database
      .prepare(
        `UPDATE cms_audit_events
         SET status = 'unknown',
             detail = 'processing lease expired; reconciliation required'
         WHERE id = ?
           AND status = 'attempted'
           AND EXISTS (
             SELECT 1
             FROM cms_mutations
             WHERE idempotency_key = ?
               AND audit_id = ?
               AND state = 'unknown'
           )`,
      )
      .bind(row.audit_id, idempotencyKey, row.audit_id),
  ])

  if (
    (hasExactlyOneChange(results[0]) && hasExactlyOneChange(results[1])) ||
    (!hasExactlyOneChange(results[0]) && !hasExactlyOneChange(results[1]))
  ) {
    return
  }

  throw new Error('Stale CMS mutation transition was not atomic')
}

async function getMutation(database: D1Database, idempotencyKey: string) {
  return await database
    .prepare(
      `SELECT
         state,
         response_json,
         http_status,
         request_id,
         audit_id,
         lease_expires_at,
         publication_branch,
         commit_marker,
         expected_head_oid
       FROM cms_mutations
       WHERE idempotency_key = ?
       LIMIT 1`,
    )
    .bind(idempotencyKey)
    .first<MutationStateRow>()
}

function parseSuccessfulReplay(
  row: MutationStateRow | null,
): Extract<CmsMutationStart, { kind: 'replay' }> | null {
  if (
    row?.state !== 'succeeded' ||
    typeof row.response_json !== 'string' ||
    typeof row.http_status !== 'number'
  ) {
    return null
  }

  try {
    return {
      kind: 'replay',
      requestId: row.request_id,
      response: JSON.parse(row.response_json) as unknown,
      status: row.http_status,
    }
  } catch {
    throw new CmsStateError('保存済み応答の監査データが壊れています。', 503)
  }
}

function reservationFromRow(
  idempotencyKey: string,
  row: MutationStateRow,
): CmsMutationReservation {
  return {
    auditId: row.audit_id,
    idempotencyKey,
    requestId: row.request_id,
    publicationBranch: row.publication_branch,
    commitMarker: row.commit_marker,
    expectedHeadOid: row.expected_head_oid,
  }
}

function assertPairedStateChange(
  results: D1Result<unknown>[],
  message: string,
  requestId: string,
) {
  if (hasExactlyOneChange(results[0]) && hasExactlyOneChange(results[1])) {
    return
  }

  logStateError(message, { requestId })
  throw new Error(message)
}

function hasExactlyOneChange(result: D1Result<unknown> | undefined) {
  return result?.meta?.changes === 1
}

function throwStateOperationError(
  message: string,
  requestId: string,
  error: unknown,
): never {
  if (error instanceof CmsStateError) throw error

  logStateError(message, {
    error,
    requestId,
  })
  throw new CmsStateError(
    'CMS監査状態を確定できません。保存結果を成功として扱いません。',
    503,
  )
}

function getRequestId(request: Request) {
  const cfRay = request.headers.get('Cf-Ray')?.trim()

  if (cfRay && /^[A-Za-z0-9-]{1,80}$/u.test(cfRay)) return cfRay

  return crypto.randomUUID()
}

function singleLine(value: string) {
  return value.replace(/[\r\n]+/gu, ' ').trim()
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function logStateError(
  message: string,
  {
    error,
    requestId,
  }: {
    error?: unknown
    requestId: string
  },
) {
  console.error(
    JSON.stringify({
      message,
      request_id: requestId,
      ...(error
        ? {
            error: error instanceof Error ? error.message : String(error),
          }
        : {}),
    }),
  )
}
