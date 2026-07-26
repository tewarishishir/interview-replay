import "server-only";

/**
 * Simple in-process job runner for self-hosted deployments.
 *
 * Jobs run directly in-process as fire-and-forget async functions.
 * Suitable for self-hosted single-tenant deployments that don't
 * need the durability guarantees of a managed queue.
 */

export async function enqueueJob<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<void> {
  fn().catch((err) => console.error(`[job:${name}] failed:`, err));
}
