// 欢乐斗地主规则：叫分、牌型比较、炸弹翻倍、春天 / 反春天。

export const RANK_LABEL = {
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "10",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
  15: "2",
  16: "小",
  17: "大",
};

export const SUIT_SYMBOL = { s: "♠", h: "♥", c: "♣", d: "♦", j: "" };

export const TYPE_NAME = {
  single: "单张",
  pair: "对子",
  triple: "三张",
  triple1: "三带一",
  triple2: "三带二",
  straight: "顺子",
  pairstraight: "连对",
  plane: "飞机",
  plane1: "飞机带单",
  plane2: "飞机带对",
  four2: "四带二",
  four4: "四带两对",
  bomb: "炸弹",
  rocket: "王炸",
};

const SUIT_ORDER = { d: 0, c: 1, h: 2, s: 3, j: 4 };

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function compareCards(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  return (SUIT_ORDER[a.suit] ?? 0) - (SUIT_ORDER[b.suit] ?? 0);
}

export function createDeck() {
  const cards = [];
  for (let rank = 3; rank <= 15; rank++) {
    for (const suit of ["s", "h", "c", "d"]) {
      cards.push({ id: `${suit}${rank}`, rank, suit });
    }
  }
  cards.push({ id: "sj", rank: 16, suit: "j" });
  cards.push({ id: "bj", rank: 17, suit: "j" });
  return cards;
}

export function shuffle(list, rng = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function seatName(player, self = 0) {
  if (player === self) return "你";
  if (player === (self + 1) % 3) return "下家";
  return "上家";
}

export function roleName(state, player) {
  if (state.landlord < 0) return "";
  return player === state.landlord ? "地主" : "农民";
}

function clone(state) {
  return structuredClone(state);
}

function freshTable() {
  return [null, null, null];
}

export function createGame(opts = {}) {
  const rng = opts.rng || Math.random;
  const scores = opts.scores ? [...opts.scores] : [0, 0, 0];
  const cards = shuffle(createDeck(), rng);
  const hands = [[], [], []];
  for (let i = 0; i < 51; i++) hands[i % 3].push(cards[i]);
  hands.forEach((h) => h.sort(compareCards));
  const start = opts.startPlayer ?? Math.floor(rng() * 3);
  return {
    hands,
    bottom: cards.slice(51).sort(compareCards),
    scores,
    phase: "bid",
    turn: ((start % 3) + 3) % 3,
    bidMax: 0,
    bidOwner: -1,
    bidCount: 0,
    bids: [null, null, null],
    landlord: -1,
    lastPlay: null,
    passes: 0,
    multiplier: 1,
    bombCount: 0,
    playedCount: [0, 0, 0],
    winner: -1,
    spring: false,
    springKind: "",
    roundScore: [0, 0, 0],
    base: 0,
    log: ["开始叫分"],
    table: freshTable(),
    dealId: opts.dealId ?? 1,
  };
}

export function legalBids(state) {
  const bids = [0];
  for (let b = state.bidMax + 1; b <= 3; b++) bids.push(b);
  return bids;
}

function pushLog(state, text) {
  state.log = [...state.log, text].slice(-24);
}

export function applyBid(state, player, bid, rng = Math.random) {
  if (state.phase !== "bid") return { ok: false, error: "现在不是叫分", state };
  if (state.turn !== player) return { ok: false, error: "还没轮到你", state };
  if (!legalBids(state).includes(bid)) return { ok: false, error: "叫分不合法", state };

  const s = clone(state);
  s.bids[player] = bid;
  s.bidCount += 1;
  if (bid > s.bidMax) {
    s.bidMax = bid;
    s.bidOwner = player;
  }
  pushLog(s, bid === 0 ? `${seatName(player)} 不叫` : `${seatName(player)} 叫 ${bid} 分`);

  const done = bid === 3 || s.bidCount === 3;
  if (!done) {
    s.turn = (player + 1) % 3;
    return { ok: true, state: s };
  }
  if (s.bidMax === 0) {
    const next = createGame({
      rng,
      scores: s.scores,
      dealId: (s.dealId || 1) + 1,
      startPlayer: (s.turn + 1) % 3,
    });
    next.log = ["无人叫分，重新发牌", "开始叫分"];
    return { ok: true, state: next, redeal: true };
  }

  s.landlord = s.bidOwner;
  s.hands[s.landlord] = s.hands[s.landlord].concat(s.bottom).sort(compareCards);
  s.phase = "play";
  s.turn = s.landlord;
  s.base = s.bidMax;
  s.multiplier = 1;
  s.lastPlay = null;
  s.passes = 0;
  s.table = freshTable();
  pushLog(s, `${seatName(s.landlord)} 以 ${s.bidMax} 分当地主`);
  return { ok: true, state: s };
}

function group(cards) {
  const map = new Map();
  for (const card of [...cards].sort(compareCards)) {
    if (!map.has(card.rank)) map.set(card.rank, []);
    map.get(card.rank).push(card);
  }
  return map;
}

export function groupCounts(cards) {
  const counts = new Map();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  return counts;
}

export function breaksBomb(hand, play) {
  if (!play || play.type === "bomb" || play.type === "rocket") return false;
  const counts = groupCounts(hand);
  const used = new Map();
  for (const card of play.cards) used.set(card.rank, (used.get(card.rank) || 0) + 1);
  for (const [rank, count] of used) {
    if (counts.get(rank) === 4 && count < 4) return true;
  }
  return false;
}

function chainRanks(start, length) {
  return Array.from({ length }, (_, i) => start + i);
}

function isChain(ranks) {
  const sorted = [...ranks].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) return false;
  }
  return sorted.length > 0 && sorted[sorted.length - 1] <= 14 && sorted[0] >= 3;
}

