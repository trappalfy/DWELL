import { encodeClaim } from "/lib/abi.js";

const CHAIN_ID = 4663;
const CHAIN_ID_HEX = "0x1237";
const HEARTBEAT_MS = 10_000;
const REFRESH_MS = 30_000;

const els = {
  room: document.querySelector(".room"),
  connect: document.getElementById("connect"),
  claim: document.getElementById("claim"),
  status: document.getElementById("status"),
  mined: document.getElementById("mined"),
  miners: document.getElementById("miners"),
  minBalance: document.getElementById("min-balance")
};

const state = {
  config: null,
  account: null,
  token: null,
  me: null,
  tendedSince: null,
  notice: null
};

/* ---------- formatting ---------- */

/** Renders a wei-scale integer as a decimal string, without floating point. */
function formatUnits(value, decimals, places) {
  const digits = value.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).slice(0, places).padEnd(places, "0");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return places > 0 ? grouped + "." + fraction : grouped;
}

function shortDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return minutes + "m";
  return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}

/* ---------- api ---------- */

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(state.token ? { authorization: "Bearer " + state.token } : {}),
      ...options.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(body.error || "request failed"), { status: response.status });
  }
  return body;
}

/* ---------- wallet ---------- */

function wallet() {
  if (!window.ethereum) throw new Error("No wallet found. Install one to continue.");
  return window.ethereum;
}

function toHexMessage(text) {
  const bytes = new TextEncoder().encode(text);
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Claiming writes to one specific chain, so being on it is not optional. */
async function ensureChain() {
  const current = await wallet().request({ method: "eth_chainId" });
  if (Number.parseInt(current, 16) === CHAIN_ID) return;

  try {
    await wallet().request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }]
    });
  } catch (error) {
    // 4902 means the wallet has never heard of this chain.
    if (error && error.code !== 4902) throw error;
    await wallet().request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: CHAIN_ID_HEX,
          chainName: "Robinhood Chain",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
          blockExplorerUrls: ["https://robinhoodchain.blockscout.com"]
        }
      ]
    });
  }
}

async function connect() {
  const accounts = await wallet().request({ method: "eth_requestAccounts" });
  await ensureChain();
  state.account = accounts[0].toLowerCase();

  const challenge = await api("/v1/session/challenge", {
    method: "POST",
    body: JSON.stringify({ account: state.account })
  });

  const signature = await wallet().request({
    method: "personal_sign",
    params: [toHexMessage(challenge.message), state.account]
  });

  const session = await api("/v1/session/verify", {
    method: "POST",
    body: JSON.stringify({ challengeId: challenge.challengeId, signature })
  });

  state.token = session.sessionToken;
  state.tendedSince = Date.now();
}

async function claim() {
  if (!state.me || !state.me.proof || state.me.claimable === "0") return;

  els.claim.disabled = true;
  try {
    const data = encodeClaim(BigInt(state.me.cumulative), state.me.proof);
    await wallet().request({
      method: "eth_sendTransaction",
      params: [{ from: state.account, to: state.config.vault, data }]
    });
    state.notice = "Claimed. It will show as collected once the block lands.";
  } catch (error) {
    state.notice = (error && error.message) || "The claim did not go through.";
  } finally {
    els.claim.disabled = false;
    render();
  }
}

/* ---------- the loop ---------- */

const isVisible = () => document.visibilityState === "visible";

async function beat() {
  if (!state.token || !isVisible()) return;
  try {
    await api("/v1/heartbeat", { method: "POST", body: "{}" });
  } catch (error) {
    if (error.status === 401) {
      // The session lapsed. Mining never resumes on its own, by design.
      state.token = null;
      state.tendedSince = null;
      render();
    }
  }
}

async function refresh() {
  try {
    const stats = await api("/v1/stats");
    els.miners.textContent = String(stats.activeMiners);
  } catch {
    /* the counter is decoration; a failed poll must not disturb the page */
  }

  if (!state.account) return;
  try {
    state.me = await api("/v1/me?account=" + state.account);
  } catch {
    /* keep the last known figures rather than blanking them */
  }
  render();
}

/* ---------- the fire is the status ---------- */

function currentState() {
  if (!state.account) return "cold";
  if (state.me && !state.me.eligible) return "short";
  if (!state.token || !isVisible()) return "idle";
  return "burning";
}

function statusLine(mode) {
  if (state.notice) return state.notice;

  if (mode === "cold") return "The hearth is cold. Connect a wallet to light it.";

  if (mode === "short") {
    const need = formatUnits(BigInt(state.config.minBalance), 18, 0);
    const have = formatUnits(BigInt((state.me && state.me.balance) || "0"), 18, 0);
    return "Hold " + need + " $DWELL to light the hearth. You have " + have + ".";
  }

  if (mode === "idle") {
    return state.token
      ? "You stepped away. The fire is banked."
      : "The fire went out. Sign again to relight it.";
  }

  return "The hearth is burning. Tended " + shortDuration(Date.now() - state.tendedSince) + ".";
}

function render() {
  const mode = currentState();
  els.room.dataset.state = mode;
  els.status.textContent = statusLine(mode);

  if (state.me) {
    els.mined.textContent = formatUnits(BigInt(state.me.cumulative), 18, 4);
    const claimable = BigInt(state.me.claimable);
    els.claim.hidden = claimable === 0n;
    els.claim.textContent = "Claim " + formatUnits(claimable, 18, 4) + " TSLA";
  }

  els.connect.textContent = state.account
    ? state.token
      ? state.account.slice(0, 6) + "…" + state.account.slice(-4)
      : "Sign in again"
    : "Connect wallet";
}

/* ---------- start ---------- */

async function start() {
  state.config = await api("/v1/config");
  els.minBalance.textContent = formatUnits(BigInt(state.config.minBalance), 18, 0);

  els.connect.addEventListener("click", async () => {
    els.connect.disabled = true;
    state.notice = null;
    try {
      await connect();
      await refresh();
      await beat();
    } catch (error) {
      state.notice = (error && error.message) || "Could not connect.";
    } finally {
      els.connect.disabled = false;
      render();
    }
  });

  els.claim.addEventListener("click", claim);

  // A hidden tab must stop counting at once, not at the next tick.
  document.addEventListener("visibilitychange", () => {
    if (isVisible() && state.token) beat();
    render();
  });

  if (window.ethereum && window.ethereum.on) {
    window.ethereum.on("accountsChanged", () => window.location.reload());
    window.ethereum.on("chainChanged", () => window.location.reload());
  }

  setInterval(beat, HEARTBEAT_MS);
  setInterval(refresh, REFRESH_MS);
  // Keeps the "tended" duration honest without re-fetching anything.
  setInterval(() => {
    if (currentState() === "burning") render();
  }, 30000);

  await refresh();
  render();
}

start().catch((error) => {
  els.status.textContent = "The room could not be prepared: " + error.message;
});
