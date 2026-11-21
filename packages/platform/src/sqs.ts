import type { SQSBatchResponse, SQSEvent } from "aws-lambda";

import type { Logger } from "./log.ts";

export interface QueueMessage {
  /** SQS message ID: stable across redeliveries, so it is the idempotency key. */
  readonly messageId: string;
  readonly body: unknown;
  readonly correlationId: string;
  readonly log: Logger;
}

export type MessageHandler = (message: QueueMessage) => Promise<void>;

/**
 * Processes each record on its own and reports only the failed ones, so SQS retries
 * those instead of the whole batch. Needs `ReportBatchItemFailures` on the event
 * source mapping. Handlers must be idempotent: SQS delivers at least once.
 */
export function sqsLambda(handler: MessageHandler, log: Logger): (event: SQSEvent) => Promise<SQSBatchResponse> {
  return async (event) => {
    const failures: SQSBatchResponse["batchItemFailures"] = [];
    for (const record of event.Records) {
      const correlationId = record.messageAttributes["correlationId"]?.stringValue ?? record.messageId;
      const messageLog = log.with({ correlationId, messageId: record.messageId });
      try {
        const body = JSON.parse(record.body) as unknown;
        // One record at a time on purpose: the pool holds one connection, and FIFO queues need order.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await handler({ messageId: record.messageId, body, correlationId, log: messageLog });
      } catch (error) {
        messageLog.error("message failed", { error });
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}
