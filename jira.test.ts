// Run: node --test jira.test.ts   (Node 22.18+ strips the types itself)
// Fixtures are invented data shaped like replies from Atlassian's v2 MCP server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { age, allIds, byBoard, byHierarchy, byStatus, matchesFilter, priorityLevel, visibleKeys } from "./filters.ts";
import {
  authorizeUrl,
  bodyText,
  boardIssueKeys,
  escapeHtml,
  isoDate,
  issueKeySchema,
  jiraError,
  pool,
  rawIssues,
  rpcResult,
  searchPage,
  toBoards,
  toComments,
  toDetail,
  toSites,
  toTicket,
  toTransition,
  toolJson,
  toolText,
  addToGraph,
  ancestorsOf,
  newGraph,
  pickSite,
  unresolved,
  type RawIssue,
} from "./jira.ts";

const SITE = "https://example.atlassian.net";
const epicType = { name: "Epic", subtask: false, hierarchyLevel: 1 };
const taskType = { name: "Task", subtask: false, hierarchyLevel: 0 };
const subtaskType = { name: "Sub-task", subtask: true, hierarchyLevel: -1 };
const inReview = { name: "In Review", statusCategory: { key: "indeterminate" } };

const task: RawIssue = {
  key: "ACME-120",
  fields: {
    summary: "Add rate limits to the orders API",
    issuetype: taskType,
    project: { key: "ACME", name: "Acme" },
    priority: { name: "Medium" },
    updated: "2026-03-14T15:05:24.263+0200",
    status: inReview,
    parent: { key: "ACME-100", fields: { summary: "Public API hardening", issuetype: epicType } },
  },
};
const subtask: RawIssue = {
  key: "ACME-121",
  fields: {
    summary: "Document the new limits",
    issuetype: subtaskType,
    status: inReview,
    parent: { key: "ACME-120", fields: { summary: task.fields.summary, issuetype: taskType } },
  },
};
const epic: RawIssue = {
  key: "ACME-100",
  fields: {
    summary: "Public API hardening",
    issuetype: epicType,
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    parent: { key: "ACME-10", fields: { summary: "Platform reliability", issuetype: { name: "Initiative", hierarchyLevel: 2 } } },
    description: "* Orders API\n* Billing API\n\n",
    assignee: { displayName: "Jane Doe" },
    labels: [],
    created: "2026-02-02T09:56:47.270+0200",
  },
};

test("authorizeUrl is a PKCE request for the v2 MCP resource", () => {
  const url = new URL(authorizeUrl("https://auth.atlassian.com/authorize", "cid", "http://localhost:38886/cb", "s+t", "chal"));
  assert.equal(url.origin + url.pathname, "https://auth.atlassian.com/authorize");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("state"), "s+t");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), "https://mcp.atlassian.com/v2/mcp");
  assert.match(url.searchParams.get("scope")!, /search:jira:agent-interface.*offline_access/);
});

test("rpcResult reads plain JSON and SSE replies, matching the id", () => {
  assert.deepEqual(rpcResult('{"jsonrpc":"2.0","id":3,"result":{"ok":1}}', "application/json", 3), { ok: 1 });
  const sse =
    'event: ping\ndata: not json\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":"old"}\n\nevent: message\ndata: {"jsonrpc":"2.0",\ndata: "id":7,"result":"mine"}\n\n';
  assert.equal(rpcResult(sse, "text/event-stream; charset=utf-8", 7), "mine");
  assert.throws(() => rpcResult('{"jsonrpc":"2.0","id":1,"error":{"message":"Unknown tool"}}', "application/json", 1), /Unknown tool/);
  assert.throws(() => rpcResult("", "text/event-stream", 1), /no reply/);
});

