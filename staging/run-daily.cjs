const retryable = new Set([408, 425, 429, 500, 502, 503, 504]);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function settings(env) {
  let origin;
  try { origin = new URL(env.STAGING_WEB_ORIGIN); } catch { throw Error('Invalid STAGING_WEB_ORIGIN'); }
  if (origin.protocol !== 'https:' || origin.href !== origin.origin + '/') throw Error('A bare HTTPS staging origin is required');
  if (env.STAGING_WEB_ORIGIN_CONFIRMED !== origin.origin) throw Error('The confirmed staging origin must match');
  const token = env.DAILY_SCHEDULER_TOKEN;
  if (!token || !/^[!-~]{32,512}$/.test(token)) throw Error('Invalid scheduler token configuration');
  return { endpoint: new URL('/api/v1/daily/run', origin), token };
}

async function run(env, { request = fetch, sleep = pause, clock = () => new Date(), log = value => console.log(JSON.stringify(value)) } = {}) {
  const { endpoint, token } = settings(env);
  const startedAt = clock();
  const report = (attempt, result, status, extra = {}) => log({
    event: 'staging_daily_trigger',
    startedAt: startedAt.toISOString(),
    observedAt: clock().toISOString(),
    attempt, result, status, ...extra
  });
  const delays = [0, 5000, 12000, 25000, 40000];
  for (const [index, backoff] of delays.entries()) {
    if (backoff) await sleep(backoff);
    const attempt = index + 1;
    let response;
    try {
      response = await request(endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(22000)
      });
    } catch {
      report(attempt, 'network_retry', null);
      continue;
    }
    if (response.status === 200) {
      let body;
      if (/^application\/json\b/i.test(response.headers.get('Content-Type') || '')) {
        try { body = await response.json(); } catch { /* A startup/proxy response may be incomplete. */ }
      } else if (response.body) {
        await response.body.cancel().catch(() => {});
      }
      if (Number.isSafeInteger(body?.processed) && body.processed >= 0) {
        report(attempt, 'acknowledged', 200, { processed: body.processed });
        return;
      }
      report(attempt, 'unexpected_response_retry', 200);
      continue;
    }
    if (response.body) await response.body.cancel().catch(() => {});
    const retry = retryable.has(response.status);
    report(attempt, retry ? 'http_retry' : 'http_rejected', response.status);
    if (!retry) throw Error('Scheduler response rejected');
  }
  throw Error('Scheduler retry budget exhausted');
}

if (require.main === module) {
  run(process.env).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { run };
