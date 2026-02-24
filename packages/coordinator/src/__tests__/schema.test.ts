import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Database Schema', () => {
  it('exports proxies table', async () => {
    const schema = await import('../db/schema.js');
    assert.ok(schema.proxies);
  });

  it('exports accounts table', async () => {
    const schema = await import('../db/schema.js');
    assert.ok(schema.accounts);
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

  it('accounts table has required columns', async () => {
    const { accounts } = await import('../db/schema.js');
    assert.ok(accounts.id);
    assert.ok(accounts.type);
    assert.ok(accounts.isActive);
    assert.ok(accounts.isValid);
    assert.ok(accounts.maxConcurrent);
    assert.ok(accounts.currentUsage);
  });
});
