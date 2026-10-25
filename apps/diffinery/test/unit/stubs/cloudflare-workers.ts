/** Stand-in for the Workers runtime's `cloudflare:workers` module, for unit tests that construct a Durable Object. */
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: DurableObjectState,
    protected env: Env,
  ) {}
}
