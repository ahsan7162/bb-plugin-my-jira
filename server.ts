// bb-plugin-my-jira — backend entry.
//
// Sign-in goes through Atlassian's v2 MCP server, whose OAuth server supports
// dynamic client registration + PKCE: the plugin registers itself on first
// Connect, so nobody has to create an app in the Atlassian developer console.
// `auth_start` hands the page an authorize URL, the browser comes back to
// `/oauth/callback`, and the code is swapped for tokens. The refresh token
// lives in a secret setting (0600 file); the access token only in memory.
// Jira reads and writes are MCP tool calls over Streamable HTTP; operations the
// server does not list as tools are run through its `executeRead`/`executeWrite`.
import { createHash, randomBytes } from "node:crypto";
import {
  defineRpcContract,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  MCP_RESOURCE_METADATA,
  MCP_URL,
  addToGraph,
  ancestorsOf,
  authorizeUrl,
  boardIssueKeys,
  detailSchema,
  escapeHtml,
  issueKeySchema,
  newGraph,
  pickSite,
  pool,
  rawIssues,
  rpcResult,
  searchPage,
  ticketSchema,
  toBoards,
  toComments,
  toDetail,
  toSites,
  toTicket,
  toTransition,
  toolJson,
  toolText,
  transitionSchema,
  unresolved,
  type Board,
  type RawIssue,
  type RawTransition,
} from "./jira";
import { ISSUE_KEY } from "./filters";
import { version } from "./package.json";

const siteSchema = z.object({ cloudId: z.string(), url: z.string(), name: z.string() });
type Site = z.infer<typeof siteSchema>;
/** The site the list shows, and every Jira site the account granted (to switch between). */
const statusSchema = z.object({ site: siteSchema.nullable(), sites: z.array(siteSchema) });
export type AuthStatus = z.infer<typeof statusSchema>;
const ticketPageSchema = z.object({
  items: z.array(ticketSchema),
  /** Total across all pages; only computed for the first page. */
  total: z.number().nullable(),
  nextPageToken: z.string().nullable(),
  fetchedAt: z.string(),
});
export type TicketPage = z.infer<typeof ticketPageSchema>;
const boardGroupsSchema = z.object({
  boards: z.array(z.object({ id: z.number(), name: z.string(), url: z.string(), keys: z.array(z.string()) })),
  /** Boards whose check failed (e.g. a filter you can't see), so they may be missing tickets. */
  unchecked: z.number(),
});
export type BoardGroups = z.infer<typeof boardGroupsSchema>;
export type Scope = "open" | "done";

export const rpcContract = defineRpcContract({
  auth_status: { input: z.null(), output: statusSchema },
  auth_start: { input: z.null(), output: z.object({ url: z.string() }) },
  auth_disconnect: { input: z.null(), output: z.null() },
  site_select: { input: z.object({ cloudId: z.string().min(1).max(200) }).strict(), output: statusSchema },
  tickets_list: {
    input: z.object({ scope: z.enum(["open", "done"]), pageToken: z.string().max(4000).nullable() }).strict(),
    output: ticketPageSchema,
  },
  ticket_detail: { input: z.object({ key: issueKeySchema }).strict(), output: detailSchema },
  board_groups: {
    input: z.object({ keys: z.array(issueKeySchema).min(1).max(100) }).strict(),
    output: boardGroupsSchema,
  },
  transitions_list: {
    input: z.object({ key: issueKeySchema }).strict(),
    output: z.object({ transitions: z.array(transitionSchema) }),
  },
  transition_apply: {
    input: z.object({ key: issueKeySchema, id: z.string().regex(/^\d+$/) }).strict(),
    output: z.null(),
  },
});

/** Realtime channel app.tsx listens on: connect/disconnect happened. */
export const AUTH_CHANGED = "auth-changed";

