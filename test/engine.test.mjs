import assert from "node:assert/strict";
import test from "node:test";
import { aiBid, aiChoose } from "../js/ai.js";
import {
  applyBid,
  applyPlay,
  beats,
  createGame,
  generatePlays,
  identify,
  legalBids,
  mulberry32,
  TYPE_NAME,
} from "../js/engine.js";

const RANK = {
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
  2: 15,
};

function cards(spec) {
  return spec
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token, index) => {
      if (token === "sj") return { id: `sj${index}`, rank: 16, suit: "j" };
      if (token === "bj") return { id: `bj${index}`, rank: 17, suit: "j" };
      const match = token.match(/^(10|[3-9JQKA2])([shdc])$/);
      if (!match) throw new Error(`bad card ${token}`);
      return {
        id: `${token}${index}`,
        rank: RANK[match[1]],
        suit: match[2],
      };
    });
}

function kind(spec) {
  const pat = identify(cards(spec));
  assert.ok(pat, `expected a pattern: ${spec}`);
  return pat;
}

test("recognizes the standard patterns", () => {
  assert.equal(kind("7s").type, "single");
  assert.equal(kind("7s 7h").type, "pair");
  assert.equal(kind("7s 7h 7d").type, "triple");
  assert.equal(kind("7s 7h 7d 7c").type, "bomb");
  assert.equal(kind("sj bj").type, "rocket");
  assert.equal(kind("Qs Qh Qd 3s").type, "triple1");
  assert.equal(kind("Qs Qh Qd 3s 3h").type, "triple2");
  assert.equal(kind("3s 4h 5d 6c 7s").type, "straight");
  assert.equal(kind("10s Jh Qd Kc As").type, "straight");
  assert.equal(kind("9s 10h Jd Qc Ks Ah").length, 6);
  assert.equal(kind("3s 3h 4d 4c 5s 5h").type, "pairstraight");
  assert.equal(kind("6s 6h 6d 7c 7s 7h").type, "plane");
  assert.equal(kind("6s 6h 6d 7c 7s 7h 4d 8c").type, "plane1");
  assert.equal(kind("6s 6h 6d 7c 7s 7h 4d 4c 8s 8h").type, "plane2");
  assert.equal(kind("8s 8h 8d 8c 4s 9h").type, "four2");
  assert.equal(kind("8s 8h 8d 8c 4s 4h 9d 9c").type, "four4");
  assert.equal(kind("3s 3h 3d 3c 4s 4h 4d 4c").type, "plane1");
});

test("rejects sequences that include 2 or jokers", () => {
  assert.equal(identify(cards("As 2s 3s 4s 5s")), null);
  assert.equal(identify(cards("10s Jh Qd Kc As 2h")), null);
  assert.equal(identify(cards("Qs Qh Ks Kh As Ah 2s 2h")), null);
  assert.equal(identify(cards("As Ah Ad 2s 2h 2d")), null);
  assert.equal(identify(cards("sj bj 3s")), null);
  assert.equal(identify(cards("3s 4h 5d 6c")), null);
  assert.equal(identify(cards("3s 3h 4d 4c")), null);
});

test("compares plays by rank, length, bombs, and rocket", () => {
  const single4 = kind("4s");
  const single5 = kind("5s");
  const ace = kind("As");
  const two = kind("2s");
  const small = kind("sj");
  const big = kind("bj");
  assert.equal(beats(single5, single4), true);
  assert.equal(beats(single4, single5), false);
  assert.equal(beats(two, ace), true);
  assert.equal(beats(small, two), true);
  assert.equal(beats(big, small), true);
  assert.equal(beats(kind("Ks Kh"), kind("Qs Qh")), true);
  assert.equal(beats(kind("9s 10h Jd Qc Ks"), kind("8s 9h 10d Jc Qs")), true);
  assert.equal(beats(kind("9s 10h Jd Qc Ks Ah"), kind("8s 9h 10d Jc Qs")), false);
  assert.equal(beats(kind("7s 7h 7d 7c"), kind("3s 4h 5d 6c 7s")), true);
  assert.equal(beats(kind("2s 2h 2d 2c"), kind("As Ah Ad Ac")), true);
  assert.equal(beats(kind("sj bj"), kind("2s 2h 2d 2c")), true);
  assert.equal(beats(kind("As Ah Ad Ac"), kind("sj bj")), false);
  assert.equal(beats(kind("8s 8h 8d 4s"), kind("7s 7h 7d 3s")), true);
  assert.equal(beats(kind("8s 8h 8d 4s"), kind("7s 7h 7d")), false);
  assert.equal(beats(single5, single5), false);
  assert.equal(beats(kind("sj bj"), kind("sj bj")), false);
});

test("type names cover every pattern the engine can return", () => {
  for (const spec of ["7s", "7s 7h", "sj bj", "3s 4h 5d 6c 7s", "8s 8h 8d 8c"]) {
    assert.ok(TYPE_NAME[kind(spec).type]);
  }
});

test("generated plays identify as themselves and beat the previous play", () => {
  const rng = mulberry32(7);
  for (let n = 0; n < 40; n++) {
    const game = createGame({ rng, startPlayer: 0 });
    const hand = game.hands[0].concat(n % 3 === 0 ? game.bottom : []);
    const leads = generatePlays(hand, null);
    assert.ok(leads.length >= hand.length);
    for (const play of leads) {
      const again = identify(play.cards);
      assert.equal(again.type, play.type);
      assert.equal(again.rank, play.rank);
      assert.equal(again.length, play.length);
      assert.equal(beats(play, play), false);
    }
    const low = leads.find((play) => play.type === "single");
    const replies = generatePlays(hand, low);
    for (const play of replies) assert.equal(beats(play, low), true);
  }
});

