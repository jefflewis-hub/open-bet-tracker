(() => {
  "use strict";

  const STORAGE_KEY = "circleSquare.v1";
  const REFRESH_MS = 45000;
  const ESPN_LEADERBOARD = "https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard";
  const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard";

  const BET_TYPE_LABELS = {
    outright: "Outright winner",
    top5: "Top 5",
    top10: "Top 10",
    top20: "Top 20",
    top30: "Top 30",
    makecut: "Makes the cut",
    h2h: "Head-to-head",
    custom: "Prop",
  };

  /* ---------- state ---------- */
  let state = loadState();
  let leaderboards = {}; // eventId -> { tournament, competitors: Map(id->comp), eventState, roundDetail }
  let activeTournamentId = state.tournaments[0] ? state.tournaments[0].id : null;
  let currentView = "bets";
  let pollTimer = null;
  let lastUpdated = null;
  let pendingRemove = null; // {type:'bet'|'tournament'|'parlay'|'otherBet', id}
  let editingParlayId = null; // set while the parlay sheet is open in edit mode, else null

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!parsed.tournaments) parsed.tournaments = [];
        if (!parsed.bets) parsed.bets = [];
        if (!parsed.parlays) parsed.parlays = [];
        if (!parsed.otherBets) parsed.otherBets = [];
        return parsed;
      }
    } catch (e) {}
    return { tournaments: [], bets: [], parlays: [], otherBets: [] };
  }
  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  /* ---------- ESPN data ---------- */
  async function fetchThisWeek() {
    const res = await fetch(ESPN_SCOREBOARD);
    if (!res.ok) throw new Error("scoreboard fetch failed");
    const data = await res.json();
    return (data.events || []).map((e) => ({
      id: e.id,
      name: e.name,
      date: e.date,
      state: e.status && e.status.type && e.status.type.state,
    }));
  }

  function parseCompetitor(c) {
    const disp = (c.status && c.status.position && c.status.position.displayName) || "-";
    const typeName = (c.status && c.status.type && c.status.type.name) || "";
    const isCut = /CUT/i.test(typeName) || disp.toUpperCase() === "CUT";
    const isWD = /WITHDR/i.test(typeName);
    const isDQ = /DISQ/i.test(typeName);
    const numMatch = disp.match(/(\d+)/);
    const posNum = numMatch ? parseInt(numMatch[1], 10) : null;
    const scoreToParStat = ((c.statistics || []).find((s) => s.name === "scoreToPar")) || null;
    const scoreToPar = scoreToParStat && typeof scoreToParStat.value === "number" ? scoreToParStat.value : null;
    return {
      id: c.athlete ? c.athlete.id : c.id,
      name: c.athlete ? c.athlete.displayName : "Unknown",
      posDisplay: disp,
      posNum,
      isCut,
      isWD,
      isDQ,
      scoreToPar,
      scoreDisplay: (c.score && c.score.displayValue) || "-",
      thru: c.status ? c.status.thru : null,
      teeTime: c.status ? c.status.teeTime : null,
    };
  }

  async function fetchLeaderboard(eventId) {
    const res = await fetch(`${ESPN_LEADERBOARD}?event=${encodeURIComponent(eventId)}`);
    if (!res.ok) throw new Error("leaderboard fetch failed");
    const data = await res.json();
    const ev = data.events && data.events[0];
    if (!ev) throw new Error("event not found");
    const comp = ev.competitions && ev.competitions[0];
    const competitors = (comp ? comp.competitors : []).map(parseCompetitor);
    const byId = new Map(competitors.map((c) => [String(c.id), c]));
    const status = ev.status && ev.status.type;
    return {
      id: ev.id,
      name: ev.name,
      eventState: status ? status.state : "pre", // pre | in | post
      stateDetail: status ? status.shortDetail || status.detail || status.description : "",
      competitors,
      byId,
    };
  }

  async function refreshAll() {
    const ids = state.tournaments.map((t) => t.id);
    if (ids.length === 0) {
      lastUpdated = new Date();
      render();
      return;
    }
    setLive(true);
    const results = await Promise.allSettled(ids.map((id) => fetchLeaderboard(id)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        leaderboards[ids[i]] = r.value;
      }
    });
    lastUpdated = new Date();
    setLive(false);
    render();
  }

  function setLive(isFetching) {
    const el = document.getElementById("refreshBtn");
    if (isFetching) el.classList.add("is-live");
    else el.classList.remove("is-live");
  }

  /* ---------- grading ---------- */
  function americanPayout(oddsStr, stake) {
    const s = parseFloat(stake);
    const m = String(oddsStr).trim().match(/^([+-]?)(\d+(\.\d+)?)$/);
    if (!m || isNaN(s)) return null;
    const sign = m[1] === "-" ? -1 : 1;
    const val = parseFloat(m[2]) * sign;
    if (val === 0) return null;
    const profit = val > 0 ? s * (val / 100) : s * (100 / Math.abs(val));
    return { profit, toReturn: s + profit };
  }

  // works for a bet, parlay, or other-bet: uses a direct toWin amount if one was
  // entered ("by payout" mode), otherwise falls back to American odds math
  function getPayout(entity) {
    if (entity.toWin !== undefined && entity.toWin !== null && entity.toWin !== "") {
      const stake = parseFloat(entity.stake) || 0;
      const toReturn = parseFloat(entity.toWin) || 0;
      return { profit: toReturn - stake, toReturn };
    }
    return americanPayout(entity.odds, entity.stake);
  }

  function evaluateBet(bet, lb) {
    // returns { mark: 'circle'|'square'|'diamond'|'dash', filled:bool, state:'good'|'bad'|'pending'|'neutral', label:string, posText, toParText }
    if (!lb) return { mark: "dash", filled: false, state: "neutral", label: "No data", posText: "—", toParText: "" };

    const golfer = lb.byId.get(String(bet.golferId));
    const final = lb.eventState === "post";

    if (bet.type === "custom") {
      if (!golfer) return { mark: "dash", filled: false, state: "neutral", label: "—", posText: "—", toParText: "" };
      return {
        mark: "dash",
        filled: false,
        state: "neutral",
        label: golfer.isCut ? "Missed cut" : golfer.isWD ? "Withdrew" : "",
        posText: golfer.isCut || golfer.isWD ? golfer.posDisplay : golfer.posDisplay,
        toParText: golfer.scoreDisplay,
      };
    }

    if (bet.type === "h2h") {
      const opp = lb.byId.get(String(bet.opponentId));
      if (!golfer || !opp) return { mark: "dash", filled: false, state: "neutral", label: "No data", posText: "—", toParText: "" };
      const mineOut = golfer.isCut || golfer.isWD || golfer.isDQ;
      const oppOut = opp.isCut || opp.isWD || opp.isDQ;
      let satisfied = null;
      if (mineOut && oppOut) satisfied = null; // push / check rules
      else if (mineOut) satisfied = false;
      else if (oppOut) satisfied = true;
      else if (golfer.scoreToPar !== null && opp.scoreToPar !== null) satisfied = golfer.scoreToPar < opp.scoreToPar;
      else satisfied = null;

      let label = `vs ${opp.name}`;
      if (mineOut && oppOut) label = "Both out — check push rule";
      const mark = satisfied === null ? "diamond" : satisfied ? "circle" : "square";
      const st = satisfied === null ? "pending" : satisfied ? "good" : "bad";
      return {
        mark,
        filled: final && satisfied !== null,
        state: st,
        label: final ? (satisfied === null ? label : satisfied ? "Won matchup" : "Lost matchup") : label,
        posText: golfer.posDisplay,
        toParText: golfer.scoreDisplay,
      };
    }

    if (!golfer) return { mark: "dash", filled: false, state: "neutral", label: "No data", posText: "—", toParText: "" };

    if (golfer.isWD || golfer.isDQ) {
      return {
        mark: "diamond",
        filled: false,
        state: "pending",
        label: golfer.isDQ ? "Disqualified — check push rule" : "Withdrew — check push rule",
        posText: golfer.posDisplay,
        toParText: golfer.scoreDisplay,
      };
    }

    if (bet.type === "makecut") {
      if (golfer.isCut) {
        return { mark: "square", filled: final, state: "bad", label: final ? "Missed cut" : "Cut", posText: golfer.posDisplay, toParText: golfer.scoreDisplay };
      }
      // rounds 1-2, cut not yet applied to anyone tournament-wide -> pending; else made it
      const cutKnown = lb.competitors.some((c) => c.isCut);
      if (!cutKnown && lb.eventState !== "post") {
        return { mark: "diamond", filled: false, state: "pending", label: "Cut pending", posText: golfer.posDisplay, toParText: golfer.scoreDisplay };
      }
      return { mark: "circle", filled: final, state: "good", label: final ? "Made the cut" : "Made cut", posText: golfer.posDisplay, toParText: golfer.scoreDisplay };
    }

    // outright / topN
    const threshold = bet.type === "outright" ? 1 : parseInt(bet.type.replace("top", ""), 10);
    if (golfer.isCut) {
      return { mark: "square", filled: true, state: "bad", label: "Missed cut", posText: golfer.posDisplay, toParText: golfer.scoreDisplay };
    }
    if (golfer.posNum === null) {
      return { mark: "diamond", filled: false, state: "pending", label: "Not started", posText: golfer.posDisplay, toParText: golfer.scoreDisplay };
    }
    const satisfied = golfer.posNum <= threshold;
    return {
      mark: satisfied ? "circle" : "square",
      filled: final,
      state: satisfied ? "good" : "bad",
      label: final ? (satisfied ? "Won" : "Lost") : "",
      posText: golfer.posDisplay,
      toParText: golfer.scoreDisplay,
    };
  }

  function evaluateParlay(parlay, legBets) {
    // won only once every leg is settled good; lost the instant any leg is settled bad
    const legResults = legBets.map((bet) => ({ bet, ev: evaluateBet(bet, leaderboards[bet.tournamentId]) }));
    const anyLost = legResults.some((l) => l.ev.state === "bad" && l.ev.filled);
    const allWon = legResults.length > 0 && legResults.every((l) => l.ev.state === "good" && l.ev.filled);
    const aliveCount = legResults.filter((l) => l.ev.state === "good").length;
    if (anyLost) return { mark: "square", filled: true, state: "bad", label: "Lost", legResults };
    if (allWon) return { mark: "circle", filled: true, state: "good", label: "Won", legResults };
    return { mark: "diamond", filled: false, state: "pending", label: `${aliveCount}/${legResults.length} live`, legResults };
  }

  /* ---------- rendering ---------- */
  function fmtMoney(n) {
    const v = Math.round(n * 100) / 100;
    return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  function markGlyph(mark) {
    if (mark === "circle") return "";
    if (mark === "square") return "";
    if (mark === "diamond") return "";
    return "–";
  }

  function timeAgo(d) {
    if (!d) return "—";
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  }

  function render() {
    renderTopbar();
    renderSummary();
    if (currentView === "bets") renderBets();
    else renderTournaments();
    document.getElementById("updatedText").textContent = timeAgo(lastUpdated);
  }

  function renderTopbar() {
    const active = state.tournaments.find((t) => t.id === activeTournamentId) || state.tournaments[0];
    const nameEl = document.getElementById("tnName");
    const subEl = document.getElementById("tnSub");
    if (!active) {
      nameEl.textContent = "No tournament yet";
      subEl.textContent = "Add one from the Tournaments tab";
      return;
    }
    nameEl.textContent = active.name;
    const lb = leaderboards[active.id];
    subEl.textContent = lb ? (lb.stateDetail || lb.eventState) : "Loading…";
  }

  document.getElementById("tournamentSwitch").addEventListener("click", () => {
    switchView("tournaments");
  });

  function renderSummary() {
    const strip = document.getElementById("summaryStrip");
    if (state.bets.length === 0 && state.otherBets.length === 0) {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    let staked = 0;
    let liveToWin = 0;
    let wins = 0;
    let losses = 0;

    state.bets.forEach((bet) => {
      if (bet.parlayId) return; // counted via its parlay instead
      const lb = leaderboards[bet.tournamentId];
      staked += parseFloat(bet.stake) || 0;
      const ev = evaluateBet(bet, lb);
      const payout = getPayout(bet);
      if (ev.filled) {
        if (ev.state === "good") wins++;
        else if (ev.state === "bad") losses++;
      } else if (payout && ev.state === "good") {
        liveToWin += payout.toReturn;
      }
    });

    state.parlays.forEach((parlay) => {
      const legs = parlay.legIds.map((id) => state.bets.find((b) => b.id === id)).filter(Boolean);
      if (legs.length === 0) return;
      staked += parseFloat(parlay.stake) || 0;
      const pr = evaluateParlay(parlay, legs);
      const payout = getPayout(parlay);
      if (pr.filled) {
        if (pr.state === "good") wins++;
        else if (pr.state === "bad") losses++;
      } else if (payout) {
        liveToWin += payout.toReturn;
      }
    });

    state.otherBets.forEach((bet) => {
      staked += parseFloat(bet.stake) || 0;
      const toWin = parseFloat(bet.toWin) || 0;
      if (bet.status === "won") wins++;
      else if (bet.status === "lost") losses++;
      else liveToWin += toWin;
    });

    document.getElementById("sumStaked").textContent = fmtMoney(staked);
    document.getElementById("sumToWin").textContent = fmtMoney(liveToWin);
    document.getElementById("sumRecord").textContent = `${wins}–${losses}`;
  }

  function renderBets() {
    document.getElementById("view-bets").hidden = false;
    document.getElementById("view-tournaments").hidden = true;
    const list = document.getElementById("betList");
    const empty = document.getElementById("emptyBets");
    list.innerHTML = "";

    if (state.bets.length === 0 && state.otherBets.length === 0) {
      empty.hidden = false;
      updateCombineButton();
      return;
    }
    empty.hidden = true;

    if (state.parlays.length > 0) {
      const title = document.createElement("div");
      title.className = "tournament-group-title";
      title.textContent = state.parlays.length === 1 ? "Parlay" : "Parlays";
      list.appendChild(title);
      state.parlays.forEach((parlay) => {
        const legs = parlay.legIds.map((id) => state.bets.find((b) => b.id === id)).filter(Boolean);
        if (legs.length === 0) return;
        list.appendChild(renderParlayCard(parlay, legs));
      });
    }

    // group standalone (non-parlay) bets by tournament, most recently added tournament first
    const groups = new Map();
    state.bets.forEach((bet) => {
      if (bet.parlayId) return;
      if (!groups.has(bet.tournamentId)) groups.set(bet.tournamentId, []);
      groups.get(bet.tournamentId).push(bet);
    });

    const order = state.tournaments.map((t) => t.id).filter((id) => groups.has(id));

    order.forEach((tid) => {
      const t = state.tournaments.find((x) => x.id === tid);
      const lb = leaderboards[tid];
      const title = document.createElement("div");
      title.className = "tournament-group-title";
      title.innerHTML = `${escapeHtml(t ? t.name : "Tournament")} <span class="group-sub">${lb ? escapeHtml(lb.stateDetail || lb.eventState) : "loading"}</span>`;
      list.appendChild(title);

      groups.get(tid).forEach((bet) => {
        list.appendChild(renderBetRow(bet, lb));
      });
    });

    if (state.otherBets.length > 0) {
      const title = document.createElement("div");
      title.className = "tournament-group-title";
      title.textContent = "Other Bets";
      list.appendChild(title);
      state.otherBets.forEach((bet) => list.appendChild(renderOtherBetRow(bet)));
    }

    updateCombineButton();
  }

  const OTHER_BET_STATES = {
    pending: { mark: "diamond", filled: false, state: "pending", label: "Pending" },
    won: { mark: "circle", filled: true, state: "good", label: "Won" },
    lost: { mark: "square", filled: true, state: "bad", label: "Lost" },
  };

  function renderOtherBetRow(bet) {
    const info = OTHER_BET_STATES[bet.status] || OTHER_BET_STATES.pending;
    const row = document.createElement("div");
    row.className = `bet-row is-${info.state}`;

    const markBtn = document.createElement("button");
    markBtn.type = "button";
    markBtn.className = `mark mark-${info.mark}${info.filled ? " filled" : ""}`;
    markBtn.setAttribute("aria-label", "Tap to change status");
    markBtn.innerHTML = info.mark === "diamond" ? `<span>${markGlyph(info.mark)}</span>` : markGlyph(info.mark);
    markBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cycleOtherBetStatus(bet.id);
    });
    row.appendChild(markBtn);

    const main = document.createElement("div");
    main.className = "bet-main";
    main.innerHTML = `
      <div class="bet-golfer">${escapeHtml(bet.description)}</div>
      <div class="bet-meta">${fmtMoney(parseFloat(bet.stake) || 0)} to win ${fmtMoney(parseFloat(bet.toWin) || 0)}</div>
    `;
    row.appendChild(main);

    const scoreEl = document.createElement("div");
    scoreEl.className = "bet-score";
    scoreEl.innerHTML = `<div class="bet-status-label">${escapeHtml(info.label)}</div>`;
    row.appendChild(scoreEl);

    const removeBtn = document.createElement("button");
    removeBtn.className = "bet-remove";
    removeBtn.setAttribute("aria-label", "Remove bet");
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      askConfirm("otherBet", bet.id, `Remove "${bet.description}"?`);
    });
    row.appendChild(removeBtn);

    return row;
  }

  function cycleOtherBetStatus(id) {
    const bet = state.otherBets.find((b) => b.id === id);
    if (!bet) return;
    const order = ["pending", "won", "lost"];
    bet.status = order[(order.indexOf(bet.status || "pending") + 1) % order.length];
    saveState();
    render();
  }

  function removeOtherBet(id) {
    state.otherBets = state.otherBets.filter((b) => b.id !== id);
    saveState();
    render();
  }

  function renderParlayCard(parlay, legs) {
    const pr = evaluateParlay(parlay, legs);
    const payout = getPayout(parlay);
    const card = document.createElement("div");
    card.className = "parlay-card";

    const header = document.createElement("div");
    header.className = `bet-row is-${pr.state}`;

    const markEl = document.createElement("div");
    markEl.className = `mark mark-${pr.mark}${pr.filled ? " filled" : ""}`;
    markEl.innerHTML = pr.mark === "diamond" ? `<span>${markGlyph(pr.mark)}</span>` : markGlyph(pr.mark);
    header.appendChild(markEl);

    const main = document.createElement("div");
    main.className = "bet-main";
    const names = legs.map((l) => l.golferName).join(", ");
    const parlayMeta = parlay.odds
      ? `${escapeHtml(parlay.odds)} · ${fmtMoney(parseFloat(parlay.stake) || 0)}${payout ? " to win " + fmtMoney(payout.toReturn) : ""}`
      : `${fmtMoney(parseFloat(parlay.stake) || 0)}${payout ? " to win " + fmtMoney(payout.toReturn) : ""}`;
    main.innerHTML = `
      <div class="bet-golfer">${legs.length}-leg parlay</div>
      <div class="bet-type">${escapeHtml(names)}</div>
      <div class="bet-meta">${parlayMeta}</div>
    `;
    header.appendChild(main);

    const scoreEl = document.createElement("div");
    scoreEl.className = "bet-score";
    scoreEl.innerHTML = `<div class="bet-status-label">${escapeHtml(pr.label)}</div>`;
    header.appendChild(scoreEl);

    const removeBtn = document.createElement("button");
    removeBtn.className = "bet-remove";
    removeBtn.setAttribute("aria-label", "Remove parlay");
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      askConfirm("parlay", parlay.id, `Remove this ${legs.length}-leg parlay? Legs go back to your bet list individually.`);
    });
    header.appendChild(removeBtn);

    card.appendChild(header);

    const legsEl = document.createElement("div");
    legsEl.className = "parlay-legs";
    pr.legResults.forEach(({ bet, ev }) => {
      const row = document.createElement("div");
      row.className = "parlay-leg-row";
      const typeLabel =
        bet.type === "h2h" ? `H2H vs ${escapeHtml(bet.opponentName || "?")}` : bet.type === "custom" ? escapeHtml(bet.custom || "Prop") : BET_TYPE_LABELS[bet.type];
      row.innerHTML = `
        <span class="leg-dot leg-${ev.state}"></span>
        <span class="leg-name">${escapeHtml(bet.golferName)} — ${typeLabel}</span>
        <span class="leg-pos">${escapeHtml(ev.posText)}</span>
      `;
      legsEl.appendChild(row);
    });
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "leg-edit-btn";
    editBtn.textContent = "+ Add / edit legs";
    editBtn.addEventListener("click", () => openParlaySheet(parlay.id));
    legsEl.appendChild(editBtn);
    card.appendChild(legsEl);

    return card;
  }

  function updateCombineButton() {
    const btn = document.getElementById("combineBtn");
    btn.hidden = state.tournaments.length === 0;
  }

  function renderBetRow(bet, lb) {
    const ev = evaluateBet(bet, lb);
    const payout = getPayout(bet);
    const row = document.createElement("div");
    row.className = `bet-row is-${ev.state}`;

    const markEl = document.createElement("div");
    markEl.className = `mark mark-${ev.mark}${ev.filled ? " filled" : ""}`;
    if (ev.mark === "diamond") {
      markEl.innerHTML = `<span>${markGlyph(ev.mark)}</span>`;
    } else {
      markEl.textContent = markGlyph(ev.mark);
    }
    row.appendChild(markEl);

    const main = document.createElement("div");
    main.className = "bet-main";
    const typeLabel = bet.type === "h2h" ? `H2H vs ${escapeHtml(bet.opponentName || "?")}` : bet.type === "custom" ? escapeHtml(bet.custom || "Prop") : BET_TYPE_LABELS[bet.type];
    let metaText;
    if (bet.odds) {
      metaText = `${escapeHtml(bet.odds)} · ${fmtMoney(parseFloat(bet.stake) || 0)}${payout ? " to win " + fmtMoney(payout.toReturn) : ""}`;
    } else if (payout) {
      metaText = `${fmtMoney(parseFloat(bet.stake) || 0)} to win ${fmtMoney(payout.toReturn)}`;
    } else {
      metaText = "No odds set — was built as a parlay leg";
    }
    main.innerHTML = `
      <div class="bet-golfer">${escapeHtml(bet.golferName)}</div>
      <div class="bet-type">${typeLabel}</div>
      <div class="bet-meta">${metaText}</div>
    `;
    row.appendChild(main);

    const scoreEl = document.createElement("div");
    scoreEl.className = "bet-score";
    scoreEl.innerHTML = `
      <div class="bet-pos">${escapeHtml(ev.posText)}</div>
      <div class="bet-topar">${escapeHtml(ev.toParText)}</div>
      ${ev.label ? `<div class="bet-status-label">${escapeHtml(ev.label)}</div>` : ""}
    `;
    row.appendChild(scoreEl);

    const removeBtn = document.createElement("button");
    removeBtn.className = "bet-remove";
    removeBtn.setAttribute("aria-label", "Remove bet");
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      askConfirm("bet", bet.id, `Remove ${bet.golferName} — ${typeLabel}?`);
    });
    row.appendChild(removeBtn);

    return row;
  }

  function renderTournaments() {
    document.getElementById("view-bets").hidden = true;
    document.getElementById("view-tournaments").hidden = false;

    const qa = document.getElementById("quickAddList");
    qa.innerHTML = `<div class="quick-add-item"><span class="qa-name">Loading this week…</span></div>`;
    fetchThisWeek()
      .then((events) => {
        qa.innerHTML = "";
        if (events.length === 0) {
          qa.innerHTML = `<div class="quick-add-item"><span class="qa-name">Nothing scheduled this week</span></div>`;
          return;
        }
        events.forEach((e) => {
          const already = state.tournaments.some((t) => t.id === e.id);
          const item = document.createElement("div");
          item.className = "quick-add-item";
          const date = new Date(e.date);
          item.innerHTML = `
            <div>
              <div class="qa-name">${escapeHtml(e.name)}</div>
              <div class="qa-date">${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div>
            </div>
          `;
          if (already) {
            const lbl = document.createElement("span");
            lbl.className = "qa-added-label";
            lbl.textContent = "Added";
            item.appendChild(lbl);
          } else {
            const btn = document.createElement("button");
            btn.className = "qa-add-btn";
            btn.textContent = "Add";
            btn.addEventListener("click", () => addTournament(e.id, e.name));
            item.appendChild(btn);
          }
          qa.appendChild(item);
        });
      })
      .catch(() => {
        qa.innerHTML = `<div class="quick-add-item"><span class="qa-name">Couldn't load this week's schedule</span></div>`;
      });

    const tracked = document.getElementById("trackedList");
    tracked.innerHTML = "";
    if (state.tournaments.length === 0) {
      tracked.innerHTML = `<div class="tracked-item"><span class="qa-name">Nothing tracked yet</span></div>`;
    }
    state.tournaments.forEach((t) => {
      const lb = leaderboards[t.id];
      const item = document.createElement("div");
      item.className = "tracked-item";
      item.innerHTML = `
        <div>
          <div class="qa-name">${escapeHtml(t.name)}</div>
          <div class="qa-date">${lb ? escapeHtml(lb.stateDetail || lb.eventState) : "loading…"}</div>
        </div>
      `;
      const btn = document.createElement("button");
      btn.className = "qa-remove-btn";
      btn.textContent = "Remove";
      const betCount = state.bets.filter((b) => b.tournamentId === t.id).length;
      btn.addEventListener("click", () =>
        askConfirm("tournament", t.id, betCount > 0 ? `Remove ${t.name} and its ${betCount} bet${betCount === 1 ? "" : "s"}?` : `Remove ${t.name}?`)
      );
      item.appendChild(btn);
      tracked.appendChild(item);
    });
  }

  function addTournament(id, name) {
    if (state.tournaments.some((t) => t.id === id)) return;
    state.tournaments.unshift({ id, name });
    saveState();
    if (!activeTournamentId) activeTournamentId = id;
    if (leaderboards[id]) {
      render();
      return;
    }
    fetchLeaderboard(id)
      .then((lb) => {
        leaderboards[id] = lb;
        render();
      })
      .catch(() => render());
    render();
  }

  function removeTournament(id) {
    state.tournaments = state.tournaments.filter((t) => t.id !== id);
    state.bets = state.bets.filter((b) => b.tournamentId !== id);
    delete leaderboards[id];
    if (activeTournamentId === id) activeTournamentId = state.tournaments[0] ? state.tournaments[0].id : null;
    state.parlays.forEach((p) => cleanupParlay(p.id));
    saveState();
    render();
  }

  function removeBet(id) {
    state.bets = state.bets.filter((b) => b.id !== id);
    state.parlays.forEach((p) => cleanupParlay(p.id));
    saveState();
    render();
  }

  // drops legs that no longer exist; dissolves the parlay (freeing remaining legs) if fewer than 2 legs remain
  function cleanupParlay(parlayId) {
    const parlay = state.parlays.find((p) => p.id === parlayId);
    if (!parlay) return;
    parlay.legIds = parlay.legIds.filter((legId) => state.bets.some((b) => b.id === legId));
    if (parlay.legIds.length < 2) {
      parlay.legIds.forEach((legId) => {
        const b = state.bets.find((x) => x.id === legId);
        if (b) delete b.parlayId;
      });
      state.parlays = state.parlays.filter((p) => p.id !== parlayId);
    }
  }

  function removeParlay(id) {
    const parlay = state.parlays.find((p) => p.id === id);
    if (parlay) {
      parlay.legIds.forEach((legId) => {
        const b = state.bets.find((x) => x.id === legId);
        if (b) delete b.parlayId;
      });
    }
    state.parlays = state.parlays.filter((p) => p.id !== id);
    saveState();
    render();
  }

  function askConfirm(type, id, text) {
    pendingRemove = { type, id };
    document.getElementById("confirmText").textContent = text;
    document.getElementById("confirmSheet").showModal();
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function extractEventId(input) {
    const raw = input.trim();
    if (/^\d+$/.test(raw)) return raw;
    const m = raw.match(/tournamentId=(\d+)/) || raw.match(/event=(\d+)/) || raw.match(/leaderboard\/(\d+)/);
    return m ? m[1] : null;
  }

  /* ---------- view / nav wiring ---------- */
  function switchView(v) {
    currentView = v;
    document.querySelectorAll(".tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === v));
    render();
  }
  document.querySelectorAll(".tab").forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.view)));

  document.getElementById("refreshBtn").addEventListener("click", () => refreshAll());

  document.getElementById("fab").addEventListener("click", () => openAddBet());

  function openAddBet() {
    if (state.tournaments.length === 0) {
      switchView("tournaments");
      return;
    }
    const sel = document.getElementById("betTournament");
    sel.innerHTML = state.tournaments.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
    sel.value = activeTournamentId || state.tournaments[0].id;
    populateGolferOptions(sel.value);
    sel.onchange = () => populateGolferOptions(sel.value);
    document.getElementById("addBetForm").reset();
    sel.value = activeTournamentId || state.tournaments[0].id;
    document.getElementById("betType").value = "outright";
    toggleTypeFields();
    setToggleMode("betModeToggle", "betOddsField", "betToWinField", "odds");
    document.getElementById("addBetSheet").showModal();
  }

  // populates a <datalist> with a tournament's field; if the leaderboard hasn't loaded
  // yet, fetches it and populates once it arrives (only if selEl, when given, still
  // points at that same tournament — guards against a stale in-flight fetch clobbering
  // a datalist after the user switched tournaments)
  function populateDatalist(dl, tournamentId, selEl) {
    const lb = leaderboards[tournamentId];
    if (!lb) {
      dl.innerHTML = "";
      fetchLeaderboard(tournamentId)
        .then((fetchedLb) => {
          leaderboards[tournamentId] = fetchedLb;
          if (!selEl || selEl.value === tournamentId) populateDatalist(dl, tournamentId, selEl);
          render();
        })
        .catch(() => {});
      return;
    }
    dl.innerHTML = "";
    lb.competitors
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.name;
        dl.appendChild(opt);
      });
  }

  function populateGolferOptions(tournamentId) {
    populateDatalist(document.getElementById("golferOptions"), tournamentId, document.getElementById("betTournament"));
  }

  // shared "by odds" / "by payout" toggle used on both the bet form and the parlay form
  function wireModeToggle(toggleId, oddsFieldId, toWinFieldId) {
    document.getElementById(toggleId).querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => setToggleMode(toggleId, oddsFieldId, toWinFieldId, btn.dataset.mode));
    });
  }
  function setToggleMode(toggleId, oddsFieldId, toWinFieldId, mode) {
    document.getElementById(toggleId).querySelectorAll(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    document.getElementById(oddsFieldId).hidden = mode === "payout";
    document.getElementById(toWinFieldId).hidden = mode !== "payout";
  }
  function getToggleMode(toggleId) {
    const active = document.querySelector(`#${toggleId} .mode-btn.active`);
    return active ? active.dataset.mode : "odds";
  }
  wireModeToggle("betModeToggle", "betOddsField", "betToWinField");
  wireModeToggle("parlayModeToggle", "parlayOddsField", "parlayToWinField");

  document.getElementById("betType").addEventListener("change", toggleTypeFields);
  function toggleTypeFields() {
    const t = document.getElementById("betType").value;
    document.getElementById("opponentField").hidden = t !== "h2h";
    document.getElementById("customField").hidden = t !== "custom";
    document.getElementById("betOpponent").required = t === "h2h";
    document.getElementById("betCustom").required = t === "custom";
  }

  document.getElementById("cancelBetBtn").addEventListener("click", () => document.getElementById("addBetSheet").close());

  document.getElementById("addBetForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const tournamentId = document.getElementById("betTournament").value;
    const lb = leaderboards[tournamentId];
    const golferName = document.getElementById("betGolfer").value.trim();
    const type = document.getElementById("betType").value;
    const oppName = document.getElementById("betOpponent").value.trim();
    const custom = document.getElementById("betCustom").value.trim();
    const stake = document.getElementById("betStake").value;
    const notes = document.getElementById("betNotes").value.trim();

    let odds = "";
    let toWin = "";
    if (getToggleMode("betModeToggle") === "payout") {
      toWin = document.getElementById("betToWin").value;
      if (!golferName || !stake || !toWin) return;
      if (parseFloat(toWin) <= parseFloat(stake)) {
        alert("To win should be more than the stake — it's the total payout, stake included.");
        return;
      }
    } else {
      odds = document.getElementById("betOdds").value.trim();
      if (!golferName || !odds || !stake) return;
      if (!americanPayout(odds, stake)) {
        alert("Odds should look like +1500 or -110.");
        return;
      }
    }

    const golfer = lb ? lb.competitors.find((c) => c.name.toLowerCase() === golferName.toLowerCase()) : null;
    let opponent = null;
    if (type === "h2h") {
      if (!oppName) return;
      opponent = lb ? lb.competitors.find((c) => c.name.toLowerCase() === oppName.toLowerCase()) : null;
    }

    const bet = {
      id: String(Date.now()) + Math.random().toString(36).slice(2, 7),
      tournamentId,
      golferId: golfer ? golfer.id : golferName,
      golferName: golfer ? golfer.name : golferName,
      type,
      opponentId: opponent ? opponent.id : oppName || null,
      opponentName: opponent ? opponent.name : oppName || null,
      custom,
      odds,
      stake,
      toWin,
      notes,
    };
    state.bets.push(bet);
    activeTournamentId = tournamentId;
    saveState();
    document.getElementById("addBetSheet").close();
    switchView("bets");
  });

  document.getElementById("addByLinkForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("linkInput");
    const errEl = document.getElementById("linkError");
    const id = extractEventId(input.value);
    if (!id) {
      errEl.textContent = "Couldn't find an event ID in that. Try pasting the full ESPN leaderboard link.";
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;
    fetchLeaderboard(id)
      .then((lb) => {
        leaderboards[id] = lb;
        addTournament(id, lb.name);
        input.value = "";
      })
      .catch(() => {
        errEl.textContent = "Couldn't find that tournament on ESPN.";
        errEl.hidden = false;
      });
  });

  document.getElementById("confirmCancelBtn").addEventListener("click", () => {
    pendingRemove = null;
    document.getElementById("confirmSheet").close();
  });
  document.getElementById("confirmOkBtn").addEventListener("click", () => {
    if (pendingRemove) {
      if (pendingRemove.type === "bet") removeBet(pendingRemove.id);
      else if (pendingRemove.type === "parlay") removeParlay(pendingRemove.id);
      else if (pendingRemove.type === "otherBet") removeOtherBet(pendingRemove.id);
      else removeTournament(pendingRemove.id);
    }
    pendingRemove = null;
    document.getElementById("confirmSheet").close();
  });

  /* ---------- parlay sheet ---------- */
  document.getElementById("combineBtn").addEventListener("click", () => openParlaySheet());
  document.getElementById("cancelParlayBtn").addEventListener("click", () => {
    editingParlayId = null;
    document.getElementById("parlaySheet").close();
  });
  document.getElementById("addLegBtn").addEventListener("click", () => addLegRow());

  let legBuilderSeq = 0;

  function createLegBuilderRow(labelIndex) {
    legBuilderSeq += 1;
    const dlId = "legGolferOptions" + legBuilderSeq;
    const row = document.createElement("div");
    row.className = "leg-builder-row";
    row.innerHTML = `
      <div class="leg-builder-head">
        <span class="leg-builder-num">Leg ${labelIndex}</span>
        <button type="button" class="leg-remove-btn" aria-label="Remove leg">×</button>
      </div>
      <label class="field">
        <span class="field-label">Tournament</span>
        <select class="leg-tournament"></select>
      </label>
      <label class="field">
        <span class="field-label">Golfer</span>
        <input type="text" class="leg-golfer" list="${dlId}" autocapitalize="words" autocomplete="off" placeholder="Start typing a name…">
        <datalist id="${dlId}"></datalist>
      </label>
      <label class="field">
        <span class="field-label">Bet type</span>
        <select class="leg-type">
          <option value="outright">Outright winner</option>
          <option value="top5">Top 5</option>
          <option value="top10">Top 10</option>
          <option value="top20">Top 20</option>
          <option value="top30">Top 30</option>
          <option value="makecut">Makes the cut</option>
          <option value="h2h">Head-to-head</option>
          <option value="custom">Other / prop</option>
        </select>
      </label>
      <label class="field leg-opponent-field" hidden>
        <span class="field-label">Versus</span>
        <input type="text" class="leg-opponent" list="${dlId}" autocapitalize="words" autocomplete="off" placeholder="Opposing golfer…">
      </label>
      <label class="field leg-custom-field" hidden>
        <span class="field-label">What's the bet?</span>
        <input type="text" class="leg-custom" maxlength="80" placeholder="e.g. top American finisher">
      </label>
    `;

    const tSel = row.querySelector(".leg-tournament");
    tSel.innerHTML = state.tournaments.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
    tSel.value = activeTournamentId || (state.tournaments[0] ? state.tournaments[0].id : "");

    const dl = row.querySelector("datalist");
    populateDatalist(dl, tSel.value, tSel);
    tSel.addEventListener("change", () => populateDatalist(dl, tSel.value, tSel));

    const typeSel = row.querySelector(".leg-type");
    const oppField = row.querySelector(".leg-opponent-field");
    const customField = row.querySelector(".leg-custom-field");
    typeSel.addEventListener("change", () => {
      oppField.hidden = typeSel.value !== "h2h";
      customField.hidden = typeSel.value !== "custom";
    });

    row.querySelector(".leg-remove-btn").addEventListener("click", () => {
      row.remove();
      renumberLegRows();
    });

    return row;
  }

  function renumberLegRows() {
    document.querySelectorAll("#parlayNewLegs .leg-builder-row").forEach((row, i) => {
      row.querySelector(".leg-builder-num").textContent = "Leg " + (i + 1);
    });
  }

  function addLegRow() {
    const container = document.getElementById("parlayNewLegs");
    container.appendChild(createLegBuilderRow(container.children.length + 1));
  }

  function legTypeLabel(bet) {
    return bet.type === "h2h" ? `H2H vs ${escapeHtml(bet.opponentName || "?")}` : bet.type === "custom" ? escapeHtml(bet.custom || "Prop") : BET_TYPE_LABELS[bet.type];
  }

  function openParlaySheet(parlayId) {
    editingParlayId = parlayId || null;
    const parlay = editingParlayId ? state.parlays.find((p) => p.id === editingParlayId) : null;

    document.getElementById("parlayForm").reset();
    document.getElementById("parlayLegError").hidden = true;
    document.getElementById("parlaySheetTitle").textContent = parlay ? "Edit parlay" : "New parlay";
    document.getElementById("newLegsLabel").textContent = parlay ? "Add more legs" : "Legs";

    const currentField = document.getElementById("currentLegsField");
    const currentList = document.getElementById("parlayCurrentLegs");
    currentList.innerHTML = "";
    if (parlay) {
      currentField.hidden = false;
      parlay.legIds.forEach((legId) => {
        const bet = state.bets.find((b) => b.id === legId);
        if (!bet) return;
        const t = state.tournaments.find((x) => x.id === bet.tournamentId);
        const row = document.createElement("div");
        row.className = "leg-check-row";
        row.dataset.betId = bet.id;
        row.innerHTML = `
          <span class="leg-check-main">
            <span class="leg-check-golfer">${escapeHtml(bet.golferName)}</span>
            <span class="leg-check-meta">${legTypeLabel(bet)} · ${escapeHtml(t ? t.name : "")}</span>
          </span>
        `;
        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "leg-remove-btn";
        removeBtn.setAttribute("aria-label", "Drop this leg from the parlay");
        removeBtn.textContent = "×";
        removeBtn.addEventListener("click", () => row.remove());
        row.appendChild(removeBtn);
        currentList.appendChild(row);
      });
    } else {
      currentField.hidden = true;
    }

    const eligible = state.bets.filter((b) => !b.parlayId);
    const existingField = document.getElementById("existingLegsField");
    const list = document.getElementById("parlayLegList");
    list.innerHTML = "";
    existingField.hidden = eligible.length === 0;
    eligible.forEach((bet) => {
      const t = state.tournaments.find((x) => x.id === bet.tournamentId);
      const row = document.createElement("label");
      row.className = "leg-check-row";
      row.innerHTML = `
        <input type="checkbox" value="${escapeHtml(bet.id)}">
        <span class="leg-check-main">
          <span class="leg-check-golfer">${escapeHtml(bet.golferName)}</span>
          <span class="leg-check-meta">${legTypeLabel(bet)} · ${escapeHtml(t ? t.name : "")}${bet.odds ? " · " + escapeHtml(bet.odds) : ""}</span>
        </span>
      `;
      list.appendChild(row);
    });

    const newLegsContainer = document.getElementById("parlayNewLegs");
    newLegsContainer.innerHTML = "";
    newLegsContainer.appendChild(createLegBuilderRow(1));
    if (!parlay) newLegsContainer.appendChild(createLegBuilderRow(2));

    if (parlay) {
      document.getElementById("parlayStake").value = parlay.stake;
      document.getElementById("parlayNotes").value = parlay.notes || "";
      if (parlay.toWin) {
        setToggleMode("parlayModeToggle", "parlayOddsField", "parlayToWinField", "payout");
        document.getElementById("parlayToWin").value = parlay.toWin;
      } else {
        setToggleMode("parlayModeToggle", "parlayOddsField", "parlayToWinField", "odds");
        document.getElementById("parlayOdds").value = parlay.odds;
      }
    } else {
      setToggleMode("parlayModeToggle", "parlayOddsField", "parlayToWinField", "odds");
    }

    document.getElementById("parlaySheet").showModal();
  }

  document.getElementById("parlayForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const errEl = document.getElementById("parlayLegError");
    errEl.hidden = true;

    const keptLegIds = Array.from(document.querySelectorAll("#parlayCurrentLegs .leg-check-row")).map((row) => row.dataset.betId);
    const checkedExisting = Array.from(document.querySelectorAll('#parlayLegList input[type="checkbox"]:checked')).map((el) => el.value);

    // validate every filled-in new-leg row before committing anything to state
    const newLegBets = [];
    const rows = document.querySelectorAll("#parlayNewLegs .leg-builder-row");
    for (const row of rows) {
      const golferName = row.querySelector(".leg-golfer").value.trim();
      if (!golferName) continue; // unused row, skip silently

      const tournamentId = row.querySelector(".leg-tournament").value;
      const type = row.querySelector(".leg-type").value;
      const oppName = row.querySelector(".leg-opponent").value.trim();
      const custom = row.querySelector(".leg-custom").value.trim();

      if (type === "h2h" && !oppName) {
        alert(`Add an opponent for the head-to-head leg on ${golferName}.`);
        return;
      }
      if (type === "custom" && !custom) {
        alert(`Describe the prop bet for ${golferName}.`);
        return;
      }

      const lb = leaderboards[tournamentId];
      const golfer = lb ? lb.competitors.find((c) => c.name.toLowerCase() === golferName.toLowerCase()) : null;
      let opponent = null;
      if (type === "h2h") {
        opponent = lb ? lb.competitors.find((c) => c.name.toLowerCase() === oppName.toLowerCase()) : null;
      }

      newLegBets.push({
        id: String(Date.now()) + Math.random().toString(36).slice(2, 7),
        tournamentId,
        golferId: golfer ? golfer.id : golferName,
        golferName: golfer ? golfer.name : golferName,
        type,
        opponentId: opponent ? opponent.id : oppName || null,
        opponentName: opponent ? opponent.name : oppName || null,
        custom,
        odds: "",
        stake: "",
        notes: "",
      });
    }

    if (keptLegIds.length + checkedExisting.length + newLegBets.length < 2) {
      errEl.hidden = false;
      return;
    }

    const stake = document.getElementById("parlayStake").value;
    const notes = document.getElementById("parlayNotes").value.trim();

    let odds = "";
    let toWin = "";
    if (getToggleMode("parlayModeToggle") === "payout") {
      toWin = document.getElementById("parlayToWin").value;
      if (!stake || !toWin) return;
      if (parseFloat(toWin) <= parseFloat(stake)) {
        alert("To win should be more than the stake — it's the total payout, stake included.");
        return;
      }
    } else {
      odds = document.getElementById("parlayOdds").value.trim();
      if (!odds || !stake) return;
      if (!americanPayout(odds, stake)) {
        alert("Odds should look like +1500 or -110.");
        return;
      }
    }

    // everything validated — commit
    newLegBets.forEach((b) => state.bets.push(b));
    const addedLegIds = checkedExisting.concat(newLegBets.map((b) => b.id));

    if (editingParlayId) {
      const parlay = state.parlays.find((p) => p.id === editingParlayId);
      if (parlay) {
        const droppedLegIds = parlay.legIds.filter((id) => !keptLegIds.includes(id));
        droppedLegIds.forEach((id) => {
          const bet = state.bets.find((b) => b.id === id);
          if (bet) delete bet.parlayId;
        });
        parlay.legIds = keptLegIds.concat(addedLegIds);
        parlay.odds = odds;
        parlay.stake = stake;
        parlay.toWin = toWin;
        parlay.notes = notes;
        addedLegIds.forEach((betId) => {
          const bet = state.bets.find((b) => b.id === betId);
          if (bet) bet.parlayId = parlay.id;
        });
      }
    } else {
      const legIds = addedLegIds;
      const parlay = {
        id: "p" + String(Date.now()) + Math.random().toString(36).slice(2, 7),
        legIds,
        odds,
        stake,
        toWin,
        notes,
      };
      state.parlays.push(parlay);
      legIds.forEach((betId) => {
        const bet = state.bets.find((b) => b.id === betId);
        if (bet) bet.parlayId = parlay.id;
      });
    }

    editingParlayId = null;
    saveState();
    document.getElementById("parlaySheet").close();
    render();
  });

  /* ---------- other bet sheet ---------- */
  document.getElementById("otherBetBtn").addEventListener("click", () => {
    document.getElementById("otherBetForm").reset();
    document.getElementById("otherBetSheet").showModal();
  });
  document.getElementById("cancelOtherBetBtn").addEventListener("click", () => document.getElementById("otherBetSheet").close());

  document.getElementById("otherBetForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const description = document.getElementById("otherBetDesc").value.trim();
    const stake = document.getElementById("otherBetStake").value;
    const toWin = document.getElementById("otherBetToWin").value;
    const notes = document.getElementById("otherBetNotes").value.trim();
    if (!description || !stake || !toWin) return;

    state.otherBets.push({
      id: "o" + String(Date.now()) + Math.random().toString(36).slice(2, 7),
      description,
      stake,
      toWin,
      notes,
      status: "pending",
    });
    saveState();
    document.getElementById("otherBetSheet").close();
    switchView("bets");
  });

  /* ---------- polling ---------- */
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!document.hidden) refreshAll();
    }, REFRESH_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshAll();
  });

  /* ---------- boot ---------- */
  render();
  refreshAll();
  startPolling();
})();
