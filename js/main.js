import { aiBid, aiChoose } from "./ai.js";
import {
  applyBid,
  applyPlay,
  beats,
  createGame,
  identify,
  mulberry32,
  RANK_LABEL,
  roleName,
  seatName,
  SUIT_SYMBOL,
  TYPE_NAME,
} from "./engine.js";

const HUMAN = 0;
const app = document.querySelector("#app");
const params = new URLSearchParams(location.search);

let state = null;
let selected = new Set();
let busy = false;
let turnToken = 0;
let toast = "";
let flash = "";
let showRules = false;
let soundOn = false;
const audio = typeof AudioContext !== "undefined" ? new AudioContext() : null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadScores() {
  try {
    const saved = JSON.parse(localStorage.getItem("ddz-scores") || "");
    if (Array.isArray(saved) && saved.length === 3 && saved.every((n) => Number.isFinite(n))) return saved;
  } catch {
    /* keep a fresh table */
  }
  return [0, 0, 0];
}

function saveScores() {
  try {
    localStorage.setItem("ddz-scores", JSON.stringify(state.scores));
  } catch {
    /* private mode can reject storage */
  }
}

function makeRng() {
  if (params.has("seed")) {
    const deal = state?.dealId || 0;
    return mulberry32((Number(params.get("seed")) || 1) + deal * 997);
  }
  return Math.random;
}

function newGame(scores = loadScores()) {
  const startPlayer = params.has("start") ? Number(params.get("start")) : undefined;
  selected = new Set();
  toast = "";
  state = createGame({
    rng: makeRng(),
    scores,
    startPlayer,
    dealId: (state?.dealId || 0) + 1,
  });
}

function tone(freq, dur = 0.08) {
  if (!soundOn || !audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = freq;
  gain.gain.value = 0.04;
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + dur);
}

function cardMarkup(card, interactive) {
  const classes = ["card"];
  if (interactive && selected.has(card.id)) classes.push("selected");
  const label =
    card.rank >= 16
      ? card.rank === 17
        ? "大王"
        : "小王"
      : `${RANK_LABEL[card.rank]}${SUIT_SYMBOL[card.suit]}`;
  let inner = "";
  if (card.rank >= 16) {
    const big = card.rank === 17;
    classes.push("joker", big ? "big" : "small");
    inner = `<span>${big ? "大王" : "小王"}</span>`;
  } else {
    const red = card.suit === "h" || card.suit === "d";
    classes.push(red ? "red" : "black");
    const suit = SUIT_SYMBOL[card.suit];
    inner = `<span class="corner"><b>${RANK_LABEL[card.rank]}</b><i>${suit}</i></span><span class="pips">${suit}</span>`;
  }
  if (!interactive) return `<div class="${classes.join(" ")}">${inner}</div>`;
  return `<button type="button" class="${classes.join(" ")}" data-id="${card.id}" aria-label="${label}" aria-pressed="${selected.has(card.id)}">${inner}</button>`;
}

function backCard() {
  return `<div class="card back"></div>`;
}

function renderPile(entry) {
  if (!entry) return "";
  if (entry.kind === "pass") return `<div class="pass-chip">不出</div>`;
  return `<div class="cards">${entry.cards.map((card) => cardMarkup(card, false)).join("")}</div><div class="type-chip">${TYPE_NAME[entry.type]}</div>`;
}

function selectionCards() {
  return state.hands[HUMAN].filter((card) => selected.has(card.id));
}

function selectionNote() {
  const picked = selectionCards();
  if (!picked.length) return state.turn === HUMAN ? "点选手牌，再出牌" : "";
  const pat = identify(picked);
  if (!pat) return "牌型不符合规则";
  if (state.lastPlay && !beats(pat, state.lastPlay)) return `${TYPE_NAME[pat.type]} · 大不过上家`;
  return TYPE_NAME[pat.type];
}

