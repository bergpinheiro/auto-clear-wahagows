import { CronExpressionParser } from 'cron-parser';
import pg from 'pg';

const { Client } = pg;

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function logLevel() {
  const l = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LOG_LEVELS[l] ?? LOG_LEVELS.info;
}

function log(level, payload) {
  if (LOG_LEVELS[level] < logLevel()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...payload,
  });
  if (level === 'error') console.error(line);
  else console.log(line);
}

function redactPostgresUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '[invalid WHATSAPP_SESSIONS_POSTGRESQL_URL]';
  }
}

/**
 * Segmento do nome do banco por sessão (minúsculas). Esta limpeza só faz sentido com
 * armazenamento GOWS — use WHATSAPP_DEFAULT_ENGINE=GOWS alinhado à WAHA.
 * Ordem: motor primeiro; WAHA_SESSION_NAMESPACE só se precisar de paridade quando a WAHA
 * usa namespace explícito (ver README).
 */
function getSessionNamespace() {
  const raw =
    process.env.WHATSAPP_DEFAULT_ENGINE ||
    process.env.WAHA_SESSION_NAMESPACE ||
    'WEBJS';
  return raw.toLowerCase();
}

function sessionNameToSlug(sessionName) {
  return sessionName.toLowerCase().replace(/[^a-z0-9-]/g, '_');
}

