/**
 * Retry logic with exponential backoff
 */

export interface RetryOptions {
  /** Maximum number of retry attempts */
  retries: number;
  /** Initial delay in milliseconds */
  retryDelay: number;
  /** Whether to use exponential backoff (default: true) */
  exponentialBackoff?: boolean;
}

/**
 * Wrap an async function with retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<{ result: T; attempts: number }> {
  const { retries, retryDelay, exponentialBackoff = true } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt + 1 };
    } catch (error) {
      lastError = error as Error;

      // Don't wait after the last attempt
      if (attempt < retries) {
        const delay = calculateRetryDelay(attempt, retryDelay, exponentialBackoff);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Calculate retry delay with exponential backoff
 * Formula: baseDelay * 2^attempt
 */
export function calculateRetryDelay(
  attempt: number,
  baseDelay: number,
  exponential: boolean = true
): number {
  if (!exponential) {
    return baseDelay;
  }

  // Exponential backoff with a maximum of 30 seconds
  const delay = baseDelay * Math.pow(2, attempt);
  return Math.min(delay, 30000);
}

/**
 * Promise-based sleep/delay function
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
