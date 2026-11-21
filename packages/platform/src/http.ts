import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

import type { Logger } from "./log.ts";

export const CORRELATION_HEADER = "x-correlation-id";

export interface HttpRequest {
  /** API Gateway route key, e.g. "GET /notes/{id}"; "$default" for the catch-all route. */
  readonly routeKey: string;
  readonly method: string;
  readonly path: string;
  readonly pathParams: Readonly<Record<string, string | undefined>>;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Parsed JSON body; `undefined` when there is none. Invalid JSON is rejected before routing. */
  readonly body: unknown;
  readonly correlationId: string;
  readonly log: Logger;
}

export interface HttpResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type HttpHandler = (request: HttpRequest) => Promise<HttpResponse>;

export const json = (status: number, body: unknown): HttpResponse => ({ status, body });

export const problem = (status: number, title: string, detail?: unknown): HttpResponse => ({
  status,
  body: detail === undefined ? { title } : { title, detail },
});

/**
 * Adapts an API Gateway HTTP API (payload v2) event to `HttpHandler`: correlation ID in
 * and out, JSON parsing, and one place that turns unexpected errors into a 500 without
 * leaking internals.
 */
export function httpLambda(
  handler: HttpHandler,
  log: Logger,
): (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2> {
  return async (event) => {
    const correlationId = event.headers[CORRELATION_HEADER] ?? event.requestContext.requestId;
    const requestLog = log.with({ correlationId, route: event.routeKey });

    let response: HttpResponse;
    const body = parseBody(event);
    if (body === invalidJson) {
      response = problem(400, "Body is not valid JSON");
    } else {
      try {
        response = await handler({
          routeKey: event.routeKey,
          method: event.requestContext.http.method,
          path: event.rawPath,
          pathParams: event.pathParameters ?? {},
          query: event.queryStringParameters ?? {},
          headers: event.headers,
          body,
          correlationId,
          log: requestLog,
        });
      } catch (error) {
        requestLog.error("unhandled error", { error });
        response = problem(500, "Internal error");
      }
    }

    requestLog.info("request", { status: response.status });
    return {
      statusCode: response.status,
      headers: { "content-type": "application/json", [CORRELATION_HEADER]: correlationId, ...response.headers },
      ...(response.body === undefined ? {} : { body: JSON.stringify(response.body) }),
    };
  };
}

const invalidJson = Symbol("invalid-json");

function parseBody(event: APIGatewayProxyEventV2): unknown {
  if (event.body === undefined || event.body === "") return undefined;
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return invalidJson;
  }
}
