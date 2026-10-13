import { generatePlays, groupCounts, breaksBomb } from "./engine.js";

function threatOf(state, me) {
  let min = 99;
  for (let p = 0; p < 3; p++) if (p !== me) min = Math.min(min, state.hands[p].length);
  return min;
}

export function handStrength(hand) {
  const counts = groupCounts(hand);
  let score = 0;
  const hasSmall = hand.some((c) => c.rank === 16);
  const hasBig = hand.some((c) => c.rank === 17);
  if (hasSmall && hasBig) score += 8;
  else if (hasBig) score += 3;
  else if (hasSmall) score += 2;
  score += (counts.get(15) || 0) * 2;
  score += (counts.get(14) || 0) * 0.4;
  for (const [, count] of counts) if (count === 4) score += 6;
  return score;
}

export function aiBid(hand, bidMax) {
  const score = handStrength(hand);
  let want = 0;
  if (score >= 11) want = 3;
  else if (score >= 7.5) want = 2;
  else if (score >= 4) want = 1;
  return want > bidMax ? want : 0;
}

function leadScore(hand, play) {
  const avg = play.cards.reduce((sum, card) => sum + card.rank, 0) / play.cards.length;
  let score = play.cards.length * 36 - avg * 1.6;
  if (play.type === "bomb" || play.type === "rocket") score -= 500;
  if (breaksBomb(hand, play)) score -= 420;
  if (play.cards.some((c) => c.rank >= 16)) score -= 80;
  else if (play.cards.some((c) => c.rank === 15)) score -= 36;
  return score;
}

function followScore(hand, play) {
  let score = play.rank * 100 + play.cards.reduce((sum, card) => sum + card.rank, 0);
  if (play.type === "bomb" || play.type === "rocket") score += 5000;
  if (breaksBomb(hand, play)) score += 8000;
  if (play.cards.some((c) => c.rank >= 16)) score += 900;
  else if (play.cards.some((c) => c.rank === 15)) score += 420;
  return score;
}

function lowest(hand, plays) {
  return plays.slice().sort((a, b) => followScore(hand, a) - followScore(hand, b))[0];
}

function bestLead(hand, plays) {
  return plays.slice().sort((a, b) => leadScore(hand, b) - leadScore(hand, a))[0];
}

export function aiChoose(state, player) {
  const hand = state.hands[player];
  const prev = state.lastPlay;
  const plays = generatePlays(hand, prev);
  if (!plays.length) return null;

  const finish = plays.find((play) => play.cards.length === hand.length);
  if (finish) return finish.cards;

  const natural = plays.filter(
    (play) => play.type !== "bomb" && play.type !== "rocket" && !breaksBomb(hand, play),
  );
  const bombs = plays.filter((play) => play.type === "bomb" || play.type === "rocket");
  const landlord = state.landlord;
  const isLandlord = player === landlord;
  const landlordLeft = state.hands[landlord].length;
  const myLeft = hand.length;

  if (!prev) {
    const threat = threatOf(state, player);
    if (threat === 1) {
      const compounds = natural.filter((play) => play.type !== "single");
      if (compounds.length) return bestLead(hand, compounds).cards;
      const singles = plays.filter((play) => play.type === "single");
      return singles.slice().sort((a, b) => b.rank - a.rank)[0].cards;
    }
    const pool = natural.length ? natural : plays;
    return bestLead(hand, pool).cards;
  }

  const partnerPlayed = !isLandlord && prev.player !== landlord && prev.player !== player;
  if (partnerPlayed && landlordLeft > 3 && myLeft > 2) return null;

  const prevLeft = state.hands[prev.player].length;
  const mustContest =
    prevLeft <= 2 ||
    (!isLandlord && landlordLeft <= 2 && prev.player === landlord) ||
    myLeft <= 4;

  if (natural.length) {
    const best = lowest(hand, natural);
    const spendsControl = best.cards.some((c) => c.rank >= 15);
    const early = myLeft > 8 && landlordLeft > 5 && prev.rank < 12;
    if (spendsControl && early && !mustContest) return null;
    return best.cards;
  }

  if (mustContest && bombs.length) return lowest(hand, bombs).cards;
  return null;
}
