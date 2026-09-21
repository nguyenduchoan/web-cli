import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, extractApiErrorInfo } from "../../web/src/lib/api.js";

test("extractApiErrorInfo preserves session error code from error field", () => {
  const result = extractApiErrorInfo(429, {
    error: "session_capacity_reached",
    message: "Maximum of 3 active sessions reached"
  });

  assert.equal(result.code, "session_capacity_reached");
  assert.equal(result.message, "Maximum of 3 active sessions reached");

  const err = new ApiError(result.message, 429, result.code);
  assert.equal(err.status, 429);
  assert.equal(err.code, "session_capacity_reached");
});

test("extractApiErrorInfo preserves error code from code field (notifications)", () => {
  const result = extractApiErrorInfo(409, {
    code: "notifications_disabled",
    message: "Push notifications are not configured"
  });

  assert.equal(result.code, "notifications_disabled");
  assert.equal(result.message, "Push notifications are not configured");

  const err = new ApiError(result.message, 409, result.code);
  assert.equal(err.status, 409);
  assert.equal(err.code, "notifications_disabled");
});

test("extractApiErrorInfo prioritizes code over error if both present", () => {
  const result = extractApiErrorInfo(409, {
    code: "session_operation_in_progress",
    error: "generic_conflict",
    message: "Session is stopping"
  });

  assert.equal(result.code, "session_operation_in_progress");
  assert.equal(result.message, "Session is stopping");
});

test("extractApiErrorInfo falls back to generic status message on non-object body", () => {
  const result = extractApiErrorInfo(500, null);
  assert.equal(result.code, undefined);
  assert.equal(result.message, "Request failed with status 500");
});
