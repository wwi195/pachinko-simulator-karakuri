'use strict';

// カラサー2 シミュレーター（画面と状態遷移）。確率は logic.js。
// 流れ：通常時 → 大当たり（先告知などの演出はまだ入れない）
//   ├ 図柄揃い → 1200個＋LT 51%／300個＋LT 1%／1200個で通常へ 48%
//   └ からくりチャージ（300個）→ そのまま通常へ
// LT：ST135回。1/78で「一劇」→ 保留5個を1個ずつ抽選（1/3.45）。当たった数×1500個。
//   1個も当たらなければ半々で「STリセット」か「ST残りから再開」。135回スルーで通常へ

const game = {
  state: 'normal_idle',
  mode: 'normal', // normal / rush
  spinRate: DEFAULT_SPIN_RATE,
  mochiDama: 0,
  toushi: 0,
  totalSpins: 0,   // 通常時（玉を使う回転）
  normalSpins: 0,  // 通常時だけ
  currentSpins: 0,
  lastHitSpins: 0, // 最後に通常時へ戻ったときの normalSpins
  normalHitCount: 0,
  rushEntryCount: 0,
  noRushStreak: 0,   // 初当たりでLTに入れなかった連続回数
  lastRushSpins: 0,  // 最後に初当たりからLTに入ったときの通常時回転数
  rushAllStats: { totalSpins: 0, hits: 0, big: 0, ends: 0, ichigeki: 0, resets: 0 },
  session: null, // 初当たりから通常に戻るまで { hits, nominalBalls, actualBalls, everRush }
  stRemaining: 0,
  pending: {},
  eigyoAlertShown: false,
  detailsExpanded: false,
  shareOpen: false, // 「当たったときの振り分け」タブを開いているか（開閉は覚えておく）
  lastRankResult: null,
  hitHistory: [], // [{games, chain}]（新しい順。chain=null は結果待ち、0はLTなし）
  slump: [{ x: 0, y: 0 }],
  log: [],
};

function addLog(text, type = '') {
  game.log.unshift({ text, type });
  if (game.log.length > 50) game.log.pop();
  renderLog();
}

// ---- ランキング ----

const RANK_KEY = 'karakuriRankingV1';

