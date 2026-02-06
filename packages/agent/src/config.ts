/**
 * Agent configuration
 * 
 * AGENT_ID uses the container hostname which Docker Compose sets automatically.
 * With `deploy.replicas`, containers are named like: reconmc-agent-1, reconmc-agent-2, etc.
 * The HOSTNAME inside the container will be the short container ID.
 */

// Docker sets HOSTNAME to the container ID (e.g., "c591ccdf70d3")
const HOSTNAME = process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? 'unknown';

// Use AGENT_ID if explicitly set, otherwise just use "agent-{hostname}"
// This keeps it simple and matches the container identity
export const AGENT_ID = process.env.AGENT_ID ?? `agent-${HOSTNAME}`;

export const COORDINATOR_URL =
  process.env.COORDINATOR_URL ?? 'http://localhost:3000';