test("toolText returns text content and turns tool errors into readable refusals", () => {
  assert.equal(toolText({ content: [{ type: "text", text: "{}" }] }), "{}");
  assert.throws(
    () => toolText({ isError: true, content: [{ type: "text", text: '{"errorMessages":["Field resolution is required."]}' }] }),
    (e: Error & { toolError?: boolean }) => e.toolError === true && e.message === "Field resolution is required.",
  );
  assert.throws(() => toolText({ isError: true, content: [{ type: "text", text: '{"error":"transitionId is required"}' }] }), /transitionId is required/);
});

test("toolJson unwraps executeRead's { data } and leaves direct tool replies alone", () => {
  assert.deepEqual(toolJson('{"data":{"transitions":[]}}'), { transitions: [] });
  assert.deepEqual(toolJson('{"issues":{"nodes":[]},"context":{}}'), { issues: { nodes: [] }, context: {} });
  assert.equal(toolJson("done"), "done");
  // A rejected transition, as v2 actually returns it (trimmed): not flagged isError, so toolJson must catch it.
  const rejected = JSON.stringify({
    message: "Jira rejected the transition request for issue ACME-7.",
    error: "TRANSITION_FAILED",
    status: 400,
    problems: [{ field: "transition", reason: "Transition id '999999' is not valid for this issue." }],
    upstreamErrors: { errorMessages: ["Transition id '999999' is not valid for this issue."], errors: {} },
  });
  assert.throws(() => toolJson(rejected), (e: Error & { toolError?: boolean }) => e.toolError === true && /999999' is not valid/.test(e.message));
  assert.deepEqual(toolJson('{"status":"In Progress"}'), { status: "In Progress" }); // a success that names a status
});

const initiative: RawIssue = {
  key: "ACME-10",
  fields: { summary: "Platform reliability", issuetype: { name: "Initiative", hierarchyLevel: 2 }, status: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
};

test("the parent graph walks subtask → task → epic → initiative, one lookup per level", () => {
  const graph = newGraph();
  addToGraph(graph, [subtask]);
  assert.deepEqual(unresolved(graph), ["ACME-120"]); // seen only as the subtask's parent
  addToGraph(graph, [task]); // the lookup for ACME-120 also reveals its epic
  assert.deepEqual(unresolved(graph), ["ACME-100"]);
  addToGraph(graph, [epic]);
  assert.deepEqual(unresolved(graph), ["ACME-10"]);
  addToGraph(graph, [initiative]);
  assert.deepEqual(unresolved(graph), []);
  const chain = ancestorsOf(graph, "ACME-121");
  assert.deepEqual(chain.map((n) => `${n.key}:${n.level}`), ["ACME-120:0", "ACME-100:1", "ACME-10:2"]);
  assert.equal(chain[1]!.type, "Epic");
  assert.equal(chain[2]!.status, "In Progress");
});

test("ancestorsOf stops at a loop", () => {
  const graph = newGraph();
  const a: RawIssue = { key: "X-1", fields: { parent: { key: "X-2" } } };
  const b: RawIssue = { key: "X-2", fields: { parent: { key: "X-1" } } };
  addToGraph(graph, [a, b]);
  assert.deepEqual(ancestorsOf(graph, "X-1").map((n) => n.key), ["X-2"]);
});

test("toTicket takes epic and initiative from itself or its chain", () => {
  const graph = newGraph();
  addToGraph(graph, [subtask, task, epic, initiative]);
  const sub = toTicket(subtask, SITE, ancestorsOf(graph, subtask.key));
  assert.equal(sub.level, -1);
  assert.equal(sub.epic?.key, "ACME-100");
  assert.equal(sub.initiative?.key, "ACME-10");
  const ep = toTicket(epic, SITE, ancestorsOf(graph, epic.key));
  assert.equal(ep.epic?.key, "ACME-100"); // an epic is its own epic
  assert.equal(ep.initiative?.key, "ACME-10");
  const lone = toTicket({ key: "OPS-1", fields: { summary: "Renew the certificate", issuetype: taskType } }, SITE);
  assert.equal(lone.epic, null);
  assert.equal(lone.initiative, null);
  const t = toTicket(task, SITE);
  assert.equal(t.url, `${SITE}/browse/ACME-120`);
  assert.equal(t.updated, "2026-03-14T13:05:24.263Z");
  assert.equal(t.epic?.key, "ACME-100"); // known from the parent field alone
});

test("searchPage reads the MCP cursor and total; REST shape too", () => {
  const mcp = { issues: { totalCount: 205, nodes: [task], pageInfo: { hasNextPage: true, endCursor: "CmNy" } } };
  assert.deepEqual(searchPage(mcp), { total: 205, nextPageToken: "CmNy" });
  assert.equal(rawIssues(mcp)[0]!.key, "ACME-120");
  assert.deepEqual(searchPage({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }), { total: null, nextPageToken: null });
  assert.deepEqual(searchPage({ issues: [task], nextPageToken: "n" }), { total: null, nextPageToken: "n" });
});

test("toSites reads v1 and v2 site lists", () => {
  const v2 = { resources: [{ cloudId: "a1b2", url: SITE, products: [{ id: "confluence" }, { id: "jira" }] }] };
  assert.deepEqual(toSites(v2), [{ cloudId: "a1b2", url: SITE, name: "example" }]);
  assert.deepEqual(toSites([{ id: "a1b2", url: SITE, name: "example", scopes: [] }]), [{ cloudId: "a1b2", url: SITE, name: "example" }]);
  assert.deepEqual(toSites({ resources: [{ cloudId: "x", url: "https://c.atlassian.net", products: [{ id: "confluence" }] }] }), []);
});

test("pickSite keeps the chosen site while it is still granted, else takes the first", () => {
  const a = { cloudId: "a1b2", url: SITE, name: "example" };
  const b = { cloudId: "c3d4", url: "https://other.atlassian.net", name: "other" };
  assert.equal(pickSite([a, b], "c3d4"), b);
  assert.equal(pickSite([a, b], "gone"), a);
  assert.equal(pickSite([a, b], undefined), a);
  assert.equal(pickSite([], "a1b2"), undefined);
});

test("bodyText keeps markdown, strips HTML, flattens ADF", () => {
  assert.equal(bodyText("**Fix**: compare `LOWER(name)`"), "**Fix**: compare `LOWER(name)`");
  assert.equal(bodyText('<p>Hi <b>there</b><script>alert(1)</script></p><p>a &amp; b</p>', "html"), "Hi there\na & b");
  const adf = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }, { type: "paragraph", content: [{ type: "text", text: "Two" }] }] };
  assert.equal(bodyText(adf).trim(), "One\n\nTwo");
});