function loadRanking() {
  try {
    const raw = localStorage.getItem(RANK_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function saveRanking(list) {
  try {
    localStorage.setItem(RANK_KEY, JSON.stringify(list));
  } catch (e) {}
}

function recordRanking(balls, renchan) {
  const list = loadRanking();
  const d = new Date();
  const entry = { balls, renchan, date: `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` };
  list.push(entry);
  list.sort((a, b) => b.balls - a.balls);
  const trimmed = list.slice(0, 10);
  saveRanking(trimmed);
  return { list: trimmed, entry, madeList: trimmed.includes(entry) };
}

function renderRankingList(list, highlightEntry) {
  if (list.length === 0) return `<div class="rr-label" style="text-align:center;">まだ記録がありません</div>`;
  return list.map((r, i) => {
    const isNew = r === highlightEntry;
    return `<div class="result-row${isNew ? ' rank-new' : ''}">
      <span class="rr-label">${i + 1}位${isNew ? ' 🆕' : ''}</span>
      <span class="rr-val${isNew ? ' gold' : ''}">${r.balls.toLocaleString()}球（${r.renchan}連）<span class="rank-date">${r.date}</span></span>
    </div>`;
  }).join('');
}

function handleShowRanking() {
  setState('ranking_view');
}

function handleRankingBack() {
  setState('normal_idle');
}

// ---- 設定 ----

function handleSpinRateChange(value) {
  game.spinRate = Number(value);
  render();
}

// ---- 球数・投資（等価：1000円=250玉） ----

function consumeSpinCost() {
  const cost = calcSpinCost(game.spinRate);
  if (game.mochiDama >= cost) {
    game.mochiDama -= cost;
  } else {
    const shortfall = cost - game.mochiDama;
    const perThousand = 1000 / YEN_PER_BALL;
    const units = Math.ceil(shortfall / perThousand);
    game.toushi += units * 1000;
    game.mochiDama = units * perThousand - shortfall;
  }
  recordSlump();
}

function award(nominal) {
  const actual = toActualBalls(nominal);
  game.mochiDama += actual;
  if (game.session) {
    game.session.nominalBalls += nominal;
    game.session.actualBalls += actual;
  }
  return actual;
}

// ---- 通常時 ----

function checkEigyoAlert() {
  if (!game.eigyoAlertShown && game.totalSpins >= 2000) {
    game.eigyoAlertShown = true;
    setState('eigyo_alert');
    return true;
  }
  return false;
}

// 1回転処理。画面が変わるとき true を返す（外れは何も起きず回転数だけ進む）
function runNormalSpin() {
  game.totalSpins++;
  game.normalSpins++;
  game.currentSpins++;
  consumeSpinCost();
  if (spinNormal() === 'miss') return false;

  const interval = game.normalSpins - game.lastHitSpins;
  startSession(interval);
  if (rollNormalHitType() === 'charge') {
    game.pending = { interval, type: 'charge' };
    const actual = award(CHARGE_BALLS);
    finishSingle();
    addLog(`${interval}回転でからくりチャージ ＋${actual}球`, 'win');
    setState('charge_hit');
    return true;
  }
  const z = rollZugara();
  game.pending = { interval, type: 'zugara', zugara: z };
  const actual = award(z.balls);
  addLog(`${interval}回転で図柄揃い！ ${z.balls}個 ＋${actual.toLocaleString()}球`, 'win');
  setState('zugara_hit');
  return true;
}

function handleStart() {
  if (checkEigyoAlert()) return;
  if (!runNormalSpin()) setState('normal_idle');
}

function autoSpin(count) {
  for (let i = 0; i < count; i++) {
    if (checkEigyoAlert()) return;
    if (runNormalSpin()) return;
  }
  setState('normal_idle');
}

function startSession(interval) {
  game.normalHitCount++;
  game.hitHistory.unshift({ games: interval, chain: null });
  game.currentSpins = 0;
  game.session = { hits: 1, nominalBalls: 0, actualBalls: 0, everRush: false };
}

// チャージ・LTに入らない図柄揃いは単発で終わる：履歴を確定して、LT非突入の連続を数える
function finishSingle() {
  const last = game.hitHistory[0];
  if (last && last.chain === null) last.chain = 0;
  game.noRushStreak++;
}

function backToNormal() {
  game.mode = 'normal';
  setState('normal_idle');
}

// ---- 図柄揃い後のLT判定（52%） ----

function handleRushJudge() {
  if (game.pending.zugara.lt) {
    addLog('LT突入！', 'rush');
    setState('judge_win');
  } else {
    finishSingle();
    addLog('LT非突入 → 通常へ');
    setState('judge_lose');
  }
}

// ---- LT（ST135回） ----

function rushSpinNo() {
  return LT_ST - game.stRemaining;
}

function enterRush() {
  if (!game.session.everRush) {
    game.session.everRush = true;
    game.rushEntryCount++;
    game.noRushStreak = 0;
    game.lastRushSpins = game.normalSpins;
  }
  game.mode = 'rush';
  game.stRemaining = LT_ST;
  setState('rush_idle');
}

// 運命の一劇の前に「リーチ！ 4○4」を出す（真ん中は薄く数字が回る）。少ししたら一劇へ
const ICHIGEKI_REACH_MS = 2200;
function showIchigekiReach() {
  setState('ichigeki_reach');
  const mid = document.getElementById('reach-mid');
  let n = Math.floor(Math.random() * 10);
  const timer = setInterval(() => {
    if (!mid.isConnected) { clearInterval(timer); return; }
    n = (n + 1) % 10;
    mid.textContent = n;
  }, 70);
  setTimeout(() => {
    clearInterval(timer);
    if (game.state === 'ichigeki_reach') setState('ichigeki');
  }, ICHIGEKI_REACH_MS);
}

// 1回転処理。画面遷移が起きたら true を返す
function runRushSpin(opts = {}) {
  game.rushAllStats.totalSpins++;
  game.stRemaining--;
  const spins = rushSpinNo();
  if (spinLt() === 'ichigeki') {
    game.rushAllStats.ichigeki++;
    // 保留5個の結果は先に決めておき、画面で1個ずつ開ける
    game.pending = { spins, result: rollIchigeki(), opened: 0 };
    addLog(`ST${spins}回転目で運命の一劇！`, 'rush');
    showIchigekiReach();
    return true;
  }
  if (game.stRemaining <= 0) {
    game.rushAllStats.ends++;
    endSession();
    return true;
  }
  if (!opts.silent) {
    setState('rush_idle');
    return true;
  }
  return false;
}

function handleRushSpin() {
  runRushSpin();
}

function handleRushSpin10() {
  for (let i = 0; i < 10; i++) {
    if (runRushSpin({ silent: true })) return;
  }
  setState('rush_idle');
}

// 一劇か、残り10回まで一気に回す
function handleRushSkip() {
  for (;;) {
    if (runRushSpin({ silent: true })) return;
    if (game.stRemaining <= 10) {
      setState('rush_idle');
      return;
    }
  }
}

// ---- 一劇（保留5個） ----

function handleOpenHold() {
  const p = game.pending;
  p.opened++;
  if (p.opened >= ICHIGEKI_HOLDS) finishIchigeki();
  else render();
}

function handleOpenAllHolds() {
  game.pending.opened = ICHIGEKI_HOLDS;
  finishIchigeki();
}

function finishIchigeki() {
  const r = game.pending.result;
  if (r.hits > 0) {
    game.rushAllStats.hits++;
    if (r.balls >= 4500) game.rushAllStats.big++;
    game.session.hits++;
    const actual = award(r.balls);
    addLog(`一劇 保留${r.hits}個当たり！ ${r.balls.toLocaleString()}個 ＋${actual.toLocaleString()}球`, 'rush');
    game.stRemaining = LT_ST;
    setState('rush_hit');
    return;
  }
  if (r.reset) {
    game.rushAllStats.resets++;
    addLog('一劇 当たりなし → STリセット（135回から）', 'rush');
    game.stRemaining = LT_ST;
  } else {
    addLog(`一劇 当たりなし → ST残り${game.stRemaining}回から再開`);
  }
  setState('ichigeki_miss');
}

// 一劇で当たらず「残りから再開」で、残りが0ならそのまま終了
function handleIchigekiMissContinue() {
  if (game.stRemaining <= 0) {
    game.rushAllStats.ends++;
    endSession();
    return;
  }
  setState('rush_idle');
}

// LTが135回スルーで終わったとき
function endSession() {
  const s = game.session;
  const last = game.hitHistory[0];
  if (last && last.chain === null) last.chain = s.hits;
  game.lastRankResult = recordRanking(Math.round(s.actualBalls), s.hits);
  addLog(`LT終了 → ${s.hits}連で終了`);
  setState('session_result');
}

function handleSessionEnd() {
  game.mode = 'normal';
  game.session = null;
  game.lastHitSpins = game.normalSpins;
  setState('normal_idle');
}

// ---- 営業終了・退店 ----

function idleStateForMode() {
  if (game.mode === 'rush') return 'rush_idle';
  return 'normal_idle';
}

function handleEigyoHai() {
  setState(idleStateForMode());
}

function handleEigyoIie() {
  setState('taiten_result');
}

function handleTaiten() {
  setState('taiten_result');
}

function resetGame() {
  Object.assign(game, {
    state: 'normal_idle',
    mode: 'normal',
    spinRate: DEFAULT_SPIN_RATE,
    mochiDama: 0,
    toushi: 0,
    totalSpins: 0,
    normalSpins: 0,
    currentSpins: 0,
    lastHitSpins: 0,
    normalHitCount: 0,
    rushEntryCount: 0,
    noRushStreak: 0,
    lastRushSpins: 0,
    rushAllStats: { totalSpins: 0, hits: 0, big: 0, ends: 0, ichigeki: 0, resets: 0 },
    session: null,
    stRemaining: 0,
    pending: {},
    eigyoAlertShown: false,
    detailsExpanded: false,
    shareOpen: false,
    lastRankResult: null,
    hitHistory: [],
    slump: [{ x: 0, y: 0 }],
    log: [],
  });
  renderLog();
  render();
}

// ---- 状態セット & レンダリング ----

function setState(state) {
  game.state = state;
  render();
}

// ---- 大当たり履歴グラフ ----
const HIST_BLOCK = 100;
const HIST_MAX_BLOCKS = 7;
function renderHitGraph() {
  const el = document.getElementById('hist-cols');
  if (!el) return;
  const col = (cls, games, label, idx) => {
    const blocks = Math.min(HIST_MAX_BLOCKS, Math.max(1, Math.ceil(games / HIST_BLOCK)));
    const more = games >= HIST_BLOCK * HIST_MAX_BLOCKS ? '<div class="hist-more">▲</div>' : '';
    return `<div class="hist-col ${cls}">
      <div class="hist-g">${games}</div>${more}
      ${'<div class="hist-block"></div>'.repeat(blocks)}
      <div class="hist-type">${label}</div>
      <div class="hist-idx">${idx}</div>
    </div>`;
  };
  let html = col('now', game.currentSpins, '現在', '');
  game.hitHistory.forEach((h, i) => {
    let cls, label;
    if (h.chain === null) { cls = 'pending'; label = '…'; }
    else if (h.chain >= 1) { cls = h.chain >= 10 ? 'big-chain' : 'rush'; label = `${h.chain}連`; }
    else { cls = 'zugar'; label = '単発'; }
    html += col(cls, h.games, label, i + 1);
  });
  if (game.hitHistory.length === 0) html += '<div class="hist-empty">まだ大当たりがありません</div>';
  el.innerHTML = html;
}

// ---- 差玉推移グラフ ----
// 差玉 = 持ち玉 − 投資玉（投資は4円/玉で玉に換算）。横軸は玉を使った総回転数（通常時）
function currentDiffBalls() {
  return Math.round(game.mochiDama - game.toushi / YEN_PER_BALL);
}
function recordSlump() {
  if (!game.slump) game.slump = [{ x: 0, y: 0 }];
  const y = currentDiffBalls();
  const pts = game.slump;
  const last = pts[pts.length - 1];
  if (last.x === game.totalSpins && last.y === y) return;
  pts.push({ x: game.totalSpins, y });
  if (pts.length > 40000) game.slump = pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1);
}
function slumpNiceStep(range) {
  const raw = range / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}
function renderSlumpGraph() {
  const el = document.getElementById('slump-svg');
  if (!el) return;
  recordSlump();
  const pts = game.slump;
  const W = 360, H = 170, L = 46, R = 8, T = 10, B = 22;
  const maxX = Math.max(100, pts[pts.length - 1].x);
  let minY = 0, maxY = 0;
  pts.forEach((p) => { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; });
  if (maxY - minY < 1000) { maxY += 500; minY -= 500; }
  const step = slumpNiceStep(maxY - minY);
  minY = Math.floor(minY / step) * step;
  maxY = Math.ceil(maxY / step) * step;
  const sx = (x) => L + (x / maxX) * (W - L - R);
  const sy = (y) => T + (1 - (y - minY) / (maxY - minY)) * (H - T - B);
  let grid = '';
  for (let v = minY; v <= maxY + 1e-9; v += step) {
    const y = sy(v).toFixed(1);
    grid += `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" class="${v === 0 ? 'sl-zero' : 'sl-grid'}"/>`;
    grid += `<text x="${L - 4}" y="${(+y + 3).toFixed(1)}" class="sl-ylab">${v.toLocaleString()}</text>`;
  }
  const xStep = slumpNiceStep(maxX);
  for (let v = 0; v <= maxX + 1e-9; v += xStep) {
    const anchor = sx(v) > W - R - 16 ? ' style="text-anchor:end"' : '';
    grid += `<text x="${sx(v).toFixed(1)}" y="${H - 6}" class="sl-xlab"${anchor}>${v.toLocaleString()}</text>`;
  }
  const maxPts = (W - L - R) * 2;
  const stride = Math.max(1, Math.floor(pts.length / maxPts));
  const line = pts.filter((_, i) => i % stride === 0 || i === pts.length - 1)
    .map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const cur = pts[pts.length - 1];
  const cls = cur.y >= 0 ? 'plus' : 'minus';
  const zeroOff = Math.min(1, Math.max(0, (sy(0) - T) / (H - T - B))).toFixed(4);
  el.innerHTML = `<defs><linearGradient id="sl-grad" gradientUnits="userSpaceOnUse" x1="0" y1="${T}" x2="0" y2="${H - B}">
      <stop offset="${zeroOff}" stop-color="#2e9e5e"/><stop offset="${zeroOff}" stop-color="#d64545"/>
    </linearGradient></defs>
    ${grid}
    <polyline points="${line}" class="sl-line" stroke="url(#sl-grad)"/>
    <circle cx="${sx(cur.x).toFixed(1)}" cy="${sy(cur.y).toFixed(1)}" r="3" class="sl-dot ${cls}"/>`;
  document.getElementById('slump-now').innerHTML =
    `現在 <b class="${cls}">${cur.y >= 0 ? '+' : ''}${cur.y.toLocaleString()}玉</b>（${game.totalSpins.toLocaleString()}回転）`;
}

function render() {
  renderHeader();
  renderModeBadge();
  renderMainScreen();
  renderRushStats();
  renderHitGraph();
  renderSlumpGraph();
}

function handleToggleDetails() {
  game.detailsExpanded = !game.detailsExpanded;
  render();
}

function renderHeader() {
  const mochiInt = Math.floor(game.mochiDama);
  document.getElementById('mochi-dama').textContent = mochiInt.toLocaleString();
  document.getElementById('toushi-value').textContent = game.toushi.toLocaleString();

  const shuushi = Math.round(mochiInt * YEN_PER_BALL) - game.toushi;
  const shuushiEl = document.getElementById('shuushi-value');
  shuushiEl.textContent = (shuushi >= 0 ? '+' : '') + shuushi.toLocaleString();
  shuushiEl.className = 'money-value ' + (shuushi >= 0 ? 'green' : 'red');
  document.getElementById('current-spins').textContent = game.currentSpins.toLocaleString();
  document.getElementById('total-spins-disp').textContent = game.totalSpins.toLocaleString();

  const esupLabel = document.getElementById('esup-label');
  const esupValue = document.getElementById('rush-count');
  if (game.mode === 'rush') {
    esupLabel.textContent = 'ST残り';
    esupValue.textContent = `${game.stRemaining}回`;
  } else {
    esupLabel.textContent = '残り';
    esupValue.textContent = '－';
  }

  document.getElementById('total-hit-count').textContent =
    (game.normalHitCount + game.rushAllStats.hits) + '回';
  document.getElementById('normal-first-hit').textContent = game.normalHitCount + '回';
  document.getElementById('normal-first-prob').textContent = game.normalHitCount > 0 && game.normalSpins > 0
    ? '1/' + Math.round(game.normalSpins / game.normalHitCount).toLocaleString()
    : '1/―';

  document.getElementById('rush-entry-count').textContent = game.rushEntryCount + '回';
  const rushEntryRate = game.normalHitCount > 0 ? Math.round(game.rushEntryCount / game.normalHitCount * 100) : 0;
  document.getElementById('rush-entry-info').textContent = `(突入率 ${rushEntryRate}%)`;

  document.getElementById('hrow2-detail').style.display = game.detailsExpanded ? 'flex' : 'none';
  document.getElementById('details-toggle').textContent = game.detailsExpanded ? '詳細▴' : '詳細▾';
}

function renderModeBadge() {
  const el = document.getElementById('mode-badge');
  if (game.mode === 'rush') {
    el.textContent = 'LT中';
    el.className = 'rush';
  } else {
    el.textContent = '通常時';
    el.className = '';
  }
}

function renderMainScreen() {
  document.getElementById('main-screen').innerHTML = buildScreen(game.state);
}

function tenThousandYenSpins() {
  return game.spinRate * 10;
}

function spinRateOptionsHtml() {
  return SPIN_RATE_OPTIONS.map((rate) => {
    const note = rate === DEFAULT_SPIN_RATE ? '（ボーダー）' : '';
    return `<option value="${rate}" ${rate === game.spinRate ? 'selected' : ''}>${rate}回転${note}</option>`;
  }).join('');
}

// ---- 出現率の表示 ----
function pctText(prob) {
  const pct = prob * 100;
  return pct >= 1 ? pct.toFixed(1) : pct >= 0.01 ? pct.toFixed(2) : pct.toPrecision(2);
}
function rareText(prob) {
  return prob * 100 < 1 ? `<br>約${Math.round(1 / prob).toLocaleString()}回に1回の割合です` : '';
}
function rareNote(html) {
  return `<p class="rare-note">${html}</p>`;
}

// 初当たりのハマり：1000回転超・50回転以内は出現率を表示
function hitIntervalProbHtml(n) {
  if (n > 1000) {
    const p = hitIntervalProbability(n).atLeast;
    return rareNote(`${n.toLocaleString()}回転以上ハマる確率 ${pctText(p)}%${rareText(p)}`);
  }
  if (n <= 50) {
    const p = hitIntervalProbability(n).within;
    return rareNote(`${n}回転以内に当たる確率 ${pctText(p)}%${rareText(p)}`);
  }
  return '';
}

// 初当たりでLTに入れなかった連続（5回連続目から）
const NO_RUSH_STREAK_NOTICE_MIN = 5;
function noRushStreakNoticeHtml() {
  const n = game.noRushStreak;
  if (n < NO_RUSH_STREAK_NOTICE_MIN) return '';
  const p = Math.pow(P_NO_LT_FROM_HIT, n);
  const hamari = game.normalSpins - game.lastRushSpins;
  return rareNote(`LT非突入　${n}回連続中<br>発生率 ${pctText(p)}%${rareText(p)}<br>前回のLT突入から ${hamari.toLocaleString()}回転ハマり`);
}

const P_NORMAL_HIT_DISPLAY = '合算 約1/199（図柄揃い 1/399.9・からくりチャージ 1/396）';
const pct1 = (p) => Math.round(p * 1000) / 10;
const P_RUSH_DISPLAY = `ST${LT_ST}回 継続率 約${pct1(ltContinueProbability())}%（STリセット込み）<br>`
  + `一劇 1/78 → 保留${ICHIGEKI_HOLDS}個（1個 1/${(1 / P_HOLD_HIT).toFixed(2)}）成功率 約${pct1(ichigekiSuccessProbability())}%`;
const RUSH_ENTRY_THEORY = `理論 約${Math.round(ltEntryProbability() * 100)}%`;

function rushIdleScreen() {
  return `<div class="screen">
    <p class="yodel-label">LT</p>
    <p class="chain-label">${game.session.hits}連チャン中</p>
    <p class="rush-sub">獲得出玉 <span>${game.session.nominalBalls.toLocaleString()}</span> 個</p>
    <p class="rush-phase second">ST残り ${game.stRemaining}回</p>
    <div class="rush-spin-btns">
      <button class="btn-rush-spin" onclick="handleRushSpin()">1回転</button>
      <button class="btn-rush-spin" onclick="handleRushSpin10()">10回転</button>
      <button class="btn-rush-spin skip" ${game.stRemaining <= 10 ? 'disabled' : 'onclick="handleRushSkip()"'}>スキップ</button>
    </div>
    <p class="prob-hint">${P_RUSH_DISPLAY}</p>
    ${shareTabHtml('rush')}
    <button class="btn-taiten" onclick="handleTaiten()">退店する</button>
  </div>`;
}

// 一劇の保留5個（開けたものだけ結果を出す）
function holdsHtml(p) {
  return `<div class="holds">${p.result.holds.map((hit, i) => {
    if (i >= p.opened) return `<div class="hold closed">?</div>`;
    return hit ? `<div class="hold hit">当</div>` : `<div class="hold miss">×</div>`;
  }).join('')}</div>`;
}

// ボーナスの振り分け（そのボーナスが選ばれる割合）を表示する
function shareNote(text) {
  return `<p class="share-note">振り分け ${text}</p>`;
}
const LT_SHARES = ltShareTable();
function ltShareText(balls) {
  const row = LT_SHARES.find((r) => r.balls === balls);
  return `${pctText(row.share)}%`;
}
const CHARGE_SHARE_HTML = shareNote(`からくりチャージ 1/396<br><small>（当たり全体の約${Math.round(P_CHARGE / P_TOTAL_HIT * 100)}%）</small>`);

// ---- 「当たったときの振り分け」タブ（タッチで開閉。普段は閉じておく） ----
const SHARE_TABLES = {
  zugara: {
    title: '図柄揃いの振り分け',
    rows: ZUGARA_TABLE.map((r) => [`${r.balls}個${r.lt ? '＋LT' : '（通常へ）'}`, `${r.pct}%`]),
    note: 'LT突入 52%',
  },
  rush: {
    title: 'LT中の大当たり（一劇）',
    rows: LT_SHARES.map((r) => [r.reset ? 'STリセット（出玉なし）' : `${r.balls.toLocaleString()}個（保留${r.balls / HOLD_BALLS}個当たり）`, `${pctText(r.share)}%`]),
    note: '公開値：1500 40%／3000 33%／4500〜7500 17%／リセット 10%。一劇で1個も当たらないときの半分がSTリセット、残り半分はST残りから再開',
  },
};

function handleToggleShare() {
  game.shareOpen = !game.shareOpen;
  render();
}

function shareTabHtml(key) {
  const t = SHARE_TABLES[key];
  const body = game.shareOpen
    ? `<div class="share-tab-body">
        <p class="share-tab-title">${t.title}</p>
        ${t.rows.map(([k, v]) => `<div class="share-tab-row"><span>${k}</span><span>${v}</span></div>`).join('')}
        ${t.note ? `<p class="share-tab-note">${t.note}</p>` : ''}
      </div>`
    : '';
  return `<div class="share-tab">
    <button class="share-tab-btn" type="button" onclick="handleToggleShare()">${game.shareOpen ? '▲' : '▼'} 当たったときの振り分け</button>
    ${body}
  </div>`;
}

// 10R=1500個。3000以上は「10R×◯」も添える
function roundsText(nominal) {
  return nominal >= 3000 ? `<p class="judge-label">10R×${nominal / 1500}</p>` : '';
}

// 「1500ボーナス！」と大きく出し、下に小さく（実質獲得 1,400）。からくりチャージは見出しだけ（大きい表記なし）。
// label はその上に小さく出す見出し（任意）
function bonusBox(label, nominal, cls = 'standard', sub = '', charge = false) {
  return `<div class="vibun-box rush-box">
    ${label ? `<p class="bonus-label">${label}</p>` : ''}
    ${charge ? '' : `<p class="bonus-main ${cls}">${nominal}ボーナス！</p>`}
    <p class="bonus-sub">（実質獲得 ${toActualBalls(nominal).toLocaleString()}）</p>
    ${sub}
  </div>`;
}

function buildScreen(state) {
  const p = game.pending;
  switch (state) {

    case 'normal_idle':
      return `<div class="screen">
        <button class="btn-start" onclick="handleStart()">START</button>
        <p class="prob-hint">${P_NORMAL_HIT_DISPLAY}</p>
        <div class="spin-rate-block">
          <span class="spin-rate-label">1000円あたりの回転数</span>
          <select class="spin-rate-select" onchange="handleSpinRateChange(this.value)">${spinRateOptionsHtml()}</select>
        </div>
        <div class="auto-spin-btns">
          <div class="auto-spin-wrap">
            <button class="btn-auto" onclick="autoSpin(${Math.round(tenThousandYenSpins())})">1万円分回す</button>
            <p class="spin-cost-hint">約${Math.round(tenThousandYenSpins())}回転分</p>
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn-taiten" onclick="handleTaiten()">退店する</button>
          <button class="btn-taiten" onclick="handleShowRanking()">🏆 ランキング</button>
        </div>
      </div>`;

    case 'ranking_view':
      return `<div class="screen">
        <p class="rush-result-title">🏆 最高出玉ランキング</p>
        <button class="btn-sub" onclick="handleRankingBack()">戻る</button>
        <div class="rush-result-box">
          ${renderRankingList(loadRanking())}
        </div>
      </div>`;

    case 'zugara_hit':
      return `<div class="screen">
        <p class="result-sub">${p.interval}回転で大当たり</p>
        ${bonusBox('図柄揃い！', p.zugara.balls)}
        ${hitIntervalProbHtml(p.interval)}
        <p class="prob-hint">LT突入率 52%</p>
        <button class="gasha-button" onclick="handleRushJudge()">PUSH</button>
        ${shareTabHtml('zugara')}
      </div>`;

    case 'judge_win':
      return `<div class="screen">
        <p class="judge-win">LT突入！</p>
        <p class="result-sub">ST${LT_ST}回・継続率 約80%</p>
        ${shareNote(`${p.zugara.balls}個＋LT ${p.zugara.pct}%`)}
        <button class="btn-action" onclick="enterRush()">▶ LTへ</button>
      </div>`;

    case 'judge_lose':
      return `<div class="screen">
        <p class="result-main lose small">LTならず…</p>
        <p class="result-sub">通常時へ戻ります（電サポなし）</p>
        ${shareNote('1200個で通常へ 48%')}
        ${noRushStreakNoticeHtml()}
        <button class="btn-sub" onclick="handleSessionEnd()" style="margin-top:8px;">▶ 通常へ戻る</button>
      </div>`;

    case 'charge_hit':
      return `<div class="screen">
        <p class="result-sub">${p.interval}回転で当たり</p>
        ${bonusBox('からくりチャージ', CHARGE_BALLS, 'standard', '', true)}
        ${CHARGE_SHARE_HTML}
        ${hitIntervalProbHtml(p.interval)}
        ${noRushStreakNoticeHtml()}
        <button class="btn-sub" onclick="handleSessionEnd()" style="margin-top:8px;">▶ 通常へ戻る</button>
      </div>`;

    case 'rush_idle':
      return rushIdleScreen();

    case 'ichigeki_reach':
      return `<div class="screen reach-screen">
        <p class="reach-title">リーチ！</p>
        <div class="reach-line">
          <span class="reach-4">4</span><span class="reach-mid" id="reach-mid">0</span><span class="reach-4">4</span>
        </div>
      </div>`;

    case 'ichigeki': {
      const hits = p.result.holds.slice(0, p.opened).filter(Boolean).length;
      return `<div class="screen">
        <p class="judge-win">運命の一劇</p>
        <p class="result-sub">ST${p.spins}回転目 ／ 保留${ICHIGEKI_HOLDS}個で勝負</p>
        ${holdsHtml(p)}
        <p class="result-sub">今の当たり ${hits}個（${(hits * HOLD_BALLS).toLocaleString()}個）</p>
        <p class="prob-hint">保留1個の当たり 1/${(1 / P_HOLD_HIT).toFixed(2)}</p>
        <button class="gasha-button" onclick="handleOpenHold()">PUSH</button>
        <button class="btn-sub" onclick="handleOpenAllHolds()">全部開ける</button>
      </div>`;
    }

    case 'rush_hit': {
      const r = p.result;
      return `<div class="screen">
        <p class="result-sub">一劇 保留${r.hits}個当たり</p>
        ${holdsHtml(p)}
        <p class="chain-label">${game.session.hits}連チャン</p>
        ${bonusBox('', r.balls, r.balls >= 4500 ? 'premium' : 'standard', roundsText(r.balls))}
        ${shareNote(`${r.balls.toLocaleString()}個 ${ltShareText(r.balls)}`)}
        <button class="btn-action" onclick="enterRush()">▶ 次へ（ST${LT_ST}回から）</button>
      </div>`;
    }

    case 'ichigeki_miss': {
      const r = p.result;
      return `<div class="screen">
        ${holdsHtml(p)}
        ${r.reset
          ? `<p class="judge-win">STリセット！</p><p class="result-sub">ST${LT_ST}回からやり直し</p>${shareNote(`STリセット ${ltShareText(0)}`)}`
          : `<p class="result-main lose small">当たりなし…</p><p class="result-sub">ST残り${game.stRemaining}回から再開</p>`}
        <button class="btn-action" onclick="handleIchigekiMissContinue()">▶ LTへ戻る</button>
      </div>`;
    }

    case 'session_result': {
      const s = game.session;
      const rank = game.lastRankResult;
      return `<div class="screen">
        <p class="result-main lose small">LT終了</p>
        <p class="rush-result-title">リザルト</p>
        <div class="rush-result-box">
          <div class="result-row highlight">
            <span class="rr-label">連チャン数（初当たり含む）</span>
            <span class="rr-val gold">${s.hits}連</span>
          </div>
          <div class="result-row">
            <span class="rr-label">TOTAL</span>
            <span class="rr-val gold">${s.nominalBalls.toLocaleString()}個</span>
          </div>
          <div class="result-row">
            <span class="rr-label">獲得出玉</span>
            <span class="rr-val">${Math.round(s.actualBalls).toLocaleString()}球</span>
          </div>
        </div>
        ${s.everRush ? '' : noRushStreakNoticeHtml()}
        <button class="btn-action" onclick="handleSessionEnd()">▶ 通常へ戻る</button>
        <div class="rush-result-box">
          <p class="rr-section">🏆 最高出玉ランキング</p>
          ${rank && rank.madeList ? '<p class="rank-madelist">ランクイン！</p>' : ''}
          ${renderRankingList(rank ? rank.list : loadRanking(), rank ? rank.entry : null)}
        </div>
      </div>`;
    }

    case 'eigyo_alert':
      return `<div class="screen">
        <p style="font-size:22px; font-weight:bold; color:var(--c-ruri); text-align:center; line-height:1.6;">
          営業時間終了になりました
        </p>
        <p style="font-size:16px; color:#666; text-align:center;">このまま居座り続けますか？</p>
        <div style="display:flex; gap:16px; margin-top:8px;">
          <button class="btn-action" style="flex:1;" onclick="handleEigyoHai()">はい</button>
          <button class="btn-action" style="flex:1; background:linear-gradient(135deg,#999,#666); border-color:#ccc;"
            onclick="handleEigyoIie()">いいえ</button>
        </div>
      </div>`;

    case 'taiten_result': {
      const mochi = Math.floor(game.mochiDama);
      const mochiYen = Math.round(mochi * YEN_PER_BALL);
      const shuushi = mochiYen - game.toushi;
      const shuushiColor = shuushi >= 0 ? '#2e9e5b' : '#d24141';
      const shuushiSign = shuushi >= 0 ? '＋' : '';
      return `<div class="screen">
        <p style="font-size:24px; font-weight:bold; color:#666;">退店します</p>
        <div class="rush-result-box" style="max-width:320px;">
          <p class="rr-section" style="margin-bottom:8px;">収支発表</p>
          <div class="result-row">
            <span class="rr-label">総回転数</span>
            <span class="rr-val">${game.totalSpins.toLocaleString()}回</span>
          </div>
          <div class="result-row">
            <span class="rr-label">投資金額</span>
            <span class="rr-val" style="color:#d24141;">${game.toushi.toLocaleString()}円</span>
          </div>
          <div class="result-row">
            <span class="rr-label">持ち球換算</span>
            <span class="rr-val">${mochiYen.toLocaleString()}円</span>
          </div>
          <hr class="result-hr">
          <div class="result-row highlight">
            <span class="rr-label" style="font-weight:bold;">収支</span>
            <span class="rr-val" style="color:${shuushiColor}; font-size:22px;">
              ${shuushiSign}${shuushi.toLocaleString()}円
            </span>
          </div>
          <hr class="result-hr">
          <div class="result-row">
            <span class="rr-label">初当たり</span>
            <span class="rr-val">${game.normalHitCount}回</span>
          </div>
          <div class="result-row">
            <span class="rr-label">LT突入</span>
            <span class="rr-val">${game.rushEntryCount}回</span>
          </div>
        </div>
        <button class="btn-action" onclick="resetGame()" style="margin-top:8px;">▶ 最初の画面に戻る</button>
      </div>`;
    }

    default:
      return `<div class="screen"><p>...</p></div>`;
  }
}

function renderRushStats() {
  const s = game.rushAllStats;
  const prob = s.hits > 0 && s.totalSpins > 0 ? '1/' + (s.totalSpins / s.hits).toFixed(1) : '1/―';
  document.getElementById('rs-chain').textContent = s.hits + '回';
  document.getElementById('rs-prob').textContent = prob;
  document.getElementById('rs-spins').textContent = s.totalSpins + '回';
  document.getElementById('rs-big').textContent = s.big + '回';
}

function renderLog() {
  const el = document.getElementById('log-list');
  el.innerHTML = game.log.map(item =>
    `<div class="log-item ${item.type}">${item.text}</div>`
  ).join('');
}

render();