function pattern(type, rank, length, cards) {
  return {
    type,
    rank,
    length,
    cards: cards.slice().sort(compareCards),
  };
}

function matchPlane(countMap, total) {
  const maxSingle = Math.floor(total / 4);
  for (let n = maxSingle; n >= 2; n--) {
    if (total !== n * 4) continue;
    for (let start = 3; start <= 14 - n + 1; start++) {
      let ok = true;
      for (let i = 0; i < n; i++) {
        if ((countMap.get(start + i) || 0) < 3) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      let leftover = 0;
      for (const [rank, count] of countMap) {
        const used = rank >= start && rank < start + n ? 3 : 0;
        leftover += Math.max(0, count - used);
      }
      if (leftover === n) return pattern("plane1", start, n, []);
    }
  }
  const maxPair = Math.floor(total / 5);
  for (let n = maxPair; n >= 2; n--) {
    if (total !== n * 5) continue;
    for (let start = 3; start <= 14 - n + 1; start++) {
      let ok = true;
      for (let i = 0; i < n; i++) {
        if ((countMap.get(start + i) || 0) < 3) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const extras = [];
      for (const [rank, count] of countMap) {
        const used = rank >= start && rank < start + n ? 3 : 0;
        const left = count - used;
        if (left > 0) extras.push([rank, left]);
      }
      if (extras.length === n && extras.every(([, count]) => count === 2)) {
        return pattern("plane2", start, n, []);
      }
    }
  }
  return null;
}

export function identify(cards) {
  if (!cards || cards.length === 0) return null;
  const unique = new Set(cards.map((c) => c.id));
  if (unique.size !== cards.length) return null;

  const grouped = group(cards);
  const entries = [...grouped.entries()];
  const countMap = new Map(entries.map(([rank, list]) => [rank, list.length]));

  if (
    cards.length === 2 &&
    cards.some((c) => c.rank === 16) &&
    cards.some((c) => c.rank === 17)
  ) {
    return pattern("rocket", 17, 1, cards);
  }

  if (entries.length === 1) {
    const [rank, list] = entries[0];
    if (list.length === 1) return pattern("single", rank, 1, cards);
    if (list.length === 2) return pattern("pair", rank, 1, cards);
    if (list.length === 3) return pattern("triple", rank, 1, cards);
    if (list.length === 4) return pattern("bomb", rank, 1, cards);
    return null;
  }

  const ranks = entries.map(([rank]) => rank);
  if (entries.every(([, list]) => list.length === 1) && entries.length >= 5 && isChain(ranks)) {
    return pattern("straight", Math.min(...ranks), entries.length, cards);
  }
  if (entries.every(([, list]) => list.length === 2) && entries.length >= 3 && isChain(ranks)) {
    return pattern("pairstraight", Math.min(...ranks), entries.length, cards);
  }
  if (entries.every(([, list]) => list.length === 3) && entries.length >= 2 && isChain(ranks)) {
    return pattern("plane", Math.min(...ranks), entries.length, cards);
  }

  if (cards.length === 4) {
    const triple = entries.find(([, list]) => list.length === 3);
    const single = entries.find(([, list]) => list.length === 1);
    if (triple && single) return pattern("triple1", triple[0], 1, cards);
  }

  if (cards.length === 5) {
    const triple = entries.find(([, list]) => list.length === 3);
    const pair = entries.find(([, list]) => list.length === 2);
    if (triple && pair) return pattern("triple2", triple[0], 1, cards);
  }

  const winged = matchPlane(countMap, cards.length);
  if (winged) return pattern(winged.type, winged.rank, winged.length, cards);

  if (cards.length === 6) {
    const quad = entries.find(([, list]) => list.length === 4);
    if (quad) return pattern("four2", quad[0], 1, cards);
  }

  if (cards.length === 8) {
    const quads = entries.filter(([, list]) => list.length === 4);
    const pairs = entries.filter(([, list]) => list.length === 2);
    if (quads.length === 1 && pairs.length === 2) return pattern("four4", quads[0][0], 1, cards);
  }

  return null;
}

export function beats(next, prev) {
  if (!next) return false;
  if (!prev) return true;
  if (next.type === "rocket") return prev.type !== "rocket";
  if (prev.type === "rocket") return false;
  if (next.type === "bomb" && prev.type !== "bomb") return true;
  if (next.type === "bomb" && prev.type === "bomb") return next.rank > prev.rank;
  if (prev.type === "bomb") return false;
  if (next.type !== prev.type || next.length !== prev.length) return false;
  return next.rank > prev.rank;
}

function addPlay(found, seen, cards) {
  const pat = identify(cards);
  if (!pat) return false;
  const key = `${pat.type}:${pat.rank}:${pat.length}:${pat.cards.map((c) => c.id).join(".")}`;
  if (seen.has(key)) return true;
  seen.add(key);
  found.push(pat);
  return true;
}

function preferredPool(hand, cards) {
  const grouped = group(hand);
  return cards.slice().sort((a, b) => {
    const control = (c) => (c.rank >= 16 ? 2 : c.rank === 15 ? 1 : 0);
    const bombExtra = (c) => ((grouped.get(c.rank) || []).length >= 4 ? 1 : 0);
    const d0 = control(a) - control(b);
    if (d0) return d0;
    const d1 = bombExtra(a) - bombExtra(b);
    if (d1) return d1;
    return compareCards(a, b);
  });
}

function firstCombo(chainCards, pool, n, accept, limit = 400) {
  if (n === 0) return accept(chainCards) ? chainCards : null;
  const arr = pool.slice();
  let found = null;
  let tries = 0;
  const chosen = [];
  function walk(start) {
    if (found || tries >= limit) return;
    if (chosen.length === n) {
      tries += 1;
      const cards = chainCards.concat(chosen);
      if (accept(cards)) found = cards.slice();
      return;
    }
    for (let i = start; i < arr.length; i++) {
      chosen.push(arr[i]);
      walk(i + 1);
      chosen.pop();
      if (found || tries >= limit) return;
    }
  }
  walk(0);
  return found;
}

function takeExact(grouped, rank, count) {
  const list = grouped.get(rank) || [];
  if (list.length < count) return null;
  return list.slice(0, count);
}

export function generatePlays(hand, prev = null) {
  const found = [];
  const seen = new Set();
  const consider = (cards) => {
    const pat = identify(cards);
    if (!pat) return;
    if (prev && !beats(pat, prev)) return;
    addPlay(found, seen, cards);
  };

  const grouped = group(hand);
  const ranks = [...grouped.keys()].sort((a, b) => a - b);

  for (const card of hand) consider([card]);

  for (const rank of ranks) {
    const list = grouped.get(rank);
    if (list.length >= 2 && rank < 16) consider(list.slice(0, 2));
    if (list.length >= 3 && rank < 16) consider(list.slice(0, 3));
    if (list.length === 4) consider(list.slice(0, 4));
  }

  const small = hand.find((c) => c.rank === 16);
  const big = hand.find((c) => c.rank === 17);
  if (small && big) consider([small, big]);

  for (let len = 5; len <= 12; len++) {
    for (let start = 3; start <= 14 - len + 1; start++) {
      const cards = [];
      let ok = true;
      for (const rank of chainRanks(start, len)) {
        const one = takeExact(grouped, rank, 1);
        if (!one) {
          ok = false;
          break;
        }
        cards.push(one[0]);
      }
      if (ok) consider(cards);
    }
  }

  for (let len = 3; len <= 10; len++) {
    for (let start = 3; start <= 14 - len + 1; start++) {
      const cards = [];
      let ok = true;
      for (const rank of chainRanks(start, len)) {
        const pair = takeExact(grouped, rank, 2);
        if (!pair) {
          ok = false;
          break;
        }
        cards.push(...pair);
      }
      if (ok) consider(cards);
    }
  }

  for (let len = 2; len <= 6; len++) {
    for (let start = 3; start <= 14 - len + 1; start++) {
      const chain = [];
      let ok = true;
      for (const rank of chainRanks(start, len)) {
        const triple = takeExact(grouped, rank, 3);
        if (!triple) {
          ok = false;
          break;
        }
        chain.push(...triple);
      }
      if (!ok) continue;
      consider(chain);

      const used = new Set(chain.map((c) => c.id));
      const pool = preferredPool(
        hand,
        hand.filter((c) => !used.has(c.id)),
      );
      const singles = firstCombo(chain, pool, len, (cards) => {
        const pat = identify(cards);
        return pat && pat.type === "plane1" && pat.rank === start && pat.length === len;
      });
      if (singles) consider(singles);

      const pairGroups = [];
      const leftover = group(pool);
      for (const [rank, list] of leftover) {
        if (list.length >= 2 && rank < 16) pairGroups.push(list.slice(0, 2));
      }
      pairGroups.sort((a, b) => {
        const penalty = (pair) => {
          const have = grouped.get(pair[0].rank).length;
          return (have >= 4 ? 2 : 0) + (pair[0].rank >= 15 ? 1 : 0);
        };
        return penalty(a) - penalty(b) || a[0].rank - b[0].rank;
      });
      const chosen = [];
      let wing = null;
      function pickPairs(startIndex) {
        if (wing) return;
        if (chosen.length === len) {
          const cards = chain.concat(chosen.flat());
          const pat = identify(cards);
          if (pat && pat.type === "plane2" && pat.rank === start && pat.length === len) wing = cards;
          return;
        }
        for (let i = startIndex; i < pairGroups.length; i++) {
          chosen.push(pairGroups[i]);
          pickPairs(i + 1);
          chosen.pop();
          if (wing) return;
        }
      }
      pickPairs(0);
      if (wing) consider(wing);
    }
  }

  for (const rank of ranks) {
    const list = grouped.get(rank);
    if (list.length !== 4) continue;
    const others = preferredPool(
      hand,
      hand.filter((c) => c.rank !== rank),
    );
    const two = firstCombo(list, others, 2, (cards) => {
      const pat = identify(cards);
      return pat && pat.type === "four2" && pat.rank === rank;
    });
    if (two) consider(two);

    const pairRanks = ranks.filter((r) => r !== rank && grouped.get(r).length >= 2 && r < 16);
    pairRanks.sort((a, b) => {
      const pa = grouped.get(a).length >= 4 ? 1 : 0;
      const pb = grouped.get(b).length >= 4 ? 1 : 0;
      return pa - pb || a - b;
    });
    if (pairRanks.length >= 2) {
      consider(list.concat(grouped.get(pairRanks[0]).slice(0, 2), grouped.get(pairRanks[1]).slice(0, 2)));
    }
  }

  for (const rank of ranks) {
    if ((grouped.get(rank) || []).length < 3 || rank >= 16) continue;
    const triple = grouped.get(rank).slice(0, 3);
    const others = preferredPool(
      hand,
      hand.filter((c) => c.rank !== rank),
    );
    const withOne = firstCombo(triple, others, 1, (cards) => identify(cards)?.type === "triple1");
    if (withOne) consider(withOne);
    const pairRank = ranks.find((r) => r !== rank && r < 16 && grouped.get(r).length >= 2 && grouped.get(r).length < 4)
      || ranks.find((r) => r !== rank && r < 16 && grouped.get(r).length >= 2);
    if (pairRank) consider(triple.concat(grouped.get(pairRank).slice(0, 2)));
  }

  return found;
}

function settle(state, winner) {
  const landlord = state.landlord;
  const landlordWin = winner === landlord;
  const peasantsQuiet = [0, 1, 2]
    .filter((p) => p !== landlord)
    .every((p) => state.playedCount[p] === 0);
  const antiSpring = !landlordWin && state.playedCount[landlord] <= 1;
  const spring = landlordWin ? peasantsQuiet : antiSpring;
  if (spring) state.multiplier *= 2;
  const delta = state.base * state.multiplier;
  state.spring = spring;
  state.springKind = spring ? (landlordWin ? "春天" : "反春天") : "";
  state.roundScore = [0, 0, 0];
  if (landlordWin) {
    state.roundScore[landlord] = delta * 2;
    for (const p of [0, 1, 2]) if (p !== landlord) state.roundScore[p] = -delta;
  } else {
    state.roundScore[landlord] = -delta * 2;
    for (const p of [0, 1, 2]) if (p !== landlord) state.roundScore[p] = delta;
  }
  state.scores = state.scores.map((score, i) => score + state.roundScore[i]);
  state.phase = "over";
  state.winner = winner;
  const who = landlordWin ? "地主胜" : "农民胜";
  pushLog(state, state.springKind ? `${who} · ${state.springKind}` : who);
}

export function applyPlay(state, player, cards) {
  if (state.phase !== "play") return { ok: false, error: "现在不能出牌", state };
  if (state.turn !== player) return { ok: false, error: "还没轮到你", state };

  const passing = !cards || cards.length === 0;
  if (passing) {
    if (!state.lastPlay) return { ok: false, error: "领出必须出牌", state };
    const s = clone(state);
    s.table = s.table.slice();
    s.table[player] = { kind: "pass" };
    s.passes += 1;
    pushLog(s, `${seatName(player)} 不出`);
    if (s.passes >= 2) {
      s.turn = s.lastPlay.player;
      s.lastPlay = null;
      s.passes = 0;
      pushLog(s, `${seatName(s.turn)} 获得出牌权`);
    } else {
      s.turn = (player + 1) % 3;
    }
    return { ok: true, state: s };
  }

  const hand = state.hands[player];
  const selected = [];
  for (const card of cards) {
    const found = hand.find((c) => c.id === card.id);
    if (!found) return { ok: false, error: "手里没有这些牌", state };
    selected.push(found);
  }
  const pat = identify(selected);
  if (!pat) return { ok: false, error: "牌型不符合规则", state };
  if (state.lastPlay && !beats(pat, state.lastPlay)) {
    return { ok: false, error: "大不过上家", state };
  }

  const s = clone(state);
  const ids = new Set(pat.cards.map((c) => c.id));
  s.hands[player] = s.hands[player].filter((c) => !ids.has(c.id));
  if (!s.lastPlay) s.table = freshTable();
  else s.table = s.table.slice();
  s.table[player] = {
    kind: "play",
    type: pat.type,
    cards: pat.cards.map((c) => ({ ...c })),
  };
  s.lastPlay = {
    player,
    type: pat.type,
    rank: pat.rank,
    length: pat.length,
    cards: pat.cards.map((c) => ({ ...c })),
  };
  s.passes = 0;
  s.playedCount[player] += 1;
  if (pat.type === "bomb" || pat.type === "rocket") {
    s.multiplier *= 2;
    s.bombCount += 1;
  }
  pushLog(s, `${seatName(player)} 打出${TYPE_NAME[pat.type]}`);
  if (s.hands[player].length === 0) {
    settle(s, player);
    return { ok: true, state: s };
  }
  s.turn = (player + 1) % 3;
  return { ok: true, state: s };
}