test("toDetail and toComments map an epic with its children and comments", () => {
  const comments = toComments({
    comments: [{ author: { displayName: "Sam" }, created: "2026-03-01T10:00:00.000+0200", body: "<p>LGTM</p>" }],
    appliedContentFormat: "html",
  });
  assert.deepEqual(comments, [{ author: "Sam", created: "2026-03-01T08:00:00.000Z", body: "LGTM" }]);
  const d = toDetail(epic, SITE, { ancestors: [], children: [toTicket(task, SITE)], comments });
  assert.equal(d.level, 1);
  assert.equal(d.description, "* Orders API\n* Billing API");
  assert.equal(d.assignee, "Jane Doe");
  assert.equal(d.reporter, null);
  assert.equal(d.children.length, 1);
});

test("board helpers read listJiraBoards and getJiraBoardIssueData", () => {
  assert.deepEqual(toBoards({ values: [{ id: 42, name: "Platform board", type: "kanban" }, { name: "no id" }] }), [
    { id: 42, name: "Platform board" },
  ]);
  assert.deepEqual(boardIssueKeys({ isLast: false, issues: [{ key: "ACME-130" }, { key: "ACME-131" }] }), ["ACME-130", "ACME-131"]);
  assert.deepEqual(boardIssueKeys({ isLast: true, issues: [] }), []);
});

