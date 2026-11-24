'use strict';

// カラサー2 の確率・振り分け。DOMに依存しない純粋なロジックだけを置く。
// 数値の出典と決め方は docs/spec.md を参照。

// ---- 遊技条件 ----
// 等価（4円/玉）固定。1000円=250玉。
const YEN_PER_BALL = 4;
const SPIN_RATE_OPTIONS = [12, 14, 16.8, 18, 20];
const DEFAULT_SPIN_RATE = 16.8; // ボーダー（docs/spec.md）

function calcSpinCost(spinRate) {
  return 250 / spinRate;
}

// 表示出玉 → 実際の獲得球。15個賞球×10カウントなので、1カウントあたり14個だけ増える（表示×14/15）。
// 1200→1120、1500→1400、300→280
function toActualBalls(nominal) {
  return nominal - nominal / 15;
}

// ---- 通常時 ----
// 図柄揃い 1/399.9 ＋ からくりチャージ 1/396 ＝ 合算 約1/199
const P_ZUGARA = 1 / 399.9;
const P_CHARGE = 1 / 396;
const P_TOTAL_HIT = P_ZUGARA + P_CHARGE;
const P_NORMAL_HIT = P_TOTAL_HIT;

function spinNormal() {
  return Math.random() < P_NORMAL_HIT ? 'hit' : 'miss';
}

// 当たりの種類：'zugara'（図柄揃い）/ 'charge'（からくりチャージ 300個 → 通常へ）
function rollNormalHitType() {
  return Math.random() < P_ZUGARA / P_TOTAL_HIT ? 'zugara' : 'charge';
}

// ---- 図柄揃いの振り分け ----
// 1200個＋LT 51%／300個＋LT 1%／1200個で通常へ 48%（LT突入 52%）
const CHARGE_BALLS = 300;
const ZUGARA_TABLE = [
  { balls: 1200, lt: true, pct: 51 },
  { balls: 300, lt: true, pct: 1 },
  { balls: 1200, lt: false, pct: 48 },
];

function rollZugara() {
  const r = Math.random() * 100;
  let acc = 0;
  for (const row of ZUGARA_TABLE) {
    acc += row.pct;
    if (r < acc) return { balls: row.balls, lt: row.lt, pct: row.pct };
  }
  const last = ZUGARA_TABLE[ZUGARA_TABLE.length - 1];
  return { balls: last.balls, lt: last.lt, pct: last.pct };
}

// ---- LT（ST135回） ----
// 1回転ごとに 1/78 で「一劇」。一劇は保留5個で、1個ずつ 1/3.45 で当たり抽選。
// 当たった数 × 1500個のボーナス（1個 1500 … 5個 7500）。当たればSTは135回に戻る。
// 1個も当たらなければ、半々で「STリセット（135回から）」か「ST残りから再開」。
// 135回、一劇で当たり（かリセット）を引けなければ終了 → 通常へ。
const LT_ST = 135;
const P_ICHIGEKI = 1 / 78;
const ICHIGEKI_HOLDS = 5;
// 保留5個が全部外れる（V0）確率を 17.52%（STリセット 8.76%＋リセットなし 8.76%）にする → 1個 約1/3.40
const P_V0 = 0.1752;
const P_HOLD_HIT = 1 - Math.pow(P_V0, 1 / ICHIGEKI_HOLDS);
const HOLD_BALLS = 1500;
const P_RESET_ON_MISS = 0.5;

function spinLt() {
  return Math.random() < P_ICHIGEKI ? 'ichigeki' : 'miss';
}

function rollHold() {
  return Math.random() < P_HOLD_HIT;
}

// 一劇の保留5個をまとめて抽選する。{ holds: [true/false ×5], hits, balls, reset }
function rollIchigeki() {
  const holds = [];
  for (let i = 0; i < ICHIGEKI_HOLDS; i++) holds.push(rollHold());
  const hits = holds.filter(Boolean).length;
  const reset = hits === 0 ? Math.random() < P_RESET_ON_MISS : false;
  return { holds, hits, balls: hits * HOLD_BALLS, reset };
}

function binom(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

// 一劇で k 個当たる確率
function ichigekiHitsProbability(k) {
  return binom(ICHIGEKI_HOLDS, k) * Math.pow(P_HOLD_HIT, k) * Math.pow(1 - P_HOLD_HIT, ICHIGEKI_HOLDS - k);
}

// 一劇の成功率（1個以上当たる：約82%）
function ichigekiSuccessProbability() {
  return 1 - ichigekiHitsProbability(0);
}

// 一劇の結果の割合（大当たり＝ボーナス＋STリセット の中での割合）。公開値 1500 40%／3000 33%／4500〜7500 17%／リセット 10% と比べる用
function ltShareTable() {
  const reset = ichigekiHitsProbability(0) * P_RESET_ON_MISS;
  const total = ichigekiSuccessProbability() + reset;
  const rows = [];
  for (let k = 1; k <= ICHIGEKI_HOLDS; k++) rows.push({ balls: k * HOLD_BALLS, share: ichigekiHitsProbability(k) / total });
  rows.push({ balls: 0, reset: true, share: reset / total });
  return rows;
}

// LTの継続率（ボーナスかSTリセットを、135回のうちに引く確率：約80%）
function ltContinueProbability() {
  const good = P_ICHIGEKI * (ichigekiSuccessProbability() + ichigekiHitsProbability(0) * P_RESET_ON_MISS);
  return 1 - Math.pow(1 - good, LT_ST);
}

// 初当たり1回がLTに入る確率（約26%）。チャージはLTに入らない
function ltEntryProbability() {
  const ltPct = ZUGARA_TABLE.filter((r) => r.lt).reduce((s, r) => s + r.pct, 0) / 100;
  return (P_ZUGARA / P_TOTAL_HIT) * ltPct;
}

const P_NO_LT_FROM_HIT = 1 - ltEntryProbability();

// 初当たりまでの回転数の確率
function hitIntervalProbability(n) {
  return {
    atLeast: Math.pow(1 - P_NORMAL_HIT, n - 1),
    within: 1 - Math.pow(1 - P_NORMAL_HIT, n),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    YEN_PER_BALL,
    SPIN_RATE_OPTIONS,
    DEFAULT_SPIN_RATE,
    calcSpinCost,
    toActualBalls,
    P_ZUGARA,
    P_CHARGE,
    P_TOTAL_HIT,
    P_NORMAL_HIT,
    spinNormal,
    rollNormalHitType,
    CHARGE_BALLS,
    ZUGARA_TABLE,
    rollZugara,
    LT_ST,
    P_ICHIGEKI,
    ICHIGEKI_HOLDS,
    P_HOLD_HIT,
    HOLD_BALLS,
    P_RESET_ON_MISS,
    spinLt,
    rollHold,
    rollIchigeki,
    ichigekiHitsProbability,
    ichigekiSuccessProbability,
    ltShareTable,
    ltContinueProbability,
    ltEntryProbability,
    P_NO_LT_FROM_HIT,
    hitIntervalProbability,
  };
}
