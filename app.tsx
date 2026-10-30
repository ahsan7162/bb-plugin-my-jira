// bb-plugin-my-jira — frontend entry: the "My Tickets" page in the nav rail.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { UrlLink, definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { AuthStatus as Status, BoardGroups, Scope, TicketPage, rpcContract } from "./server";
import type { Ticket } from "./jira";
import { ISSUE_KEY, RANK, allIds, byBoard, byHierarchy, byStatus, catOf, matchesFilter, visibleKeys, type Group, type GroupHead, type HierarchyBy } from "./filters";
import { DetailView, detailCache } from "./detail";
import {
  BOARD_TEXT,
  ChipFilter,
  Crumb,
  ENTER,
  Empty,
  Kbd,
  NodeTitle,
  Problem,
  ROWS,
  Ring,
  Row,
  STATUS,
  Section,
  Seg,
  TYPES,
  Tiles,
  Warning,
  ago,
  menuItemClass,
  message,
  overlays,
  quietChip,
  typeOf,
  useMenu,
  type FilterOption,
  type Open,
  type Rpc,
} from "./parts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Site = NonNullable<Status["site"]>;
type GroupBy = "status" | "hierarchy" | "board";
const PAGE_SIZE = 50; // matches server.ts

// Survive remounts (bb remounts the page on resize, and may on navigation).
let cachedStatus: Status | null = null;
/** Pages by site, tab and page token. A tab's first page carries its total. */
const pageCache = new Map<string, TicketPage>();
const view = {
  scope: "open" as Scope,
  groupBy: "status" as GroupBy,
  hierarchyBy: "initiative" as HierarchyBy,
  /** Page tokens walked so far per tab; the last one is the current page (null = first). */
  tokens: { open: [null], done: [null] } as Record<Scope, (string | null)[]>,
  statuses: new Set<string>() as ReadonlySet<string>,
  types: new Set<string>() as ReadonlySet<string>,
  query: "",
  collapsed: new Set<string>() as ReadonlySet<string>,
  /** Where the list was scrolled when a ticket took over a narrow pane; restored on the way back. */
  listScroll: null as number | null,
};
type View = typeof view;

/** Drop everything read from the previous site or account (cursors included: they belong to one site). */
function forget() {
  pageCache.clear();
  detailCache.clear();
  view.tokens = { open: [null], done: [null] };
}

/** State kept in `view`, so it survives remounts. */
function useView<K extends keyof View>(key: K): [View[K], (next: View[K]) => void] {
  const [value, setValue] = useState(view[key]);
  return [
    value,
    (next) => {
      view[key] = next;
      setValue(next);
    },
  ];
}

// ---------- group headings (the groups themselves are data, in filters.ts) ----------

function Head({ head, onOpen }: { head: GroupHead; onOpen: Open }) {
  switch (head.kind) {
    case "status":
      return (
        <>
          <Ring cat={head.cat} />
          <span className="truncate">{head.status}</span>
        </>
      );
    case "node":
      return (
        <>
          <NodeTitle node={head.node} onOpen={onOpen} />
          {head.initiative ? (
            <span className="hidden min-w-0 items-center gap-1 text-xs font-normal text-muted-foreground @2xl:inline-flex">
              in <Crumb node={head.initiative} onOpen={onOpen} />
            </span>
          ) : null}
        </>
      );
    case "board":
      return (
        <UrlLink
          href={head.url}
          title="Open board in Jira"
          className="relative inline-flex min-w-0 items-center gap-2 rounded-md hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon name="Columns2" className={cn("size-4 shrink-0", BOARD_TEXT)} aria-hidden />
          <span className="truncate">{head.name}</span>
          <Icon name="ExternalLink" className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        </UrlLink>
      );
    case "label":
      return <span className="text-muted-foreground">{head.text}</span>;
  }
}

// ---------- data ----------