test("pool keeps order and never exceeds its limit", async () => {
  let running = 0;
  let peak = 0;
  const out = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak, 3);
});

test("toTransition names the target status", () => {
  assert.deepEqual(toTransition({ id: "21", name: "Start work", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } }), {
    id: "21",
    name: "Start work",
    to: "In Progress",
    category: "indeterminate",
  });
});

test("small helpers: dates, Jira errors, keys, escaping", () => {
  assert.equal(isoDate("garbage"), new Date(0).toISOString());
  assert.equal(jiraError({ errorMessages: ["Nope."], errors: { resolution: "Resolution is required." } }, 400), "Nope. Resolution is required.");
  assert.ok(issueKeySchema.safeParse("ABC_2-99").success);
  for (const bad of ["abc-1", "ABC-1/../../x", "ABC-1) OR (1=1", "-1"]) assert.ok(!issueKeySchema.safeParse(bad).success, bad);
  assert.equal(escapeHtml(`<img src=x onerror="a">'&`), "&#60;img src=x onerror=&#34;a&#34;&#62;&#39;&#38;");
});

test("priorityLevel reads Jira's priority names, highest and lowest before high and low", () => {
  assert.equal(priorityLevel("P0 - Blocker"), "highest");
  assert.equal(priorityLevel("Highest"), "highest");
  assert.equal(priorityLevel("P1 - High"), "high");
  assert.equal(priorityLevel("P2 - Medium"), "medium");
  assert.equal(priorityLevel("Lowest"), "lowest");
  assert.equal(priorityLevel("P3 - Low"), "low");
  assert.equal(priorityLevel(null), null);
  assert.equal(priorityLevel("Unprioritised"), null);
});

test("matchesFilter: OR within status and type, AND across them, then the search", () => {
  const t = (key: string, status: string, type: string, summary = "x") => ({ key, summary, status, type, epic: { key: "ACME-1", summary: "Checkout revamp" }, initiative: null });
  const items = [t("ACME-2", "In Review", "Bug"), t("ACME-3", "In Review", "Task"), t("ACME-4", "To Do", "Bug", "Retry payment sync"), t("ACME-5", "Done", "Story")];
  const keys = (statuses: string[], types: string[], query = "") =>
    items.filter((i) => matchesFilter(i, { statuses: new Set(statuses), types: new Set(types), query })).map((i) => i.key);
  assert.deepEqual(keys([], []), ["ACME-2", "ACME-3", "ACME-4", "ACME-5"]);
  assert.deepEqual(keys(["In Review", "To Do"], []), ["ACME-2", "ACME-3", "ACME-4"]);
  assert.deepEqual(keys([], ["Bug", "Story"]), ["ACME-2", "ACME-4", "ACME-5"]);
  assert.deepEqual(keys(["In Review"], ["Bug"]), ["ACME-2"]);
  assert.deepEqual(keys([], ["Bug"], "retry"), ["ACME-4"]);
  assert.deepEqual(keys([], [], "revamp"), ["ACME-2", "ACME-3", "ACME-4", "ACME-5"]); // the epic's name counts
  assert.deepEqual(keys(["Done"], [], "acme-5"), ["ACME-5"]);
});

test("age: minutes, hours, days, then a short date", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(age(ago(20_000), now), "now");
  assert.equal(age(ago(5 * 60_000), now), "5m");
  assert.equal(age(ago(3 * 3_600_000), now), "3h");
  assert.equal(age(ago(47 * 3_600_000), now), "47h");
  assert.equal(age(ago(36 * 86_400_000), now), "36d");
  assert.equal(age("2026-04-18T10:00:00Z", now), "Apr 18");
  assert.equal(age("2025-03-02T10:00:00Z", now), "Mar 2025");
});

