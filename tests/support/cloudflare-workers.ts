// Node stand-in for the Workers runtime module, so Durable Object classes load in tests.
export abstract class DurableObject<Env = unknown> {
  constructor(protected readonly ctx: unknown, protected readonly env: Env) {}
}
