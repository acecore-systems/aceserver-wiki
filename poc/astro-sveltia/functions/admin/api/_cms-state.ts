import type { CmsRuntimeEnv } from './_cms-policy.ts'

const RATE_LIMIT_WINDOW_SECONDS = 10 * 60
const GLOBAL_READ_BURST_WINDOW_SECONDS = 10
const GLOBAL_READ_SUSTAINED_WINDOW_SECONDS = 10 * 60
const RATE_LIMIT_MAX_READS_PER_USER = 120
const RATE_LIMIT_MAX_READS_GLOBAL_BURST = 60
const RATE_LIMIT_MAX_READS_GLOBAL_SUSTAINED = 240
const GLOBAL_READ_RATE_LIMIT_ACTOR = 'gateway'
const GLOBAL_MUTATION_RATE_LIMIT_ACTOR = 'gateway'
export const CMS_MUTATION_RATE_LIMITS = {
  windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
  userMutations: 12,
  globalMutations: 60,
  userAdditionBytes: 16 * 1024 * 1024,
  globalAdditionBytes: 64 * 1024 * 1024,
} as const
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

export async function authorizeCmsApiAttempt({
  discordId,
  env,
  request,
}: {
  discordId: string
  env: CmsRuntimeEnv
  request: Request
}) {
  const database = requireCmsDatabase(env)
  const now = Math.floor(Date.now() / 1000)
  const requestId = getRequestId(request)
  const userWindowStart = now - (now % RATE_LIMIT_WINDOW_SECONDS)
  const globalBurstWindowStart = now - (now % GLOBAL_READ_BURST_WINDOW_SECONDS)
  const globalSustainedWindowStart =
    now - (now % GLOBAL_READ_SUSTAINED_WINDOW_SECONDS)

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
      .first<{ expires_at: number | null; reason: string }>()

    if (ban) {
      throw new CmsStateError(
        ban.expires_at
          ? 'このDiscordユーザーのCMS閲覧権限は一時停止されています。'
          : 'このDiscordユーザーのCMS閲覧権限は停止されています。',
        403,
      )
    }

    const userReadCount = await incrementReadRateLimit({
      actorId: discordId,
      database,
      maximum: RATE_LIMIT_MAX_READS_PER_USER,
      scope: 'read-user',
      windowStart: userWindowStart,
    })
    const userRetryAfterSeconds = Math.max(
      1,
      userWindowStart + RATE_LIMIT_WINDOW_SECONDS - now,
    )

    if (userReadCount === null) {
      throw new CmsStateError(
        'CMS APIアクセス回数がユーザー上限に達しました。少し待ってから再試行してください。',
        429,
        userRetryAfterSeconds,
      )
    }

    const globalBurstReadCount = await incrementReadRateLimit({
      actorId: GLOBAL_READ_RATE_LIMIT_ACTOR,
      database,
      maximum: RATE_LIMIT_MAX_READS_GLOBAL_BURST,
      scope: 'read-global-burst',
      windowStart: globalBurstWindowStart,
    })

    if (globalBurstReadCount === null) {
      throw new CmsStateError(
        'CMS API全体の短時間アクセス上限に達しました。少し待ってから再試行してください。',
        429,
        Math.max(
          1,
          globalBurstWindowStart + GLOBAL_READ_BURST_WINDOW_SECONDS - now,
        ),
      )
    }

    const globalSustainedReadCount = await incrementReadRateLimit({
      actorId: GLOBAL_READ_RATE_LIMIT_ACTOR,
      database,
      maximum: RATE_LIMIT_MAX_READS_GLOBAL_SUSTAINED,
      scope: 'read-global-sustained',
      windowStart: globalSustainedWindowStart,
    })

    if (globalSustainedReadCount === null) {
      throw new CmsStateError(
        'CMS API全体の継続アクセス上限に達しました。少し待ってから再試行してください。',
        429,
        Math.max(
          1,
          globalSustainedWindowStart +
            GLOBAL_READ_SUSTAINED_WINDOW_SECONDS -
            now,
        ),
      )
    }
  } catch (error) {
    if (error instanceof CmsStateError) throw error

    logStateError('CMS read authorization failed', {
      error,
      requestId,
    })
    throw new CmsStateError('CMSのBANとrate limitを確認できません。', 503)
  }
}

