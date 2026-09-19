import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";

const execFileAsync = promisify(execFile);
const servers = new Map();

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
}

function excerpt(body, length = 260) {
    const text = String(body ?? "").replace(/\s+/g, " ").trim();
    return text.length > length ? `${text.slice(0, length - 1)}…` : text || "No description provided.";
}

function ageInDays(updatedAt) {
    return Math.max(0, (Date.now() - new Date(updatedAt).getTime()) / 86_400_000);
}

function issueScore(issue) {
    const labels = issue.labels.map((label) => label.name.toLowerCase());
    const priority = labels.some((label) => /critical|urgent|blocker|p0|p1|high/.test(label)) ? 45 : 0;
    const risk = labels.some((label) => /bug|security|incident|regression/.test(label)) ? 30 : 0;
    return priority + risk + Math.min(issue.comments * 2, 16) + Math.max(0, 20 - ageInDays(issue.updated_at));
}

function attentionReason(issue) {
    const labels = issue.labels.map((label) => label.name);
    const reasons = [];
    if (labels.some((label) => /critical|urgent|blocker|p0|p1|high/i.test(label))) reasons.push("priority label");
    if (labels.some((label) => /bug|security|incident|regression/i.test(label))) reasons.push("risk-related label");
    if (issue.comments > 0) reasons.push(`${issue.comments} comment${issue.comments === 1 ? "" : "s"}`);
    if (ageInDays(issue.updated_at) < 2) reasons.push("recent activity");
    return reasons.length ? `Ranked highly due to ${reasons.join(", ")}.` : "Ranked highly because it is among the most recently active open issues.";
}

async function githubIssues() {
    const { stdout } = await execFileAsync("gh", [
        "issue", "list", "--state", "open", "--limit", "100",
        "--json", "number,title,body,url,labels,comments,updatedAt",
    ], { cwd: process.cwd(), maxBuffer: 2_000_000 });
    return JSON.parse(stdout)
        .map((issue) => ({
            ...issue,
            updated_at: issue.updatedAt,
            labels: issue.labels ?? [],
            comments: issue.comments ?? 0,
        }))
        .map((issue) => ({ ...issue, score: issueScore(issue) }))
        .sort((left, right) => right.score - left.score || left.number - right.number);
}

function issueCard(issue, featured) {
    const labels = issue.labels.map((label) => `<span class="label">${escapeHtml(label.name)}</span>`).join("");
    return `<article class="card${featured ? " featured" : ""}">
      <div class="card-heading"><span class="issue-number">#${issue.number}</span><span class="updated">Updated ${escapeHtml(new Date(issue.updated_at).toLocaleDateString())}</span></div>
      <h3><a href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer">${escapeHtml(issue.title)}</a></h3>
      <p class="description">${escapeHtml(excerpt(issue.body))}</p>
      <div class="labels">${labels || '<span class="muted">No labels</span>'}</div>
      ${featured ? `<p class="reason"><strong>Why now:</strong> ${escapeHtml(attentionReason(issue))}</p>` : ""}
      <button type="button" class="context-button" data-issue="${issue.number}" data-testid="add-issue-${issue.number}">Add to current context</button>
    </article>`;
}

