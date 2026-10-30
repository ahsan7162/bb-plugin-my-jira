// Presentational pieces shared by the list (app.tsx) and the ticket (detail.tsx). What each value means: MASTER.md.
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode, Ref } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { IssueNode, Ticket, Transition } from "./jira";
import { age, catOf, priorityLevel, type Cat, type Priority } from "./filters";

export { age };
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
export type Open = (key: string) => void;

export const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// ---------- motion: two durations (120ms, 200ms), one curve ----------

export const EASE = "cubic-bezier(0.2, 0, 0, 1)";
/** A 200ms fade in. Slides are added with motion-safe: so reduced motion keeps the fade only. */
export const ENTER = "animate-in fade-in-0 duration-200 ease-[cubic-bezier(0.2,0,0,1)]";
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Menus open right now; Escape closes those before it closes the ticket. */
export const overlays = { open: 0 };

/** While `open`, count as an open overlay and close on Escape. */
function useOverlay(open: boolean, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    overlays.open += 1;
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", esc);
    return () => {
      overlays.open -= 1;
      document.removeEventListener("keydown", esc);
    };
  }, [open, setOpen]);
}

// ---------- colour vocabulary. Full class strings only: Tailwind finds classes by scanning source text. ----------

export const STATUS: Record<Cat, { label: string; ring: string; pill: string }> = {
  new: { label: "To do", ring: "text-slate-500 dark:text-slate-400", pill: "bg-slate-500/15 text-slate-700 dark:text-slate-300" },
  indeterminate: { label: "In progress", ring: "text-sky-600 dark:text-sky-400", pill: "bg-sky-500/15 text-sky-800 dark:text-sky-200" },
  done: { label: "Done", ring: "text-emerald-600 dark:text-emerald-400", pill: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200" },
};

export const TYPES = {
  initiative: { icon: "Star", chip: "bg-amber-500/15 text-amber-700 dark:text-amber-300", text: "text-amber-600 dark:text-amber-400" },
  epic: { icon: "Layers", chip: "bg-violet-500/15 text-violet-700 dark:text-violet-300", text: "text-violet-600 dark:text-violet-400" },
  story: { icon: "AlignLeft", chip: "bg-green-500/15 text-green-700 dark:text-green-300", text: "text-green-600 dark:text-green-400" },
  task: { icon: "Check", chip: "bg-blue-500/15 text-blue-700 dark:text-blue-300", text: "text-blue-600 dark:text-blue-400" },
  bug: { icon: "Bug", chip: "bg-red-500/15 text-red-700 dark:text-red-300", text: "text-red-600 dark:text-red-400" },
  security: { icon: "SecurityCheck", chip: "bg-rose-500/15 text-rose-700 dark:text-rose-300", text: "text-rose-600 dark:text-rose-400" },
  subtask: { icon: "ChildThread", chip: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300", text: "text-cyan-600 dark:text-cyan-400" },
};
export const BOARD_TEXT = "text-teal-600 dark:text-teal-400";

/** Issue type → colour and glyph: by name first (Bug, Story…), then by hierarchy level. */
export function typeOf(type: string, level: number) {
  const name = type.toLowerCase();
  if (level >= 2 || name.includes("initiative")) return TYPES.initiative;
  if (level === 1 || name.includes("epic")) return TYPES.epic;
  if (level === -1 || name.includes("sub")) return TYPES.subtask;
  if (name.includes("security") || name.includes("vulnerab")) return TYPES.security;
  if (name.includes("bug") || name.includes("incident")) return TYPES.bug;
  if (name.includes("story")) return TYPES.story;
  return TYPES.task;
}

// Urgent priorities get a tinted tag (6px corners, unlike the round status pill); the rest are coloured text.
const PRIO: Record<Priority, { path: string; tone: string; glyph: string }> = {
  highest: { path: "M3 6.5l3-3 3 3M3 9.5l3-3 3 3", tone: "rounded-md bg-red-500/15 px-1.5 py-0.5 text-red-700 dark:text-red-300", glyph: "text-red-600 dark:text-red-400" },
  high: { path: "M3 7.5l3-3 3 3", tone: "rounded-md bg-orange-500/15 px-1.5 py-0.5 text-orange-800 dark:text-orange-300", glyph: "text-orange-600 dark:text-orange-400" },
  medium: { path: "M3 4.5h6M3 7.5h6", tone: "text-amber-700 dark:text-amber-400", glyph: "text-amber-700 dark:text-amber-400" },
  low: { path: "M3 4.5l3 3 3-3", tone: "text-sky-700 dark:text-sky-400", glyph: "text-sky-700 dark:text-sky-400" },
  lowest: { path: "M3 2.5l3 3 3-3M3 5.5l3 3 3-3", tone: "text-slate-600 dark:text-slate-400", glyph: "text-slate-600 dark:text-slate-400" },
};

// ---------- small pieces ----------

/** The status category as a ring: empty (to do), half (in progress), filled with a check (done). */
export function Ring({ cat, className }: { cat: Cat; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={cn("size-3.5 shrink-0", STATUS[cat].ring, className)} aria-hidden>
      <circle cx="8" cy="8" r="6.25" fill={cat === "done" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" />
      {cat === "indeterminate" ? <path d="M8 3.5a4.5 4.5 0 0 1 0 9z" fill="currentColor" /> : null}
      {cat === "done" ? <path d="M5.3 8.2l1.8 1.8 3.6-3.8" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> : null}
    </svg>
  );
}

/** Priority as a coloured chevron and label; `glyph` drops the label (for icons). */
export function PriorityMark({ priority, glyph = false }: { priority: string | null; glyph?: boolean }) {
  const p = priorityLevel(priority);
  if (!p || !priority) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-0.5 font-medium", glyph ? PRIO[p].glyph : PRIO[p].tone)}>
      <svg viewBox="0 0 12 12" className="size-3" aria-hidden>
        <path d={PRIO[p].path} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {glyph ? <span className="sr-only">{priority}</span> : priority.replace(/^(P\d)\s*-\s*/i, "$1 · ")}
    </span>
  );
}

export function TypeChip({ type, level, size = "md" }: { type: string; level: number; size?: "sm" | "md" }) {
  const t = typeOf(type, level);
  return (
    <span title={type} className={cn("grid shrink-0 place-items-center rounded-lg", t.chip, size === "md" ? "size-7" : "size-6")}>
      <Icon name={t.icon} className="size-3.5" aria-hidden />
      <span className="sr-only">{type}</span>
    </span>
  );
}

/** A parent in a chain, as a soft chip: its type glyph in colour, key, summary. Opens it. */
export function Crumb({ node, onOpen }: { node: IssueNode; onOpen: Open }) {
  const t = typeOf(node.type, node.level);
  return (
    <button
      type="button"
      onClick={() => onOpen(node.key)}
      title={`${node.type} · ${node.status}`}
      className="pointer-events-auto relative inline-flex min-w-0 max-w-[16rem] cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 transition-colors duration-[120ms] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @4xl:max-w-[24rem]"
    >
      <Icon name={t.icon} className={cn("size-3 shrink-0", t.text)} aria-hidden />
      <span className="shrink-0 font-mono">{node.key}</span>
      <span className="truncate">{node.summary}</span>
    </button>
  );
}

/** Where a ticket sits: initiative › epic › parent (nearest last). */
export function Lineage({ nodes, onOpen }: { nodes: IssueNode[]; onOpen: Open }) {
  return (
    <>
      {[...nodes].reverse().map((n, i) => (
        <span key={n.key} className="inline-flex min-w-0 max-w-full items-center">
          {i > 0 ? <Icon name="ChevronRight" className="size-3 shrink-0 opacity-40" aria-hidden /> : null}
          <Crumb node={n} onOpen={onOpen} />
        </span>
      ))}
    </>
  );
}

/** A group header's title when the group is an issue (initiative or epic): opens it. */
export function NodeTitle({ node, onOpen }: { node: IssueNode; onOpen: Open }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(node.key)}
      title={`Open ${node.key} (${node.status})`}
      className="relative inline-flex min-w-0 cursor-pointer items-center gap-2 rounded-md text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <TypeChip type={node.type} level={node.level} size="sm" />
      <span className="shrink-0 font-mono text-xs font-normal text-muted-foreground">{node.key}</span>
      <span className="truncate">{node.summary}</span>
      <Ring cat={catOf(node.category)} />
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{children}</kbd>;
}

export interface SegOption<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  count?: number;
}