export async function beginCmsMutation({
  bodyText,
  discordId,
  discordRoleIds,
  env,
  expectedHeadOid,
  mutationBytes,
  paths,
  request,
}: {
  bodyText: string
  discordId: string
  discordRoleIds: string[]
  env: CmsRuntimeEnv
  expectedHeadOid: string
  mutationBytes: number
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

    if (!Number.isSafeInteger(mutationBytes) || mutationBytes < 0) {
      throw new CmsStateError('CMS追加ファイルのbyte数が不正です。', 500)
    }

    const windowStart = now - (now % RATE_LIMIT_WINDOW_SECONDS)
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
    let results: D1Result<unknown>[]

    try {
      results = await database.batch([
        mutationRateLimitStatement({
          actorId: discordId,
          additionBytes: mutationBytes,
          database,
          lastReservationId: auditId,
          maxAdditionBytes: CMS_MUTATION_RATE_LIMITS.userAdditionBytes,
          maxMutationCount: CMS_MUTATION_RATE_LIMITS.userMutations,
          scope: 'user',
          windowStart,
        }),
        mutationRateLimitStatement({
          actorId: GLOBAL_MUTATION_RATE_LIMIT_ACTOR,
          additionBytes: mutationBytes,
          database,
          lastReservationId: auditId,
          maxAdditionBytes: CMS_MUTATION_RATE_LIMITS.globalAdditionBytes,
          maxMutationCount: CMS_MUTATION_RATE_LIMITS.globalMutations,
          scope: 'global',
          windowStart,
        }),
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
        mutationRateCompensationStatement({
          actorId: discordId,
          additionBytes: mutationBytes,
          auditId,
          database,
          idempotencyKey,
          scope: 'user',
          windowStart,
        }),
        mutationRateCompensationStatement({
          actorId: GLOBAL_MUTATION_RATE_LIMIT_ACTOR,
          additionBytes: mutationBytes,
          auditId,
          database,
          idempotencyKey,
          scope: 'global',
          windowStart,
        }),
      ])
    } catch (error) {
      const rateLimitError = await getMutationRateLimitError({
        additionBytes: mutationBytes,
        database,
        discordId,
        now,
        windowStart,
      })

      if (rateLimitError) throw rateLimitError
      throw error
    }

    const mutationReserved =
      hasExactlyOneChange(results[2]) && hasExactlyOneChange(results[3])
    const mutationRaced = hasNoChanges(results[2]) && hasNoChanges(results[3])
    const rateLimitsReserved =
      hasExactlyOneChange(results[0]) && hasExactlyOneChange(results[1])
    const rateLimitsCompensated =
      hasExactlyOneChange(results[4]) && hasExactlyOneChange(results[5])

    if (
      !rateLimitsReserved ||
      (mutationReserved &&
        (!hasNoChanges(results[4]) || !hasNoChanges(results[5]))) ||
      (mutationRaced && !rateLimitsCompensated) ||
      (!mutationReserved && !mutationRaced)
    ) {
      throw new Error(
        'CMS mutation rate limits, reservation, and audit were not changed atomically',
      )
    }

    if (mutationRaced) {
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
        `DELETE FROM cms_mutation_rate_limits
         WHERE rowid IN (
           SELECT rowid
           FROM cms_mutation_rate_limits
           WHERE window_start < ?
           ORDER BY window_start
           LIMIT ?
         )`,
      )
      .bind(now - RATE_LIMIT_RETENTION_SECONDS, RETENTION_DELETE_LIMIT),
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

function mutationRateLimitStatement({
  actorId,
  additionBytes,
  database,
  lastReservationId,
  maxAdditionBytes,
  maxMutationCount,
  scope,
  windowStart,
}: {
  actorId: string
  additionBytes: number
  database: D1Database
  lastReservationId: string
  maxAdditionBytes: number
  maxMutationCount: number
  scope: 'global' | 'user'
  windowStart: number
}) {
  return database
    .prepare(
      `INSERT INTO cms_mutation_rate_limits (
         scope,
         actor_id,
         window_start,
         mutation_count,
         addition_bytes,
         max_mutation_count,
         max_addition_bytes,
         last_reservation_id
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(scope, actor_id, window_start)
       DO UPDATE SET
         mutation_count = mutation_count + 1,
         addition_bytes = addition_bytes + excluded.addition_bytes,
         max_mutation_count = excluded.max_mutation_count,
         max_addition_bytes = excluded.max_addition_bytes,
         last_reservation_id = excluded.last_reservation_id`,
    )
    .bind(
      scope,
      actorId,
      windowStart,
      additionBytes,
      maxMutationCount,
      maxAdditionBytes,
      lastReservationId,
    )
}

function mutationRateCompensationStatement({
  actorId,
  additionBytes,
  auditId,
  database,
  idempotencyKey,
  scope,
  windowStart,
}: {
  actorId: string
  additionBytes: number
  auditId: string
  database: D1Database
  idempotencyKey: string
  scope: 'global' | 'user'
  windowStart: number
}) {
  return database
    .prepare(
      `UPDATE cms_mutation_rate_limits
       SET mutation_count = mutation_count - 1,
           addition_bytes = addition_bytes - ?,
           last_reservation_id = ''
       WHERE scope = ?
         AND actor_id = ?
         AND window_start = ?
         AND last_reservation_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM cms_mutations AS mutation
           INNER JOIN cms_audit_events AS audit
             ON audit.id = mutation.audit_id
           WHERE mutation.idempotency_key = ?
             AND mutation.audit_id = ?
             AND mutation.state = 'processing'
             AND audit.status = 'attempted'
         )`,
    )
    .bind(
      additionBytes,
      scope,
      actorId,
      windowStart,
      auditId,
      idempotencyKey,
      auditId,
    )
}

async function getMutationRateLimitError({
  additionBytes,
  database,
  discordId,
  now,
  windowStart,
}: {
  additionBytes: number
  database: D1Database
  discordId: string
  now: number
  windowStart: number
}) {
  const rows = await database.batch<{
    addition_bytes: number
    mutation_count: number
  }>([
    database
      .prepare(
        `SELECT mutation_count, addition_bytes
         FROM cms_mutation_rate_limits
         WHERE scope = 'user'
           AND actor_id = ?
           AND window_start = ?
         LIMIT 1`,
      )
      .bind(discordId, windowStart),
    database
      .prepare(
        `SELECT mutation_count, addition_bytes
         FROM cms_mutation_rate_limits
         WHERE scope = 'global'
           AND actor_id = ?
           AND window_start = ?
         LIMIT 1`,
      )
      .bind(GLOBAL_MUTATION_RATE_LIMIT_ACTOR, windowStart),
  ])
  const user = rows[0]?.results[0]
  const global = rows[1]?.results[0]
  const retryAfterSeconds = Math.max(
    1,
    windowStart + RATE_LIMIT_WINDOW_SECONDS - now,
  )

  if (
    user &&
    user.mutation_count + 1 > CMS_MUTATION_RATE_LIMITS.userMutations
  ) {
    return new CmsStateError(
      '保存回数がユーザー上限に達しました。少し待ってから再試行してください。',
      429,
      retryAfterSeconds,
    )
  }

  if (
    user &&
    user.addition_bytes + additionBytes >
      CMS_MUTATION_RATE_LIMITS.userAdditionBytes
  ) {
    return new CmsStateError(
      '追加ファイル量がユーザー上限に達しました。少し待ってから再試行してください。',
      429,
      retryAfterSeconds,
    )
  }

  if (
    global &&
    global.mutation_count + 1 > CMS_MUTATION_RATE_LIMITS.globalMutations
  ) {
    return new CmsStateError(
      'CMS全体の保存回数が上限に達しました。少し待ってから再試行してください。',
      429,
      retryAfterSeconds,
    )
  }

  if (
    global &&
    global.addition_bytes + additionBytes >
      CMS_MUTATION_RATE_LIMITS.globalAdditionBytes
  ) {
    return new CmsStateError(
      'CMS全体の追加ファイル量が上限に達しました。少し待ってから再試行してください。',
      429,
      retryAfterSeconds,
    )
  }

  return null
}

async function incrementReadRateLimit({
  actorId,
  database,
  maximum,
  scope,
  windowStart,
}: {
  actorId: string
  database: D1Database
  maximum: number
  scope: 'read-global-burst' | 'read-global-sustained' | 'read-user'
  windowStart: number
}) {
  const result = await database
    .prepare(
      `INSERT INTO cms_rate_limits (
         scope, actor_id, window_start, hit_count
       ) VALUES (?, ?, ?, 1)
       ON CONFLICT(scope, actor_id, window_start)
       DO UPDATE SET hit_count = hit_count + 1
       WHERE cms_rate_limits.hit_count < ?
       RETURNING hit_count`,
    )
    .bind(scope, actorId, windowStart, maximum)
    .run<{
      hit_count?: number
    }>()
  const hitCount = result.results[0]?.hit_count

  if (result.meta.changes === 0 && result.results.length === 0) {
    return null
  }

  if (
    !hasExactlyOneChange(result) ||
    !Number.isInteger(hitCount) ||
    (hitCount as number) < 1 ||
    (hitCount as number) > maximum
  ) {
    throw new Error('D1 read rate limit result is invalid')
  }

  return hitCount as number
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

function hasNoChanges(result: D1Result<unknown> | undefined) {
  return result?.meta?.changes === 0
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
