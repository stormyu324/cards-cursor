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
import { connectRoom } from "./net.js";

const HUMAN = 0;
const app = document.querySelector("#app");
const params = new URLSearchParams(location.search);
// The table is redrawn wholesale; forms live in `modal` so typing survives a redraw.
const view = document.createElement("div");
view.className = "view";
const modal = document.createElement("div");
app.append(view, modal);
const roomCode = /^\d{4}$/.test(params.get("room") || "") ? params.get("room") : null;

let state = null;
let selected = new Set();
let busy = false;
let turnToken = 0;
let toast = "";
let flash = "";
let showRules = false;
let soundOn = loadPref("ddz-sound");
let musicOn = loadPref("ddz-music");
let audio = null;
let musicBus = null;
let noise = null;
let net = null;
let room = null;
let link = "";
let fatal = "";
let lastSeq = null;
let turnEnds = 0;

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

function loadPref(key) {
  try {
    return localStorage.getItem(key) !== "off";
  } catch {
    return true;
  }
}

function savePref(key, on) {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    /* private mode can reject storage */
  }
}

// Browsers only let audio start from a user gesture, so the context is
// created and resumed on the first tap instead of at page load.
function unlockAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!audio) {
    audio = new Ctx();
    musicBus = audio.createGain();
    musicBus.gain.value = musicOn ? 1 : 0;
    musicBus.connect(audio.destination);
  }
  if (audio.state === "suspended") audio.resume();
}

