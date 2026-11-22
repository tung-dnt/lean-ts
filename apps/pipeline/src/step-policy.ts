import { createRetryStrategy, JitterStrategy, StepSemantics, type StepConfig } from "@aws/durable-execution-sdk-js";

/**
 * A value that comes back unchanged from the JSON checkpoint on replay. `Date`, `Map`, `Set`,
 * class instances and `undefined` do not: a `Date` replays as a string, a `Map` as `{}`.
 * Use a type alias, not an interface, for object results (interfaces have no index signature).
 */
export type Checkpointable =
  | string
  | number
  | boolean
  | null
  | readonly Checkpointable[]
  | { readonly [key: string]: Checkpointable };

/** Retry policies by name, so the workflow contract card can print which one a step uses. */
const retryPolicies = {
  /** Network blips, throttling, lock timeouts: 5 attempts, 1 s doubling to 30 s, full jitter. */
  transient: createRetryStrategy({
    maxAttempts: 5,
    initialDelay: { seconds: 1 },
    maxDelay: { seconds: 30 },
    backoffRate: 2,
    jitter: JitterStrategy.FULL,
  }),
  /** One attempt: the first error fails the step. */
  none: createRetryStrategy({ maxAttempts: 1 }),
} as const;

export type RetryPolicy = keyof typeof retryPolicies;

/**
 * Why a step with a side effect is safe to run again. A step re-runs when it succeeded but its
 * checkpoint was lost (crash, timeout), on every retry, and two executions can run it at once.
 * - `row-lock`: `SELECT … FOR UPDATE` in one transaction, then a state check before writing;
 * - `conditional-update`: the write only applies to the expected version or state;
 * - `unique-key`: a unique constraint turns the second insert into a no-op or a known error;
 * - `idempotency-key`: the external API deduplicates on a key derived from the execution and step.
 * Every guard needs a test that runs the step twice (`idempotent: <workflow>/<step>`).
 */
export type IdempotencyGuard = "row-lock" | "conditional-update" | "unique-key" | "idempotency-key";

/**
 * What a step does, declared next to it. Write literals: `vp run workflows:contract` reads them
 * from source to print the contract card and fails when one is missing.
 */
export type StepSpec =
  | { readonly effect: "read"; readonly retry: RetryPolicy }
  | { readonly effect: "write"; readonly guard: IdempotencyGuard; readonly retry: RetryPolicy }
  /** Not safe to repeat and no guard possible: runs at most once, with no retries. */
  | { readonly effect: "write"; readonly guard: "at-most-once" };

/**
 * The third argument of every `context.step`: explicit retries and execution semantics, and a
 * result type that survives the JSON checkpoint.
 *
 *   await context.step("archive", () => archive(deps, id), stepPolicy({ effect: "write", guard: "row-lock", retry: "transient" }))
 */
export function stepPolicy<T extends Checkpointable>(spec: StepSpec): StepConfig<T> {
  if (spec.effect === "write" && spec.guard === "at-most-once") {
    return { semantics: StepSemantics.AtMostOncePerRetry, retryStrategy: retryPolicies.none };
  }
  return { semantics: StepSemantics.AtLeastOncePerRetry, retryStrategy: retryPolicies[spec.retry] };
}