function useTicketPage(rpc: Rpc, site: string, scope: Scope, token: string | null) {
  const cacheKey = `${site}:${scope}:${token ?? ""}`;
  // The page asked for last: a slower reply for another tab or page must not replace it.
  const latest = useRef(cacheKey);
  latest.current = cacheKey;
  const [data, setData] = useState<TicketPage | null>(pageCache.get(cacheKey) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refetch = useCallback(() => {
    setLoading(true);
    rpc
      .call("tickets_list", { scope, pageToken: token })
      .then((page) => {
        pageCache.set(cacheKey, page);
        if (latest.current !== cacheKey) return;
        setData(page);
        setError(null);
      }, (c: unknown) => latest.current === cacheKey && setError(message(c)))
      .finally(() => latest.current === cacheKey && setLoading(false));
  }, [rpc, scope, token, cacheKey]);
  useEffect(() => {
    setData(pageCache.get(cacheKey) ?? null);
    refetch();
  }, [refetch, cacheKey]);
  return { data, error, loading, refetch };
}

/** Which board lists each ticket or its ancestors: one request per board, so only fetched while Board grouping is on. */
function useBoardGroups(rpc: Rpc, items: Ticket[] | null, enabled: boolean) {
  // Tickets first, then their ancestors, so inheritance has something to inherit; the server takes up to 100.
  const keys = items ? [...new Set([...items.map((t) => t.key), ...items.flatMap((t) => t.ancestors.map((a) => a.key))])].slice(0, 100).join(",") : "";
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ keys: string; attempt: number; data: BoardGroups | null; error: string | null }>({
    keys: "",
    attempt: 0,
    data: null,
    error: null,
  });
  useEffect(() => {
    if (!enabled || keys === "" || (state.keys === keys && state.attempt === attempt)) return;
    setState({ keys, attempt, data: null, error: null });
    rpc.call("board_groups", { keys: keys.split(",") }).then(
      (data) => setState((s) => (s.keys === keys && s.attempt === attempt ? { ...s, data } : s)),
      (c: unknown) => setState((s) => (s.keys === keys && s.attempt === attempt ? { ...s, error: message(c) } : s)),
    );
  }, [rpc, keys, enabled, attempt, state.keys, state.attempt]);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...(state.keys === keys ? state : { data: null, error: null }), retry };
}

// ---------- pieces of the list page ----------

function Pager({ index, total, hasNext, onPrev, onNext }: { index: number; total: number | undefined; hasNext: boolean; onPrev: () => void; onNext: () => void }) {
  if (index === 0 && !hasNext) return null;
  const pages = total !== undefined ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : undefined;
  return (
    <nav aria-label="Pages" className="flex items-center justify-center gap-2 text-xs">
      <Button variant="outline" size="sm" className="rounded-full" disabled={index === 0} onClick={onPrev}>
        <Icon name="ChevronLeft" className="size-4" /> Previous
      </Button>
      <span className="rounded-full bg-muted px-3 py-1 tabular-nums">
        Page {index + 1}
        {pages ? ` of ${pages}` : ""}
      </span>
      <Button variant="outline" size="sm" className="rounded-full" disabled={!hasNext} onClick={onNext}>
        Next <Icon name="ChevronRight" className="size-4" />
      </Button>
    </nav>
  );
}

const GROUPINGS: { id: string; label: string; icon: ReactNode }[] = [
  { id: "status", label: "Status", icon: <Ring cat="new" /> },
  { id: "hierarchy:initiative", label: "Initiative, then epic", icon: <Icon name="Star" className={cn("size-3.5", TYPES.initiative.text)} aria-hidden /> },
  { id: "hierarchy:epic", label: "Epic", icon: <Icon name="Layers" className={cn("size-3.5", TYPES.epic.text)} aria-hidden /> },
  { id: "board", label: "Board", icon: <Icon name="Columns2" className={cn("size-3.5", BOARD_TEXT)} aria-hidden /> },
];

