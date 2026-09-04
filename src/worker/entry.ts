import {
  createDurableObjectBrokerApi,
  createWorkerHandler,
  type MoodleMcpServerLike,
  type WorkerEnv,
  type WorkerHandler,
} from "./http.js";

export { AuthBroker } from "./auth-broker.js";
export { SessionBroker } from "./session-broker.js";

const worker = createWorkerHandler({
  mcpServer: (env) => ({
    handle(body, context) {
      if (!env.SESSION_BROKER) throw new Error("The session broker binding is unavailable.");
      return createDurableObjectBrokerApi(env.SESSION_BROKER).handleMcp(body, context);
    },
  }),
});

export default worker;

export function createWorkerEntrypoint(
  mcpServer: MoodleMcpServerLike | ((env: WorkerEnv) => MoodleMcpServerLike),
): WorkerHandler {
  return createWorkerHandler({ mcpServer });
}
