import {
  createWorkerHandler,
  durableObjectMcpServer,
  type MoodleMcpServerLike,
  type WorkerEnv,
  type WorkerHandler,
} from "./http.js";

export { AuthBroker } from "./auth-broker.js";
export { SessionBroker } from "./session-broker.js";

const worker = createWorkerHandler({ mcpServer: durableObjectMcpServer });

export default worker;

export function createWorkerEntrypoint(
  mcpServer: MoodleMcpServerLike | ((env: WorkerEnv) => MoodleMcpServerLike),
): WorkerHandler {
  return createWorkerHandler({ mcpServer });
}
