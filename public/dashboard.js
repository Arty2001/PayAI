const $ = (sel) => document.querySelector(sel);

/** One tick = one paid call at the server's minimum billable charge. */
const TICK_USD = 0.005;
const CAPACITY = 24;

const el = {
  input: $("#wallet-input"),
  watch: $("#connect-btn"),
  lamp: $("#lamp"),
  railState: $("#rail-state"),
  railNetwork: $("#rail-network"),
  meter: $("#meter-panel"),
  meterTag: $("#meter-tag"),
  amount: $("#balance-value"),
  ticks: $("#ticks"),
  legend: $("#ticks-legend"),
  held: $("#held-value"),
  spent: $("#spent-value"),
  requests: $("#requests-value"),
  owner: $("#owner-value"),
  fund: $("#fund-btn"),
  simulate: $("#simulate-btn"),
  note: $("#controls-note"),
  frames: $("#frames"),
  wireTag: $("#wire-tag"),
  wireEmpty: $("#wire-empty"),
  curl: $("#curl-sample"),
  copy: $("#copy-btn"),
  origin: $("#foot-origin"),
};

let walletId = localStorage.getItem("payai-wallet") ?? "";
let source = null;
let poll = null;
let litCount = null; // previous tick count, so we can animate the one that burned

/**
 * Usage entries already drawn on the wire, by ledger entry id.
 *
 * The wire is fed from two places on purpose. SSE is instant but a proxy is
 * free to buffer it — Cloudflare does, and then the stream delivers nothing at
 * all. So every poll also backfills from the wallet snapshot's recentRequests,
 * and this set keeps the two sources from drawing the same call twice.
 */
const drawn = new Set();

const usd = (n) => `$${Number(n ?? 0).toFixed(6)}`;
const clock = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

/* ── Chrome ──────────────────────────────────────────────────── */

function setRail(text, state) {
  el.railState.textContent = text;
  el.lamp.dataset.state = state;
}

function sample(id) {
  return [
    `curl ${location.origin}/v1/messages \\`,
    `  -H 'content-type: application/json' \\`,
    `  -H 'x-payai-wallet: ${id || "my-agent"}' \\`,
    `  -d '{"model":"claude-haiku-4-5","max_tokens":64,`,
    `       "messages":[{"role":"user","content":"hello"}]}'`,
  ].join("\n");
}

/* ── The meter ───────────────────────────────────────────────── */

function buildTicks() {
  if (el.ticks.childElementCount === CAPACITY) return;
  el.ticks.replaceChildren(
    ...Array.from({ length: CAPACITY }, () => {
      const t = document.createElement("span");
      t.className = "tick";
      return t;
    }),
  );
}

function renderTicks(balanceUsd) {
  buildTicks();
  const affordable = Math.floor((balanceUsd + 1e-9) / TICK_USD);
  const lit = Math.max(0, Math.min(CAPACITY, affordable));
  const marks = el.ticks.children;

  for (let i = 0; i < CAPACITY; i += 1) {
    marks[i].dataset.lit = i < lit ? "1" : "0";
  }

  // Flash the mark that just went out, so spending is visible even if you
  // weren't watching the number.
  if (litCount !== null && lit < litCount) {
    for (let i = lit; i < Math.min(litCount, CAPACITY); i += 1) {
      const mark = marks[i];
      mark.dataset.spent = "1";
      setTimeout(() => delete mark.dataset.spent, 700);
    }
  }
  litCount = lit;

  const overflow = affordable > CAPACITY ? `${affordable} calls funded — showing ${CAPACITY}. ` : "";
  el.legend.textContent = affordable
    ? `${overflow}Each mark is one paid call at the $${TICK_USD.toFixed(3)} floor.`
    : `Out of credit. Each mark is one paid call at the $${TICK_USD.toFixed(3)} floor.`;
}

/** Draw one metered call. Ignores anything already on the wire. */
function drawUsage(entry) {
  if (!entry?.id || drawn.has(entry.id)) return false;
  drawn.add(entry.id);
  const tokens =
    entry.inputTokens != null ? `${entry.inputTokens} in / ${entry.outputTokens} out` : "usage metered";
  const cost = entry.actualMicroUsd != null ? entry.actualMicroUsd / 1e6 : entry.costUsd;
  addFrame("usage", "usage", `${tokens} · ${entry.model ?? "model"}`, `−${usd(cost)}`);
  return true;
}

