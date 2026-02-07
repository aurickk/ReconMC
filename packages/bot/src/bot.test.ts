import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateProxyConfig } from './proxy/types.js';
import { createSocksOptions } from './proxy/socks.js';

describe('validateProxyConfig', () => {
  it('should accept valid socks5 and socks4 configs', () => {
    assert.equal(validateProxyConfig({ host: '1.2.3.4', port: 1080, type: 'socks5' }), true);
    assert.equal(validateProxyConfig({ host: '1.2.3.4', port: 1080, type: 'socks4' }), true);
    assert.equal(validateProxyConfig({ host: 'proxy.example.com', port: 8080, type: 'socks5', username: 'u', password: 'p' }), true);
  });

  it('should reject invalid host or port', () => {
    assert.equal(validateProxyConfig({ host: '', port: 1080, type: 'socks5' }), false);
    assert.equal(validateProxyConfig({ host: '1.2.3.4', port: 0, type: 'socks5' }), false);
    assert.equal(validateProxyConfig({ host: '1.2.3.4', port: -1, type: 'socks5' }), false);
    assert.equal(validateProxyConfig({ host: '1.2.3.4', port: 65536, type: 'socks5' }), false);
  });

  it('should accept boundary ports 1 and 65535', () => {
    assert.equal(validateProxyConfig({ host: '1.2.3.4', port: 1, type: 'socks5' }), true);
    assert.equal(validateProxyConfig({ host: '1.2.3.4', port: 65535, type: 'socks5' }), true);
  });
});

describe('createSocksOptions', () => {
  it('should map proxy type and set destination', () => {
    const opts = createSocksOptions(
      { host: '1.2.3.4', port: 1080, type: 'socks5' },
      { host: 'mc.server.com', port: 25565 }
    );
    assert.equal(opts.proxy.host, '1.2.3.4');
    assert.equal(opts.proxy.port, 1080);
    assert.equal(opts.proxy.type, 5);
    assert.equal(opts.command, 'connect');
    assert.equal(opts.destination.host, 'mc.server.com');
    assert.equal(opts.destination.port, 25565);
  });

  it('should map socks4 to type 4', () => {
    const opts = createSocksOptions(
      { host: '1.2.3.4', port: 1080, type: 'socks4' },
      { host: 'mc.server.com', port: 25565 }
    );
    assert.equal(opts.proxy.type, 4);
  });

  it('should pass auth credentials through', () => {
    const opts = createSocksOptions(
      { host: '1.2.3.4', port: 1080, type: 'socks5', username: 'user', password: 'pass' },
      { host: 'mc.server.com', port: 25565 }
    );
    assert.equal(opts.proxy.userId, 'user');
    assert.equal(opts.proxy.password, 'pass');
  });
});
