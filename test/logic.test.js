'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../logic.js');

function withMockRandom(values, fn) {
  const original = Math.random;
  let i = 0;
  Math.random = () => values[Math.min(i++, values.length - 1)];
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

test('実際の獲得球：表示×14/15', () => {
  assert.equal(logic.toActualBalls(1200), 1120);
  assert.equal(logic.toActualBalls(1500), 1400);
  assert.equal(logic.toActualBalls(300), 280);
  assert.equal(logic.toActualBalls(7500), 7000);
});

test('合算 約1/199 ＝ 図柄揃い 1/399.9 ＋ チャージ 1/396', () => {
  assert.ok(close(1 / logic.P_TOTAL_HIT, 199.0, 0.1));
});

test('図柄揃いの振り分け：1200＋LT 51%／300＋LT 1%／1200で通常 48%', () => {
  assert.deepEqual(withMockRandom([0.50], () => logic.rollZugara()), { balls: 1200, lt: true, pct: 51 });
  assert.deepEqual(withMockRandom([0.515], () => logic.rollZugara()), { balls: 300, lt: true, pct: 1 });
  assert.deepEqual(withMockRandom([0.53], () => logic.rollZugara()), { balls: 1200, lt: false, pct: 48 });
});

test('一劇：保留5個の当たり数 × 1500個、0個なら半々でSTリセット', () => {
  // 保留：当・外・当・外・外 → 2個 3000
  const r = withMockRandom([0.1, 0.9, 0.1, 0.9, 0.9], () => logic.rollIchigeki());
  assert.deepEqual(r, { holds: [true, false, true, false, false], hits: 2, balls: 3000, reset: false });
  const miss = withMockRandom([0.9, 0.9, 0.9, 0.9, 0.9, 0.3], () => logic.rollIchigeki());
  assert.equal(miss.hits, 0);
  assert.equal(miss.reset, true);
  const miss2 = withMockRandom([0.9, 0.9, 0.9, 0.9, 0.9, 0.7], () => logic.rollIchigeki());
  assert.equal(miss2.reset, false);
});

test('一劇：V0（全部外れ）17.52%＝リセット 8.76%＋リセットなし 8.76%', () => {
  assert.ok(close(logic.ichigekiHitsProbability(0), 0.1752, 1e-9));
});

test('一劇の成功率 約82%（公開値）', () => {
  assert.ok(close(logic.ichigekiSuccessProbability(), 0.8248, 0.0005));
});

test('LTの振り分けが公開値（1500 40%／3000 33%／4500〜7500 17%／リセット 10%）に近い', () => {
  const t = logic.ltShareTable();
  const big = t.filter((r) => r.balls >= 4500).reduce((s, r) => s + r.share, 0);
  assert.ok(close(t[0].share, 0.40, 0.01), String(t[0].share));
  assert.ok(close(t[1].share, 0.33, 0.01), String(t[1].share));
  assert.ok(close(big, 0.17, 0.01), String(big));
  assert.ok(close(t[5].share, 0.10, 0.01), String(t[5].share));
});

test('LTの継続率 約80%（STリセット込み）', () => {
  assert.ok(close(logic.ltContinueProbability(), 0.80, 0.01), String(logic.ltContinueProbability()));
});

test('初当たりのLT突入率 約26%', () => {
  assert.ok(close(logic.ltEntryProbability(), 0.259, 0.002));
});

test('シミュレーションでも一劇の成功率が理論値に近い', () => {
  let ok = 0;
  const N = 40000;
  for (let i = 0; i < N; i++) if (logic.rollIchigeki().hits > 0) ok++;
  assert.ok(close(ok / N, logic.ichigekiSuccessProbability(), 0.01));
});