/**
 * Backfill the wire from a wallet snapshot. recentRequests arrives newest-first;
 * draw oldest-first so the wire reads chronologically once prepended.
 */
function backfill(w) {
  const recent = w?.recentRequests;
  if (!Array.isArray(recent) || recent.length === 0) return;
  for (let i = recent.length - 1; i >= 0; i -= 1) drawUsage(recent[i]);
}

function renderWallet(w) {
  if (!w) return;

  const balance = w.balanceUsd ?? (w.balanceMicroUsd ?? 0) / 1e6;
  el.amount.textContent = usd(balance);
  el.held.textContent = usd(w.heldUsd ?? (w.heldMicroUsd ?? 0) / 1e6);
  el.spent.textContent = usd((w.totalSpentMicroUsd ?? 0) / 1e6);
  el.requests.textContent = String(w.requestCount ?? 0);
  el.owner.textContent = w.ownerAddress
    ? `${w.ownerAddress.slice(0, 6)}…${w.ownerAddress.slice(-4)}`
    : "unclaimed";

  renderTicks(balance);

  const broke = balance < TICK_USD;
  el.meter.dataset.state = broke ? "charge" : "live";
  el.meterTag.textContent = broke ? "payment required" : w.id ?? walletId;
  setRail(broke ? "402 — payment required" : "watching", broke ? "charge" : "live");

  if (broke) {
    el.note.dataset.tone = "charge";
    el.note.textContent = "This wallet can't cover another call. Top up to keep going.";
  } else {
    delete el.note.dataset.tone;
    el.note.textContent = "";
  }

  backfill(w);
}

/* ── The wire ────────────────────────────────────────────────── */

function addFrame(kind, label, body, amount = "") {
  el.wireEmpty.hidden = true;
  el.wireTag.textContent = "live";

  const li = document.createElement("li");
  li.className = "frame";
  li.dataset.kind = kind;

  const time = document.createElement("span");
  time.className = "frame__time";
  time.textContent = clock(Date.now());

  const tag = document.createElement("span");
  tag.className = "frame__kind";
  tag.textContent = label;

  const text = document.createElement("span");
  text.className = "frame__body";
  if (amount) {
    const amt = document.createElement("span");
    amt.className = "frame__amount";
    amt.textContent = amount;
    text.append(amt, ` ${body}`);
  } else {
    text.textContent = body;
  }

  li.append(time, tag, text);
  el.frames.prepend(li);
  while (el.frames.childElementCount > 60) el.frames.lastElementChild.remove();
}

function onEvent(event) {
  const mine = !event.walletId || event.walletId === walletId.toLowerCase();
  if (!mine) return;

  if (event.wallet) renderWallet(event.wallet);

  switch (event.type) {
    case "usage":
      drawUsage(event.entry);
      break;
    case "reserve":
      addFrame("reserve", "hold", "reserved for a request in flight", `−${usd(event.amountMicroUsd / 1e6)}`);
      break;
    case "release":
      addFrame("release", "refund", `hold released — ${event.reason ?? "request failed"}`, `+${usd(event.amountMicroUsd / 1e6)}`);
      break;
    case "top_up":
      addFrame("top_up", "credit", event.tx ? `settled ${String(event.tx).slice(0, 14)}…` : "credited", `+${usd(event.amountMicroUsd / 1e6)}`);
      break;
    case "wallet_created":
      addFrame("top_up", "open", event.faucet ? "wallet opened with faucet credit" : "wallet opened", event.amountMicroUsd ? `+${usd(event.amountMicroUsd / 1e6)}` : "");
      break;
  }
}

/* ── Transport ───────────────────────────────────────────────── */

async function fetchWallet(id) {
  const res = await fetch(`/api/wallet/${encodeURIComponent(id)}?_=${Date.now()}`);
  if (!res.ok) throw new Error(`wallet lookup failed (${res.status})`);
  const data = await res.json();
  renderWallet(data);
  el.fund.disabled = !data.x402Enabled;
  el.simulate.disabled = !data.demoMode;
  return data;
}

