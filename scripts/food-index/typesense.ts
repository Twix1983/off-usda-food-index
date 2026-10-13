// The admin side of Typesense the import needs: collections, bulk import,
// aliases. Plain fetch (no SDK).
export interface CollectionInfo {
  name: string;
  num_documents: number;
}

export class TypesenseAdmin {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  private async call(method: string, path: string, body?: string, type = "application/json"):
    Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {"X-TYPESENSE-API-KEY": this.apiKey, ...(body ? {"Content-Type": type} : {})},
      body,
      signal: AbortSignal.timeout(600_000),
    });
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.call(method, path, body === undefined ? undefined : JSON.stringify(body));
    const text = await res.text();
    if (!res.ok) throw new Error(`Typesense ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async health(): Promise<boolean> {
    try {
      return (await this.json<{ok: boolean}>("GET", "/health")).ok === true;
    } catch {
      return false;
    }
  }

  async aliasTarget(alias: string): Promise<string | null> {
    const res = await this.call("GET", `/aliases/${alias}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Typesense alias ${alias} → ${res.status}`);
    return ((await res.json()) as {collection_name: string}).collection_name;
  }

  async upsertAlias(alias: string, collection: string): Promise<void> {
    await this.json("PUT", `/aliases/${alias}`, {collection_name: collection});
  }

  async collections(): Promise<CollectionInfo[]> {
    return this.json("GET", "/collections");
  }

  async collection(name: string): Promise<CollectionInfo | null> {
    const res = await this.call("GET", `/collections/${name}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Typesense collection ${name} → ${res.status}`);
    return (await res.json()) as CollectionInfo;
  }

  async createCollection(schema: object): Promise<void> {
    await this.json("POST", "/collections", schema);
  }

  async deleteCollection(name: string): Promise<void> {
    await this.json("DELETE", `/collections/${name}`);
  }

  // Bulk JSONL import. Typesense answers 200 with one result line per
  // document; returns how many failed and the first few errors.
  async importJsonl(collection: string, jsonl: string):
    Promise<{ok: number; failed: number; errors: string[]}> {
    const res = await this.call("POST",
      `/collections/${collection}/documents/import?action=create`, jsonl, "text/plain");
    const text = await res.text();
    if (!res.ok) throw new Error(`Typesense import → ${res.status}: ${text.slice(0, 300)}`);
    let ok = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as {success: boolean; error?: string};
      if (r.success) ok++;
      else {
        failed++;
        if (errors.length < 5) errors.push(r.error ?? "unknown");
      }
    }
    return {ok, failed, errors};
  }

  async search(collection: string, params: Record<string, string | number>):
    Promise<{found: number; hits: Array<{document: Record<string, unknown>}>}> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    return this.json("GET", `/collections/${collection}/documents/search?${qs}`);
  }
}
