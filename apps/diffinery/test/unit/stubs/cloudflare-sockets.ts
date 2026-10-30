/** Stand-in for the Workers runtime's `cloudflare:sockets` module: a unit test sets what connect() returns with setConnect. */
type Connect = (address: { hostname: string; port: number } | string, options?: { secureTransport?: string; allowHalfOpen: boolean }) => Socket;

let fake: Connect | null = null;

export function setConnect(fn: Connect | null): void {
  fake = fn;
}

export const connect: Connect = (address, options) => {
  if (!fake) throw new Error("this test set no fake connect()");
  return fake(address, options);
};