// Grouping: tickets with their parent chains, as the list gets them.
const todo = { name: "To Do", statusCategory: { key: "new" } };
const loose: RawIssue = { key: "ACME-200", fields: { summary: "Update the README", issuetype: taskType, status: todo } };
const orphan: RawIssue = { key: "ACME-202", fields: { summary: "Rotate the keys", issuetype: taskType, status: todo } };
const listed = () => {
  const graph = newGraph();
  addToGraph(graph, [subtask, task, epic, initiative, loose, orphan]);
  const t = (raw: RawIssue) => toTicket(raw, SITE, ancestorsOf(graph, raw.key));
  return { sub: t(subtask), tsk: t(task), lone: t(loose), stray: t(orphan) };
};
const rowsOf = (g: { rows?: { ticket: { key: string }; depth: number; parent?: { key: string } | null; via?: boolean }[] }) =>
  (g.rows ?? []).map((r) => [r.ticket.key, r.depth, r.parent?.key ?? null, r.via ?? false]);

test("byStatus: workflow order, a subtask under its task, rows name the parent", () => {
  const { sub, tsk, lone } = listed();
  const groups = byStatus([lone, sub, tsk]);
  assert.deepEqual(groups.map((g) => g.id), ["status:In Review", "status:To Do"]); // in progress before to do
  assert.deepEqual(groups[0]!.head, { kind: "status", status: "In Review", cat: "indeterminate" });
  assert.deepEqual(rowsOf(groups[0]!), [["ACME-120", 0, "ACME-100", false], ["ACME-121", 1, null, false]]); // task names its epic
});

test("byHierarchy: initiative with epics inside, or one lane per epic; ungrouped last", () => {
  const { sub, tsk, lone } = listed();
  const byInitiative = byHierarchy([lone, sub, tsk], "initiative");
  assert.deepEqual(allIds(byInitiative), ["initiative:ACME-10", "initiative:ACME-10/epic:ACME-100", "epic:"]);
  assert.equal(byInitiative[0]!.count, 2);
  assert.deepEqual(byInitiative[1]!.head, { kind: "label", text: "No epic or initiative" }); // top level: the initiative, then the rest
  assert.deepEqual(visibleKeys(byInitiative, new Set()), ["ACME-120", "ACME-121", "ACME-200"]);
  assert.deepEqual(visibleKeys(byInitiative, new Set(["initiative:ACME-10/epic:ACME-100"])), ["ACME-200"]);
  const byEpic = byHierarchy([lone, tsk], "epic");
  assert.deepEqual(byEpic.map((g) => g.id), ["epic:ACME-100", "epic:"]);
  const head = byEpic[0]!.head;
  assert.ok(head.kind === "node" && head.node.key === "ACME-100" && head.initiative?.key === "ACME-10");
  assert.deepEqual(rowsOf(byHierarchy([sub], "epic")[0]!), [["ACME-121", 0, "ACME-120", false]]); // its task isn't listed: name it
});

test("byBoard: a ticket inherits its nearest listed ancestor's board; the rest go last", () => {
  const { sub, tsk, lone, stray } = listed();
  const boards = [
    { id: 2, name: "Docs board", url: "https://example.atlassian.net/b/2", keys: ["ACME-200"] },
    { id: 1, name: "Platform board", url: "https://example.atlassian.net/b/1", keys: ["ACME-120"] },
  ];
  const groups = byBoard([tsk, sub, lone, stray], { boards });
  assert.deepEqual(groups.map((g) => g.id), ["board:1", "board:2", "board:none"]); // busiest board first
  assert.deepEqual(groups[0]!.head, { kind: "board", name: "Platform board", url: "https://example.atlassian.net/b/1" });
  assert.deepEqual(rowsOf(groups[0]!), [["ACME-120", 0, "ACME-100", false], ["ACME-121", 0, "ACME-120", true]]); // the subtask is there via its task
  assert.deepEqual(rowsOf(groups[2]!), [["ACME-202", 0, null, false]]);
});
