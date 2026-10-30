// Pure Jira/Atlassian MCP helpers shared by server.ts (and its types by app.tsx).
// No I/O here, so jira.test.ts can cover them directly.
import { z } from "zod";
import { ISSUE_KEY } from "./filters.ts";

/** Jira project key + number, e.g. ABC-123. Goes into URL paths and JQL, so validate it. */
export const issueKeySchema = z.string().regex(ISSUE_KEY, "Expected an issue key like ABC-123");

/** One issue in a parent chain: enough to label, colour and link it. */
export const nodeSchema = z.object({
  key: z.string(),
  summary: z.string(),
  type: z.string(),
  /** Jira hierarchy level: -1 subtask, 0 task/story/bug, 1 epic, 2+ initiative and above. */
  level: z.number(),
  status: z.string(),
  category: z.string(),
});
export type IssueNode = z.infer<typeof nodeSchema>;

export const ticketSchema = z.object({
  key: z.string(),
  summary: z.string(),
  url: z.string(),
  status: z.string(),
  /** Jira status category: new | indeterminate | done | undefined. */
  category: z.string(),
  type: z.string(),
  priority: z.string().nullable(),
  project: z.string(),
  updated: z.string(),
  level: z.number(),
  /** Parent chain, nearest first: e.g. task → epic → initiative for a subtask. */
  ancestors: z.array(nodeSchema),
  /** The epic / initiative this ticket rolls up to (itself, when it is one). */
  epic: nodeSchema.nullable(),
  initiative: nodeSchema.nullable(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const transitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  to: z.string(),
  category: z.string(),
});
export type Transition = z.infer<typeof transitionSchema>;

export const commentSchema = z.object({ author: z.string(), created: z.string(), body: z.string() });

export const detailSchema = ticketSchema.extend({
  description: z.string(),
  assignee: z.string().nullable(),
  reporter: z.string().nullable(),
  created: z.string(),
  labels: z.array(z.string()),
  children: z.array(ticketSchema),
  comments: z.array(commentSchema),
});
export type TicketDetail = z.infer<typeof detailSchema>;

/** Atlassian's v2 MCP server (the one claude.ai uses): has the board tools that v1 lacks. */
export const MCP_URL = "https://mcp.atlassian.com/v2/mcp";
export const MCP_RESOURCE_METADATA = "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp";
export const SCOPES = [
  "read:jira:agent-interface",
  "search:jira:agent-interface",
  "write:jira:agent-interface",
  "read:me",
  "read:account",
  "offline_access",
].join(" ");

export function authorizeUrl(
  endpoint: string,
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: SCOPES,
    resource: MCP_URL,
  });
  return `${endpoint}?${query}`;
}

/** Find the JSON-RPC reply with `id` in a Streamable HTTP response (plain JSON or SSE). */
export function rpcResult(text: string, contentType: string | null, id: number): unknown {
  const payloads = contentType?.includes("text/event-stream")
    ? text
        .split(/\r?\n\r?\n/)
        .map((event) =>
          event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /, ""))
            .join("\n"),
        )
        .filter((data) => data !== "")
    : [text];
  for (const payload of payloads) {
    let message: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(payload);
    } catch {
      continue; // pings and other non-JSON events
    }
    if (message.id !== id) continue;
    if (message.error) throw new Error(message.error.message ?? "Atlassian MCP error");
    return message.result;
  }
  throw new Error("Atlassian MCP sent no reply");
}

/** A tool's text content; a tool-level error becomes one readable line. */
export function toolText(result: unknown): string {
  const r = (result ?? {}) as { content?: { type?: string; text?: string }[]; isError?: boolean };
  const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  if (!r.isError) return text;
  let message = text.slice(0, 500) || "Jira refused the request";
  try {
    const parsed = jiraError(JSON.parse(text), 400);
    if (parsed !== "Jira returned 400") message = parsed; // not Jira's error shape: keep the raw text
  } catch {
    // plain-text error: keep it
  }
  throw Object.assign(new Error(message), { toolError: true });
}

