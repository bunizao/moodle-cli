import worker from "./entry.js";
import type { WorkerEnv } from "./http.js";

export { AuthBroker, SessionBroker } from "./entry.js";

// The recovery release keeps encrypted sessions readable through the owner's static bridge.
export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return worker.fetch(request, { ...env, AUTH_BROKER: undefined });
  },
};
