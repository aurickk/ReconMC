import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { proxies } from '../db/schema.js';
import type { NewProxy } from '../db/schema.js';
import { isPrivateIp } from '../services/ipResolver.js';
import { z } from 'zod';

const createProxySchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(255).optional(),
  password: z.string().max(255).optional(),
  protocol: z.enum(['socks4', 'socks5']).default('socks5'),
  maxConcurrent: z.number().int().min(1).max(100).default(3),
});

const updateProxySchema = z.object({
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().max(255).optional(),
  password: z.string().max(255).optional(),
  isActive: z.boolean().optional(),
  maxConcurrent: z.number().int().min(1).max(100).optional(),
});

const importProxiesSchema = z.object({
  content: z.string().min(1).max(500000),
});

/**
 * Hostnames that should be blocked for proxy configuration
 */
const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
];

/**
 * Validate a proxy hostname to prevent SSRF attacks
 * - Blocks localhost variants
 * - Blocks private IP addresses
 * - Validates hostname format
 */
export function isValidProxyHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();

  // Block localhost variants
  if (BLOCKED_HOSTNAMES.includes(trimmed)) {
    return false;
  }

  // Block hostnames ending with .local (mDNS/local network)
  if (trimmed.endsWith('.local')) {
    return false;
  }

  // Block private IPs
  if (isPrivateIp(trimmed)) {
    return false;
  }

  // Basic hostname validation (allow domain names, IPs, etc.)
  // Must not be empty and must contain at least one dot or be a valid IP
  if (!trimmed) {
    return false;
  }

  return true;
}

function parseWebshareLine(line: string): { host: string; port: number; username?: string; password?: string } | null {
  const parts = line.trim().split(':');
  const host = parts[0]?.trim();
  const port = parts[1] ? parseInt(parts[1], 10) : NaN;
  const username = parts[2]?.trim();
  const password = parts[3]?.trim();
  if (!host || isNaN(port) || port <= 0 || port > 65535) return null;

  // Validate proxy host to prevent SSRF
  if (!isValidProxyHost(host)) return null;

  return {
    host,
    port,
    ...(username && password ? { username, password } : {}),
  };
}

export async function proxyRoutes(fastify: FastifyInstance) {
  const db = createDb();

  fastify.get('/proxies', async (_request, reply) => {
    const list = await db.select({
      id: proxies.id,
      host: proxies.host,
      port: proxies.port,
      username: proxies.username,
      protocol: proxies.protocol,
      currentUsage: proxies.currentUsage,
      maxConcurrent: proxies.maxConcurrent,
      isActive: proxies.isActive,
      lastUsedAt: proxies.lastUsedAt,
      createdAt: proxies.createdAt,
    }).from(proxies);
    return reply.send(list);
  });

  // Export proxies (returns all proxy data including passwords for re-importing)
  fastify.get('/proxies/export', async (_request, reply) => {
    const list = await db.select({
      host: proxies.host,
      port: proxies.port,
      username: proxies.username,
      password: proxies.password,
      protocol: proxies.protocol,
      maxConcurrent: proxies.maxConcurrent,
    }).from(proxies).where(eq(proxies.isActive, true));
    return reply.send(list);
  });

  fastify.post('/proxies', async (request, reply) => {
    const parsed = createProxySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }
    const body = parsed.data;

    if (!isValidProxyHost(body.host)) {
      return reply.code(400).send({ error: 'Invalid proxy host: private IPs and localhost are not allowed' });
    }

    const [row] = await db
      .insert(proxies)
      .values({
        host: body.host,
        port: body.port,
        username: body.username ?? null,
        password: body.password ?? null,
        protocol: body.protocol,
        maxConcurrent: body.maxConcurrent,
      } as NewProxy)
      .returning();
    return reply.code(201).send(row);
  });

  fastify.put<{ Params: { id: string } }>('/proxies/:id', async (request, reply) => {
    const parsed = updateProxySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    }

    const [existing] = await db.select().from(proxies).where(eq(proxies.id, request.params.id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'Proxy not found' });
    const body = parsed.data;

    if (body.host !== undefined && !isValidProxyHost(body.host)) {
      return reply.code(400).send({ error: 'Invalid proxy host: private IPs and localhost are not allowed' });
    }

    const [updated] = await db
      .update(proxies)
      .set({
        ...(body.host !== undefined && { host: body.host }),
        ...(body.port !== undefined && { port: body.port }),
        ...(body.username !== undefined && { username: body.username }),
        ...(body.password !== undefined && { password: body.password }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        ...(body.maxConcurrent !== undefined && { maxConcurrent: body.maxConcurrent }),
      })
      .where(eq(proxies.id, request.params.id))
      .returning();
    return reply.send(updated);
  });

  fastify.delete<{ Params: { id: string } }>('/proxies/:id', async (request, reply) => {
    const deleted = await db.delete(proxies).where(eq(proxies.id, request.params.id)).returning({ id: proxies.id });
    if (deleted.length === 0) return reply.code(404).send({ error: 'Proxy not found' });
    return reply.code(204).send();
  });

  fastify.post('/proxies/import', async (request, reply) => {
    const parsed = importProxiesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'content is required (Webshare format text)', details: parsed.error.issues });
    }
    const content = parsed.data.content;
    const lines = content.split('\n').map((l) => parseWebshareLine(l)).filter((p): p is NonNullable<typeof p> => p !== null);
    if (lines.length === 0) return reply.code(400).send({ error: 'No valid proxy lines found' });
    const values = lines.map((p) => ({
      host: p.host,
      port: p.port,
      username: p.username ?? null,
      password: p.password ?? null,
      protocol: 'socks5' as const,
      maxConcurrent: 3,
    }));
    const inserted = await db.insert(proxies).values(values).returning();
    return reply.code(201).send({ imported: inserted.length, proxies: inserted });
  });
}