const JQL: Record<Scope, string> = {
  open: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
  // Not resolutiondate: tickets closed without a resolution have none and would sort first.
  done: "assignee = currentUser() AND statusCategory = Done ORDER BY updated DESC",
};
const PAGE_SIZE = 50;
const FIELDS = ["summary", "status", "priority", "issuetype", "project", "updated", "parent"];
const DETAIL_FIELDS = [...FIELDS, "description", "assignee", "reporter", "created", "labels"];
const STATE_TTL_MS = 10 * 60_000;
const BOARD_CACHE_MS = 5 * 60_000;
const GRAPH_TTL_MS = 10 * 60_000;
const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_KEY = "client-v2"; // v1's client is not valid on the v2 OAuth server
/** clientId that issued the stored refresh token: a token from any other registration (e.g. v1) is stale. */
const TOKEN_CLIENT_KEY = "token-client";
const NOT_CONNECTED = "Jira is not connected. Click Connect Jira.";

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}
/** A dynamically registered OAuth client and the endpoints it belongs to. */
interface OAuthClient {
  clientId: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}
interface McpSession {
  id: string | null;
  protocol: string;
  tools: Set<string>;
}

const refuse = (code: experimental_PluginRpcRefusal["code"], message: string) =>
  new experimental_PluginRpcRefusal({ code, message });
const base64url = (bytes: Buffer) => bytes.toString("base64url");