/** Nomes de sessão a nunca limpar (comparação case-insensitive). */
function parseIgnoredSessionNameSet() {
  const raw =
    process.env.IGNORE_SESSION_NAMES || process.env.SESSION_NAMES_IGNORE || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isSessionIgnored(sessionName, ignoreSet) {
  return ignoreSet.has(sessionName.trim().toLowerCase());
}

function computeDatabaseName(sessionName) {
  const sessionNamespace = getSessionNamespace();
  const slug = sessionNameToSlug(sessionName);
  return `waha_${sessionNamespace}_${slug}`;
}

function sessionDatabaseUrl(baseUrl, databaseName) {
  const u = new URL(baseUrl);
  u.pathname = '/' + databaseName;
  return u.toString();
}

/** @param {number} retentionDays */
function computeCutoff(retentionDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  return cutoff;
}

/**
 * @param {unknown} session
 * @returns {{ enabled: boolean, retentionDays: number | null }}
 */
function readGowsCleanup(session) {
  const cleanup =
    session &&
    typeof session === 'object' &&
    'config' in session &&
    session.config &&
    typeof session.config === 'object' &&
    'gows' in session.config &&
    session.config.gows &&
    typeof session.config.gows === 'object' &&
    'cleanup' in session.config.gows
      ? session.config.gows.cleanup
      : undefined;
  if (!cleanup || typeof cleanup !== 'object') {
    return { enabled: true, retentionDays: null };
  }
  const enabled = cleanup.enabled !== false;
  const rd = cleanup.retentionDays;
  const retentionDays =
    typeof rd === 'number' && Number.isFinite(rd) ? rd : null;
  return { enabled, retentionDays };
}

async function fetchSessionsFromWaha() {
  const base = process.env.WAHA_BASE_URL?.replace(/\/$/, '');
  if (!base) return null;
  const url = `${base}/api/sessions?all=true`;
  const headers = { Accept: 'application/json' };
  const key = process.env.WAHA_API_KEY;
  if (key) headers['X-Api-Key'] = key;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`WAHA sessions API HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * @param {Set<string>} ignoreSessionNames lowercased session names
 * @returns {Promise<{ source: string, globalRetention: number, targets: Array<{sessionName: string, retentionDays: number, skippedReason: string | null}>, skipReason?: string }>}
 */
async function resolveSessionTargets(ignoreSessionNames) {
  const globalRetention = parseInt(process.env.RETENTION_DAYS || '90', 10);
  if (!Number.isFinite(globalRetention) || globalRetention < 0) {
    throw new Error('RETENTION_DAYS must be a non-negative integer');
  }

  const useWahaApi =
    process.env.WAHA_USE_SESSION_API !== 'false' &&
    process.env.WAHA_USE_SESSION_API !== '0';
  const wahaBase = process.env.WAHA_BASE_URL?.trim();
  const wantsApi = Boolean(useWahaApi && wahaBase);

  if (wantsApi) {
    const fromApi = await fetchSessionsFromWaha().catch((err) => {
      log('warn', {
        event: 'waha_api_failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    });

    if (fromApi === null) {
      return {
        source: 'waha_api',
        globalRetention,
        targets: [],
        skipReason: 'api_unavailable',
      };
    }

    if (!Array.isArray(fromApi)) {
      log('warn', {
        event: 'waha_api_invalid_response',
        detail: typeof fromApi,
      });
      return {
        source: 'waha_api',
        globalRetention,
        targets: [],
        skipReason: 'api_invalid_response',
      };
    }

    const targets = [];
    for (const item of fromApi) {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string') {
        continue;
      }
      if (isSessionIgnored(item.name, ignoreSessionNames)) {
        targets.push({
          sessionName: item.name,
          retentionDays: globalRetention,
          skippedReason: 'ignored_by_env',
        });
        continue;
      }
      const { enabled, retentionDays } = readGowsCleanup(item);
      if (!enabled) {
        targets.push({
          sessionName: item.name,
          retentionDays: globalRetention,
          skippedReason: 'cleanup_disabled',
        });
        continue;
      }
      targets.push({
        sessionName: item.name,
        retentionDays: retentionDays ?? globalRetention,
        skippedReason: null,
      });
    }

    if (targets.length === 0) {
      return {
        source: 'waha_api',
        globalRetention,
        targets: [],
        skipReason: 'api_empty_or_no_valid_sessions',
      };
    }

    return { source: 'waha_api', globalRetention, targets };
  }

  const namesRaw = process.env.SESSION_NAMES || '';
  const sessionNames = namesRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (sessionNames.length === 0) {
    throw new Error(
      'Set SESSION_NAMES when WAHA_BASE_URL is unset or WAHA_USE_SESSION_API is false',
    );
  }

  const targets = sessionNames.map((sessionName) => ({
    sessionName,
    retentionDays: globalRetention,
    skippedReason: isSessionIgnored(sessionName, ignoreSessionNames)
      ? 'ignored_by_env'
      : null,
  }));
  return { source: 'env', globalRetention, targets };
}

const TABLE_CHECK_SQL = `
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'gows_messages'
  ) AS exists
`;

const COUNT_SQL = `
  SELECT COUNT(*)::bigint AS c
  FROM gows_messages
  WHERE "timestamp" < $1
`;

const DELETE_SQL = `
  DELETE FROM gows_messages
  WHERE "timestamp" < $1
`;

/**
 * @param {string} baseUrl
 * @param {{ sessionName: string, retentionDays: number, skippedReason: string | null }} target
 * @param {boolean} dryRun
 */
async function processSession(baseUrl, target, dryRun) {
  const { sessionName, retentionDays, skippedReason } = target;
  const database = computeDatabaseName(sessionName);
  const cutoff = computeCutoff(retentionDays);
  const cutoffIso = cutoff.toISOString();

  if (skippedReason === 'cleanup_disabled' || skippedReason === 'ignored_by_env') {
    log('info', {
      event: 'session_skipped',
      session: sessionName,
      database,
      reason: skippedReason,
    });
    return { sessionName, database, cutoffIso, rowsAffected: 0, skippedReason };
  }

  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    log('warn', {
      event: 'session_skipped',
      session: sessionName,
      database,
      reason: 'invalid_retention',
    });
    return {
      sessionName,
      database,
      cutoffIso,
      rowsAffected: 0,
      skippedReason: 'invalid_retention',
    };
  }

  const connStr = sessionDatabaseUrl(baseUrl, database);
  const client = new Client({ connectionString: connStr });

  try {
    await client.connect();

    const { rows: existRows } = await client.query(TABLE_CHECK_SQL);
    const exists = existRows[0]?.exists === true;
    if (!exists) {
      log('info', {
        event: 'session_skipped',
        session: sessionName,
        database,
        reason: 'no_gows_messages_table',
        cutoff: cutoffIso,
      });
      return {
        sessionName,
        database,
        cutoffIso,
        rowsAffected: 0,
        skippedReason: 'no_gows_messages_table',
      };
    }

    if (dryRun) {
      const { rows } = await client.query(COUNT_SQL, [cutoff]);
      const count = Number(rows[0]?.c ?? 0);
      log('info', {
        event: 'dry_run_count',
        session: sessionName,
        database,
        cutoff: cutoffIso,
        rowsWouldDelete: count,
      });
      return {
        sessionName,
        database,
        cutoffIso,
        rowsAffected: count,
        skippedReason: null,
        dryRun: true,
      };
    }

    const result = await client.query(DELETE_SQL, [cutoff]);
    const rowsAffected = result.rowCount ?? 0;
    log('info', {
      event: 'cleanup_done',
      session: sessionName,
      database,
      cutoff: cutoffIso,
      rowsDeleted: rowsAffected,
    });
    return { sessionName, database, cutoffIso, rowsAffected, skippedReason: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', {
      event: 'session_error',
      session: sessionName,
      database,
      message,
    });
    return {
      sessionName,
      database,
      cutoffIso,
      rowsAffected: 0,
      skippedReason: 'error',
    };
  } finally {
    await client.end().catch(() => {});
  }
}

async function runJob() {
  const baseUrl = process.env.WHATSAPP_SESSIONS_POSTGRESQL_URL;
  if (!baseUrl) {
    throw new Error('WHATSAPP_SESSIONS_POSTGRESQL_URL is required');
  }

  const ignoreSessionNames = parseIgnoredSessionNameSet();

  const dryRun =
    process.env.DRY_RUN === 'true' ||
    process.env.DRY_RUN === '1' ||
    process.env.DRY_RUN === 'yes';

  log('info', {
    event: 'job_start',
    postgresUrl: redactPostgresUrl(baseUrl),
    sessionNamespace: getSessionNamespace(),
    dryRun,
    ignoredSessionNamesCount: ignoreSessionNames.size,
  });

  const { source, globalRetention, targets, skipReason } =
    await resolveSessionTargets(ignoreSessionNames);

  log('info', {
    event: 'sessions_resolved',
    source,
    globalRetention,
    sessionCount: targets.length,
    ...(skipReason ? { skipReason } : {}),
  });

  for (const target of targets) {
    await processSession(baseUrl, target, dryRun);
  }

  log('info', { event: 'job_complete' });
}

function parseCronExpression() {
  const raw = (process.env.CRON || '0 0 2 * * *').trim();
  const tz = process.env.TZ || 'UTC';
  return { expression: raw, tz };
}

function getNextRun(expression, tz, fromDate) {
  const interval = CronExpressionParser.parse(expression, {
    currentDate: fromDate,
    tz,
  });
  return interval.next().toDate();
}

let shutdownRequested = false;
let scheduleTimeout = null;

function clearSchedule() {
  if (scheduleTimeout) {
    clearTimeout(scheduleTimeout);
    scheduleTimeout = null;
  }
}

async function scheduleLoop() {
  const { expression, tz } = parseCronExpression();
  const runOnStart =
    process.env.RUN_ON_START === 'true' || process.env.RUN_ON_START === '1';

  const scheduleNext = () => {
    if (shutdownRequested) return;
    const next = getNextRun(expression, tz, new Date());
    const delay = Math.max(0, next.getTime() - Date.now());
    log('info', {
      event: 'scheduled_next',
      cron: expression,
      tz,
      nextRun: next.toISOString(),
      delayMs: delay,
    });
    scheduleTimeout = setTimeout(runCycle, delay);
  };

  const runCycle = async () => {
    if (shutdownRequested) return;
    try {
      await runJob();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', { event: 'job_failed', message });
    }
    if (shutdownRequested) return;
    scheduleNext();
  };

  if (runOnStart) {
    log('info', {
      event: 'scheduler_started',
      cron: expression,
      tz,
      runOnStart: true,
    });
    scheduleTimeout = setTimeout(runCycle, 0);
  } else {
    const first = getNextRun(expression, tz, new Date());
    const initialDelay = Math.max(0, first.getTime() - Date.now());
    log('info', {
      event: 'scheduler_started',
      cron: expression,
      tz,
      firstRun: first.toISOString(),
      initialDelayMs: initialDelay,
    });
    scheduleTimeout = setTimeout(runCycle, initialDelay);
  }
}

function requestShutdown(signal) {
  log('info', { event: 'shutdown_signal', signal });
  shutdownRequested = true;
  clearSchedule();
  process.exit(0);
}

async function main() {
  const once = process.env.RUN_ONCE === 'true' || process.env.RUN_ONCE === '1';
  if (once) {
    await runJob();
    return;
  }
  await scheduleLoop();
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));
  process.on('SIGINT', () => requestShutdown('SIGINT'));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log('error', { event: 'fatal', message });
  process.exit(1);
});
