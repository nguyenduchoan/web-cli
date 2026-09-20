import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

export class AppHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AppHttpError";
  }
}

export class SessionCapacityReachedError extends AppHttpError {
  constructor(maxSessions: number) {
    super(429, "session_capacity_reached", `Maximum of ${maxSessions} active sessions reached`);
  }
}

export class SessionOperationInProgressError extends AppHttpError {
  constructor(sessionId: string) {
    super(409, "session_operation_in_progress", `An operation is already in progress for session ${sessionId}`);
  }
}

export class SessionAlreadyRestartedError extends AppHttpError {
  constructor(sessionId: string) {
    super(409, "session_already_restarted", `Session ${sessionId} has already been restarted`);
  }
}

export class SessionStopTimeoutError extends AppHttpError {
  constructor(sessionId: string) {
    super(504, "session_stop_timeout", `Session ${sessionId} did not terminate in time`);
  }
}

export class ServerShuttingDownError extends AppHttpError {
  constructor() {
    super(503, "server_shutting_down", "Server is shutting down");
  }
}

export class IdempotencyConflictError extends AppHttpError {
  constructor(message = "Idempotency key reused with different request payload") {
    super(409, "idempotency_conflict", message);
  }
}

export class IdempotencyCapacityError extends AppHttpError {
  constructor() {
    super(429, "idempotency_capacity", "Too many concurrent or pending idempotent operations");
  }
}

export class InvalidSubpathError extends AppHttpError {
  constructor(message = "Invalid subpath") {
    super(400, "invalid_subpath", message);
  }
}

export class PathNotFoundError extends AppHttpError {
  constructor(message = "Directory path not found") {
    super(404, "path_not_found", message);
  }
}

export class PathTraversalError extends AppHttpError {
  constructor(message = "Path traversal outside project root is forbidden") {
    super(403, "path_traversal", message);
  }
}

export class UnknownSessionError extends AppHttpError {
  constructor(id: string) {
    super(404, "unknown_session", `Unknown session: ${id}`);
  }
}

export class UnknownAgentError extends AppHttpError {
  constructor(id: string) {
    super(404, "unknown_agent", `Unknown agent: ${id}`);
  }
}

export class UnknownProjectError extends AppHttpError {
  constructor(id: string) {
    super(404, "unknown_project", `Unknown project: ${id}`);
  }
}

export class ControlLockedError extends AppHttpError {
  constructor() {
    super(409, "control_locked", "Terminal input is locked because another connection is controlling this session");
  }
}

export function sendError(reply: FastifyReply, statusCode: number, message: string, code = "error") {
  return reply.code(statusCode).send({
    error: code,
    message
  });
}

export function formatValidationError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Invalid request";
}