function htmlPage(title: string, message: string, status: number): Response {
  const body = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<body style="font:15px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem">
<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></body>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.json()) as T;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    refreshToken: {
      type: "string",
      label: "Jira refresh token",
      description: "Filled in by Connect Jira. Clear it to disconnect.",
      secret: true,
    },
  });

  /** Pending OAuth `state` → PKCE verifier, one-time use. */
  const pending = new Map<string, { verifier: string; expiresAt: number }>();
  let access: { token: string; expiresAt: number } | null = null;
  // Atlassian rotates refresh tokens: two parallel refreshes would burn one and log the user out.
  let refreshing: Promise<string> | null = null;
  let session: Promise<McpSession> | null = null;
  let nextId = 1;
  const boardCache = new Map<string, { at: number; value: BoardGroups }>();
  /** Parent chains seen so far, shared across calls; rebuilt every 10 minutes and after a status change. */
  let graph = newGraph();
  let graphAt = Date.now();

  function callbackUrl(): string {
    const url = new URL(`/api/v1/plugins/${bb.pluginId}/http/oauth/callback`, bb.server.loopbackBaseUrl);
    url.hostname = "localhost"; // OAuth servers accept plain http callbacks only for localhost
    return url.toString();
  }

  /** Discover the OAuth server, register once (RFC 7591), reuse; register again only if bb's callback URL changed. */
  async function registeredClient(): Promise<OAuthClient> {
    const redirectUri = callbackUrl();
    const saved = await bb.storage.kv.get<OAuthClient>(CLIENT_KEY);
    if (saved?.redirectUri === redirectUri) return saved;
    const resource = await getJson<{ authorization_servers?: string[] }>(MCP_RESOURCE_METADATA);
    const issuer = resource.authorization_servers?.[0];
    if (!issuer) throw new Error("Atlassian's MCP server did not name an OAuth server");
    const meta = await getJson<{ authorization_endpoint: string; token_endpoint: string; registration_endpoint: string }>(
      `${issuer}/.well-known/oauth-authorization-server`,
    );
    const res = await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "BB Jira Board",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none", // public client: Atlassian also returns a secret, which PKCE makes unnecessary
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { client_id?: string; error_description?: string };
    if (!res.ok || !body.client_id) {
      throw new Error(`Atlassian refused to register BB (${res.status}) ${body.error_description ?? ""}`.trim());
    }
    const client = {
      clientId: body.client_id,
      redirectUri,
      authorizationEndpoint: meta.authorization_endpoint,
      tokenEndpoint: meta.token_endpoint,
    };
    await bb.storage.kv.set(CLIENT_KEY, client);
    return client;
  }

  async function tokenRequest(client: OAuthClient, params: Record<string, string>): Promise<TokenResponse> {
    const res = await fetch(client.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...params, client_id: client.clientId, resource: MCP_URL }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & {
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      const detail = body.error_description ?? body.error ?? `status ${res.status}`;
      throw Object.assign(new Error(`Atlassian token request failed: ${detail}`), { status: res.status, code: body.error });
    }
    return body as TokenResponse;
  }

  async function saveTokens(tokens: TokenResponse): Promise<void> {
    access = { token: tokens.access_token, expiresAt: Date.now() + ((tokens.expires_in ?? 3600) - 60) * 1000 };
    session = null; // a new token gets a new MCP session
    if (tokens.refresh_token) await settings.experimental_set({ refreshToken: tokens.refresh_token });
  }

  /** Issue keys repeat across sites and accounts, so nothing cached for the previous one may carry over. */
  function forgetSite(): void {
    boardCache.clear();
    graph = newGraph();
    graphAt = Date.now();
  }

  async function disconnect(): Promise<void> {
    access = null;
    session = null;
    forgetSite();
    await settings.experimental_set({ refreshToken: null });
    await bb.storage.kv.delete(TOKEN_CLIENT_KEY);
    await bb.storage.kv.delete("site");
    await bb.storage.kv.delete("sites");
    bb.realtime.publish(AUTH_CHANGED, null);
  }

  /** The client the stored refresh token belongs to, or null when there is no usable token. */
  async function tokenClient(): Promise<OAuthClient | null> {
    const { refreshToken } = await settings.get();
    const client = await bb.storage.kv.get<OAuthClient>(CLIENT_KEY);
    const issuer = await bb.storage.kv.get<string>(TOKEN_CLIENT_KEY);
    return refreshToken && client && issuer === client.clientId ? client : null;
  }

  function accessToken(): Promise<string> {
    if (access && access.expiresAt > Date.now()) return Promise.resolve(access.token);
    refreshing ??= (async () => {
      const { refreshToken } = await settings.get();
      const client = await tokenClient();
      if (!refreshToken || !client) throw refuse("forbidden", NOT_CONNECTED);
      try {
        await saveTokens(await tokenRequest(client, { grant_type: "refresh_token", refresh_token: refreshToken }));
      } catch (error) {
        const { status, code } = error as { status?: number; code?: string };
        // Only a dead grant (revoked, expired, client gone) logs you out; 429s and network errors keep it.
        if (code === "invalid_grant" || code === "invalid_client" || status === 401 || status === 403) {
          bb.log.warn(`refresh rejected: ${(error as Error).message}`);
          await disconnect();
          throw refuse("forbidden", "Your Jira session expired. Click Connect Jira again.");
        }
        throw error;
      }
      return access!.token;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  function mcpPost(token: string, message: object, sid: McpSession | null): Promise<Response> {
    return fetch(MCP_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sid?.id ? { "mcp-session-id": sid.id } : {}),
        ...(sid ? { "mcp-protocol-version": sid.protocol } : {}),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(30_000),
    });
  }

  function httpError(res: Response): Error {
    if (res.status === 401) return Object.assign(new Error("unauthorized"), { status: 401 });
    if (res.status === 429) {
      const wait = res.headers.get("retry-after");
      return new Error(`Atlassian is rate-limiting requests. Try again${wait ? ` in ${wait}s` : " in a minute"}.`);
    }
    return new Error(`Atlassian MCP returned ${res.status}`);
  }

  async function request(token: string, sid: McpSession | null, method: string, params: object): Promise<unknown> {
    const id = nextId++;
    const res = await mcpPost(token, { jsonrpc: "2.0", id, method, params }, sid);
    if (res.status === 404 && sid) throw Object.assign(new Error("session expired"), { expired: true });
    if (!res.ok) throw httpError(res);
    return rpcResult(await res.text(), res.headers.get("content-type"), id);
  }

  async function openSession(token: string): Promise<McpSession> {
    const id = nextId++;
    const res = await mcpPost(
      token,
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "bb-plugin-my-jira", version },
        },
      },
      null,
    );
    if (!res.ok) throw httpError(res);
    const result = rpcResult(await res.text(), res.headers.get("content-type"), id) as { protocolVersion?: string };
    const sid: McpSession = {
      id: res.headers.get("mcp-session-id"),
      protocol: result.protocolVersion ?? PROTOCOL_VERSION,
      tools: new Set(),
    };
    await mcpPost(token, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
    const listed = (await request(token, sid, "tools/list", {})) as { tools?: { name: string }[] };
    sid.tools = new Set((listed.tools ?? []).map((t) => t.name));
    return sid;
  }

  /**
   * Run an Atlassian operation and return its JSON. `names` lists the tool names it goes by (v1 first);
   * the first one the server lists as a tool is called directly, otherwise the last goes through
   * executeRead/executeWrite. Retries once on an expired session or token.
   */
  async function op(names: string[], args: Record<string, unknown>, kind: "read" | "write" = "read"): Promise<unknown> {
    for (const retry of [true, false]) {
      const token = await accessToken();
      try {
        session ??= openSession(token);
        const sid = await session;
        const direct = names.find((n) => sid.tools.has(n));
        const execute = kind === "read" ? "executeRead" : "executeWrite";
        let call: { name: string; arguments: Record<string, unknown> };
        if (direct) {
          call = { name: direct, arguments: args };
        } else if (sid.tools.has(execute)) {
          const { cloudId, ...inputs } = args;
          call = { name: execute, arguments: { name: names[names.length - 1], cloudId, inputs } };
        } else {
          throw refuse("not_found", `Atlassian does not offer "${names[names.length - 1]}" to this connection.`);
        }
        return toolJson(toolText(await request(token, sid, "tools/call", call)));
      } catch (error) {
        const e = error as { status?: number; expired?: boolean; toolError?: boolean };
        if (error instanceof experimental_PluginRpcRefusal) throw error;
        if (e.toolError) throw refuse("invalid", (error as Error).message);
        session = null;
        if (e.expired && retry) continue;
        if (e.status === 401) {
          access = null; // force a refresh
          if (retry) continue;
          throw refuse("forbidden", "Jira rejected the session. Click Connect Jira again.");
        }
        throw error;
      }
    }
    throw new Error("unreachable");
  }

  async function connectedSite(): Promise<Site> {
    const site = await bb.storage.kv.get<Site>("site");
    if (!site) throw refuse("forbidden", NOT_CONNECTED);
    return site;
  }

  // v2 defaults to a "compact" view without parent links or hierarchy levels; ask for the full issue.
  const search = (site: Site, args: Record<string, unknown>) =>
    op(["searchJiraIssuesUsingJql"], { cloudId: site.cloudId, view: "full", ...args });

  /** Map raw issues to tickets with their full parent chain, looking up one level of unknown parents per search. */
  async function withAncestry(site: Site, raws: RawIssue[]) {
    if (Date.now() - graphAt > GRAPH_TTL_MS) {
      graph = newGraph();
      graphAt = Date.now();
    }
    // This call's graph: a site switch while it waits must not get the old site's issues.
    const g = graph;
    addToGraph(g, raws);
    for (let depth = 0; depth < 5; depth++) {
      const missing = unresolved(g);
      if (missing.length === 0) break;
      for (let i = 0; i < missing.length; i += 100) {
        const chunk = missing.slice(i, i + 100);
        const valid = chunk.filter((k) => ISSUE_KEY.test(k)); // keys go into JQL
        if (valid.length > 0) {
          const result = await search(site, { jql: `key in (${valid.join(",")})`, fields: ["summary", "status", "issuetype", "parent"], maxResults: 100 });
          addToGraph(g, rawIssues(result));
        }
        for (const k of chunk) if (!g.parentOf.has(k)) g.parentOf.set(k, null); // hidden from you: the chain stops here
      }
    }
    return raws.map((raw) => toTicket(raw, site.url, ancestorsOf(g, raw.key)));
  }

  bb.http.route("GET", "/oauth/callback", async (c) => {
    const { code, state, error, error_description: errorDescription } = c.req.query();
    if (error) return htmlPage("Jira connection cancelled", errorDescription ?? error, 400);
    const flow = state ? pending.get(state) : undefined;
    if (state) pending.delete(state);
    if (!flow || flow.expiresAt < Date.now() || !code) {
      return htmlPage("This link has expired", "Go back to BB and click Connect Jira again.", 400);
    }
    // Once tokens are saved, any failure below must remove them: the page would say "not connected"
    // and offer no Disconnect, leaving a live token you can't see.
    let saved = false;
    try {
      const client = await registeredClient();
      await saveTokens(
        await tokenRequest(client, {
          grant_type: "authorization_code",
          code,
          redirect_uri: client.redirectUri,
          code_verifier: flow.verifier,
        }),
      );
      saved = true;
      await bb.storage.kv.set(TOKEN_CLIENT_KEY, client.clientId);
      const sites = toSites(await op(["getAccessibleAtlassianResources"], {}));
      const site = pickSite(sites, (await bb.storage.kv.get<Site>("site"))?.cloudId);
      if (!site) {
        await disconnect();
        return htmlPage("No Jira site", "Your Atlassian account did not grant access to any Jira site.", 400);
      }
      await bb.storage.kv.set("sites", sites satisfies Site[]);
      await bb.storage.kv.set("site", site);
      forgetSite();
      bb.realtime.publish(AUTH_CHANGED, null);
      const more = sites.length > 1 ? ` Switch between your ${sites.length} Jira sites from the site menu in BB.` : "";
      return htmlPage("Connected to Jira", `BB can now see your tickets on ${site.name}.${more} You can close this tab.`, 200);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      bb.log.error(`oauth callback: ${message}`);
      if (saved) await disconnect();
      return htmlPage("Couldn't connect to Jira", message, 502);
    }
  });

  bb.rpc.register(rpcContract, {
    auth_status: async () => {
      // A leftover v1 token (or one from before bb's port changed) means "connect again".
      if (!(await tokenClient())) return { site: null, sites: [] };
      const site = (await bb.storage.kv.get<Site>("site")) ?? null;
      // Connections made before the site menu saved only the one site.
      return { site, sites: (await bb.storage.kv.get<Site[]>("sites")) ?? (site ? [site] : []) };
    },
    site_select: async ({ cloudId }) => {
      // Only a site the account granted: the page names it by cloudId and never supplies a URL.
      const sites = (await bb.storage.kv.get<Site[]>("sites")) ?? [];
      const site = sites.find((s) => s.cloudId === cloudId);
      if (!site) throw refuse("not_found", "That Jira site isn't connected. Disconnect, then connect again and grant it.");
      await bb.storage.kv.set("site", site);
      forgetSite();
      bb.realtime.publish(AUTH_CHANGED, null);
      return { site, sites };
    },
    auth_start: async () => {
      const client = await registeredClient();
      const now = Date.now();
      for (const [s, flow] of pending) if (flow.expiresAt < now) pending.delete(s);
      const state = base64url(randomBytes(24));
      const verifier = base64url(randomBytes(32));
      pending.set(state, { verifier, expiresAt: now + STATE_TTL_MS });
      const challenge = base64url(createHash("sha256").update(verifier).digest());
      return { url: authorizeUrl(client.authorizationEndpoint, client.clientId, client.redirectUri, state, challenge) };
    },
    auth_disconnect: async () => {
      await disconnect();
      return null;
    },
    tickets_list: async ({ scope, pageToken }) => {
      const site = await connectedSite();
      const result = await search(site, {
        jql: JQL[scope],
        fields: FIELDS,
        maxResults: PAGE_SIZE,
        // The total costs Jira an extra count; ask once, on the first page.
        ...(pageToken ? { nextPageToken: pageToken } : { searchResultMode: "all" }),
      });
      const items = await withAncestry(site, rawIssues(result));
      return { items, ...searchPage(result), fetchedAt: new Date().toISOString() };
    },
    ticket_detail: async ({ key }) => {
      const site = await connectedSite();
      const [issueResult, comments] = await Promise.all([
        op(["getJiraIssue"], { cloudId: site.cloudId, issueIdOrKey: key, fields: DETAIL_FIELDS, responseContentFormat: "markdown", view: "full" }),
        // shortcut: first 50 comments only.
        op(["listJiraIssueComments"], { cloudId: site.cloudId, issueIdOrKey: key, maxResults: 50 }).then(toComments, (e) => {
          bb.log.warn(`comments for ${key}: ${(e as Error).message}`);
          return [];
        }),
      ]);
      const raw = rawIssues(issueResult)[0] ?? (issueResult as { key?: string; fields?: object });
      if (!raw?.key || !raw.fields) throw refuse("not_found", `${key} was not found`);
      const issue = raw;
      const [, children] = await Promise.all([
        withAncestry(site, [issue]),
        // Anything can have children: an initiative's epics, an epic's issues, a task's subtasks.
        // shortcut: first 100 children only.
        search(site, { jql: `parent = ${key} ORDER BY updated DESC`, fields: FIELDS, maxResults: 100 }).then((r) => withAncestry(site, rawIssues(r))),
      ]);
      const format = (issueResult as { appliedContentFormat?: string }).appliedContentFormat;
      return toDetail(issue, site.url, { format, ancestors: ancestorsOf(graph, key), children, comments });
    },
    board_groups: async ({ keys }) => {
      const site = await connectedSite();
      const cacheKey = [...keys].sort().join(",");
      const cached = boardCache.get(cacheKey);
      if (cached && Date.now() - cached.at < BOARD_CACHE_MS) return cached.value;
      // Boards whose filter mentions each project, then ask each board which of these tickets it lists.
      const projects = [...new Set(keys.map((k) => k.split("-")[0]))];
      const boardLists = await pool(projects, 4, async (projectKeyOrId) =>
        // shortcut: first 100 boards per project.
        toBoards(await op(["listJiraBoards"], { cloudId: site.cloudId, projectKeyOrId, maxResults: 100 })),
      );
      const boards = [...new Map(boardLists.flat().map((b) => [b.id, b])).values()];
      const jql = `key in (${keys.join(",")})`;
      const found = await pool(boards, 8, async (board: Board) => {
        try {
          const result = await op(["getJiraBoardIssueData"], {
            cloudId: site.cloudId,
            boardId: board.id,
            dataset: "all",
            jql,
            fields: ["summary"],
            maxResults: 100,
          });
          return { ...board, keys: boardIssueKeys(result), failed: false };
        } catch (error) {
          if (/rate.?limit|429|too many/i.test((error as Error).message)) throw error; // retrying the rest would only make it worse
          bb.log.warn(`board ${board.id}: ${(error as Error).message}`); // e.g. a board whose filter you can't see
          return { ...board, keys: [], failed: true };
        }
      });
      const value = {
        boards: found
          .filter((b) => b.keys.length > 0)
          .map(({ id, name, keys: onBoard }) => ({ id, name, keys: onBoard, url: `${site.url}/secure/RapidBoard.jspa?rapidView=${id}` })),
        unchecked: found.filter((b) => b.failed).length,
      };
      if (value.unchecked === 0) boardCache.set(cacheKey, { at: Date.now(), value }); // never cache a partial answer
      return value;
    },
    transitions_list: async ({ key }) => {
      const site = await connectedSite();
      const result = (await op(["getTransitionsForJiraIssue", "listJiraIssueTransitions"], {
        cloudId: site.cloudId,
        issueIdOrKey: key,
      })) as { transitions?: RawTransition[] };
      return { transitions: (result.transitions ?? []).map(toTransition) };
    },
    transition_apply: async ({ key, id }) => {
      const site = await connectedSite();
      // v2's transitionJiraIssue takes transitionId (v1 took transition: { id }) and rejects unknown fields.
      await op(["transitionJiraIssue"], { cloudId: site.cloudId, issueIdOrKey: key, transitionId: id }, "write");
      boardCache.clear(); // the list reload re-reads the moved ticket; its parent chain is unchanged, so the graph stays
      return null;
    },
  });
}
