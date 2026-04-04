import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Database Schema', () => {
  it('exports proxies table', async () => {
    const schema = await import('../db/schema.js');
    assert.ok(schema.proxies);
  });

  it('exports sessions table', async () => {
    const schema = await import('../db/schema.js');
    assert.ok(schema.sessions);
  });

  it('exports agents table', async () => {
    const schema = await import('../db/schema.js');
    assert.ok(schema.agents);
  });

  it('exports servers table', async () => {
    const schema = await import('../db/schema.js');
    assert.ok(schema.servers);
  });

  it('exports scanQueue table', async () => {
    const schema = await import('../db/schema.js');
    assert.ok(schema.scanQueue);
  });

  it('proxies table has required columns', async () => {
    const { proxies } = await import('../db/schema.js');
    assert.ok(proxies.id);
    assert.ok(proxies.host);
    assert.ok(proxies.port);
    assert.ok(proxies.protocol);
    assert.ok(proxies.isActive);
    assert.ok(proxies.maxConcurrent);
    assert.ok(proxies.currentUsage);
  });

  it('sessions table has required columns', async () => {
    const { sessions } = await import('../db/schema.js');
    assert.ok(sessions.id);
    assert.ok(sessions.username);
    assert.ok(sessions.accessToken);
    assert.ok(sessions.uuid);
    assert.ok(sessions.isActive);
    assert.ok(sessions.maxConcurrent);
    assert.ok(sessions.currentUsage);
  });
});
