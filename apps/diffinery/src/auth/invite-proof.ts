import { devAuth } from "./dev.js";
import type { Env } from "../env.js";
import { hmacSha256, matchesAnyKey, signingSecrets } from "../lib/crypto.js";
import { b64url } from "../lib/util.js";

/**
 * Proof that someone can read the invited address's email. The invite link shown to the
 * person who sent it creates nothing on its own: only the copy emailed to the invited
 * address carries this proof, so nobody can join as an address they don't own (and so
 * collect its other invitations, or a bootstrap administrator's rights).
 * The key is derived from MASTER_KEY, so emailed links stay valid across deploys, and across a
 * rotation of MASTER_KEY while the old one is kept as MASTER_KEY_PREV.
 */
function secrets(env: Env): string[] {
  // Local development has no MASTER_KEY unless one is passed; production always does.
  return signingSecrets(env, devAuth(env) ? "diffinery-dev-invite-proof" : null, "MASTER_KEY is not set, so invitation emails can't be signed");
}

const proofWith = async (secret: string, tokenHash: string): Promise<string> => b64url(await hmacSha256(`diffinery-invite-proof-v1:${secret}`, tokenHash));

/** The proof for the invite whose token hashes to `tokenHash`. */
export async function inviteProof(env: Env, tokenHash: string): Promise<string> {
  return proofWith(secrets(env)[0]!, tokenHash);
}

/** Whether `proof` is the invite's proof, made with MASTER_KEY or, while it is being rotated, MASTER_KEY_PREV. */
export async function validInviteProof(env: Env, tokenHash: string, proof: string | undefined | null): Promise<boolean> {
  if (!proof || proof.length > 100) return false;
  return matchesAnyKey(secrets(env), proof, (s) => proofWith(s, tokenHash));
}
