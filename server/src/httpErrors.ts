import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

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

