import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { AppHttpError } from "./httpErrors.js";
import type { HubAuth } from "./hubAuth.js";
import type { PushDispatcher } from "./pushDispatcher.js";
import { validateFid, validateUuid, type PushStore } from "./pushStore.js";
import type { WebAuth } from "./webAuth.js";

const deviceSchema = z.object({
  deviceId: z.string(),
  fid: z.string()
});

const deviceParamsSchema = z.object({
  deviceId: z.string()
});

const testSchema = z.object({
  deviceId: z.string()
});

export function registerPushRoutes(
  app: FastifyInstance,
  options: {
    config: AppConfig;
    auth: WebAuth;
    hub?: HubAuth;
    pushStore?: PushStore;
    pushDispatcher?: PushDispatcher;
  }
): void {
  const { config, auth, hub, pushStore, pushDispatcher } = options;

  app.get("/api/notifications/config", async () => {
    if (!config.push.enabled) {
      return {
        enabled: false,
        supportedAgents: ["codex"]
      };
    }

    return {
      enabled: true,
      supportedAgents: ["codex"],
      firebaseConfig: {
        apiKey: config.push.firebaseWebConfig.apiKey,
        projectId: config.push.firebaseWebConfig.projectId,
        messagingSenderId: config.push.firebaseWebConfig.messagingSenderId,
        appId: config.push.firebaseWebConfig.appId
      },
      vapidPublicKey: config.push.vapidPublicKey
    };
  });

  app.post(
    "/api/notifications/devices",
    { bodyLimit: 4096 },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!config.push.enabled || !pushStore) {
        return reply.code(409).send({
          code: "notifications_disabled",
          message: "Thông báo FCM đang tắt."
        });
      }

      const parsed = deviceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "invalid_request_body",
          message: "Dữ liệu đăng ký không hợp lệ."
        });
      }

      const { deviceId, fid } = parsed.data;

      if (!validateUuid(deviceId)) {
        return reply.code(400).send({
          code: "invalid_device_id",
          message: "deviceId phải là UUID hợp lệ."
        });
      }

      if (!validateFid(fid)) {
        return reply.code(400).send({
          code: "invalid_fid",
          message: "fid phải là chuỗi 22 ký tự base64url hợp lệ."
        });
      }

      const webAuthScope = auth.getAuthScope(request.raw);
      if (!webAuthScope) {
        return reply.code(401).send({
          code: "unauthorized",
          message: "Vui lòng đăng nhập lại."
        });
      }

      const hubAuthScope = hub?.getAuthScope(request.raw) ?? undefined;

      try {
        const result = await pushStore.upsertDevice({
          deviceId,
          fid,
          webAuthScope,
          hubAuthScope
        });
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof AppHttpError) {
          return reply.code(err.statusCode).send({
            code: err.code,
            message: err.message
          });
        }
        return reply.code(503).send({
          code: "push_store_error",
          message: "Không thể lưu thông tin thiết bị."
        });
      }
    }
  );

  app.delete(
    "/api/notifications/devices/:deviceId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!config.push.enabled || !pushStore) {
        return reply.code(409).send({
          code: "notifications_disabled",
          message: "Thông báo FCM đang tắt."
        });
      }

      const parsed = deviceParamsSchema.safeParse(request.params);
      if (!parsed.success || !validateUuid(parsed.data.deviceId)) {
        return reply.code(400).send({
          code: "invalid_device_id",
          message: "deviceId phải là UUID hợp lệ."
        });
      }

      const authScope = auth.getAuthScope(request.raw);

      try {
        await pushStore.deleteDevice(parsed.data.deviceId, authScope ?? undefined);
        return reply.code(200).send({ ok: true });
      } catch (err) {
        if (err instanceof AppHttpError) {
          return reply.code(err.statusCode).send({
            code: err.code,
            message: err.message
          });
        }
        return reply.code(503).send({
          code: "push_store_error",
          message: "Không thể xóa thiết bị."
        });
      }
    }
  );

  app.post(
    "/api/notifications/test",
    { bodyLimit: 4096 },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!config.push.enabled || !pushStore || !pushDispatcher) {
        return reply.code(409).send({
          code: "notifications_disabled",
          message: "Thông báo FCM đang tắt."
        });
      }

      const parsed = testSchema.safeParse(request.body);
      if (!parsed.success || !validateUuid(parsed.data.deviceId)) {
        return reply.code(400).send({
          code: "invalid_device_id",
          message: "deviceId phải là UUID hợp lệ."
        });
      }

      const authScope = auth.getAuthScope(request.raw);
      if (!authScope) {
        return reply.code(401).send({
          code: "unauthorized",
          message: "Vui lòng đăng nhập lại."
        });
      }

      try {
        const result = await pushDispatcher.dispatchTest(parsed.data.deviceId, authScope);
        return reply.code(202).send(result);
      } catch (err) {
        if (err instanceof AppHttpError) {
          return reply.code(err.statusCode).send({
            code: err.code,
            message: err.message
          });
        }
        return reply.code(500).send({
          code: "internal_error",
          message: "Không thể xếp hàng thông báo thử."
        });
      }
    }
  );
}