function renderHtml(issues) {
    const featured = issues.slice(0, 3);
    const remaining = issues.slice(3);
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Issue triage board</title>
    <style>
      :root { --surface: color-mix(in srgb, var(--background-color-default, #fff) 94%, var(--text-color-default, #1f2328) 6%); --strong: color-mix(in srgb, var(--background-color-default, #fff) 87%, var(--text-color-default, #1f2328) 13%); }
      * { box-sizing: border-box; }
      body { margin: 0; background: var(--background-color-default, #fff); color: var(--text-color-default, #1f2328); font: var(--text-body-medium, 14px)/var(--leading-body-medium, 20px) var(--font-sans, system-ui, sans-serif); }
      main { max-width: 1200px; margin: auto; padding: clamp(16px, 3vw, 32px); }
      header { border-bottom: 1px solid var(--border-color-default, #d0d7de); margin-bottom: 24px; padding-bottom: 20px; }
      h1 { font-size: clamp(26px, 4vw, 38px); line-height: 1.1; margin: 0; }
      header p { color: var(--text-color-muted, #59636e); margin: 8px 0 0; max-width: 70ch; }
      section { margin-top: 28px; }
      .section-heading { align-items: baseline; display: flex; gap: 10px; justify-content: space-between; margin-bottom: 12px; }
      h2 { font-size: 18px; margin: 0; }
      .count, .muted, .updated { color: var(--text-color-muted, #59636e); font-size: 12px; }
      .board { display: grid; gap: 14px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .remaining { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); }
      .card { background: var(--surface); border: 1px solid var(--border-color-default, #d0d7de); border-radius: 10px; display: flex; flex-direction: column; min-width: 0; padding: 16px; }
      .card.featured { border-color: color-mix(in srgb, var(--true-color-blue, #0969da) 55%, var(--border-color-default, #d0d7de)); box-shadow: 0 8px 22px color-mix(in srgb, var(--true-color-blue, #0969da) 12%, transparent); }
      .card-heading { align-items: center; display: flex; justify-content: space-between; }
      .issue-number { color: var(--true-color-blue, #0969da); font-weight: 600; }
      h3 { font-size: 16px; line-height: 1.35; margin: 10px 0 6px; }
      h3 a { color: inherit; text-decoration: none; }
      h3 a:hover { text-decoration: underline; }
      .description { color: var(--text-color-muted, #59636e); margin: 0 0 12px; }
      .labels { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 12px; }
      .label { background: var(--true-color-blue-muted, #ddf4ff); border-radius: 999px; color: var(--true-color-blue, #0969da); font-size: 11px; padding: 2px 8px; }
      .reason { background: var(--strong); border-left: 3px solid var(--true-color-blue, #0969da); margin: 0 0 14px; padding: 8px 10px; }
      button { appearance: none; background: var(--true-color-blue, #0969da); border: 1px solid var(--true-color-blue, #0969da); border-radius: 7px; color: var(--color-white, #fff); cursor: pointer; font: inherit; font-weight: 600; margin-top: auto; min-height: 34px; padding: 6px 10px; }
      button:hover:not(:disabled) { filter: brightness(.9); }
      button:disabled { cursor: wait; opacity: .65; }
      button:focus-visible { outline: 2px solid var(--color-focus-outline, #0969da); outline-offset: 2px; }
      #status { color: var(--text-color-muted, #59636e); min-height: 20px; }
      .empty { border: 1px dashed var(--border-color-default, #d0d7de); border-radius: 10px; color: var(--text-color-muted, #59636e); padding: 16px; }
      @media (max-width: 800px) { .board { grid-template-columns: 1fr; } }
      @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
    </style>
  </head>
  <body>
    <main>
      <header><h1>Issue triage board</h1><p>Three issues most likely to need attention now, followed by the remaining open issues. Use a card button to bring an issue into this session.</p></header>
      <div id="status" role="status" aria-live="polite"></div>
      <section aria-labelledby="priority-heading">
        <div class="section-heading"><h2 id="priority-heading">Needs attention now</h2><span class="count">${featured.length} issue${featured.length === 1 ? "" : "s"}</span></div>
        ${featured.length ? `<div class="board">${featured.map((issue) => issueCard(issue, true)).join("")}</div>` : '<div class="empty">No open issues found.</div>'}
      </section>
      <section aria-labelledby="remaining-heading">
        <div class="section-heading"><h2 id="remaining-heading">Remaining open issues</h2><span class="count">${remaining.length} issue${remaining.length === 1 ? "" : "s"}</span></div>
        ${remaining.length ? `<div class="remaining">${remaining.map((issue) => issueCard(issue, false)).join("")}</div>` : '<div class="empty">There are no additional open issues.</div>'}
      </section>
    </main>
    <script>
      const status = document.querySelector("#status");
      document.querySelectorAll(".context-button").forEach((button) => button.addEventListener("click", async () => {
        button.disabled = true;
        status.textContent = "Adding issue to the current context...";
        try {
          const response = await fetch("/api/context", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ number: Number(button.dataset.issue) }) });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Could not add the issue.");
          status.textContent = data.message;
        } catch (error) {
          status.textContent = error.message;
          button.disabled = false;
        }
      }));
    </script>
  </body>
</html>`;
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => resolve(body));
        request.on("error", reject);
    });
}

async function startServer(session) {
    const issues = await githubIssues();
    const server = createServer(async (request, response) => {
        try {
            if (request.method === "POST" && request.url === "/api/context") {
                const { number } = JSON.parse(await readBody(request));
                const issue = issues.find((candidate) => candidate.number === number);
                if (!issue) throw new Error("That issue is no longer in the open issue list. Reopen the board to refresh it.");
                await session.send({ prompt: `Add GitHub issue #${issue.number} to the current working context.\n\nTitle: ${issue.title}\nURL: ${issue.url}\nDescription: ${issue.body || "No description provided."}\n\nTriage note: ${attentionReason(issue)}` });
                response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                response.end(JSON.stringify({ message: `Issue #${issue.number} added to the current context.` }));
                return;
            }
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(renderHtml(issues));
        } catch (error) {
            response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : "The request failed." }));
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "issue-triage-board",
            displayName: "Issue triage board",
            description: "Prioritize open GitHub issues and add a selected issue to the current session context.",
            actions: [
                {
                    name: "refresh_issues",
                    description: "Fetch and rank the repository's open GitHub issues.",
                    handler: async () => {
                        const issues = await githubIssues();
                        return { total: issues.length, topIssues: issues.slice(0, 3).map(({ number, title, score }) => ({ number, title, score })) };
                    },
                },
                {
                    name: "add_issue_to_context",
                    description: "Add an open GitHub issue to the current session context.",
                    inputSchema: {
                        type: "object",
                        properties: { number: { type: "integer", minimum: 1 } },
                        required: ["number"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const issue = (await githubIssues()).find((candidate) => candidate.number === ctx.input?.number);
                        if (!issue) throw new Error("Open issue not found.");
                        await session.send({ prompt: `Add GitHub issue #${issue.number} to the current working context.\n\nTitle: ${issue.title}\nURL: ${issue.url}\nDescription: ${issue.body || "No description provided."}` });
                        return { added: issue.number, title: issue.title };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startServer(session);
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Issue triage board", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve) => entry.server.close(() => resolve()));
                }
            },
        }),
    ],
});