function connect(id) {
  if (source) source.close();
  source = new EventSource(`/api/wallet/${encodeURIComponent(id)}/events`);
  source.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data));
    } catch {
      /* ignore malformed frame */
    }
  };
  source.onerror = () => {
    el.wireTag.textContent = "reconnecting";
  };

  // Poll alongside the stream so the number keeps moving even if a proxy
  // buffers SSE.
  if (poll) clearInterval(poll);
  poll = setInterval(() => fetchWallet(id).catch(() => {}), 1500);
}

async function watch() {
  const id = el.input.value.trim();
  if (!id) {
    el.input.focus();
    return;
  }
  walletId = id;
  localStorage.setItem("payai-wallet", id);
  el.curl.textContent = sample(id);
  litCount = null;
  drawn.clear();
  el.frames.replaceChildren();

  try {
    const data = await fetchWallet(id);
    connect(id);
    if (!data.exists) {
      el.meterTag.textContent = "not opened yet";
      el.wireTag.textContent = "waiting";
      setRail("waiting for first call", "live");
    }
  } catch (err) {
    setRail("unreachable", "charge");
    el.note.dataset.tone = "charge";
    el.note.textContent = err.message;
  }
}

/* ── Actions ─────────────────────────────────────────────────── */

async function topUp() {
  if (!walletId) return;
  el.note.textContent = "Waiting for signature…";
  delete el.note.dataset.tone;

  try {
    if (!window.ethereum) {
      throw new Error("No browser wallet found. Use demo credit, or install one to pay with USDC.");
    }

    const { wrapFetchWithPayment, x402Client } = await import("https://esm.sh/@x402/fetch@2.21.0");
    const { ExactEvmScheme, toClientEvmSigner } = await import("https://esm.sh/@x402/evm@2.21.0/exact/client");

    const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
    const client = new x402Client().register(
      "eip155:84532",
      new ExactEvmScheme(
        toClientEvmSigner({
          address,
          signTypedData: (params) =>
            window.ethereum.request({
              method: "eth_signTypedData_v4",
              params: [address, JSON.stringify(params)],
            }),
        }),
      ),
    );

    const res = await wrapFetchWithPayment(fetch, client)(
      `/api/wallet/${encodeURIComponent(walletId)}/fund`,
      { method: "POST", headers: { "content-type": "application/json", "x-payai-wallet": walletId } },
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.message ?? "Payment failed");

    el.note.textContent = "Settled onchain.";
    await fetchWallet(walletId);
  } catch (err) {
    el.note.dataset.tone = "charge";
    el.note.textContent = err.message;
  }
}

async function demoCredit() {
  if (!walletId) return;
  const res = await fetch(`/api/wallet/${encodeURIComponent(walletId)}/simulate-fund`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    el.note.dataset.tone = "charge";
    el.note.textContent = body.message ?? "Demo credit unavailable.";
    return;
  }
  delete el.note.dataset.tone;
  el.note.textContent = `Added $${Number(body.creditedUsd).toFixed(2)}.`;
  await fetchWallet(walletId);
}

/* ── Boot ────────────────────────────────────────────────────── */

el.watch.addEventListener("click", watch);
el.input.addEventListener("keydown", (e) => e.key === "Enter" && watch());
el.fund.addEventListener("click", topUp);
el.simulate.addEventListener("click", demoCredit);
el.copy.addEventListener("click", async () => {
  await navigator.clipboard.writeText(el.curl.textContent);
  el.copy.textContent = "Copied";
  setTimeout(() => (el.copy.textContent = "Copy"), 1400);
});

buildTicks();
el.curl.textContent = sample(walletId);
el.origin.textContent = location.host;
if (walletId) el.input.value = walletId;

fetch("/health")
  .then((r) => r.json())
  .then((h) => {
    el.railNetwork.textContent = h.x402?.ready
      ? "x402 · base sepolia"
      : h.x402?.configured
        ? "x402 degraded"
        : "x402 · demo mode";
  })
  .catch(() => {});

if (walletId) watch();
