---
title: Status page
description: The public status page at /status and its JSON: the components, how their statuses are derived, posting incidents, and why it needs an external uptime monitor beside it.
---

Every Diffinery instance has a public status page at `/status`, like GitHub's githubstatus.com. It says whether each part of the instance works, what the site administrators are doing about an incident in progress, and what went wrong in the last 14 days. Anyone can open it without signing in, and it is linked as **Status** at the bottom of every page. The same information is available as JSON for monitors and scripts.

The page is served by the instance itself, so it can't report that the whole instance is down. See [Monitoring from outside](#monitoring-from-outside).

## What the page shows

From the top:

1. **The overall status**: a banner with the worst status of any component, such as "All systems operational" or "Partial outage".
2. **Active incidents**: each unresolved incident with its title, impact, the components it affects and its updates, newest first.
3. **Components**: each component with its status, and a note when something other than an incident set it.
4. **Past incidents**: incidents resolved in the last 14 days, with all their updates.

Updates are plain text: Markdown and HTML show as written.

## Components

| Id | Name | What it covers |
| --- | --- | --- |
| `web` | Website and API | The web UI, the REST API and the MCP server |
| `git` | Git operations | Clone, fetch and push over HTTPS, and Git LFS |
| `actions` | Actions | Workflow runs and jobs on hosted and self-hosted runners |
| `agents` | Agents and sandboxes | Agent tasks, reviews, web terminals and sandboxes |
| `packages` | Packages | The container registry |
| `email` | Email | Notification and security emails |

## How statuses are derived

A component's status uses the names of Atlassian Statuspage, which GitHub's status page uses too. It is the worst of:

- the impact of each unresolved incident that names the component:

  | Incident impact | Component status |
  | --- | --- |
  | `critical` | `major_outage` (**Major outage**) |
  | `major` | `partial_outage` (**Partial outage**) |
  | `minor` | `degraded_performance` (**Degraded performance**) |
  | `maintenance` | `under_maintenance` (**Under maintenance**) |