function pluck(freq, start, dur, vol, type, dest) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(vol, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

function tone(freq, dur = 0.08, delay = 0, type = "triangle") {
  if (!soundOn || !audio) return;
  pluck(freq, audio.currentTime + delay, dur, 0.22, type, audio.destination);
}

// A short burst of filtered noise that reads as a card hitting the table.
function snap(delay = 0) {
  if (!soundOn || !audio) return;
  if (!noise) {
    noise = audio.createBuffer(1, audio.sampleRate * 0.1, audio.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  }
  const start = audio.currentTime + delay;
  const src = audio.createBufferSource();
  const filter = audio.createBiquadFilter();
  const gain = audio.createGain();
  src.buffer = noise;
  filter.type = "bandpass";
  filter.frequency.value = 1800;
  gain.gain.setValueAtTime(0.3, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.07);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(audio.destination);
  src.start(start);
  src.stop(start + 0.09);
}

function say(text) {
  if (!soundOn || !audio || typeof speechSynthesis === "undefined") return;
  const line = new SpeechSynthesisUtterance(text);
  line.lang = "zh-CN";
  line.rate = 1.25;
  line.volume = 0.9;
  speechSynthesis.cancel();
  speechSynthesis.speak(line);
}

function passSound() {
  tone(392, 0.1, 0, "sine");
  tone(262, 0.16, 0.09, "sine");
  tone(196, 0.22, 0.2, "triangle");
  say("不要");
}

function playSound(entry) {
  snap();
  snap(0.07);
  tone(523, 0.07, 0.02);
  tone(784, 0.12, 0.09);
  say(TYPE_NAME[entry.type] || "出牌");
}

function tickSound(critical) {
  tone(critical ? 988 : 740, critical ? 0.09 : 0.045, 0, "square");
}

function bidSound(bid) {
  tone(bid === 0 ? 280 : 440 + bid * 60, 0.1);
  say(BID_LINES[bid]);
}

const BID_LINES = ["不叫", "一分", "两分", "三分"];

// Background music: an eight-bar pentatonic loop, eight steps to the bar.
const MELODY = [
  659, 0, 784, 880, 784, 0, 659, 587,
  523, 0, 587, 659, 587, 0, 523, 440,
  392, 0, 440, 523, 587, 0, 659, 784,
  659, 0, 587, 0, 523, 0, 0, 0,
  880, 0, 784, 659, 784, 0, 880, 1047,
  880, 0, 784, 659, 587, 0, 659, 784,
  659, 0, 587, 523, 440, 0, 523, 587,
  523, 0, 0, 0, 392, 0, 0, 0,
];
const BASS = [131, 110, 131, 98, 110, 131, 110, 131];
const music = { step: 0, next: 0 };

function musicTempo() {
  if (state.phase === "bid") return 92;
  const fewest = Math.min(...state.hands.map((hand) => hand.length));
  return fewest <= 3 ? 136 : 108;
}

function musicTick() {
  const playing = musicOn && audio?.state === "running" && state && state.phase !== "over" && !document.hidden;
  if (!playing) {
    music.next = 0;
    return;
  }
  if (music.next < audio.currentTime) music.next = audio.currentTime + 0.05;
  const stepDur = 30 / musicTempo();
  while (music.next < audio.currentTime + 0.3) {
    const freq = MELODY[music.step];
    if (freq) pluck(freq, music.next, stepDur * 2.4, 0.07, "triangle", musicBus);
    if (music.step % 4 === 0) {
      const root = BASS[Math.floor(music.step / 8)];
      pluck(music.step % 8 === 0 ? root : root * 1.5, music.next, stepDur * 3, 0.09, "sine", musicBus);
    }
    music.next += stepDur;
    music.step = (music.step + 1) % MELODY.length;
  }
}

function jingle(win) {
  const notes = win ? [523, 659, 784, 1047] : [392, 330, 262];
  notes.forEach((freq, i) => tone(freq, win ? 0.2 : 0.3, i * (win ? 0.13 : 0.22)));
}

function humanWon() {
  return (state.winner === state.landlord) === (state.landlord === HUMAN);
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
    inner = `<span class="corner"><b>${big ? "大" : "小"}</b><b>王</b></span>`;
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
  return `<div class="cards" style="--n:${Math.max(2, entry.cards.length)}">${entry.cards.map((card) => cardMarkup(card, false)).join("")}</div><div class="type-chip">${TYPE_NAME[entry.type]}</div>`;
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
  if (!state) {
    renderLobby();
    return;
  }
  const bidding = state.phase === "bid";
  const myTurn = state.turn === HUMAN && state.phase !== "over";
  const landlordKnown = state.landlord >= 0;
  const overlap = handOverlap(state.hands[HUMAN].length);

  view.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <div class="seal">地主</div>
        <div>
          <h1>斗地主</h1>
          <p>${subtitle(landlordKnown)}</p>
        </div>
      </div>
      <div class="top-actions">
        ${topActions(true)}
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
      <div class="status">${toast || linkNote() || state.log[state.log.length - 1] || ""}</div>
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
  if (hand) layoutHand(hand);
  bind();
}

function subtitle(landlordKnown) {
  if (!roomCode) return landlordKnown ? `底分 ${state.base} · 倍数 ×${state.multiplier}` : "三人局 · 叫分";
  return `房间 ${roomCode}${landlordKnown ? ` · ${state.base}分×${state.multiplier}` : ""}`;
}

function topActions(full) {
  const toggle = (action, label, on) =>
    `<button type="button" class="ghost ${on ? "" : "off"}" data-action="${action}" aria-pressed="${on}">${label}</button>`;
  return `<button type="button" class="ghost" data-action="online">${roomCode ? "离开" : "联机"}</button>
    ${toggle("music", "音乐", musicOn)}
    ${toggle("sound", "音效", soundOn)}
    ${full ? `<button type="button" class="ghost" data-action="rules">规则</button>` : ""}`;
}

function linkNote() {
  if (!roomCode || link === "open") return "";
  return link === "closed" ? "连接断开，正在重连…" : "正在连接…";
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function renderLobby() {
  const seats = room?.seats || [null, null, null];
  const action = fatal
    ? `<button type="button" class="btn primary" data-action="online">返回单机</button>`
    : room?.host
      ? `<div class="hint">人到齐后开始，空位由电脑补上</div><button type="button" class="btn primary" data-action="start">开始游戏</button>`
      : `<div class="hint">${room ? "等待房主开始游戏" : ""}</div>`;
  view.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <div class="seal">地主</div>
        <div>
          <h1>斗地主</h1>
          <p>联机房间</p>
        </div>
      </div>
      <div class="top-actions">${topActions(false)}</div>
    </header>
    <section class="felt lobby">
      <div class="room-code"><span>房间号</span><b>${roomCode}</b></div>
      <button type="button" class="btn" data-action="copy">复制邀请链接</button>
      <ul class="seat-list">
        ${seats
          .map((seat) =>
            seat
              ? `<li>${escapeHtml(seat.name)}${seat.you ? "（你）" : ""}${seat.host ? " · 房主" : ""}</li>`
              : `<li class="empty">空位</li>`,
          )
          .join("")}
      </ul>
      <div class="status">${fatal || toast || linkNote()}</div>
    </section>
    <footer class="dock"><div class="actions">${action}</div></footer>
  `;
  bind();
}

function layoutHand(hand) {
  const cards = [...hand.querySelectorAll(".card")];
  const count = cards.length;
  if (count < 2) return;
  const cardWidth = cards[0].offsetWidth;
  const fit = () => {
    const available = hand.clientWidth;
    return Math.min(30, (available - cardWidth) / (count - 1));
  };
  const apply = (stride) => {
    cards.forEach((el, index) => {
      el.style.marginLeft = index === 0 ? "0px" : `${stride - cardWidth}px`;
    });
  };
  apply(fit());
  const overflow =
    cards[count - 1].getBoundingClientRect().right - hand.getBoundingClientRect().right;
  if (overflow > 0.5) apply(fit() - (overflow + 1) / (count - 1));
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
  const sitter = room?.names?.[player];
  const nick = !roomCode ? "" : !sitter ? "电脑" : `${escapeHtml(sitter.name)}${sitter.online ? "" : " · 托管"}`;
  return `<aside class="seat ${side}${thinking}">
    <div class="who">${seatName(player)}</div>
    ${nick ? `<div class="nick">${nick}</div>` : ""}
    ${tag}
    <div class="backs" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="count">${state.hands[player].length} 张${thinking ? ` <span data-clock></span>` : ""}</div>
  </aside>`;
}

function actions(bidding, myTurn) {
  const clock = `<span data-clock="mine"></span><span class="time-hint" data-time-hint></span>`;
  const note = `<div class="hint">${myTurn ? `${bidding ? "轮到你叫分" : selectionNote() || "轮到你了"} ${clock}` : "等待其他玩家"}</div>`;
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
        ${roomCode ? "" : `<button type="button" class="btn" data-action="again">重开本局</button>`}
        <button type="button" class="btn primary" data-action="close-rules">知道了</button>
      </div>
    </div>
  </div>`;
}

function resultDialog() {
  const landlordWin = state.winner === state.landlord;
  const humanWin = humanWon();
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
      <div class="reveal">
        ${[2, 1].map(revealHand).join("")}
      </div>
      <div class="row">
        ${roomCode ? "" : `<button type="button" class="btn" data-action="reset-score">积分清零</button>`}
        <button type="button" class="btn primary" data-action="again">再来一局</button>
      </div>
    </div>
  </div>`;
}

function revealHand(player) {
  const hand = state.hands[player];
  const title = `${seatName(player)}（${roleName(state, player)}）`;
  if (!hand.length) return `<div class="reveal-row"><span>${title} 出完了</span></div>`;
  return `<div class="reveal-row">
    <span>${title} 剩 ${hand.length} 张</span>
    <div class="mini-cards">${hand.map((card) => cardMarkup(card, false)).join("")}</div>
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
  app.querySelector("[data-action='sound']")?.addEventListener("click", () => {
    soundOn = !soundOn;
    savePref("ddz-sound", soundOn);
    if (!soundOn && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    tone(520, 0.06);
    render();
  });
  app.querySelector("[data-action='music']")?.addEventListener("click", () => {
    musicOn = !musicOn;
    savePref("ddz-music", musicOn);
    if (musicBus) musicBus.gain.value = musicOn ? 1 : 0;
    render();
  });
  app.querySelectorAll("[data-action='again']").forEach((el) => {
    el.addEventListener("click", () => (roomCode ? net?.send({ t: "again" }) : restart(state.scores)));
  });
  app.querySelector("[data-action='online']")?.addEventListener("click", () => {
    if (!roomCode) {
      openOnlineDialog();
      return;
    }
    net?.send({ t: "leave" });
    net?.close();
    location.search = "";
  });
  app.querySelector("[data-action='start']")?.addEventListener("click", () => net?.send({ t: "start" }));
  app.querySelector("[data-action='copy']")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast = "邀请链接已复制，发给朋友即可";
    } catch {
      toast = `复制失败，请把房间号 ${roomCode} 告诉朋友`;
    }
    render();
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
  for (let i = 0; i < 6; i += 1) snap(i * 0.07);
  proceed();
}

function toggle(id) {
  if (state.turn !== HUMAN || state.phase !== "play" || busy) return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  toast = "";
  tone(selected.has(id) ? 660 : 440, 0.04);
  render();
}

function humanBid(bid) {
  if (busy || state.phase !== "bid" || state.turn !== HUMAN) return;
  if (roomCode) {
    net?.send({ t: "bid", bid });
    return;
  }
  const res = applyBid(state, HUMAN, bid, makeRng());
  if (!res.ok) {
    toast = res.error;
    render();
    return;
  }
  state = res.state;
  bidSound(bid);
  proceed();
}

function humanPlay(forced) {
  if (busy || state.phase !== "play" || state.turn !== HUMAN) return;
  const cards = forced === null ? null : selectionCards();
  if (roomCode) {
    net?.send(cards ? { t: "play", ids: cards.map((card) => card.id) } : { t: "pass" });
    return;
  }
  const res = applyPlay(state, HUMAN, cards);
  if (!res.ok) {
    toast = res.error;
    render();
    return;
  }
  selected = new Set();
  toast = "";
  state = res.state;
  noteAction(state.table[HUMAN]);
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

function noteAction(entry) {
  flash = "";
  app.classList.remove("shake");
  if (entry.type === "rocket") {
    flash = "王炸";
    app.classList.add("shake");
    tone(140, 0.5, 0, "sawtooth");
    tone(70, 0.6, 0.05, "sawtooth");
    say("王炸");
  } else if (entry.type === "bomb") {
    flash = "炸弹";
    app.classList.add("shake");
    tone(180, 0.35, 0, "sawtooth");
    say("炸弹");
  } else if (entry.kind === "pass") passSound();
  else playSound(entry);
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
        bidSound(bid);
      } else {
        const actor = state.turn;
        const res = applyPlay(state, actor, aiChoose(state, actor));
        if (!res.ok) {
          toast = res.error;
          break;
        }
        state = res.state;
        noteAction(state.table[actor]);
      }
      render();
    }
    if (mine !== turnToken) return;
    if (state.phase === "over") {
      saveScores();
      jingle(humanWon());
    }
    if (flash) await wait(680);
  } finally {
    if (mine !== turnToken) return;
    busy = false;
    flash = "";
    app.classList.remove("shake");
    render();
  }
}

function stored(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode can reject storage */
  }
}

