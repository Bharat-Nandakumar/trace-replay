import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";

export type Scenario =
  | "normal"
  | "slow_load"
  | "permission_denied"
  | "session_expired"
  | "unexpected_dialog";

type Member = {
  id: string;
  name: string;
  savingsAccount: string;
  savingsBalance: string;
};

type BankSession = {
  scenario: Scenario;
  searchedId?: string;
  slowLoadShown: boolean;
  dialogDismissed: boolean;
  expired: boolean;
  accountClosed: boolean;
};

const members: Record<string, Member> = {
  "10001": {
    id: "10001",
    name: "Avery Sample",
    savingsAccount: "SAV-4101",
    savingsBalance: "1250.75",
  },
  "10002": {
    id: "10002",
    name: "Jordan Sample",
    savingsAccount: "SAV-4102",
    savingsBalance: "842.10",
  },
};

const scenarios: Scenario[] = [
  "normal",
  "slow_load",
  "permission_denied",
  "session_expired",
  "unexpected_dialog",
];

const sessions = new Map<string, BankSession>();

export const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false }));
app.use("/assets", express.static(new URL("./public", import.meta.url).pathname));

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const escapes: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return escapes[character];
  });
}

function htmlPage(title: string, main: string, options?: { refresh?: string }): string {
  const refresh = options?.refresh
    ? `<meta http-equiv="refresh" content="2;url=${escapeHtml(options.refresh)}">`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${refresh}
    <title>${escapeHtml(title)} | Northstar Credit Union Operations</title>
    <link rel="stylesheet" href="/assets/bank.css">
  </head>
  <body>
    <header class="masthead">
      <div class="masthead-inner">
        <strong>Northstar Credit Union</strong>
        <span>Operations Console</span>
      </div>
    </header>
    <div class="shell">
      <nav class="side-nav" aria-label="Primary navigation">
        <div class="side-nav-title">SERVICING</div>
        <a href="/members/search">Member Search</a>
      </nav>
      <main class="content">${main}</main>
    </div>
  </body>
</html>`;
}

function sendPage(res: Response, title: string, main: string, options?: { refresh?: string }): void {
  res.type("html").send(htmlPage(title, main, options));
}

function cookieValue(req: Request, name: string): string | undefined {
  const cookie = req.headers.cookie?.split(";").map((part) => part.trim());
  const match = cookie?.find((part) => part.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function sessionFor(req: Request, res: Response): BankSession | undefined {
  const id = cookieValue(req, "bank_session");
  const session = id ? sessions.get(id) : undefined;
  if (!session) {
    res.redirect("/start");
    return undefined;
  }
  if (session.expired && req.path !== "/session-expired") {
    res.redirect("/session-expired");
    return undefined;
  }
  return session;
}

function memberFor(req: Request, res: Response): Member | undefined {
  const member = members[String(req.params.memberId)];
  if (!member) {
    sendPage(
      res,
      "Member not found",
      `<h1>Member not found</h1><p>The requested member record is unavailable.</p><p><a href="/members/search">Return to Member Search</a></p>`,
    );
    return undefined;
  }
  return member;
}

function searchPage(error?: string): string {
  return `<div class="breadcrumb">Servicing / Member Search</div>
    <h1>Member Search</h1>
    <p class="intro">Enter a five-digit member ID to locate a member record.</p>
    ${error ? `<div class="notice error" role="alert">${escapeHtml(error)}</div>` : ""}
    <section class="panel">
      <h2>Search criteria</h2>
      <form action="/members/search" method="post" class="search-form">
        <label for="member-id">Member ID</label>
        <input id="member-id" name="memberId" type="text" inputmode="numeric" autocomplete="off" maxlength="24">
        <button type="submit">Search</button>
      </form>
    </section>`;
}

function accountPath(member: Member): string {
  return `/members/${member.id}/accounts/savings`;
}

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/", (_req, res) => {
  res.redirect("/start");
});

app.get("/start", (req, res) => {
  const requested = String(req.query.scenario ?? "normal");
  if (!scenarios.includes(requested as Scenario)) {
    res.status(400).type("text").send("Unknown local demo scenario");
    return;
  }
  const sessionId = randomUUID();
  sessions.set(sessionId, {
    scenario: requested as Scenario,
    slowLoadShown: false,
    dialogDismissed: false,
    expired: false,
    accountClosed: false,
  });
  res.cookie("bank_session", sessionId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  res.redirect("/members/search");
});

app.get("/members/search", (req, res) => {
  if (!sessionFor(req, res)) return;
  sendPage(res, "Member Search", searchPage());
});

app.post("/members/search", (req, res) => {
  const session = sessionFor(req, res);
  if (!session) return;
  const memberId = typeof req.body.memberId === "string" ? req.body.memberId.trim() : "";
  if (!/^\d{5}$/.test(memberId)) {
    res.status(422);
    sendPage(res, "Member Search", searchPage("Enter a valid five-digit member ID."));
    return;
  }
  session.searchedId = memberId;
  session.slowLoadShown = false;
  res.redirect("/members/results");
});

app.get("/members/results", (req, res) => {
  const session = sessionFor(req, res);
  if (!session) return;
  if (!session.searchedId) {
    res.redirect("/members/search");
    return;
  }
  if (session.scenario === "slow_load" && !session.slowLoadShown) {
    session.slowLoadShown = true;
    sendPage(
      res,
      "Loading search results",
      `<div class="breadcrumb">Servicing / Member Search / Results</div>
       <h1>Search Results</h1>
       <div class="notice loading" role="status">Loading member records. Please wait…</div>`,
      { refresh: "/members/results" },
    );
    return;
  }
  const member = members[session.searchedId];
  if (!member) {
    sendPage(
      res,
      "Search Results",
      `<div class="breadcrumb">Servicing / Member Search / Results</div>
       <h1>Search Results</h1>
       <div class="notice info" role="status">No member found for that ID.</div>
       <p><a href="/members/search">Search again</a></p>`,
    );
    return;
  }
  sendPage(
    res,
    "Search Results",
    `<div class="breadcrumb">Servicing / Member Search / Results</div>
     <h1>Search Results</h1>
     <p class="intro">One member record matched your search.</p>
     <section class="panel table-panel">
       <table>
         <thead><tr><th>Member ID</th><th>Member Name</th><th>Record</th></tr></thead>
         <tbody><tr><td>${member.id}</td><td>${escapeHtml(member.name)}</td><td><a href="/members/${member.id}">Open member</a></td></tr></tbody>
       </table>
     </section>`,
  );
});

app.get("/members/:memberId", (req, res) => {
  if (!sessionFor(req, res)) return;
  const member = memberFor(req, res);
  if (!member) return;
  sendPage(
    res,
    "Member Details",
    `<div class="breadcrumb">Servicing / Members / ${member.id}</div>
     <h1>Member Details</h1>
     <section class="panel">
       <h2>Member profile</h2>
       <dl class="summary"><dt>Member ID</dt><dd>${member.id}</dd><dt>Member Name</dt><dd>${escapeHtml(member.name)}</dd></dl>
     </section>
     <section class="panel table-panel">
       <h2>Accounts</h2>
       <table>
         <thead><tr><th>Account</th><th>Type</th><th>Status</th><th>Details</th></tr></thead>
         <tbody><tr><td>${member.savingsAccount}</td><td>Savings</td><td>Open</td><td><a href="${accountPath(member)}">Open savings account</a></td></tr></tbody>
       </table>
     </section>`,
  );
});

app.get("/members/:memberId/accounts/savings", (req, res) => {
  const session = sessionFor(req, res);
  if (!session) return;
  const member = memberFor(req, res);
  if (!member) return;
  if (session.scenario === "session_expired") {
    session.expired = true;
    res.redirect("/session-expired");
    return;
  }
  if (session.scenario === "permission_denied") {
    res.status(403);
    sendPage(
      res,
      "Access Denied",
      `<div class="breadcrumb">Servicing / Members / ${member.id} / Savings</div>
       <h1>Access Denied</h1>
       <div class="notice error" role="alert">You do not have permission to view this savings account.</div>
       <p><a href="/members/${member.id}">Return to Member Details</a></p>`,
    );
    return;
  }
  if (session.scenario === "unexpected_dialog" && !session.dialogDismissed) {
    sendPage(
      res,
      "Account Notice",
      `<div class="breadcrumb">Servicing / Members / ${member.id} / Savings</div>
       <h1>Savings Account</h1>
       <div class="modal-backdrop">
         <section class="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
           <h2 id="dialog-title">Account notice</h2>
           <p>Manual review is required before this account can be displayed.</p>
           <form action="${accountPath(member)}/dismiss" method="post"><button type="submit">Dismiss notice</button></form>
         </section>
       </div>`,
    );
    return;
  }
  sendPage(
    res,
    "Savings Account",
    `<div class="breadcrumb">Servicing / Members / ${member.id} / Savings</div>
     <h1>Savings Account</h1>
     <p class="intro">Account ${member.savingsAccount} for ${escapeHtml(member.name)}</p>
     <section class="panel frame-panel">
       <iframe title="Savings account details" src="${accountPath(member)}/panel"></iframe>
     </section>
     <section class="panel danger-panel">
       <h2>Account actions</h2>
       <p>Closing an account changes its status. This action requires review.</p>
       <form action="${accountPath(member)}/close/review" method="post"><button type="submit" class="danger-button">Close Account</button></form>
     </section>`,
  );
});

app.get("/members/:memberId/accounts/savings/panel", (req, res) => {
  const session = sessionFor(req, res);
  if (!session) return;
  const member = memberFor(req, res);
  if (!member) return;
  if (session.scenario === "permission_denied" || (session.scenario === "unexpected_dialog" && !session.dialogDismissed)) {
    res.status(403).type("text").send("Account details unavailable");
    return;
  }
  res.type("html").send(`<!doctype html>
  <html lang="en"><head><meta charset="utf-8"><title>Account details</title><link rel="stylesheet" href="/assets/bank.css"></head>
  <body class="frame-body"><h2>Account Balance</h2>
    <table><tbody><tr><th scope="row">Account number</th><td>${member.savingsAccount}</td></tr>
    <tr><th scope="row">Current savings balance</th><td><strong class="balance">$${member.savingsBalance} USD</strong></td></tr>
    <tr><th scope="row">Account status</th><td>${session.accountClosed ? "Closed" : "Open"}</td></tr></tbody></table>
  </body></html>`);
});

app.post("/members/:memberId/accounts/savings/dismiss", (req, res) => {
  const session = sessionFor(req, res);
  if (!session) return;
  const member = memberFor(req, res);
  if (!member) return;
  session.dialogDismissed = true;
  res.redirect(accountPath(member));
});

app.post("/members/:memberId/accounts/savings/close/review", (req, res) => {
  if (!sessionFor(req, res)) return;
  const member = memberFor(req, res);
  if (!member) return;
  sendPage(
    res,
    "Review account closure",
    `<div class="breadcrumb">Servicing / Members / ${member.id} / Savings / Close</div>
     <h1>Review Account Closure</h1>
     <div class="notice warning" role="alert">This will close savings account ${member.savingsAccount} for ${escapeHtml(member.name)}.</div>
     <form action="${accountPath(member)}/close/confirm" method="post"><button type="submit" class="danger-button">Confirm Close Account</button></form>
     <p><a href="${accountPath(member)}">Cancel and return to account</a></p>`,
  );
});

app.post("/members/:memberId/accounts/savings/close/confirm", (req, res) => {
  const session = sessionFor(req, res);
  if (!session) return;
  const member = memberFor(req, res);
  if (!member) return;
  session.accountClosed = true;
  sendPage(
    res,
    "Account closed",
    `<h1>Account Closed</h1><div class="notice warning" role="status">Synthetic savings account ${member.savingsAccount} is now closed for this demo session.</div><p><a href="${accountPath(member)}">View account</a></p>`,
  );
});

app.get("/session-expired", (req, res) => {
  const sessionId = cookieValue(req, "bank_session");
  if (!sessionId || !sessions.has(sessionId)) {
    res.redirect("/start");
    return;
  }
  res.status(401);
  sendPage(
    res,
    "Session Expired",
    `<h1>Session Expired</h1><div class="notice error" role="alert">Your servicing session has expired.</div><p><a href="/start">Start a new synthetic session</a></p>`,
  );
});