test("bidding ends on three, rejects a lower bid, and redeals if everyone passes", () => {
  let state = createGame({ rng: mulberry32(3), startPlayer: 0 });
  assert.deepEqual(legalBids(state), [0, 1, 2, 3]);
  let res = applyBid(state, 0, 1);
  state = res.state;
  assert.equal(applyBid(state, 1, 1).ok, false);
  res = applyBid(state, 1, 3);
  state = res.state;
  assert.equal(state.phase, "play");
  assert.equal(state.landlord, 1);
  assert.equal(state.turn, 1);
  assert.equal(state.hands[1].length, 20);
  assert.equal(state.hands[0].length, 17);
  assert.equal(state.base, 3);

  state = createGame({ rng: mulberry32(5), startPlayer: 0 });
  state = applyBid(state, 0, 0).state;
  state = applyBid(state, 1, 0).state;
  res = applyBid(state, 2, 0, mulberry32(99));
  assert.equal(res.redeal, true);
  assert.equal(res.state.phase, "bid");
  assert.equal(res.state.bidCount, 0);
  assert.match(res.state.log[0], /重新发牌/);
});

function playState(partial) {
  return {
    hands: [[], [], []],
    bottom: [],
    scores: [0, 0, 0],
    phase: "play",
    turn: 0,
    bidMax: 1,
    bidOwner: 0,
    bidCount: 3,
    bids: [1, 0, 0],
    landlord: 0,
    lastPlay: null,
    passes: 0,
    multiplier: 1,
    bombCount: 0,
    playedCount: [0, 0, 0],
    winner: -1,
    spring: false,
    springKind: "",
    roundScore: [0, 0, 0],
    base: 1,
    log: [],
    table: [null, null, null],
    dealId: 1,
    ...partial,
  };
}

test("two passes return the lead, and a lead cannot pass", () => {
  let state = playState({
    hands: [cards("3s 4s"), cards("5s"), cards("6s")],
    landlord: 0,
    turn: 0,
  });
  assert.equal(applyPlay(state, 0, null).ok, false);
  state = applyPlay(state, 0, [state.hands[0][0]]).state;
  assert.equal(state.turn, 1);
  state = applyPlay(state, 1, null).state;
  state = applyPlay(state, 2, null).state;
  assert.equal(state.turn, 0);
  assert.equal(state.lastPlay, null);
  assert.equal(state.table[1].kind, "pass");
  assert.equal(state.table[2].kind, "pass");
});

test("spring doubles the landlord and anti-spring pays the peasants", () => {
  let state = playState({
    hands: [cards("3s"), cards("4s"), cards("5s")],
  });
  state = applyPlay(state, 0, [state.hands[0][0]]).state;
  assert.equal(state.phase, "over");
  assert.equal(state.springKind, "春天");
  assert.deepEqual(state.roundScore, [4, -2, -2]);
  assert.equal(state.scores.reduce((a, b) => a + b, 0), 0);

  state = playState({
    hands: [cards("9s 8s 7s"), cards("4s"), cards("3s")],
    playedCount: [1, 0, 0],
    turn: 2,
    landlord: 0,
  });
  state = applyPlay(state, 2, [state.hands[2][0]]).state;
  assert.equal(state.springKind, "反春天");
  assert.deepEqual(state.roundScore, [-4, 2, 2]);

  state = playState({
    hands: [cards("9s"), cards("4s"), cards("3s")],
    playedCount: [2, 1, 0],
    turn: 0,
  });
  state = applyPlay(state, 0, [state.hands[0][0]]).state;
  assert.equal(state.springKind, "");
  assert.deepEqual(state.roundScore, [2, -1, -1]);
});

test("a bomb doubles the multiplier before settlement", () => {
  const state = playState({
    hands: [cards("5s 5h 5d 5c"), cards("As"), cards("Ks")],
    base: 2,
    bidMax: 2,
  });
  const next = applyPlay(state, 0, state.hands[0]).state;
  assert.equal(next.bombCount, 1);
  assert.equal(next.multiplier, 4);
  assert.deepEqual(next.roundScore, [16, -8, -8]);
});

test("ai finishes games with a zero-sum score", () => {
  const wins = [0, 0];
  for (let seed = 1; seed <= 24; seed++) {
    let state = createGame({ rng: mulberry32(seed), startPlayer: seed % 3 });
    let redeals = 0;
    for (let step = 0; step < 2500 && state.phase !== "over"; step++) {
      const ids = state.hands.flat().map((c) => c.id);
      assert.equal(new Set(ids).size, ids.length);
      if (state.phase === "bid") {
        const bid = aiBid(state.hands[state.turn], state.bidMax);
        assert.ok(legalBids(state).includes(bid));
        const res = applyBid(state, state.turn, bid, mulberry32(seed * 1000 + step));
        assert.equal(res.ok, true, res.error);
        if (res.redeal) redeals += 1;
        state = res.state;
      } else {
        const choice = aiChoose(state, state.turn);
        const res = applyPlay(state, state.turn, choice);
        assert.equal(res.ok, true, res.error);
        state = res.state;
      }
    }
    assert.equal(state.phase, "over", `seed ${seed} did not finish, redeals ${redeals}`);
    assert.equal(state.hands[state.winner].length, 0);
    assert.equal(state.scores.reduce((a, b) => a + b, 0), 0);
    wins[state.winner === state.landlord ? 0 : 1] += 1;
  }
  assert.ok(wins[0] > 0 && wins[1] > 0, `expected both sides to win, got ${wins}`);
});
