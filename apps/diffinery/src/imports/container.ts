import { Container } from "@cloudflare/containers";
import type { StopParams } from "@cloudflare/containers";
import type { Env } from "../env.js";
import { ImportService } from "./service.js";

/**
 * One container per GitHub import's Git transfer: the runner image in import
 * mode (`DIFFINERY_IMPORT_ID`), which clones from GitHub, pushes to Diffinery in
 * size-bounded chunks and reports back through the import's agent endpoints.
 */
export class ImportContainer extends Container<Env> {
  // The agent makes no inbound requests, so activity-based sleep is the only timer; a little over the 6h transfer cap.
  override sleepAfter = "7h";
  override enableInternet = true;

  async startImport(input: { importId: string; token: string; apiUrl: string; chunkBytes?: number; stamp?: string }): Promise<void> {
    await this.ctx.storage.put("import", input.importId);
    // The attempt-try this container serves, so a late stop of an old try is ignored (M4 / Correctness 7).
    if (input.stamp) await this.ctx.storage.put("stamp", input.stamp);
    await this.start({
      envVars: {
        DIFFINERY_API_URL: input.apiUrl,
        DIFFINERY_IMPORT_ID: input.importId,
        DIFFINERY_IMPORT_TOKEN: input.token,
        ...(input.chunkBytes ? { DIFFINERY_IMPORT_CHUNK_BYTES: String(input.chunkBytes) } : {}),
      },
    });
  }

  async stopImport(): Promise<void> {
    if (this.ctx.container?.running) await this.stop("SIGTERM");
  }

  override async onStop(params: StopParams): Promise<void> {
    const importId = await this.ctx.storage.get<string>("import");
    if (!importId) return;
    const stamp = await this.ctx.storage.get<string>("stamp");
    // A transfer that stopped without reporting (crash, out of memory, platform restart) fails so the workflow can retry it;
    // a stale stamp (an old try stopping late) is ignored by the service.
    await new ImportService(this.env).gitStopped(importId, params.exitCode ?? null, stamp);
    await this.ctx.storage.delete("import");
    await this.ctx.storage.delete("stamp");
  }

  override onError(error: unknown): void {
    console.error("import container error", error);
  }
}
