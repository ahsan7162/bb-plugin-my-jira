// One issue in full: where it sits in the hierarchy, facts, description, children and comments.
// Beside the list on wide panes, on its own page on narrow ones.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import type { TicketDetail } from "./jira";
import {
  Empty,
  Lineage,
  PriorityMark,
  Problem,
  Ring,
  ROWS,
  Row,
  Tiles,
  TypeChip,
  ago,
  message,
  useStatusChanger,
  type Open,
  type Rpc,
} from "./parts";
import { catOf, nestSubtasks } from "./filters";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/** Details already read, so Previous / Next and coming back show at once while the fresh copy loads. */
export const detailCache = new Map<string, TicketDetail>();

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm">{children}</dd>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-2 px-1 text-sm font-semibold">
        {title}
        {count !== undefined ? <span className="rounded-full bg-muted px-2 text-xs font-medium tabular-nums text-muted-foreground">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** What an issue's children are called, by its own level. */
function childrenTitle(level: number): string {
  if (level >= 2) return "Epics and issues in this initiative";
  if (level === 1) return "Issues in this epic";
  return "Subtasks";
}

export interface Position {
  index: number;
  total: number;
}

function Loaded({ rpc, d, onOpen, onChanged }: { rpc: Rpc; d: TicketDetail; onOpen: Open; onChanged: () => void }) {
  const { pill, panel } = useStatusChanger(rpc, d, onChanged);
  return (
    <>
      <header className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
        {d.ancestors.length > 0 ? (
          <nav aria-label="Hierarchy" className="-ml-1.5 flex min-w-0 flex-wrap items-center text-xs text-muted-foreground">
            <Lineage nodes={d.ancestors} onOpen={onOpen} />
          </nav>
        ) : null}
        <div className="flex items-start gap-3">
          <TypeChip type={d.type} level={d.level} />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
              <span className="font-mono">{d.key}</span>
              <span>{d.type}</span>
              <span>{d.project}</span>
            </p>
            <h2 className="text-xl font-semibold leading-snug">{d.summary}</h2>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {pill}
          <PriorityMark priority={d.priority} />
          <UrlLink
            href={d.url}
            className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-1 text-muted-foreground transition-colors duration-[120ms] hover:bg-muted hover:text-foreground"
          >
            Open in Jira <Icon name="ExternalLink" className="size-3" aria-hidden />
          </UrlLink>
        </div>
        {panel}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border/70 pt-4 @lg:grid-cols-3">
          <Fact label="Status">
            <span className="inline-flex items-center gap-1.5">
              <Ring cat={catOf(d.category)} />
              {d.status}
            </span>
          </Fact>
          <Fact label="Priority">{d.priority ? <PriorityMark priority={d.priority} /> : "None"}</Fact>
          <Fact label="Assignee">{d.assignee ?? "Unassigned"}</Fact>
          <Fact label="Reporter">{d.reporter ?? "Unknown"}</Fact>
          <Fact label="Created">{ago(d.created)}</Fact>
          <Fact label="Updated">{ago(d.updated)}</Fact>
          {d.labels.length > 0 ? (
            <Fact label="Labels">
              <span className="flex flex-wrap gap-1">
                {d.labels.map((l) => (
                  <span key={l} className="rounded-full bg-muted px-2 text-xs">
                    {l}
                  </span>
                ))}
              </span>
            </Fact>
          ) : null}
        </dl>
      </header>

      <Section title="Description">
        {d.description ? (
          <div className="min-w-0 overflow-x-auto rounded-2xl border border-border/70 bg-card px-6 py-4 text-sm">
            <Markdown content={d.description} />
          </div>
        ) : (
          <Empty>No description.</Empty>
        )}
      </Section>

      {d.children.length > 0 || d.level >= 1 ? (
        <Section title={childrenTitle(d.level)} count={d.children.length}>
          {d.children.length === 0 ? (
            <Empty>Nothing under this {d.type.toLowerCase()} yet.</Empty>
          ) : (
            <ul className={ROWS}>
              {nestSubtasks(d.children).map(({ ticket, depth }) => (
                <Row key={ticket.key} ticket={ticket} rpc={rpc} depth={depth} onOpen={onOpen} onChanged={onChanged} />
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      <Section title="Comments" count={d.comments.length}>
        {d.comments.length === 0 ? (
          <Empty>No comments.</Empty>
        ) : (
          <ul className="space-y-2">
            {d.comments.map((c, i) => (
              <li key={i} className="rounded-2xl border border-border/70 bg-card px-6 py-4">
                <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="grid size-6 place-items-center rounded-full bg-muted text-[10px] font-semibold uppercase text-foreground">{c.author.slice(0, 2)}</span>
                  <span className="font-medium text-foreground">{c.author}</span>
                  <span>{ago(c.created)}</span>
                </div>
                <div className="min-w-0 overflow-x-auto text-sm">
                  <Markdown content={c.body} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

export function DetailView({
  rpc,
  issueKey,
  version,
  position,
  onPrev,
  onNext,
  onClose,
  onOpen,
  onChanged,
}: {
  rpc: Rpc;
  issueKey: string;
  /** Bumped when any status changes, so the open ticket re-reads. */
  version: number;
  position: Position | null;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onOpen: Open;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<TicketDetail | null>(detailCache.get(issueKey) ?? null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("ticket_detail", { key: issueKey }).then(
      (d) => {
        detailCache.set(issueKey, d);
        if (live) {
          setDetail(d);
          setError(null);
        }
      },
      (c: unknown) => live && setError(message(c)),
    );
    return () => {
      live = false;
    };
  }, [rpc, issueKey, version]);
  const parent = detail?.ancestors[0];

  return (
    <div data-pane className="space-y-6">
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="ghost" size="sm" className="-ml-2 rounded-full" onClick={onClose}>
          <Icon name="ChevronLeft" className="size-4" />
          <span className="@5xl:hidden">My Tickets</span>
          <span className="hidden @5xl:inline">Close</span>
        </Button>
        {parent ? (
          <Button variant="ghost" size="sm" className="rounded-full" onClick={() => onOpen(parent.key)}>
            Up to {parent.key}
          </Button>
        ) : null}
        <span className="ml-auto inline-flex items-center gap-1">
          {position ? (
            <span className="px-1 text-xs tabular-nums text-muted-foreground">
              {position.index + 1} of {position.total}
            </span>
          ) : null}
          <Button variant="outline" size="sm" className="rounded-full" disabled={!position || position.index === 0} onClick={onPrev}>
            <Icon name="ChevronLeft" className="size-4" /> Previous
          </Button>
          <Button variant="outline" size="sm" className="rounded-full" disabled={!position || position.index >= position.total - 1} onClick={onNext}>
            Next <Icon name="ChevronRight" className="size-4" />
          </Button>
        </span>
      </div>
      {error ? <Problem>{error}</Problem> : null}
      {detail ? <Loaded rpc={rpc} d={detail} onOpen={onOpen} onChanged={onChanged} /> : error ? null : <Tiles rows={4} />}
    </div>
  );
}
