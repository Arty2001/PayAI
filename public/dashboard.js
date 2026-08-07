const $ = (sel) => document.querySelector(sel);

const walletInput = $("#wallet-input");
const connectBtn = $("#connect-btn");
const fundBtn = $("#fund-btn");
const simulateBtn = $("#simulate-btn");
const eventLog = $("#event-log");
const liveStatus = $("#sse-status");
const statusPill = $("#status-pill");

let walletId = localStorage.getItem("payai-wallet") ?? "";
let eventSource = null;
let pollTimer = null;
let walletMeta = { demoMode: true, x402Enabled: false };

if (walletId) walletInput.value = walletId;

function fmtUsd(n) {
  return `$${Number(n).toFixed(6)}`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

function setStatus(text, kind = "idle") {
  statusPill.textContent = text;
  statusPill.className = `pill ${kind}`;
}

function flashBalance() {
  const el = $("#balance-value");
  el.classList.remove("flash");
  // reflow so animation restarts
  void el.offsetWidth;
  el.classList.add("flash");
}

function renderWallet(w) {
  if (!w) return;
  const prev = $("#balance-value").textContent;
  const next = fmtUsd(w.balanceUsd ?? w.balanceMicroUsd / 1e6);
  $("#balance-value").textContent = next;
  $("#balance-sub").textContent = w.id;
  $("#requests-value").textContent = String(w.requestCount ?? 0);
  $("#spent-value").textContent = fmtUsd((w.totalSpentMicroUsd ?? 0) / 1e6);
  $("#topup-value").textContent = fmtUsd((w.totalTopUpMicroUsd ?? 0) / 1e6);
  if (prev !== "—" && prev !== next) flashBalance();
}

function prependLog(kind, text) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="time">${fmtTime(Date.now())}</span><span class="kind-${kind}">${text}</span>`;
  eventLog.prepend(li);
  while (eventLog.children.length > 80) eventLog.lastChild.remove();
}

async function fetchWallet(id) {
  const res = await fetch(`/api/wallet/${encodeURIComponent(id)}?_=${Date.now()}`);
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  walletMeta = data;
  renderWallet(data);
  fundBtn.disabled = !data.x402Enabled;
  simulateBtn.disabled = !data.demoMode;
  return data;
}

function handleLiveEvent(event) {
  // Apply wallet snapshot from the event immediately (no extra network hop)
  if (event.wallet && (!event.walletId || event.walletId === walletId?.toLowerCase())) {
    renderWallet(event.wallet);
  } else if (event.balanceMicroUsd != null && event.walletId === walletId?.toLowerCase()) {
    renderWallet({
      id: event.walletId,
      balanceMicroUsd: event.balanceMicroUsd,
      balanceUsd: event.balanceMicroUsd / 1e6,
      requestCount: Number($("#requests-value").textContent) || 0,
      totalSpentMicroUsd: 0,
      totalTopUpMicroUsd: 0,
    });
    // refresh full stats shortly
    fetchWallet(walletId).catch(() => {});
  }

  if (event.type === "snapshot" && event.wallet) {
    renderWallet(event.wallet);
    return;
  }
  if (event.type === "usage" && event.entry) {
    prependLog(
      "usage",
      `−${fmtUsd(event.entry.actualMicroUsd / 1e6)} · ${event.entry.provider} · ${event.entry.model ?? "model"}`,
    );
  } else if (event.type === "top_up") {
    prependLog("top_up", `+${fmtUsd(event.amountMicroUsd / 1e6)} credited`);
  } else if (event.type === "reserve") {
    prependLog("reserve", `hold −${fmtUsd(event.amountMicroUsd / 1e6)} (request started)`);
  } else if (event.type === "wallet_created") {
    prependLog("top_up", `wallet created · ${fmtUsd((event.wallet?.balanceMicroUsd ?? 0) / 1e6)} seed`);
  }
}

function startPolling(id) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    fetchWallet(id).catch(() => {});
  }, 800);
}

function connectSse(id) {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`/api/wallet/${encodeURIComponent(id)}/events`);
  liveStatus.textContent = "live";
  liveStatus.classList.add("live");

  eventSource.onopen = () => {
    liveStatus.textContent = "live";
    liveStatus.classList.add("live");
  };

  eventSource.onmessage = (ev) => {
    try {
      handleLiveEvent(JSON.parse(ev.data));
    } catch (err) {
      console.warn("bad live event", err);
    }
  };

  eventSource.onerror = () => {
    liveStatus.textContent = "polling…";
    liveStatus.classList.remove("live");
  };

  // Always poll as a reliable backup so balance always moves on screen
  startPolling(id);
}

async function trackWallet() {
  const id = walletInput.value.trim();
  if (!id) return;
  walletId = id;
  localStorage.setItem("payai-wallet", id);
  setStatus("tracking", "live");
  try {
    await fetchWallet(id);
    connectSse(id);
    prependLog("top_up", `tracking "${id}" — run: $env:PAYAI_WALLET='${id}'; npm run test:messages`);
  } catch (err) {
    setStatus("error", "error");
    prependLog("usage", err.message);
  }
}

async function topUpViaX402() {
  if (!walletId) return;
  setStatus("awaiting payment…");

  try {
    const { wrapFetchWithPayment, x402Client } = await import("https://esm.sh/@x402/fetch@2.21.0");
    const { ExactEvmScheme, toClientEvmSigner } = await import("https://esm.sh/@x402/evm@2.21.0/exact/client");

    if (!window.ethereum) {
      alert("Install MetaMask or use Simulate top-up for demo.");
      setStatus("no wallet provider", "error");
      return;
    }

    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const address = accounts[0];

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

    const payFetch = wrapFetchWithPayment(fetch, client);
    const res = await payFetch(`/api/wallet/${encodeURIComponent(walletId)}/fund`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PayAI-Wallet": walletId },
    });

    const body = await res.json();
    if (!res.ok) throw new Error(body.message ?? JSON.stringify(body));

    prependLog("top_up", `x402 settled · ${body.transaction?.slice(0, 14)}…`);
    await fetchWallet(walletId);
    setStatus("credited", "live");
  } catch (err) {
    console.error(err);
    setStatus("payment failed", "error");
    prependLog("usage", err.message);
  }
}

async function simulateTopUp() {
  if (!walletId) return;
  setStatus("simulating…");
  const res = await fetch(`/api/wallet/${encodeURIComponent(walletId)}/simulate-fund`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) {
    setStatus("denied", "error");
    prependLog("usage", body.message);
    return;
  }
  prependLog("top_up", `demo credit +${fmtUsd(body.creditedUsd)}`);
  await fetchWallet(walletId);
  setStatus("credited", "live");
}

connectBtn.addEventListener("click", trackWallet);
fundBtn.addEventListener("click", topUpViaX402);
simulateBtn.addEventListener("click", simulateTopUp);
walletInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") trackWallet();
});

if (walletId) trackWallet();
