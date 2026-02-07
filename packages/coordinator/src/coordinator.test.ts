import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, isIpAddress, parseServerAddress } from './services/ipResolver.js';
import { isValidAgentId } from './services/agentService.js';
import { sanitizeLogMessage, sanitizeErrorMessage } from './routes/tasks.js';
import { isValidProxyHost } from './routes/proxies.js';

describe('isPrivateIp (SSRF prevention)', () => {
  it('should block all private/reserved ranges', () => {
    const blocked = ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '0.0.0.0', '::1', '224.0.0.1', '240.0.0.1', '255.255.255.255'];
    for (const ip of blocked) {
      assert.equal(isPrivateIp(ip), true, `should block ${ip}`);
    }
  });

  it('should allow public IPs', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      assert.equal(isPrivateIp(ip), false, `should allow ${ip}`);
    }
  });
});

describe('isIpAddress', () => {
  it('should distinguish IPs from hostnames', () => {
    assert.equal(isIpAddress('1.2.3.4'), true);
    assert.equal(isIpAddress(' 1.2.3.4 '), true);
    assert.equal(isIpAddress('mc.hypixel.net'), false);
    assert.equal(isIpAddress('localhost'), false);
  });
});

describe('parseServerAddress', () => {
  it('should parse host:port and default to 25565', () => {
    const r1 = parseServerAddress('mc.example.com:12345');
    assert.equal(r1.host, 'mc.example.com');
    assert.equal(r1.port, 12345);

    const r2 = parseServerAddress('mc.example.com');
    assert.equal(r2.port, 25565);
  });

  it('should handle invalid/out-of-range ports', () => {
    assert.equal(parseServerAddress('h:abc').port, 25565);
    assert.equal(parseServerAddress('h:0').port, 25565);
    assert.equal(parseServerAddress('h:-1').port, 25565);
    assert.equal(parseServerAddress('h:99999').port, 65535);
  });
});

describe('isValidAgentId', () => {
  it('should accept alphanumeric IDs with dashes/underscores', () => {
    assert.equal(isValidAgentId('agent-1'), true);
    assert.equal(isValidAgentId('a'), true);
    assert.equal(isValidAgentId('a'.repeat(100)), true);
  });

  it('should reject injection attempts and oversized IDs', () => {
    assert.equal(isValidAgentId(''), false);
    assert.equal(isValidAgentId('agent;DROP TABLE'), false);
    assert.equal(isValidAgentId('agent<script>'), false);
    assert.equal(isValidAgentId('a'.repeat(101)), false);
  });
});

describe('sanitizeLogMessage / sanitizeErrorMessage', () => {
  it('should strip control chars, replace newlines, and truncate', () => {
    assert.equal(sanitizeLogMessage('Hello\x00World'), 'HelloWorld');
    assert.equal(sanitizeLogMessage('Hello\nWorld'), 'Hello World');
    assert.equal(sanitizeLogMessage('  Hello  '), 'Hello');
    assert.ok(sanitizeLogMessage('x'.repeat(20000)).length <= 10000);
    assert.equal(sanitizeLogMessage(42 as any), '42');
  });

  it('should truncate error messages at 5000 chars', () => {
    assert.ok(sanitizeErrorMessage('e'.repeat(10000)).length <= 5000);
    assert.equal(sanitizeErrorMessage('Error\x00msg'), 'Errormsg');
  });
});

describe('isValidProxyHost (SSRF prevention)', () => {
  it('should accept public hosts and reject private/localhost', () => {
    assert.equal(isValidProxyHost('proxy.example.com'), true);
    assert.equal(isValidProxyHost('1.2.3.4'), true);
    assert.equal(isValidProxyHost('localhost'), false);
    assert.equal(isValidProxyHost('LOCALHOST'), false);
    assert.equal(isValidProxyHost('myserver.local'), false);
    assert.equal(isValidProxyHost('127.0.0.1'), false);
    assert.equal(isValidProxyHost('10.0.0.1'), false);
    assert.equal(isValidProxyHost(''), false);
  });
});