function playerId() {
  let pid = stored("ddz-pid");
  if (!pid) {
    pid = crypto.randomUUID();
    store("ddz-pid", pid);
  }
  return pid;
}

function openOnlineDialog(joining = "") {
  modal.innerHTML = `<div class="overlay">
    <form class="dialog online">
      <h2>${joining ? `加入房间 ${joining}` : "联机对战"}</h2>
      <p>${joining ? "起个昵称，让牌友认得你。" : "创建房间后把链接发给朋友；人不够时空位由电脑补上。"}</p>
      <label>昵称<input name="nick" maxlength="8" autocomplete="off" value="${escapeHtml(stored("ddz-name"))}" placeholder="最多 8 个字" /></label>
      ${joining ? "" : `<label>房间号<input name="code" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="加入朋友的房间时填写" /></label>`}
      <p class="note" role="alert"></p>
      <div class="row">
        <button type="button" class="btn" data-go="cancel">取消</button>
        ${
          joining
            ? `<button type="submit" class="btn primary" data-go="enter">进入房间</button>`
            : `<button type="button" class="btn" data-go="join">加入房间</button>
               <button type="submit" class="btn primary" data-go="create">创建房间</button>`
        }
      </div>
    </form>
  </div>`;
  const form = modal.querySelector("form");
  const note = form.querySelector(".note");
  const keepName = () => store("ddz-name", form.nick.value.trim() || "玩家");
  const go = {
    cancel() {
      modal.innerHTML = "";
      if (joining) location.search = "";
    },
    enter() {
      keepName();
      modal.innerHTML = "";
      startOnline();
    },
    join() {
      const code = form.code.value.trim();
      if (!/^\d{4}$/.test(code)) {
        note.textContent = "房间号是 4 位数字";
        return;
      }
      keepName();
      location.search = `?room=${code}`;
    },
    async create() {
      keepName();
      note.textContent = "正在创建房间…";
      try {
        const res = await fetch(new URL("api/create", location.href), { method: "POST" });
        const data = await res.json();
        if (!data.code) throw new Error(data.error || "create failed");
        location.search = `?room=${data.code}`;
      } catch {
        note.textContent = "联机服务暂时连不上，请稍后再试";
      }
    },
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    go[joining ? "enter" : "create"]();
  });
  form.querySelectorAll("button[type='button']").forEach((el) => {
    el.addEventListener("click", () => go[el.dataset.go]());
  });
}