- the instance-wide [kill switches](/docs/admin/site-administration#kill-switches): while hosted compute is paused, **Actions** and **Agents and sandboxes** are `under_maintenance`, with the notes "Hosted jobs are paused by the site administrators. Jobs on self-hosted runners still run." and "Agent sandboxes are paused by the site administrators." The pause's reason isn't shown. An incident with a worse impact wins, and the note stays.

With neither, a component is `operational`. From best to worst: operational, under maintenance, degraded performance, partial outage, major outage. An incident counts from when it is opened until it is resolved, whatever its state (investigating, identified or monitoring) in between.

The overall status follows the worst component:

| Worst component | `indicator` | Description |
| --- | --- | --- |
| `operational` | `none` | All systems operational |
| `under_maintenance` | `maintenance` | Service under maintenance |
| `degraded_performance` | `minor` | Degraded performance |
| `partial_outage` | `major` | Partial outage |
| `major_outage` | `critical` | Major outage |

When the page can't read the D1 database, it still answers: **Website and API** shows as a major outage with the note "This instance can't read its database right now, so most pages and API calls fail, and incidents can't be shown." and no incidents are listed.

## Posting incidents

Site administrators manage incidents under **Settings → Status** (`/settings/admin/status`).

To open an incident, fill in **Open an incident** and click **Open the incident**:

- **Title**: one line, up to 200 characters.
- **Impact**: minor, major, critical or maintenance (see the table above).
- **Affected components**: at least one.
- **State**: investigating, identified or monitoring.
- **First update**: what is happening, up to 5,000 characters of plain text.

The incident is on the status page at once. Under **Open incidents**, each incident has a form to post an update: pick its new state, write the update and click **Post the update**. Choose **Resolved** to resolve it: its components go back to operational (unless something else affects them) and it moves to past incidents for 14 days. Posting an update with another state to a resolved incident reopens it.

Opening, updating and resolving are recorded in the [audit log](/docs/security/audit-log) as `status_incident.create`, `status_incident.update` and `status_incident.resolve`, without the text of the updates. Everything typed into an incident is public: don't put internal details or people's data in it.

Diffinery doesn't open incidents by itself, except for the kill switch and database signals above, and it doesn't email anyone about them.

## JSON

`GET /api/v3/diffinery/status` needs no authentication and is shaped like Statuspage's summary. Shared caches may keep it for 30 seconds (`cache-control: public, max-age=30`).

```json
{
  "status": { "indicator": "major", "description": "Partial outage" },
  "components": [
    { "id": "web", "name": "Website and API", "status": "operational" },
    { "id": "git", "name": "Git operations", "status": "partial_outage" },
    { "id": "actions", "name": "Actions", "status": "under_maintenance", "note": "Hosted jobs are paused by the site administrators. Jobs on self-hosted runners still run." }
  ],
  "incidents": [
    {
      "id": "4f1c...",
      "title": "Pushes are failing",
      "impact": "major",
      "state": "identified",
      "components": ["git"],
      "created_at": "2026-10-14T09:12:00.000Z",
      "updated_at": "2026-10-14T09:40:00.000Z",
      "resolved_at": null,
      "updates": [
        { "id": "9a0b...", "state": "identified", "body": "We found the cause and are rolling out a fix.", "created_at": "2026-10-14T09:40:00.000Z" },
        { "id": "77de...", "state": "investigating", "body": "We are investigating failed pushes.", "created_at": "2026-10-14T09:12:00.000Z" }
      ],
      "html_url": "https://diffinery.com/status#incident-4f1c..."
    }
  ],
  "updated_at": "2026-10-14T09:41:05.120Z"
}
```

(The example lists three of the six components.) `incidents` holds only unresolved incidents; `updated_at` is when the summary was made.

Site administrators manage incidents through the API too. To anyone else these endpoints answer `404`, as if they didn't exist.

| Method and path | Description | Needs |
| --- | --- | --- |
| `GET /api/v3/diffinery/admin/status/incidents` | Incidents, newest first, resolved or not, as in the summary plus `created_by` and each update's `author`. Takes `per_page` (default 50, up to 200). | site administrator, a `read` token not limited to repositories, or a browser session |
| `POST /api/v3/diffinery/admin/status/incidents` | `{"title": "...", "impact": "major", "components": ["git"], "state": "investigating", "body": "..."}`: opens an incident with its first update. Answers `201` with the incident. | site administrator, with an `admin` token not limited to repositories, or a browser session |
| `POST /api/v3/diffinery/admin/status/incidents/{id}/updates` | `{"state": "resolved", "body": "..."}`: posts an update and moves the incident to its state. Answers `201` with the incident. | site administrator, with an `admin` token not limited to repositories, or a browser session |

What is missing or unknown is refused with `422` and a sentence saying what to fix, such as "Choose at least one affected component."

```sh
curl https://diffinery.com/api/v3/diffinery/status
echo '{"title": "Pushes are failing", "impact": "major", "components": ["git"], "state": "investigating", "body": "We are investigating failed pushes."}' | diffinery api POST /diffinery/admin/status/incidents --input -
echo '{"state": "resolved", "body": "Pushes work again."}' | diffinery api POST /diffinery/admin/status/incidents/<id>/updates --input -
```

## Monitoring from outside

The status page runs in the same Worker as everything else. When the whole Worker is down, because of a bad deploy, a Cloudflare incident or an exceeded plan limit, `/status` is down too and can't tell anyone. Watch the instance from outside as well:

- Point an external uptime monitor (any service that checks a URL every minute or so) at `https://<your host>/healthz`, which answers `{"ok": true}` without touching the database, and alert yourself when it fails.
- Optionally also watch `/api/v3/diffinery/status` and alert when `status.indicator` isn't `none`, to hear about incidents and kill switches. A database failure shows there as a `critical` indicator while `/healthz` still answers.

Tell people where to look when the instance doesn't answer at all, for example a status page hosted elsewhere or a chat channel.
