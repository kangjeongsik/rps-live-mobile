const {randomUUID, randomBytes} = require('node:crypto');

function createEventStore(pool) {
  async function transaction(work) {
    if (!pool) throw Error('DATABASE_URL is required for tournament events');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function load(client, selector) {
    let id = selector.eventId;
    if (!id && !selector.joinCode) {
      const alias = await client.query(
        "SELECT event_id FROM rps_event_aliases WHERE name = 'default' FOR UPDATE"
      );
      id = alias.rows[0]?.event_id;
      if (!id) throw Error('Default tournament event is missing');
    }
    const {rows} = await client.query(
      `SELECT e.id, e.join_code, r.snapshot, r.revision, r.retired_at,
              r.prizes_enabled, replacement.join_code AS replacement_code
         FROM rps_event_runtime r
         JOIN rps_events e ON e.id = r.event_id
         LEFT JOIN rps_events replacement ON replacement.id = r.replacement_event_id
        WHERE ${selector.joinCode ? 'e.join_code' : 'r.event_id'} = $1
        FOR UPDATE OF r`,
      [selector.joinCode || id]
    );
    return rows[0];
  }

  async function create(client, snapshot, prizesEnabled = false) {
    const id = randomUUID();
    const joinCode = randomBytes(9).toString('base64url');
    await client.query(
      'INSERT INTO rps_events(id, join_code, status) VALUES ($1, $2, $3)',
      [id, joinCode, snapshot.game.phase]
    );
    await client.query(
      'INSERT INTO rps_event_runtime(event_id, snapshot, prizes_enabled) VALUES ($1, $2, $3)',
      [id, snapshot, prizesEnabled]
    );
    return {id, join_code: joinCode, snapshot, revision: '0', prizes_enabled: prizesEnabled};
  }

  async function save(client, row, snapshot, nextActionAt) {
    const {rows} = await client.query(
      `UPDATE rps_event_runtime SET snapshot = $2, next_action_at = $3,
          revision = revision + 1 WHERE event_id = $1 RETURNING revision`,
      [row.id, snapshot, nextActionAt ? new Date(nextActionAt) : null]
    );
    if (row.snapshot.game?.phase !== snapshot.game.phase) {
      await client.query('UPDATE rps_events SET status = $2 WHERE id = $1', [row.id, snapshot.game.phase]);
    }
    return rows[0].revision;
  }

  async function replaceDefault(client, previous, snapshot) {
    const next = await create(client, snapshot, previous.prizes_enabled);
    await client.query(
      `UPDATE rps_event_runtime SET retired_at = now(), next_action_at = NULL,
          replacement_event_id = $2 WHERE event_id = $1`,
      [previous.id, next.id]
    );
    await client.query(
      "UPDATE rps_event_aliases SET event_id = $1 WHERE name = 'default'", [next.id]
    );
    return next;
  }

  async function dueEvents() {
    const {rows} = await pool.query(
      `SELECT event_id FROM rps_event_runtime WHERE retired_at IS NULL AND next_action_at <= now()
         ORDER BY next_action_at LIMIT 50`
    );
    return rows;
  }

  return {transaction, load, create, save, replaceDefault, dueEvents};
}

module.exports = {createEventStore};