/** Neutral segmented control: the selection is bb's background, the icons carry meaning. */
export function Seg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: SegOption<T>[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-full bg-muted/70 p-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === o.id ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.icon}
          {o.label}
          {o.count !== undefined ? <span className="rounded-full bg-foreground/10 px-1.5 text-xs tabular-nums">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function Problem({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Warning({ children }: { children: ReactNode }) {
  return <div className="rounded-xl bg-amber-500/10 px-4 py-2.5 text-xs text-amber-800 dark:text-amber-200">{children}</div>;
}

/** Loading placeholders, the size of ticket tiles. */
export function Tiles({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy role="status" aria-label="Loading" className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl bg-muted/60 motion-reduce:animate-none" />
      ))}
    </div>
  );
}

// ---------- menus and filter chips ----------

/** A small popover menu: opens toward the side with room, closes on Escape or a click outside. */
export function useMenu() {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(open, setOpen);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const toggle = (e: ReactMouseEvent<HTMLElement>) => {
    // Open toward the side with room, so the menu never pushes the pane sideways.
    const pane = ref.current?.closest('[class~="@container"]')?.getBoundingClientRect();
    setAlignRight(pane !== undefined && e.currentTarget.getBoundingClientRect().left + 256 > pane.right);
    setOpen(!open);
  };
  const panelClass = cn(
    "absolute top-full z-20 mt-2 w-64 space-y-0.5 rounded-2xl border border-border/70 bg-card p-1.5 shadow-lg shadow-black/10 motion-safe:slide-in-from-top-1",
    alignRight ? "right-0" : "left-0",
    ENTER,
  );
  return { open, setOpen, ref, toggle, panelClass };
}