/** Tool output as JSON; `executeRead`/`executeWrite` wrap theirs in `{ data }`. Non-JSON text comes back as-is. */
export function toolJson(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  const wrapped = value as { data?: unknown } | null;
  const result = wrapped && typeof wrapped === "object" && "data" in wrapped && Object.keys(wrapped).length <= 2 ? wrapped.data : value;
  // v2 reports a rejected write as a normal reply: { error: "TRANSITION_FAILED", status: 400, problems, upstreamErrors }.
  const failure = result as { error?: unknown; status?: unknown; message?: string; problems?: { reason?: string }[]; upstreamErrors?: unknown } | null;
  if (failure && typeof failure.error === "string" && typeof failure.status === "number" && failure.status >= 400) {
    const reasons = (failure.problems ?? []).map((p) => p.reason).filter(Boolean);
    const upstream = failure.upstreamErrors ? jiraError(failure.upstreamErrors, failure.status) : "";
    const message = reasons.length > 0 ? reasons.join(" ") : upstream.startsWith("Jira returned") ? (failure.message ?? upstream) : upstream;
    throw Object.assign(new Error(message), { toolError: true });
  }
  return result;
}

interface Named {
  name?: string;
}
interface RawStatus extends Named {
  statusCategory?: { key?: string; name?: string };
}
interface RawType extends Named {
  hierarchyLevel?: number;
  subtask?: boolean;
}
interface RawParent {
  key: string;
  fields?: { summary?: string; issuetype?: RawType; status?: RawStatus };
}
interface RawUser {
  displayName?: string;
}
export interface RawIssue {
  key: string;
  fields: {
    summary?: string;
    status?: RawStatus;
    priority?: Named | null;
    issuetype?: RawType;
    project?: Named & { key?: string };
    updated?: string;
    created?: string;
    parent?: RawParent;
    description?: unknown;
    assignee?: RawUser | null;
    reporter?: RawUser | null;
    labels?: string[];
  };
}
export interface RawTransition {
  id: string;
  name: string;
  to?: RawStatus;
}

