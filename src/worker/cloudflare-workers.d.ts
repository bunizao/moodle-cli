// The runtime module behind Workers RPC. Hosts bring the full declaration through
// @cloudflare/workers-types or `wrangler types`; this covers what the Worker uses.
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: unknown;
    protected env: Env;
    constructor(ctx: unknown, env: Env);
  }
}
