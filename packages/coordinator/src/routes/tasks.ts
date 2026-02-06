import type { FastifyInstance } from 'fastify';
import { createDb } from '../db/index.js';
import { claimTask, completeTask, failTask } from '../services/taskManager.js';
import { eq, desc, inArray } from 'drizzle-orm';
import { tasks, taskLogs, agents } from '../db/schema.js';
import type { NewTaskLog } from '../db/schema.js';
import { requireApiKey } from '../middleware/auth.js';

/**
 * Maximum log message length
 */
const MAX_LOG_MESSAGE_LENGTH = 10000;

/**
 * Control characters that should be stripped from log messages
 * to prevent log injection attacks
 */
const CONTROL_CHARS = /[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g;

/**
 * Line break characters that could be used for log injection
 */
const LINE_BREAK_CHARS = /[\r\n\u2028\u2029]/g;

/**
 * Maximum error message length
 */
const MAX_ERROR_MESSAGE_LENGTH = 5000;

/**
 * Sanitize a log message to prevent log injection attacks
 * - Removes control characters
 * - Replaces line breaks with spaces
 * - Limits length
 */
export function sanitizeLogMessage(message: string): string {
  return String(message)
    .replace(CONTROL_CHARS, '') // Remove control characters
    .replace(LINE_BREAK_CHARS, ' ') // Replace line breaks with spaces
    .trim()
    .substring(0, MAX_LOG_MESSAGE_LENGTH);
}

/**
 * Sanitize an error message
 */
export function sanitizeErrorMessage(message: string): string {
  return String(message)
    .replace(CONTROL_CHARS, '')
    .replace(LINE_BREAK_CHARS, ' ')
    .trim()
    .substring(0, MAX_ERROR_MESSAGE_LENGTH);
}

export async function taskRoutes(fastify: FastifyInstance) {
  const db = createDb();

  fastify.post<{ Body: { agentId: string } }>('/tasks/claim', async (request, reply) => {
    const agentId = request.body?.agentId;

    if (!agentId || typeof agentId !== 'string') {
      return reply.code(400).send({ error: 'agentId is required' });
    }

    // Validate agent ID format
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId) || agentId.length > 100) {
      return reply.code(400).send({ error: 'Invalid agentId format' });
    }

    // Verify agent exists
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) {
      return reply.code(404).send({ error: 'Agent not registered' });
    }

    const claimed = await claimTask(db, agentId);
    if (!claimed) return reply.code(204).send();
    return reply.send(claimed);
  });

  fastify.post<{
    Params: { id: string };
    Body: { result?: unknown; errorMessage?: string };
  }>('/tasks/:id/complete', async (request, reply) => {
    const { id } = request.params;
    const { result, errorMessage } = request.body ?? {};
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!task) return reply.code(404).send({ error: 'Task not found' });
    if (task.status !== 'processing') {
      return reply.code(400).send({ error: 'Task is not in processing state' });
    }
    await completeTask(
      db,
      id,
      result,
      errorMessage !== undefined ? sanitizeErrorMessage(errorMessage) : undefined
    );
    return reply.code(200).send({ ok: true });
  });

  fastify.post<{ Params: { id: string }; Body: { errorMessage: string } }>('/tasks/:id/fail', async (request, reply) => {
    const { id } = request.params;
    const rawErrorMessage = request.body?.errorMessage ?? 'Unknown error';
    const errorMessage = sanitizeErrorMessage(rawErrorMessage);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!task) return reply.code(404).send({ error: 'Task not found' });
    if (task.status !== 'processing') {
      return reply.code(400).send({ error: 'Task is not in processing state' });
    }
    await failTask(db, id, errorMessage);
    return reply.code(200).send({ ok: true });
  });

  /**
   * Receive logs from an agent for a task
   */
  fastify.post<{
    Params: { id: string };
    Body: { agentId: string; logs: Array<{ level: string; message: string }> };
  }>('/tasks/:id/logs', async (request, reply) => {
    const { id } = request.params;
    const { agentId, logs } = request.body ?? {};

    if (!agentId || typeof agentId !== 'string') {
      return reply.code(400).send({ error: 'agentId is required' });
    }
    if (!Array.isArray(logs)) {
      return reply.code(400).send({ error: 'logs must be an array' });
    }

    const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!task) {
      return reply.code(404).send({ error: 'Task not found' });
    }

    // Insert log entries with sanitized messages
    for (const log of logs) {
      await db.insert(taskLogs).values({
        taskId: id,
        agentId,
        level: log.level || 'info',
        message: sanitizeLogMessage(log.message),
      } as NewTaskLog);
    }

    return reply.code(200).send({ ok: true, received: logs.length });
  });

  /**
   * Get logs for a task (protected - requires API key for dashboard users)
   */
  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string };
  }>('/tasks/:id/logs', { onRequest: requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const { limit, offset } = request.query;

    const limitNum = limit ? Math.min(parseInt(limit, 10) || 100, 500) : 100;
    const offsetNum = offset ? parseInt(offset, 10) || 0 : 0;

    const logs = await db
      .select()
      .from(taskLogs)
      .where(eq(taskLogs.taskId, id))
      .orderBy(desc(taskLogs.timestamp))
      .limit(limitNum)
      .offset(offsetNum);

    return reply.send(logs);
  });

  /**
   * Get logs for a batch (protected - requires API key for dashboard users)
   */
  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string };
  }>('/batches/:id/logs', { onRequest: requireApiKey }, async (request, reply) => {
    const { id } = request.params;
    const { limit, offset } = request.query;

    const limitNum = limit ? Math.min(parseInt(limit, 10) || 100, 500) : 100;
    const offsetNum = offset ? parseInt(offset, 10) || 0 : 0;

    // Get all tasks for the batch
    const batchTasks = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.batchId, id));

    const taskIds = batchTasks.map(t => t.id);
    if (taskIds.length === 0) {
      return reply.send([]);
    }

    // Get logs for all tasks in the batch
    const logs = await db
      .select()
      .from(taskLogs)
      .where(inArray(taskLogs.taskId, taskIds))
      .orderBy(desc(taskLogs.timestamp))
      .limit(limitNum)
      .offset(offsetNum);

    return reply.send(logs);
  });
}