function render() {
  const bidding = state.phase === "bid";
  const myTurn = state.turn === HUMAN && state.phase !== "over";
  const landlordKnown = state.landlord >= 0;
  const overlap = handOverlap(state.hands[HUMAN].length);

  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <div class="seal">地主</div>
        <div>
          <h1>斗地主</h1>
          <p>${landlordKnown ? `底分 ${state.base} · 倍数 ×${state.multiplier}` : "三人局 · 叫分"}</p>
        </div>
      </div>
      <div class="top-actions">
        <button type="button" class="ghost" data-action="sound">${soundOn ? "声音开" : "声音关"}</button>
        <button type="button" class="ghost" data-action="rules">规则</button>
      </div>
    </header>
    <div class="scoreline">
      <span>你 <b>${state.scores[0]}</b></span>
      <span>下家 <b>${state.scores[1]}</b></span>
      <span>上家 <b>${state.scores[2]}</b></span>
    </div>
    <section class="felt">
      <div class="bottom-row">
        <span class="label">底牌</span>
        <div class="mini-cards">
          ${
            landlordKnown
              ? state.bottom.map((card) => cardMarkup(card, false)).join("")
              : [0, 1, 2].map(backCard).join("")
          }
        </div>
      </div>
      ${seat(2, "left")}
      ${seat(1, "right")}
      <div class="trick">
        <div class="play">${renderPile(state.table[2])}</div>
        <div class="play">${renderPile(state.table[1])}</div>
        <div class="play mine">${renderPile(state.table[0])}</div>
      </div>
      <div class="status">${toast || state.log[state.log.length - 1] || ""}</div>
      ${flash ? `<div class="flash">${flash}</div>` : ""}
    </section>
    <footer class="dock">
      <div class="hand-wrap">
        <div class="hand" style="--w:${overlap.w}px">
          ${state.hands[HUMAN].map((card) => cardMarkup(card, true)).join("")}
        </div>
      </div>
      <div class="actions">
        ${actions(bidding, myTurn)}
      </div>
    </footer>
    ${showRules ? rulesDialog() : ""}
    ${state.phase === "over" ? resultDialog() : ""}
  `;

  const hand = app.querySelector(".hand");
  if (hand) {
    const cardsInHand = [...hand.querySelectorAll(".card")];
    const slack = hand.clientWidth - overlap.w;
    const gap = cardsInHand.length > 1 ? Math.min(overlap.w * 0.46, slack / (cardsInHand.length - 1)) : 0;
    cardsInHand.forEach((el, index) => {
      el.style.marginLeft = index === 0 ? "0" : `${gap - overlap.w}px`;
    });
  }
  bind();
}

function handOverlap(count) {
  const width = Math.min(420, app.clientWidth || 390) - 16;
  const w = count > 12 ? 50 : 58;
  return { w: Math.max(44, Math.min(w, width / 6)) };
}

function seat(player, side) {
  const role = roleName(state, player);
  const bid = state.bids[player];
  const tag = role
    ? `<div class="role ${role === "地主" ? "lord" : ""}">${role}</div>`
    : bid === null
      ? ""
      : `<div class="role">${bid === 0 ? "不叫" : `${bid} 分`}</div>`;
  const thinking = state.turn === player && state.phase !== "over" ? " thinking" : "";
  return `<aside class="seat ${side}${thinking}">
    <div class="who">${seatName(player)}</div>
    ${tag}
    <div class="backs" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="count">${state.hands[player].length} 张</div>
  </aside>`;
}

function actions(bidding, myTurn) {
  const note = `<div class="hint">${myTurn ? selectionNote() || "轮到你了" : "等待其他玩家"}</div>`;
  if (!myTurn) return `${note}<button type="button" class="btn" disabled>请稍候</button>`;
  if (bidding) {
    return `${note}${[0, 1, 2, 3]
      .map((bid) => {
        const enabled = bid === 0 || bid > state.bidMax;
        const label = bid === 0 ? "不叫" : `${bid} 分`;
        return `<button type="button" class="btn bid ${bid === 3 ? "primary" : ""}" data-bid="${bid}" ${enabled ? "" : "disabled"}>${label}</button>`;
      })
      .join("")}`;
  }
  const leading = !state.lastPlay;
  const picked = selectionCards();
  const pat = identify(picked);
  const canPlay = pat && (!state.lastPlay || beats(pat, state.lastPlay));
  return `${note}
    <button type="button" class="btn" data-action="pass" ${leading ? "disabled" : ""}>不出</button>
    <button type="button" class="btn" data-action="hint">提示</button>
    <button type="button" class="btn primary" data-action="play" ${canPlay ? "" : "disabled"}>出牌</button>`;
}

function rulesDialog() {
  return `<div class="overlay">
    <div class="dialog rules">
      <h2>怎么玩</h2>
      <ul>
        <li>三人局，你在下方。叫 1 到 3 分，最高者当地主并拿走三张底牌。</li>
        <li>单张、对子、三张、三带一、三带二、顺子（至少五张，不含 2 和王）、连对、飞机、四带二、炸弹、王炸。</li>
        <li>炸弹压过普通牌型，更大的炸弹压过小炸弹，王炸最大。炸弹和王炸让倍数翻倍。</li>
        <li>地主先出。先出完牌的一方获胜。春天、反春天再翻一倍。</li>
      </ul>
      <div class="row">
        <button type="button" class="btn" data-action="again">重开本局</button>
        <button type="button" class="btn primary" data-action="close-rules">知道了</button>
      </div>
    </div>
  </div>`;
}

function resultDialog() {
  const humanLandlord = state.landlord === HUMAN;
  const landlordWin = state.winner === state.landlord;
  const humanWin = humanLandlord ? landlordWin : !landlordWin;
  const detail = [
    `底分 ${state.base}`,
    `倍数 ×${state.multiplier}`,
    state.bombCount ? `炸弹 ${state.bombCount} 次` : "",
    state.springKind,
  ]
    .filter(Boolean)
    .join(" · ");
  return `<div class="overlay">
    <div class="dialog">
      <h2>${humanWin ? "你赢了" : "你输了"}</h2>
      <p>${landlordWin ? "地主胜" : "农民胜"}${state.springKind ? ` · ${state.springKind}` : ""}</p>
      <div class="score-jump">${state.roundScore[HUMAN] > 0 ? "+" : ""}${state.roundScore[HUMAN]}</div>
      <p>${detail}</p>
      <p>总分　你 ${state.scores[0]}　下家 ${state.scores[1]}　上家 ${state.scores[2]}</p>
      <div class="row">
        <button type="button" class="btn" data-action="reset-score">积分清零</button>
        <button type="button" class="btn primary" data-action="again">再来一局</button>
      </div>
    </div>
  </div>`;
}

function bind() {
  app.querySelectorAll(".hand .card").forEach((el) => {
    el.addEventListener("click", () => toggle(el.dataset.id));
  });
  app.querySelectorAll("[data-bid]").forEach((el) => {
    el.addEventListener("click", () => humanBid(Number(el.dataset.bid)));
  });
  app.querySelector("[data-action='play']")?.addEventListener("click", humanPlay);
  app.querySelector("[data-action='pass']")?.addEventListener("click", () => humanPlay(null));
  app.querySelector("[data-action='hint']")?.addEventListener("click", hint);
  app.querySelector("[data-action='rules']")?.addEventListener("click", () => {
    showRules = true;
    render();
  });
  app.querySelector("[data-action='close-rules']")?.addEventListener("click", () => {
    showRules = false;
    render();
  });
  app.querySelector("[data-action='sound']")?.addEventListener("click", async () => {
    soundOn = !soundOn;
    if (soundOn && audio?.state === "suspended") await audio.resume();
    tone(520, 0.06);
    render();
  });
  app.querySelectorAll("[data-action='again']").forEach((el) => {
    el.addEventListener("click", () => restart(state.scores));
  });
  app.querySelector("[data-action='reset-score']")?.addEventListener("click", () => {
    restart([0, 0, 0]);
    saveScores();
  });
}

function restart(scores) {
  turnToken += 1;
  busy = false;
  showRules = false;
  flash = "";
  app.classList.remove("shake");
  newGame(scores);
  proceed();
}

function toggle(id) {
  if (state.turn !== HUMAN || state.phase !== "play" || busy) return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  toast = "";
  render();
}

function humanBid(bid) {
  if (busy || state.phase !== "bid" || state.turn !== HUMAN) return;
  const res = applyBid(state, HUMAN, bid, makeRng());
  if (!res.ok) {
    toast = res.error;
    render();
    return;
  }
  state = res.state;
  tone(bid === 0 ? 280 : 440);
  proceed();
}

function humanPlay(forced) {
  if (busy || state.phase !== "play" || state.turn !== HUMAN) return;
  const cards = forced === null ? null : selectionCards();
  const res = applyPlay(state, HUMAN, cards);
  if (!res.ok) {
    toast = res.error;
    render();
    return;
  }
  selected = new Set();
  toast = "";
  state = res.state;
  noteBoom(res.state);
  if (state.phase === "over") saveScores();
  proceed();
}

function hint() {
  const choice = aiChoose(state, HUMAN);
  if (!choice) {
    toast = state.lastPlay ? "要不起，可以不出" : "没有可出的牌";
    selected = new Set();
    render();
    return;
  }
  selected = new Set(choice.map((card) => card.id));
  toast = "";
  render();
}

function noteBoom(next) {
  const last = next.log[next.log.length - 1] || "";
  flash = "";
  app.classList.remove("shake");
  if (last.includes("王炸")) {
    flash = "王炸";
    app.classList.add("shake");
    tone(140, 0.28);
  } else if (last.includes("炸弹")) {
    flash = "炸弹";
    app.classList.add("shake");
    tone(180, 0.2);
  } else if (last.includes("不出")) tone(300, 0.05);
  else tone(520, 0.07);
}

async function proceed() {
  if (busy) return;
  busy = true;
  const mine = ++turnToken;
  try {
    render();
    while (mine === turnToken && state.phase !== "over" && state.turn !== HUMAN) {
      await wait(620);
      if (mine !== turnToken) return;
      if (state.phase === "bid") {
        const bid = aiBid(state.hands[state.turn], state.bidMax);
        const res = applyBid(state, state.turn, bid, makeRng());
        state = res.state;
      } else {
        const choice = aiChoose(state, state.turn);
        const res = applyPlay(state, state.turn, choice);
        if (!res.ok) {
          toast = res.error;
          break;
        }
        state = res.state;
        noteBoom(state);
      }
      render();
    }
    if (mine !== turnToken) return;
    if (state.phase === "over") saveScores();
    if (flash) await wait(680);
  } finally {
    if (mine !== turnToken) return;
    busy = false;
    flash = "";
    app.classList.remove("shake");
    render();
  }
}

newGame();
proceed();