function onRoomState(msg) {
  room = msg;
  state = msg.game;
  fatal = "";
  toast = "";
  const mine = new Set(state ? state.hands[HUMAN].map((card) => card.id) : []);
  selected = new Set([...selected].filter((id) => mine.has(id)));
  turnEnds = msg.turnLeft === null ? 0 : performance.now() + msg.turnLeft;

  const event = msg.event;
  const fresh = event && lastSeq !== null && event.seq !== lastSeq;
  lastSeq = event ? event.seq : 0;
  if (fresh) {
    if (event.kind === "deal") for (let i = 0; i < 6; i += 1) snap(i * 0.07);
    else if (event.kind === "bid") bidSound(event.bid);
    else noteAction(event);
    if (state.phase === "over") jingle(humanWon());
    if (flash) {
      setTimeout(() => {
        flash = "";
        app.classList.remove("shake");
        render();
      }, 680);
    }
  }
  render();
}

function startOnline() {
  const url = new URL(`api/room/${roomCode}/ws`, location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  net = connectRoom(
    url,
    { pid: playerId(), name: stored("ddz-name") },
    {
      state: onRoomState,
      status(next) {
        link = next;
        render();
      },
      error(message, isFatal) {
        if (isFatal) {
          fatal = message;
          state = null;
        } else toast = message;
        render();
      },
    },
  );
}

let clockWatch = 0;
let urged = false;
let hurried = false;
let clockSecond = null;

function tickClocks() {
  const left = turnEnds ? Math.max(0, Math.ceil((turnEnds - performance.now()) / 1000)) : null;
  if (turnEnds !== clockWatch) {
    clockWatch = turnEnds;
    urged = false;
    hurried = false;
    clockSecond = null;
  }
  const mine = Boolean(state && state.phase !== "over" && state.turn === HUMAN && left !== null);
  const low = mine && left <= 10;
  const critical = mine && left <= 5;
  app.classList.toggle("time-low", low);
  app.classList.toggle("time-critical", critical);
  app.querySelectorAll("[data-clock]").forEach((el) => {
    const own = el.dataset.clock === "mine";
    el.textContent = left === null ? "" : `${left}s`;
    el.classList.toggle("low", own ? low : left !== null && left <= 10);
    el.classList.toggle("critical", own ? critical : left !== null && left <= 5);
  });
  const hint = app.querySelector("[data-time-hint]");
  if (hint) {
    if (!mine) hint.textContent = "";
    else if (critical) hint.textContent = "时间不多了，快出牌";
    else if (low) hint.textContent = "还剩不到 10 秒";
    else hint.textContent = `还剩 ${left} 秒`;
  }
  if (mine && left !== null && left !== clockSecond) {
    if (left > 0 && left <= 10) tickSound(critical);
    if (left <= 10 && !urged) {
      urged = true;
      if (left > 5) say("时间不多了");
    }
    if (left <= 5 && left > 0 && !hurried) {
      hurried = true;
      say("快点出牌");
    }
  }
  clockSecond = left;
}

document.addEventListener("pointerdown", unlockAudio, true);
document.addEventListener("keydown", unlockAudio, true);
setInterval(musicTick, 100);
setInterval(tickClocks, 250);

if (!roomCode) {
  newGame();
  proceed();
} else if (stored("ddz-name")) {
  startOnline();
} else {
  render();
  openOnlineDialog(roomCode);
}
