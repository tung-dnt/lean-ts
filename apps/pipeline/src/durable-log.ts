import type { DurableLogger, DurableLoggingContext } from "@aws/durable-execution-sdk-js";

import type { Logger } from "@lean-ts/platform";

/**
 * Routes the SDK's replay-aware logger (`context.logger`) to the platform JSON logger.
 * The SDK's default logger formats extra fields into the message string; this keeps them
 * as top-level JSON keys (`correlationId`, `noteId`, …) next to the SDK's execution fields
 * (`executionArn`, `operationName`, `attempt`) and the OTel plugin's `traceId`/`spanId`,
 * so Logs Insights can filter on any of them.
 */
export function durableLogger(log: Logger): DurableLogger {
  let durable: DurableLoggingContext | undefined;
  const at =
    (level: "debug" | "info" | "warn" | "error") =>
    (message: unknown, fields?: unknown): void => {
      log[level](String(message), {
        ...durable?.getDurableLogData(),
        ...durable?.getLogEnrichment?.(),
        ...(typeof fields === "object" && fields !== null ? fields : {}),
      });
    };
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    configureDurableLoggingContext: (context) => {
      durable = context;
    },
  };
}
