import { BatchProcessor, EventType, processPartialResponse } from "@aws-lambda-powertools/batch";
import { parser } from "@aws-lambda-powertools/batch/parser";
import type { ParsedRecord } from "@aws-lambda-powertools/batch/types";
import type { Logger } from "@aws-lambda-powertools/logger";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import type { Context } from "aws-lambda";
import type { z } from "zod";

export interface QueueMessage<T> {
  /** SQS message ID: stable across redeliveries, so it is the idempotency key. */
  readonly messageId: string;
  /** The JSON body, already validated against the queue's schema. */
  readonly body: T;
}

/**
 * An SQS Lambda on Powertools Batch Processing. Each record's JSON body is validated with
 * `schema` before `handle` sees it; a record that fails validation or whose `handle`
 * throws is reported as a batch item failure, so SQS retries only that record (needs
 * `ReportBatchItemFailures` on the event source mapping) and then moves it to the DLQ.
 *
 * Records run one at a time on purpose: each Lambda holds one pooled database connection,
 * and FIFO queues need order. Handlers must be idempotent: SQS delivers at least once.
 * The record's `correlationId` message attribute, or else its message ID, becomes the
 * logger's `correlation_id` while it runs.
 */
export function sqsBatchHandler<S extends z.ZodType>(options: {
  readonly schema: S;
  readonly logger: Logger;
  readonly handle: (message: QueueMessage<z.output<S>>) => Promise<void>;
}): (event: SQSEvent, context: Context) => Promise<SQSBatchResponse> {
  const processor = new BatchProcessor(EventType.SQS, {
    parser,
    innerSchema: options.schema,
    transformer: "json",
    logger: options.logger,
  });
  const record = async ({ messageId, body, messageAttributes }: ParsedRecord<SQSRecord, z.output<S>>) => {
    options.logger.setCorrelationId(messageAttributes["correlationId"]?.stringValue ?? messageId);
    await options.handle({ messageId, body });
  };
  return async (event, context) => {
    options.logger.addContext(context);
    return await processPartialResponse(event, record, processor, { context, processInParallel: false });
  };
}