/** Group by, as one quiet menu: status, hierarchy by initiative or by epic (Jira's swimlanes), or board. */
function GroupByMenu({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const menu = useMenu();
  const current = GROUPINGS.find((g) => g.id === value) ?? GROUPINGS[0];
  return (
    <div ref={menu.ref} className="relative">
      <button type="button" aria-expanded={menu.open} aria-haspopup="menu" onClick={menu.toggle} className={quietChip(false)}>
        <span>Group by</span>
        <span className="font-medium text-foreground">{current.label}</span>
        <Icon name="ChevronDown" className={cn("size-3.5 transition-transform duration-[120ms] motion-reduce:transition-none", menu.open && "rotate-180")} aria-hidden />
      </button>
      {menu.open ? (
        <div role="menu" className={menu.panelClass}>
          {GROUPINGS.map((g) => (
            <button
              key={g.id}
              type="button"
              role="menuitemradio"
              aria-checked={g.id === value}
              onClick={() => {
                onChange(g.id);
                menu.setOpen(false);
              }}
              className={menuItemClass}
            >
              {g.icon}
              <span className="min-w-0 flex-1">{g.label}</span>
              {g.id === value ? <Icon name="Check" className="size-3.5" aria-hidden /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The connected Jira site, linking to it; with several granted, a menu to switch between them. */
function SiteSwitch({ site, sites, onSelect }: { site: Site; sites: Site[]; onSelect: (cloudId: string) => void }) {
  const menu = useMenu();
  const look = "flex min-w-0 items-center gap-2 rounded-full py-1 pl-1 pr-3 text-sm font-semibold transition-colors duration-[120ms] hover:bg-muted";
  const name = (
    <>
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted">
        <Icon name="Columns2" className="size-3.5" aria-hidden />
      </span>
      <span className="truncate">{site.name}</span>
    </>
  );
  if (sites.length < 2) {
    return (
      <UrlLink href={site.url} className={look}>
        {name}
      </UrlLink>
    );
  }
  return (
    <div ref={menu.ref} className="relative min-w-0">
      <button
        type="button"
        aria-expanded={menu.open}
        aria-haspopup="menu"
        aria-label={`Jira site: ${site.name}. Switch site`}
        onClick={menu.toggle}
        className={cn(look, "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
      >
        {name}
        <Icon name="ChevronDown" className={cn("size-3.5 shrink-0 transition-transform duration-[120ms] motion-reduce:transition-none", menu.open && "rotate-180")} aria-hidden />
      </button>
      {menu.open ? (
        <div role="menu" className={menu.panelClass}>
          {sites.map((s) => (
            <button
              key={s.cloudId}
              type="button"
              role="menuitemradio"
              aria-checked={s.cloudId === site.cloudId}
              onClick={() => {
                menu.setOpen(false);
                if (s.cloudId !== site.cloudId) onSelect(s.cloudId);
              }}
              className={menuItemClass}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{s.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{new URL(s.url).host}</span>
              </span>
              {s.cloudId === site.cloudId ? <Icon name="Check" className="size-3.5" aria-hidden /> : null}
            </button>
          ))}
          <UrlLink href={site.url} className={menuItemClass}>
            <span className="min-w-0 flex-1 truncate">Open {site.name} in Jira</span>
            <Icon name="ExternalLink" className="size-3.5" aria-hidden />
          </UrlLink>
        </div>
      ) : null}
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["J / K or ↓ / ↑", "Move through the list (with a ticket open, open the next one)"],
  ["Enter", "Open the selected ticket"],
  ["[ / ]", "Previous / next ticket"],
  ["U", "Up to the open ticket's parent"],
  ["S", "Change the status of the selected ticket"],
  ["/", "Search"],
  ["Esc", "Close a menu, then the ticket, then clear search"],
  ["?", "Show or hide this list"],
];

function ShortcutSheet() {
  return (
    <div className={cn("absolute right-0 top-full z-20 mt-2 w-80 space-y-2 rounded-2xl border border-border/70 bg-card p-4 shadow-lg shadow-black/10 motion-safe:slide-in-from-top-1", ENTER)}>
      <p className="text-xs text-muted-foreground">When this panel has focus</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>
              <Kbd>{k}</Kbd>
            </dt>
            <dd className="text-muted-foreground">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// ---------- the list, with the open ticket beside it ----------

function ListView({
  rpc,
  site,
  sites,
  onSelectSite,
  openKey,
  onOpen,
  onClose,
  onDisconnect,
}: {
  rpc: Rpc;
  site: Site;
  /** Every Jira site the account granted; the list shows `site`. */
  sites: Site[];
  onSelectSite: (cloudId: string) => void;
  /** The ticket in the route, if any: beside the list on wide panes, instead of it on narrow ones. */
  openKey: string | null;
  onOpen: Open;
  onClose: () => void;
  onDisconnect: () => void;
}) {
  const nav = useBbNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [scope, setScopeView] = useView("scope");
  const [groupBy, setGroupBy] = useView("groupBy");
  const [lanes, setLanes] = useView("hierarchyBy");
  const [statuses, setStatuses] = useView("statuses");
  const [types, setTypes] = useView("types");
  const [query, setQuery] = useView("query");
  const [collapsed, setCollapsed] = useView("collapsed");
  const [tokens, setTokensState] = useState(view.tokens[view.scope]);
  const [cursor, setCursor] = useState<string | null>(openKey);
  const [sheet, setSheet] = useState(false);
  const [version, setVersion] = useState(0);
  const [paneH, setPaneH] = useState(0);
  const setScope = (next: Scope) => {
    setScopeView(next);
    setTokensState(view.tokens[next]);
    setStatuses(new Set());
    setTypes(new Set());
    setCursor(null);
  };
  const setTokens = (next: (string | null)[]) => {
    view.tokens[scope] = next;
    setTokensState(next);
  };
  const index = tokens.length - 1;
  const { data, error, loading, refetch } = useTicketPage(rpc, site.cloudId, scope, tokens[index] ?? null);
  const total = (of: Scope) => pageCache.get(`${site.cloudId}:${of}:`)?.total ?? undefined;
  const items = useMemo(() => data?.items ?? [], [data]);
  const boards = useBoardGroups(rpc, data?.items ?? null, groupBy === "board");
  // A status moved somewhere: re-read the list and the open ticket.
  const onChanged = () => {
    refetch();
    setVersion((v) => v + 1);
  };

  const statusOptions = useMemo(() => {
    const m = new Map<string, FilterOption & { rank: number }>();
    for (const t of items) {
      const cat = catOf(t.category);
      const o = m.get(t.status) ?? { id: t.status, label: t.status, icon: <Ring cat={cat} />, count: 0, on: STATUS[cat].pill, rank: RANK[cat] };
      o.count += 1;
      m.set(t.status, o);
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.rank - b.rank);
  }, [items]);
  // By Jira's own type name (Task, Bug, Story, Sub-task…), coloured like its chip.
  const typeOptions = useMemo(() => {
    const m = new Map<string, FilterOption>();
    for (const t of items) {
      const style = typeOf(t.type, t.level);
      const o = m.get(t.type) ?? { id: t.type, label: t.type, icon: <Icon name={style.icon} className={cn("size-3.5", style.text)} aria-hidden />, count: 0, on: style.chip };
      o.count += 1;
      m.set(t.type, o);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [items]);
  const shown = items.filter((t) => matchesFilter(t, { statuses, types, query }));
  const q = query.trim();
  const typedKey = ISSUE_KEY.test(q.toUpperCase()) ? q.toUpperCase() : null;
  const offerOpen = typedKey !== null && !items.some((t) => t.key === typedKey);
  const filtering = q !== "" || statuses.size > 0 || types.size > 0;

  const scroller = () => rootRef.current?.closest<HTMLElement>('[class~="@container"]') ?? null;
  const isNarrow = () => (scroller()?.clientWidth ?? 0) < 1024; // @5xl, where the ticket moves beside the list
  const rowInView = (key: string) => requestAnimationFrame(() => rootRef.current?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" }));
  const openTicket = (key: string) => {
    if (!openKey && isNarrow()) view.listScroll = scroller()?.scrollTop ?? null;
    setCursor(key);
    onOpen(key);
  };

  // After the route changes: a narrow pane starts the ticket at the top, or goes back to where the list was;
  // a wide one keeps the open ticket's row in sight.
  useEffect(() => {
    const el = scroller();
    if (openKey) {
      setCursor(openKey);
      if (isNarrow()) el?.scrollTo({ top: 0 });
      else rowInView(openKey);
    } else if (view.listScroll !== null) {
      const top = view.listScroll;
      view.listScroll = null;
      requestAnimationFrame(() => el?.scrollTo({ top }));
    } else if (cursor) rowInView(cursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  // Side by side, the list and the ticket each scroll on their own, sized to what is left below the toolbar.
  const split = openKey !== null;
  useEffect(() => {
    const el = scroller();
    const grid = gridRef.current;
    if (!split || !el || !grid) return;
    const measure = () => {
      const top = grid.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      setPaneH(Math.max(320, el.clientHeight - top - 24));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    const header = rootRef.current?.firstElementChild; // the filter rows can wrap and push the panes down
    if (header) watch.observe(header);
    return () => watch.disconnect();
  }, [split]);

  const groups =
    groupBy === "status"
      ? byStatus(shown)
      : groupBy === "hierarchy"
        ? byHierarchy(shown, lanes)
        : boards.data
          ? byBoard(shown, boards.data)
          : [];
  const order = [...new Set(visibleKeys(groups, collapsed))];
  const selected = openKey ?? cursor;
  const position = openKey && order.includes(openKey) ? { index: order.indexOf(openKey), total: order.length } : null;
  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
  };
  const move = (delta: number) => {
    const at = selected ? order.indexOf(selected) : -1;
    const next = order[Math.min(order.length - 1, Math.max(0, at + delta))];
    if (!next || next === openKey) return;
    if (openKey) openTicket(next);
    else {
      setCursor(next);
      rowInView(next);
    }
  };
  const refresh = () => {
    refetch();
    setVersion((v) => v + 1);
    if (groupBy === "board" && (boards.error || boards.data?.unchecked)) boards.retry();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement;
    if (el.closest("input, textarea, [contenteditable=true]")) {
      if (e.key === "Escape") {
        setQuery("");
        rootRef.current?.focus();
      }
      return;
    }
    switch (e.key) {
      case "j":
      case "ArrowDown":
      case "]":
        move(1);
        break;
      case "k":
      case "ArrowUp":
      case "[":
        move(-1);
        break;
      case "Enter":
        if (el.closest("button, a") || !cursor) return; // a focused control answers Enter itself
        openTicket(cursor);
        break;
      case "Escape":
        if (overlays.open > 0) return; // the open menu closes first
        if (sheet) setSheet(false);
        else if (openKey) onClose();
        else if (q) setQuery("");
        else return;
        break;
      case "/":
        searchRef.current?.focus();
        break;
      case "?":
        setSheet(!sheet);
        break;
      case "s": {
        const holder = openKey ? rootRef.current?.querySelector("[data-pane]") : selected ? rootRef.current?.querySelector(`[data-key="${CSS.escape(selected)}"]`) : null;
        const pill = holder?.querySelector<HTMLButtonElement>('button[aria-label^="Status:"]');
        if (!pill) return;
        pill.click();
        break;
      }
      case "u": {
        const parent = openKey ? (items.find((t) => t.key === openKey) ?? detailCache.get(openKey))?.ancestors[0] : undefined;
        if (!parent) return;
        openTicket(parent.key);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  const renderGroup = (g: Group, nested = false): ReactNode => (
    <Section key={g.id} header={<Head head={g.head} onOpen={openTicket} />} count={g.count} nested={nested} collapsed={collapsed.has(g.id)} onToggle={() => toggle(g.id)}>
      {g.rows ? (
        <ul className={ROWS}>
          {g.rows.map((r) => (
            <Row
              key={r.ticket.key}
              ticket={r.ticket}
              rpc={rpc}
              depth={r.depth}
              parent={r.parent}
              via={r.via}
              compactStatus={groupBy === "status"}
              parentColumn={g.rows!.some((x) => x.parent)}
              selected={r.ticket.key === selected}
              onOpen={openTicket}
              onChanged={onChanged}
            />
          ))}
        </ul>
      ) : null}
      {g.groups ? <div className="space-y-4">{g.groups.map((c) => renderGroup(c, true))}</div> : null}
    </Section>
  );

  return (
    <div ref={rootRef} tabIndex={-1} onKeyDown={onKey} className="space-y-6 outline-none">
      <div className={cn("space-y-3", split && "hidden @5xl:block")}>
        <div className="flex flex-wrap items-center gap-3">
          <SiteSwitch site={site} sites={sites} onSelect={onSelectSite} />
          <div className="relative min-w-[12rem] flex-1 @4xl:max-w-md">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find by key, words or epic"
              aria-label="Find a ticket"
              className="h-9 w-full rounded-full border border-border bg-background pl-4 pr-10 text-sm outline-none transition-shadow duration-[120ms] placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">{query ? null : <Kbd>/</Kbd>}</span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            {/* Creating happens in Jira itself: open its boards in the browser. */}
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => nav.openUrl(`${site.url}/jira/boards`)}>
              <Icon name="Plus" className="size-4" /> Create ticket
            </Button>
            <span title={data ? `Updated ${ago(data.fetchedAt)}` : undefined}>
              <Button variant="ghost" size="icon" className="rounded-full" aria-label="Refresh" disabled={loading} onClick={refresh}>
                <Icon name="RotateCcw" className={cn("size-4", loading && "animate-spin motion-reduce:animate-none")} />
              </Button>
            </span>
            <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground" onClick={onDisconnect}>
              Disconnect
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Seg
            label="Which tickets"
            value={scope}
            onChange={setScope}
            options={[
              { id: "open", label: "Open", icon: <Ring cat="indeterminate" />, count: total("open") },
              { id: "done", label: "Done", icon: <Ring cat="done" />, count: total("done") },
            ]}
          />
          <ChipFilter name="status" options={statusOptions} selected={statuses} onChange={setStatuses} inline={3} />
          <ChipFilter name="type" options={typeOptions} selected={types} onChange={setTypes} inline={0} menuLabel="Type" />
          {statuses.size > 0 || types.size > 0 ? (
            <button
              type="button"
              onClick={() => {
                setStatuses(new Set());
                setTypes(new Set());
              }}
              className="cursor-pointer rounded-full px-2 py-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Clear filters
            </button>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            <GroupByMenu
              value={groupBy === "hierarchy" ? `hierarchy:${lanes}` : groupBy}
              onChange={(id) => {
                if (id.startsWith("hierarchy:")) {
                  setGroupBy("hierarchy");
                  setLanes(id.slice("hierarchy:".length) as HierarchyBy);
                } else setGroupBy(id as GroupBy);
              }}
            />
            <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground" onClick={() => setCollapsed(collapsed.size > 0 ? new Set() : new Set(allIds(groups)))}>
              {collapsed.size > 0 ? "Expand all" : "Collapse all"}
            </Button>
            <span className="relative">
              <Button variant="ghost" size="icon" className="rounded-full text-muted-foreground" aria-label="Keyboard shortcuts" aria-expanded={sheet} onClick={() => setSheet(!sheet)}>
                ?
              </Button>
              {sheet ? <ShortcutSheet /> : null}
            </span>
          </div>
        </div>
      </div>

      {error ? <Problem>{error}</Problem> : null}

      <div
        ref={gridRef}
        style={split ? ({ "--pane-h": `${paneH}px` } as CSSProperties) : undefined}
        className={cn("grid grid-cols-1 gap-6", split && "@5xl:grid-cols-[minmax(22rem,2fr)_minmax(0,3fr)] @5xl:items-start")}
      >
        <div className={cn("@container/list min-w-0 space-y-6", split && "hidden @5xl:block @5xl:max-h-[var(--pane-h)] @5xl:overflow-y-auto @5xl:overscroll-contain @5xl:pr-2")}>
          {data === null ? (
            error ? null : <Tiles rows={4} />
          ) : items.length === 0 ? (
            <Empty>{scope === "open" ? "Nothing assigned to you. 🎉" : "No done tickets yet."}</Empty>
          ) : (
            <>
              {!split && (index > 0 || data.nextPageToken) ? <p className="px-1 text-xs text-muted-foreground">Counts, filters and groups cover the tickets on this page.</p> : null}

              {offerOpen ? (
                <div className={cn("flex items-center gap-3 rounded-2xl border border-border/70 bg-card px-4 py-3 text-sm motion-safe:slide-in-from-top-1", ENTER)}>
                  <span className="text-muted-foreground">{typedKey} isn't in this list.</span>
                  <Button size="sm" variant="outline" className="rounded-full" onClick={() => openTicket(typedKey)}>
                    Open {typedKey}
                  </Button>
                </div>
              ) : filtering && shown.length === 0 ? (
                <Empty>{q ? `No tickets match "${q}" here.` : "No tickets match these filters."}</Empty>
              ) : null}

              {groupBy === "board" && boards.error ? (
                <Problem>
                  {boards.error}{" "}
                  <button type="button" onClick={boards.retry} className="cursor-pointer font-medium underline">
                    Try again
                  </button>
                </Problem>
              ) : groupBy === "board" && !boards.data ? (
                <div role="status" className="space-y-3">
                  <p className="px-1 text-xs text-muted-foreground">Checking which of your boards list these tickets and their parents…</p>
                  <Tiles rows={3} />
                </div>
              ) : (
                <>
                  {groupBy === "board" && boards.data?.unchecked ? (
                    <Warning>
                      {boards.data.unchecked} board{boards.data.unchecked === 1 ? "" : "s"} couldn't be checked, so a ticket may be missing from its board.{" "}
                      <button type="button" onClick={boards.retry} className="cursor-pointer font-medium underline">
                        Try again
                      </button>
                    </Warning>
                  ) : null}
                  {/* Keyed by the grouping, so regrouped content fades in. */}
                  <div key={`${scope}:${groupBy}:${lanes}`} className={cn("space-y-6", ENTER)}>
                    {groups.map((g) => renderGroup(g))}
                  </div>
                </>
              )}

              <Pager
                index={index}
                total={total(scope)}
                hasNext={data.nextPageToken !== null}
                onPrev={() => setTokens(tokens.slice(0, -1))}
                onNext={() => setTokens([...tokens, data.nextPageToken])}
              />
            </>
          )}
        </div>

        {openKey ? (
          <div key={openKey} className={cn("min-w-0 motion-safe:slide-in-from-right-2 @5xl:max-h-[var(--pane-h)] @5xl:overflow-y-auto @5xl:overscroll-contain @5xl:pr-2", ENTER)}>
            <DetailView
              rpc={rpc}
              issueKey={openKey}
              version={version}
              position={position}
              onPrev={() => move(-1)}
              onNext={() => move(1)}
              onClose={onClose}
              onOpen={openTicket}
              onChanged={onChanged}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConnectPanel({ rpc }: { rpc: Rpc }) {
  const nav = useBbNavigate();
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const connect = () =>
    rpc.call("auth_start").then(({ url }) => {
      setError(null);
      setOpened(nav.openUrl(url));
    }, (cause: unknown) => setError(message(cause)));
  return (
    <section className="max-w-xl space-y-3 rounded-2xl border border-border/70 bg-card p-6 text-sm">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <span className="grid size-7 place-items-center rounded-full bg-muted">
          <Icon name="Columns2" className="size-3.5" aria-hidden />
        </span>
        Connect Jira
      </h2>
      <p className="text-muted-foreground">Sign in with your Atlassian account in the browser to see the tickets assigned to you. Nothing to set up.</p>
      {error ? <Problem>{error}</Problem> : null}
      <Button className="rounded-full" onClick={() => void connect()}>
        <Icon name="Link" className="size-4" /> Connect Jira
      </Button>
      {opened ? <p className={cn("text-xs text-muted-foreground", ENTER)}>Finish signing in in your browser. This page updates on its own.</p> : null}
    </section>
  );
}

function TicketsPage({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [status, setStatus] = useState<Status | null>(cachedStatus);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    rpc.call("auth_status").then((s) => {
      // Another site or account, or signed out (also when Atlassian ended the session): forget the old one.
      if (s.site?.cloudId !== cachedStatus?.site?.cloudId) forget();
      cachedStatus = s;
      setStatus(s);
      setError(null);
    }, (c: unknown) => setError(message(c)));
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("auth-changed", load); // the OAuth callback finished in the browser
  const disconnect = () => {
    rpc.call("auth_disconnect").then(load, (c: unknown) => setError(message(c)));
  };
  const selectSite = (cloudId: string) =>
    rpc.call("site_select", { cloudId }).then(() => {
      nav.toPluginPanel("tickets"); // an open ticket belongs to the old site
      load();
    }, (c: unknown) => setError(message(c)));
  const route = subPath.replace(/^\/+|\/+$/g, "");
  const issueKey = ISSUE_KEY.test(route) ? route : null;

  return (
    // Not keyed by route: the list stays mounted while tickets open beside it.
    // @container: layouts respond to this pane's width, not the window's (bb's sidebar and panels take some of it).
    <div className="@container h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-[120rem] space-y-6 px-4 pb-6 pt-4 md:px-6 md:pt-6">
        {error ? <Problem>{error}</Problem> : null}
        {status === null ? null : status.site === null ? (
          <ConnectPanel rpc={rpc} />
        ) : (
          // Keyed by site, so switching starts the list afresh.
          <ListView
            key={status.site.cloudId}
            rpc={rpc}
            site={status.site}
            sites={status.sites}
            onSelectSite={(cloudId) => void selectSite(cloudId)}
            openKey={issueKey}
            onOpen={(key) => nav.toPluginPanel("tickets", { subPath: key })}
            onClose={() => nav.toPluginPanel("tickets")}
            onDisconnect={disconnect}
          />
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "tickets",
    title: "My Tickets",
    icon: "Columns2",
    path: "tickets",
    component: TicketsPage,
  });
});