/** Jira writes `+0000` offsets; make them ISO (`+00:00`) so Date.parse is reliable everywhere. */
export function isoDate(value: string | undefined): string {
  if (!value) return new Date(0).toISOString();
  const date = new Date(value.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

// Slim ("compact") replies drop hierarchyLevel and statusCategory.key; fall back to Jira's default names.
function levelOf(type: RawType | undefined): number {
  if (typeof type?.hierarchyLevel === "number") return type.hierarchyLevel;
  if (type?.subtask) return -1;
  const name = type?.name?.toLowerCase() ?? "";
  if (name.includes("initiative")) return 2;
  if (name === "epic") return 1;
  if (name.startsWith("sub")) return -1;
  return 0;
}
const CATEGORY_BY_NAME: Record<string, string> = { "to do": "new", "in progress": "indeterminate", done: "done" };
const categoryOf = (status: RawStatus | undefined) =>
  status?.statusCategory?.key ?? CATEGORY_BY_NAME[status?.statusCategory?.name?.toLowerCase() ?? ""] ?? "undefined";

function nodeOf(key: string, f: { summary?: string; issuetype?: RawType; status?: RawStatus }): IssueNode {
  return {
    key,
    summary: f.summary?.trim() || key,
    type: f.issuetype?.name ?? "Issue",
    level: levelOf(f.issuetype),
    status: f.status?.name ?? "Unknown",
    category: categoryOf(f.status),
  };
}

export function toTicket(raw: RawIssue, siteUrl: string, chain: IssueNode[] = []): Ticket {
  const f = raw.fields;
  const self = nodeOf(raw.key, f);
  // Without a looked-up chain, the parent field still names one level.
  const ancestors = chain.length > 0 || !f.parent ? chain : [nodeOf(f.parent.key, f.parent.fields ?? {})];
  const lineage = [self, ...ancestors];
  return {
    key: raw.key,
    summary: self.summary === raw.key ? "(no summary)" : self.summary,
    url: `${siteUrl}/browse/${raw.key}`,
    status: self.status,
    category: self.category,
    type: self.type,
    priority: f.priority?.name ?? null,
    project: f.project?.name ?? raw.key.split("-")[0],
    updated: isoDate(f.updated),
    level: self.level,
    ancestors,
    epic: lineage.find((n) => n.level === 1) ?? null,
    initiative: lineage.find((n) => n.level >= 2) ?? null,
  };
}

/** What we know about the parent chains of a set of issues. */
export interface Graph {
  nodes: Map<string, IssueNode>;
  /** key → parent key (null = top). Missing = not looked up yet. */
  parentOf: Map<string, string | null>;
}
export const newGraph = (): Graph => ({ nodes: new Map(), parentOf: new Map() });

/** Record what raw issues say about themselves, their parent link and their parent. */
export function addToGraph(graph: Graph, raws: RawIssue[]): void {
  for (const raw of raws) {
    graph.nodes.set(raw.key, nodeOf(raw.key, raw.fields));
    const parent = raw.fields.parent;
    graph.parentOf.set(raw.key, parent?.key ?? null);
    if (parent && !graph.nodes.has(parent.key)) graph.nodes.set(parent.key, nodeOf(parent.key, parent.fields ?? {}));
  }
}

/** Issues seen only as someone's parent, whose own parent is still unknown. */
export function unresolved(graph: Graph): string[] {
  return [...graph.nodes.keys()].filter((key) => !graph.parentOf.has(key));
}

/** Walk up from `key`, nearest parent first. */
export function ancestorsOf(graph: Graph, key: string): IssueNode[] {
  const chain: IssueNode[] = [];
  const seen = new Set([key]);
  for (let parent = graph.parentOf.get(key); parent && !seen.has(parent) && chain.length < 8; parent = graph.parentOf.get(parent)) {
    seen.add(parent);
    const node = graph.nodes.get(parent);
    if (!node) break;
    chain.push(node);
  }
  return chain;
}

/** Issues from a search or getJiraIssue reply: the MCP wraps them as `{ issues: { nodes } }`; plain REST also accepted. */
export function rawIssues(result: unknown): RawIssue[] {
  const r = (result ?? {}) as { issues?: RawIssue[] | { nodes?: RawIssue[] } };
  return Array.isArray(r.issues) ? r.issues : (r.issues?.nodes ?? []);
}

export function searchPage(result: unknown): { total: number | null; nextPageToken: string | null } {
  const r = (result ?? {}) as {
    issues?: unknown[] | { totalCount?: number; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
    nextPageToken?: string;
    total?: number;
    totalCount?: number;
  };
  if (Array.isArray(r.issues)) return { total: r.totalCount ?? r.total ?? null, nextPageToken: r.nextPageToken ?? null };
  const page = r.issues?.pageInfo;
  return {
    total: r.issues?.totalCount ?? null,
    nextPageToken: page?.hasNextPage && page.endCursor ? page.endCursor : null,
  };
}

/**
 * Rich text for bb's <Markdown>: HTML bodies are stripped to text, ADF flattened, markdown passed through.
 * (bb's renderer also sanitizes any inline HTML left in markdown with a GitHub-style allowlist.)
 */
export function bodyText(value: unknown, format?: string): string {
  if (typeof value === "string") {
    if (format !== "html" && !/^\s*<[a-z!]/i.test(value)) return value;
    return value
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  if (value && typeof value === "object") {
    const node = value as { type?: string; text?: string; content?: unknown[] };
    const inner = (node.content ?? []).map((c) => bodyText(c)).join("");
    if (node.type === "text") return node.text ?? "";
    if (node.type === "hardBreak") return "\n";
    return ["paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(node.type ?? "") ? `${inner}\n\n` : inner;
  }
  return "";
}

export function toComments(result: unknown): z.infer<typeof commentSchema>[] {
  const r = (result ?? {}) as {
    comments?: { author?: RawUser; created?: string; body?: unknown }[];
    appliedContentFormat?: string;
  };
  return (r.comments ?? []).map((c) => ({
    author: c.author?.displayName ?? "Someone",
    created: isoDate(c.created),
    body: bodyText(c.body, r.appliedContentFormat).trim(),
  }));
}

export function toDetail(
  raw: RawIssue,
  siteUrl: string,
  extra: { format?: string; ancestors: IssueNode[]; children: Ticket[]; comments: TicketDetail["comments"] },
): TicketDetail {
  const f = raw.fields;
  const ticket = toTicket(raw, siteUrl, extra.ancestors);
  return {
    ...ticket,
    description: bodyText(f.description, extra.format).trim(),
    assignee: f.assignee?.displayName ?? null,
    reporter: f.reporter?.displayName ?? null,
    created: isoDate(f.created),
    labels: f.labels ?? [],
    children: extra.children,
    comments: extra.comments,
  };
}

/** getAccessibleAtlassianResources: v1 returns `[{ id, url, name }]`, v2 `{ resources: [{ cloudId, url, products }] }`. */
export function toSites(result: unknown): { cloudId: string; url: string; name: string }[] {
  type Raw = { id?: string; cloudId?: string; url?: string; name?: string; products?: { id?: string }[] };
  const list: Raw[] = Array.isArray(result) ? result : ((result as { resources?: Raw[] } | null)?.resources ?? []);
  return list
    .filter((s) => !s.products || s.products.some((p) => p.id === "jira"))
    .map((s) => ({ cloudId: s.cloudId ?? s.id ?? "", url: s.url ?? "", name: s.name ?? new URL(s.url ?? "https://jira").hostname.split(".")[0] }))
    .filter((s) => s.cloudId !== "" && s.url.startsWith("https://"));
}

/** The site to show: the one already chosen while it is still granted, else the first. */
export function pickSite<S extends { cloudId: string }>(sites: S[], current: string | undefined): S | undefined {
  return sites.find((s) => s.cloudId === current) ?? sites[0];
}

export function toTransition(raw: RawTransition): Transition {
  return {
    id: raw.id,
    name: raw.name,
    to: raw.to?.name ?? raw.name,
    category: raw.to?.statusCategory?.key ?? "undefined",
  };
}

export interface Board {
  id: number;
  name: string;
}
export function toBoards(result: unknown): Board[] {
  const r = (result ?? {}) as { values?: { id?: number; name?: string }[] };
  return (r.values ?? [])
    .filter((b): b is { id: number; name?: string } => typeof b.id === "number")
    .map((b) => ({ id: b.id, name: b.name?.trim() || `Board ${b.id}` }));
}

/** getJiraBoardIssueData → the keys it lists. */
export function boardIssueKeys(result: unknown): string[] {
  const r = (result ?? {}) as { issues?: { key?: string }[] };
  return (r.issues ?? []).map((i) => i.key).filter((k): k is string => typeof k === "string");
}

/** Run `work` over `items` with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Jira's `{ errorMessages: [], errors: { field: msg } }` → one readable line. */
export function jiraError(body: unknown, status: number): string {
  const b = (body ?? {}) as { errorMessages?: unknown; errors?: unknown };
  const messages = [
    ...(Array.isArray(b.errorMessages) ? b.errorMessages : []),
    ...(b.errors && typeof b.errors === "object" ? Object.values(b.errors) : []),
  ].filter((m): m is string => typeof m === "string" && m !== "");
  return messages.length > 0 ? messages.join(" ") : `Jira returned ${status}`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
