/** Stand-in for the Workers runtime's `cloudflare:workflows` module, for unit tests that load the router. */
export class NonRetryableError extends Error {
  constructor(message: string, name?: string) {
    super(message);
    this.name = name ?? "NonRetryableError";
  }
}
