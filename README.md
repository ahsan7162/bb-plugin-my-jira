# Jira Board for bb

The Jira tickets assigned to you, in a calm list you can filter, group and work through without
leaving [bb](https://getbb.app).



https://github.com/user-attachments/assets/8cf74bd1-b91e-4c04-9c8e-295c257c0519



```
bb plugin install git:https://github.com/ahsan7162/bb-plugin-my-jira.git@^0.5.0
```

Or install **Jira Board** from bb's plugin store. Click **Connect Jira** and sign in with Atlassian
in the browser; there is nothing to configure. See [Requirements](#requirements).

<img width="3200" height="2000" alt="01-list" src="https://github.com/user-attachments/assets/1a6a1c2f-abd9-4249-8b72-0194961073e6" />

<img width="3200" height="2000" alt="02-ticket" src="https://github.com/user-attachments/assets/c47964a4-064a-4071-a727-92e1997c34fb" />

<img width="3200" height="2000" alt="03-status" src="https://github.com/user-attachments/assets/f8db226a-9d11-42c3-a433-6f825a585419" />

<img width="3200" height="2000" alt="04-assign" src="https://github.com/user-attachments/assets/89750bd1-023e-4c0b-8588-bd571729ce37" />

<img width="3200" height="2000" alt="05-hierarchy" src="https://github.com/user-attachments/assets/215d47c5-228e-4a96-a8d1-402f6af4a68d" />

<img width="3200" height="2000" alt="06-board" src="https://github.com/user-attachments/assets/679c8d22-27c9-45a0-b9c8-15bc11ad2398" />





## What you get

- **Your tickets in one tab.** A **My Tickets** page in the bb rail with **Open** and **Done**,
  50 per page, one row per ticket: type, key, title, epic, status, priority and age.
- **Filters beside the tabs.** Status chips (the busiest three inline, the rest in a menu) and a
  **Type** menu. Pick several; statuses and types combine. Search by key, words or epic; type a
  key that isn't in the list to open it anyway.
- **Group by** status, initiative then epic, epic, or board. Board grouping finds which of your
  boards list each ticket; a ticket no board lists inherits its parent's board ("via …").
- **Open a ticket beside the list.** Its lineage, facts, description, children and comments, with
  Previous / Next through the list and Up to its parent. Narrow panes give it its own page.
- **Change statuses in place.** Click a status to see the moves your workflow allows.
- **Assign or reassign.** In an open ticket, click the assignee to search the people Jira lets you
  assign it to, or unassign it.
- **Create in Jira.** **Create ticket** opens your Jira boards in the browser.
- **Move by keyboard.** J / K to move, Enter to open, [ and ] for previous / next, U for the
  parent, S to change status, / to search, ? for the list.
- **Any Jira Cloud site.** If your account grants several, the site name becomes a menu to switch.

## Requirements

- Jira Cloud. Jira Data Center and Server are not supported.
- Your organization must allow Atlassian's Rovo MCP server (it does if Claude or other AI tools
  can already reach your Jira).

## How it works

The plugin signs in through Atlassian's Rovo MCP server (`mcp.atlassian.com/v2/mcp`). Its OAuth
server supports dynamic client registration and PKCE, so each install registers itself on the
first **Connect Jira**: no app to create, no shared secret in the code. The refresh token is kept
in a secret plugin setting on the machine running bb; the access token only in memory. Requests go
from bb to Atlassian, and nowhere else. Disconnect removes the token.

To add another site later, Disconnect, then Connect again and grant both.

## Develop

```
npm install
bb plugin install .
bb plugin dev        # rebuild and reload on save
npm test && npm run typecheck
```

- `server.ts`: OAuth (`auth_start`, `/oauth/callback`, token refresh), site switching, and the
  RPCs for tickets, a ticket's detail, boards, status changes and assignment.
- `jira.ts`: pure helpers that read Atlassian's replies; `filters.ts`: the list's rules (filters,
  priorities, groupings). Both are covered by `jira.test.ts`.
- `app.tsx` (the list), `detail.tsx` (one ticket), `parts.tsx` (shared pieces; the design system
  is in `MASTER.md`).
- `repo.test.ts` keeps media and files over 1 MB out of every branch and tag, because bb clones
  the whole repository on install. Put README images in as GitHub attachments, never in git.

## License

MIT