/** A quiet chip: plain text until it is on, then the colour of what it stands for. */
export const quietChip = (on: boolean, onClass?: string) =>
  cn(
    "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-sm transition-colors duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    on ? cn("font-medium", onClass ?? "bg-muted text-foreground") : "text-muted-foreground hover:bg-muted hover:text-foreground",
  );

export const menuItemClass =
  "flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors duration-[120ms] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function MenuCheck({ on }: { on: boolean }) {
  return (
    <span className={cn("grid size-4 shrink-0 place-items-center rounded-md border", on ? "border-transparent bg-foreground text-background" : "border-border")}>
      {on ? <Icon name="Check" className="size-3" aria-hidden /> : null}
    </span>
  );
}

export interface FilterOption {
  id: string;
  label: string;
  icon: ReactNode;
  count: number;
  /** Classes for the chip while it is on: the colour of what it stands for. */
  on: string;
}

/**
 * Filter chips: the busiest `inline` options as quiet chips, the rest in a menu. With `inline` 0 the whole set
 * sits behind one menu button named `menuLabel`. Several can be on at once.
 */
export function ChipFilter({
  name,
  options,
  selected,
  onChange,
  inline,
  menuLabel,
}: {
  name: string;
  options: FilterOption[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  inline: number;
  menuLabel?: string;
}) {
  const menu = useMenu();
  if (options.length < 2) return null; // a single option leaves nothing to filter
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  const shown = options.slice(0, inline);
  const more = options.slice(inline);
  const moreOn = more.filter((o) => selected.has(o.id)).length;
  const label = inline === 0 ? `${menuLabel ?? "More"}${moreOn > 0 ? ` · ${moreOn}` : ""}` : moreOn > 0 ? `More · ${moreOn} on` : `${more.length} more`;
  return (
    <div role="group" aria-label={`Filter by ${name}`} className="flex flex-wrap items-center gap-0.5">
      {shown.map((o) => (
        <button key={o.id} type="button" aria-pressed={selected.has(o.id)} onClick={() => toggle(o.id)} className={quietChip(selected.has(o.id), o.on)}>
          {o.icon}
          {o.label}
          <span className="text-xs tabular-nums opacity-60">{o.count}</span>
        </button>
      ))}
      {more.length > 0 ? (
        <div ref={menu.ref} className="relative">
          <button type="button" aria-expanded={menu.open} aria-haspopup="menu" onClick={menu.toggle} className={quietChip(moreOn > 0)}>
            {label}
            <Icon name="ChevronDown" className={cn("size-3.5 transition-transform duration-[120ms] motion-reduce:transition-none", menu.open && "rotate-180")} aria-hidden />
          </button>
          {menu.open ? (
            <div role="menu" className={menu.panelClass}>
              {more.map((o) => (
                <button key={o.id} type="button" role="menuitemcheckbox" aria-checked={selected.has(o.id)} onClick={() => toggle(o.id)} className={menuItemClass}>
                  <MenuCheck on={selected.has(o.id)} />
                  {o.icon}
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{o.count}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------- status change ----------

function MenuPanel({ transitions, error, url, busy, onPick }: { transitions: Transition[] | null; error: string | null; url: string; busy: boolean; onPick: (t: Transition) => void }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 rounded-xl bg-muted/50 p-2 motion-safe:slide-in-from-top-1", ENTER)}>
      {error ? (
        <span className="px-1 text-xs text-destructive">
          {error}{" "}
          <UrlLink href={url} className="font-medium underline">
            Open in Jira
          </UrlLink>
        </span>
      ) : transitions === null ? (
        <span className="px-1 text-xs text-muted-foreground">Loading statuses…</span>
      ) : transitions.length === 0 ? (
        <span className="px-1 text-xs text-muted-foreground">No status changes available.</span>
      ) : (
        <>
          <span className="px-1 text-xs text-muted-foreground">Move to</span>
          {transitions.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={busy}
              onClick={() => onPick(t)}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium transition-colors duration-[120ms] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-muted/80 disabled:pointer-events-none disabled:opacity-50"
            >
              <Ring cat={catOf(t.category)} />
              {t.name === t.to ? t.to : `${t.name} → ${t.to}`}
            </button>
          ))}
        </>
      )}
    </div>
  );
}

function StatusPill({
  cat,
  label,
  open,
  busy,
  compact,
  onClick,
  onHover,
  pillRef,
}: {
  cat: Cat;
  label: string;
  open: boolean;
  busy: boolean;
  /** The ring alone, where a heading already names the status. */
  compact: boolean;
  onClick: () => void;
  onHover: () => void;
  pillRef: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={pillRef}
      type="button"
      onClick={onClick}
      onPointerEnter={onHover}
      onFocus={onHover}
      aria-expanded={open}
      aria-label={`Status: ${label}. Change status`}
      title={compact ? label : undefined}
      className={cn(
        "pointer-events-auto relative inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-full text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact
          ? "gap-0.5 p-1 text-muted-foreground transition-colors duration-[120ms] hover:bg-muted"
          : cn("gap-1.5 px-2 py-0.5 transition-shadow duration-[120ms] hover:shadow-sm", STATUS[cat].pill),
      )}
    >
      <Ring cat={cat} />
      {compact ? (busy ? "Moving…" : null) : busy ? "Moving…" : label}
      <Icon name="ChevronDown" className={cn("size-3 transition-transform duration-[120ms] motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
    </button>
  );
}

/**
 * A ticket's status pill and, once clicked, the transitions its workflow allows.
 * Returns the two parts separately so callers can place the panel under the whole row.
 */
export function useStatusChanger(rpc: Rpc, ticket: Pick<Ticket, "key" | "status" | "category" | "url">, onChanged: () => void, compact = false) {
  const [transitions, setTransitions] = useState<Transition[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The status just moved to, shown until the refreshed ticket arrives (the reload takes a second or two).
  const [moved, setMoved] = useState<{ status: string; category: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setMoved(null), [ticket.status]);
  useOverlay(open, setOpen); // Escape closes the open menu before anything else

  // Started on hover/focus too, so the list is usually there by the time the pill is clicked.
  const prefetch = () => {
    if (transitions !== null || loading) return;
    setLoading(true);
    rpc
      .call("transitions_list", { key: ticket.key })
      .then((r) => setTransitions(r.transitions), (c: unknown) => setError(message(c)))
      .finally(() => setLoading(false));
  };
  const toggle = () => {
    setOpen(!open);
    setError(null);
    if (!open) prefetch();
  };
  const apply = (t: Transition) => {
    setBusy(true);
    setError(null);
    rpc
      .call("transition_apply", { key: ticket.key, id: t.id })
      .then(() => {
        setOpen(false);
        setMoved({ status: t.to, category: t.category });
        setTransitions(null); // the next status has different transitions
        if (!reducedMotion()) pillRef.current?.animate([{ transform: "scale(1)" }, { transform: "scale(1.06)" }, { transform: "scale(1)" }], { duration: 200, easing: EASE });
        onChanged();
      }, (c: unknown) => setError(message(c)))
      .finally(() => setBusy(false));
  };

  const shown = moved ?? ticket;
  const pill = <StatusPill pillRef={pillRef} cat={catOf(shown.category)} label={shown.status} open={open} busy={busy} compact={compact} onHover={prefetch} onClick={toggle} />;
  const panel = open ? <MenuPanel transitions={transitions} error={error} url={ticket.url} busy={busy} onPick={apply} /> : null;
  return { pill, panel };
}

// ---------- a ticket row ----------

/** Rows: medium and low as the coloured glyph alone (name on hover); highest and high keep their tag and label. */
export function PriorityCue({ priority }: { priority: string | null }) {
  const level = priorityLevel(priority);
  if (!level || !priority) return null;
  if (level === "highest" || level === "high") return <PriorityMark priority={priority} />;
  return (
    <span title={priority}>
      <PriorityMark priority={priority} glyph />
    </span>
  );
}

/** The one parent worth naming on a row (an epic, a subtask's task), or the ancestor that put it on a board. */
function ParentLink({ node, via, onOpen }: { node: IssueNode; via: boolean; onOpen: Open }) {
  const t = typeOf(node.type, node.level);
  return (
    <button
      type="button"
      onClick={() => onOpen(node.key)}
      title={`${via ? "On this board through " : ""}${node.key} ${node.summary}`}
      className="pointer-events-auto relative -ml-1.5 inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 text-left transition-colors duration-[120ms] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {via ? <span className="shrink-0">via</span> : null}
      <Icon name={t.icon} className={cn("size-3 shrink-0", t.text)} aria-hidden />
      <span className="min-w-0 truncate">{node.summary}</span>
    </button>
  );
}

/**
 * One ticket, inbox style. The title carries the row; key, parent, status, priority and age sit in aligned columns
 * when the list is wide (an @container named "list"), or on one muted line under the title when it is narrow.
 * The whole row opens the ticket; the pill, the parent and Open in Jira stay clickable on their own.
 */
export function Row({
  ticket: t,
  rpc,
  onOpen,
  onChanged,
  depth = 0,
  parent = null,
  via = false,
  compactStatus = false,
  parentColumn = true,
  selected = false,
}: {
  ticket: Ticket;
  rpc: Rpc;
  onOpen: Open;
  onChanged: () => void;
  /** 1 for a subtask shown under its parent in the same list. */
  depth?: number;
  parent?: IssueNode | null;
  /** The parent is the ancestor that put this ticket on a board. */
  via?: boolean;
  /** The heading already names the status: show the ring alone. */
  compactStatus?: boolean;
  /** Keep a parent column on wide lists; off when no row in the group names a parent. */
  parentColumn?: boolean;
  selected?: boolean;
}) {
  const { pill, panel } = useStatusChanger(rpc, t, onChanged, compactStatus);
  const type = typeOf(t.type, t.level);
  return (
    <li data-key={t.key}>
      <div
        className={cn(
          "group relative grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 transition-colors duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] hover:bg-muted/60",
          compactStatus
            ? parentColumn
              ? "@4xl/list:grid-cols-[1rem_5.5rem_minmax(0,1fr)_minmax(0,14rem)_2.75rem_5.5rem_4.5rem_3.25rem]"
              : "@4xl/list:grid-cols-[1rem_5.5rem_minmax(0,1fr)_2.75rem_5.5rem_4.5rem_3.25rem]"
            : parentColumn
              ? "@4xl/list:grid-cols-[1rem_5.5rem_minmax(0,1fr)_minmax(0,14rem)_10rem_5.5rem_4.5rem_3.25rem]"
              : "@4xl/list:grid-cols-[1rem_5.5rem_minmax(0,1fr)_10rem_5.5rem_4.5rem_3.25rem]",
          selected && "bg-muted/60 ring-1 ring-inset ring-primary/40",
        )}
      >
        <button
          type="button"
          onClick={() => onOpen(t.key)}
          aria-label={`Open ${t.key}: ${t.summary}`}
          className="absolute inset-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
        <span className="pointer-events-none self-start pt-0.5 @4xl/list:self-center" title={t.type}>
          <Icon name={type.icon} className={cn("size-4", type.text)} aria-hidden />
          <span className="sr-only">{t.type}</span>
        </span>
        <span className="pointer-events-none hidden font-mono text-xs text-muted-foreground @4xl/list:block">{t.key}</span>
        <span className="pointer-events-none line-clamp-2 min-w-0 text-sm font-medium leading-snug @4xl/list:line-clamp-1">
          {depth > 0 ? (
            <span className="mr-1.5 text-muted-foreground" aria-hidden>
              ↳
            </span>
          ) : null}
          {t.summary}
        </span>
        <div className="pointer-events-none col-span-2 col-start-2 row-start-2 flex min-w-0 items-center gap-x-3 text-xs text-muted-foreground @4xl/list:contents">
          <span className="shrink-0 font-mono @4xl/list:hidden">{t.key}</span>
          <span className={cn("min-w-0 flex-1 truncate", !parentColumn && "@4xl/list:hidden")}>{parent ? <ParentLink node={parent} via={via} onOpen={onOpen} /> : null}</span>
          <span className="flex shrink-0 items-center">{pill}</span>
          <span className="flex shrink-0 items-center">
            <PriorityCue priority={t.priority} />
          </span>
          <span className="shrink-0 whitespace-nowrap tabular-nums @4xl/list:text-right" title={`Updated ${new Date(t.updated).toLocaleString()}`}>
            {age(t.updated)}
          </span>
        </div>
        <span className="pointer-events-auto relative col-start-3 row-start-1 flex items-center justify-end opacity-0 transition-opacity duration-[120ms] group-hover:opacity-100 group-focus-within:opacity-100 @4xl/list:col-start-auto @4xl/list:row-start-auto">
          <UrlLink
            href={t.url}
            aria-label={`Open ${t.key} in Jira`}
            className="rounded-full p-1.5 text-muted-foreground transition-colors duration-[120ms] hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon name="ExternalLink" className="size-3.5" />
          </UrlLink>
          <Icon
            name="ChevronRight"
            className="pointer-events-none size-4 text-muted-foreground transition-transform duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] motion-safe:group-hover:translate-x-0.5"
            aria-hidden
          />
        </span>
      </div>
      {panel ? <div className="px-4 pb-3">{panel}</div> : null}
    </li>
  );
}

/** Rows in one quiet surface, separated by hairlines. */
export const ROWS = "divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-card";

/** A group: a plain heading (it collapses the group) over its rows and/or nested groups. Colour lives in the heading's glyph. */
export function Section({
  header,
  count,
  nested = false,
  collapsed,
  onToggle,
  children,
}: {
  header: ReactNode;
  count: number;
  nested?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className={cn("space-y-2", nested && "pl-4")}>
      <div className={cn("relative flex min-w-0 items-center gap-2 px-1 py-0.5", nested ? "text-[13px] font-medium" : "text-sm font-semibold")}>
        {/* The heading toggles the group; links in it sit above and still open their issue or board. */}
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand group" : "Collapse group"}
          onClick={onToggle}
          className="absolute inset-0 cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Icon
          name="ChevronRight"
          className={cn(
            "pointer-events-none size-4 shrink-0 text-muted-foreground transition-transform duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none",
            !collapsed && "rotate-90",
          )}
          aria-hidden
        />
        <span className="flex min-w-0 items-center gap-2">{header}</span>
        <span className="pointer-events-none shrink-0 font-normal tabular-nums text-muted-foreground">{count}</span>
      </div>
      {collapsed ? null : <div className={ENTER}>{children}</div>}
    </section>
  );
}
