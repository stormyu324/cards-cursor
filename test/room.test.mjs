import test from "node:test";
import assert from "node:assert/strict";
import { mulberry32 } from "../js/engine.js";
import { AI_DELAY, AWAY_DELAY, Room, TURN_LIMIT, cleanName } from "../server/room.js";

function lobby(...pids) {
  const room = new Room();
  room.claim(0);
  for (const pid of pids) assert.equal(room.join(pid, pid, 0).ok, true);
  return room;
}

test("a room must be claimed before anyone can join, and holds three players", () => {
  const room = new Room();
  assert.equal(room.join("a", "A", 0).ok, false);
  room.claim(0);
  assert.equal(room.taken(1000), true);
  for (const pid of ["a", "b", "c"]) assert.equal(room.join(pid, pid, 0).ok, true);
  assert.equal(room.join("d", "D", 0).error, "房间已满");
  assert.equal(room.join("b", "B2", 0).seat, 1);
  assert.equal(room.seats[1].name, "B2");
});

test("only the host starts the first deal, and the host moves on when they leave", () => {
  const room = lobby("a", "b");
  assert.equal(room.start("b", 0).ok, false);
  room.leave("a");
  assert.equal(room.host, "b");
  assert.equal(room.start("b", 0).ok, true);
  assert.equal(room.start("b", 0).error, "牌局进行中");
});

test("names are stripped of markup", () => {
  assert.equal(cleanName("<b>阿 明</b>"), "b阿明/b");
  assert.equal(cleanName(""), "玩家");
  assert.equal(cleanName("一二三四五六七八九十"), "一二三四五六七八");
});

test("each player sees only their own hand, rotated to seat 0", () => {
  const room = lobby("a", "b", "c");
  room.start("a", 0, mulberry32(5));
  const game = room.game;
  ["a", "b", "c"].forEach((pid, seat) => {
    const view = room.view(pid, 0);
    assert.deepEqual(view.game.hands[0], game.hands[seat]);
    assert.deepEqual(view.game.hands[1], game.hands[(seat + 1) % 3].map(() => null));
    assert.deepEqual(view.game.hands[2], game.hands[(seat + 2) % 3].map(() => null));
    assert.deepEqual(view.game.bottom, []);
    assert.equal(view.game.turn, (game.turn - seat + 3) % 3);
    assert.equal(JSON.stringify(view).includes(game.hands[(seat + 1) % 3][0].id), false);
  });
});

test("actions are checked against the sender's own seat and hand", () => {
  const room = lobby("a", "b", "c");
  room.start("a", 0, mulberry32(5));
  const turn = room.game.turn;
  const pids = ["a", "b", "c"];
  assert.equal(room.bid(pids[(turn + 1) % 3], 1, 0).error, "还没轮到你");
  assert.equal(room.bid("stranger", 1, 0).ok, false);
  assert.equal(room.bid(pids[turn], 3, 0).ok, true);
  assert.equal(room.game.landlord, turn);
  const other = room.game.hands[(turn + 1) % 3][0];
  assert.equal(room.play(pids[turn], [other.id], 0).error, "手里没有这些牌");
  const view = room.view(pids[(turn + 1) % 3], 0);
  assert.equal(view.game.landlord, 2);
  assert.equal(view.game.log.at(-1), "上家 以 3 分当地主");
  assert.equal(view.game.bottom.length, 3);
});

test("the computer fills empty seats, covers absent players, and times out idle ones", () => {
  const room = lobby("a", "b");
  room.start("a", 0, mulberry32(9));
  for (let p = 0; p < 3; p += 1) {
    room.game.turn = p;
    room.turnAt = 1000;
    const expected = p === 2 ? AI_DELAY : TURN_LIMIT;
    assert.equal(room.nextAuto(1000), expected);
  }
  room.drop("b");
  assert.equal(room.seats[1].online, false);
  room.game.turn = 1;
  assert.equal(room.nextAuto(1000), AWAY_DELAY);
  assert.equal(room.nextAuto(1000 + TURN_LIMIT), 0);
  assert.equal(room.view("a", 1000).turnLeft, null);
  assert.equal(room.join("b", "b", 2000).seat, 1);
  assert.equal(room.view("a", 2000).turnLeft, TURN_LIMIT - 1000);
});

test("a full game on autopilot ends zero-sum, reveals hands, and carries scores into the next deal", () => {
  const room = lobby("a");
  const rng = mulberry32(21);
  room.start("a", 0, rng);
  let steps = 0;
  while (room.playing() && steps < 400) {
    assert.equal(room.auto(steps, rng).ok, true);
    steps += 1;
  }
  assert.equal(room.game.phase, "over");
  assert.equal(room.nextAuto(0), null);
  assert.equal(room.scores.reduce((a, b) => a + b, 0), 0);
  assert.notDeepEqual(room.scores, [0, 0, 0]);
  const view = room.view("a", 0);
  assert.ok(view.game.hands.flat().every(Boolean));
  const scores = [...room.scores];
  assert.equal(room.start("a", 0, rng).ok, true);
  assert.deepEqual(room.game.scores, scores);
  assert.equal(room.event.kind, "deal");
});

test("a snapshot restores the game with everyone marked offline", () => {
  const room = lobby("a", "b");
  room.start("a", 0, mulberry32(3));
  const copy = new Room(JSON.parse(JSON.stringify(room.snapshot())));
  assert.deepEqual(copy.game, room.game);
  assert.deepEqual(copy.seats.map((seat) => seat && seat.online), [false, false, null]);
  assert.equal(copy.join("a", "a", 5).seat, 0);
});
