// Beginner mode: step-by-step navigation with electrogram interpretation, plus an on-screen operation tour
import { ORIGIN } from '../core/sim.js';

const has = (ss, ...k) => k.every((x) => ss.inserted.has(x));
const mapOf = (ss, ch, ml) => Object.values(ss.maps).some((m) => m.chamber === ch && m.volumeMl() >= ml);
const pts = (ss, view, n) => { const m = ss.maps[ss.activeMap]; return !!m && m.points.length >= n && ['lat', 'prop'].includes(view.opts.mapMode); };
const tags = (ss, n) => ss.abl.tags.length >= n;

// common opening steps
const S_CATH = (req, extra) => ({
  title: 'カテーテルを留置する',
  todo: `「カテ」タブで ${req.join('・')} が挿入されていることを確認します（✓が付いていれば挿入済み）。${extra || ''}`,
  look: '3D画面のカテーテルの色：HRA＝橙、His＝黄、CS＝紫、RV＝緑、ABL＝白、MAP＝水色、Halo＝桃。下の心内心電図の行は、それぞれのカテーテルの電極ペア（双極）です。',
  done: extra && extra.includes('低位側壁') ? (ss) => has(ss, ...req) && (ss.cath.HRA.site === 'lowlat' || has(ss, 'HALO')) : undefined,
  manual: !(extra && extra.includes('低位側壁')),
});
const S_SINUS = (extra) => ({
  title: '洞調律の心内電位を読む',
  todo: '心電図の「フリーズ」で波形を止め、波形を2回クリックするとキャリパーで間隔を測れます。読み終えたら「次へ」。',
  look: `正常の心房興奮は HRA（高位右房）→ His の心房波（A）→ CS 9-10（近位）→ CS 1-2（遠位）の順です。His電極では A・H（鋭い小さな棘波）・V の3つが記録され、AH 約80 ms、HV 35–55 ms が基準値です。${extra || ''}`,
  manual: true,
});
const S_FAM = (ch, name, ml, extra) => ({
  title: `${name}のジオメトリーを作る（FAM）`,
  todo: `「マップ」タブで ${name} を選んで「作成」を押すと、FAM記録が始まります。3D画面の壁をタップするとカテーテルがそこへ移動し、通過した空間が形になります。半透明の解剖ガイドを目安に、壁全体をまんべんなくタップしてください。時間がなければ「自動FAM（デモ）」も使えます。${extra || ''}`,
  look: 'カテーテルが届いていない部分は形が欠けます。弁輪や静脈の入口は穴として抜けて見えます。操作するカテーテルは左下の「操作対象」で切り替えます（多極MAPの方が速く形を作れます）。',
  done: (ss) => mapOf(ss, ch, ml),
});

export const GUIDES = {
  AFL: [
    S_CATH(['HRA', 'HIS', 'CS', 'ABL'], 'HRAは留置部位を「低位側壁」にしておくと、最後のCTIブロック確認に使えます（Halo 20極でも可）。'),
    S_SINUS(),
    S_FAM('RA', '右房', 35, '上大静脈・下大静脈・三尖弁輪・CS入口部が分かるように作ります。'),
    {
      title: '心房粗動を誘発する',
      todo: '「刺激」タブの「推奨プロトコルで誘発」を押します。CS 9-10 から S1 600 ms×8 の後に S2 を 240 ms から 10 ms ずつ短くしていきます（数十秒かかります）。',
      look: '早い期外刺激がCTIの片方向でブロックされると（一方向性ブロック）、興奮が反対側から回り込んでリエントリーが成立します。',
      done: (ss) => ss.tachy(),
    },
    {
      title: '頻拍を診断する（電位の読み方）',
      todo: '波形を観察し、読み終えたら「次へ」。',
      look: 'II・III・aVF に陰性の鋸歯状波（F波）、心房周期は約250 ms で 2:1 房室伝導です。CS は近位（9-10）から遠位（1-2）へ興奮し、右房起源を示します。中隔を上行して側壁を下行する＝三尖弁輪を反時計回り（通常型）。応用：CTI上でABLから頻拍周期より20–30 ms短い周期でペーシングして止めると、PPI（刺激タブに自動表示）−頻拍周期が20 ms未満ならCTIが回路内です。',
      manual: true,
    },
    {
      title: '興奮伝播マップを作る',
      todo: '「マップ」タブでポイント自動取得をON（基準：CS 9-10）にし、三尖弁輪の周囲を中心にタップして点を集めます。上の表示を「LAT」または「伝播」に切り替えます。',
      look: '赤（早い）→紫（遅い）で表示されます。三尖弁輪の周りを色が一周し、最早期（赤）と最遅延（紫）が隣り合う「early meets late」が、弁輪を回るマクロリエントリーの証拠です。「伝播」では興奮が輪を回る様子が見えます。',
      done: (ss, v) => pts(ss, v, 60),
    },
    {
      title: 'CTIを焼灼する',
      todo: '「焼灼」タブでRF（35–40 W）を選びます。ABLを操作対象にして壁をタップし、接触圧10–30 g（右下の表示が緑）で Space（または通電ボタン）で通電・停止します。',
      look: '目安の部位：三尖弁輪の下壁側（LAO像で6時方向付近）から下大静脈の入口まで。弁輪側から始めて、下大静脈へ向かって点状焼灼をすき間なく（4–6 mm以内）並べます。焼灼指標450–550以上（タグが赤）を目安にします。ラインが完成すると頻拍が停止します。',
      done: (ss) => tags(ss, 4) && !ss.tachy(),
    },
    {
      title: '双方向性ブロックを証明する',
      todo: '「刺激」タブで部位を CS 9-10 にして連続ペーシング（CL 600）→ 低位側壁HRAまでの時間を測ります。次に部位を HRA d にしてペーシング → CS 9-10 までの時間を測ります。最後に「焼灼」タブの「20分待機」の後にもう一度確認し、再誘発もしてみます。',
      look: 'ブロック前は約90 msで対側に到達しますが、ブロックが完成すると興奮は三尖弁輪を反対回りに一周してから届くため、約200 msに延長します（目安：120–150 ms以上）。Haloでは衝突型の興奮順序が一方向性に変わります。焼灼ライン上の二重電位（2つの電位の間隔が広い）も完成の所見です。待機後に短縮していれば再伝導です。最後に「記録」タブの「手技終了・評価」で答え合わせをします。',
      manual: true,
    },
  ],
  AVNRT: [
    S_CATH(['HRA', 'HIS', 'CS', 'RVA', 'ABL']),
    S_SINUS('AVNRTでは房室結節の伝導路が2本（速伝導路と遅伝導路）あり、洞調律では速伝導路を通ります。'),
    S_FAM('RA', '右房', 35, 'Koch三角（His電位の記録部位・CS入口部・三尖弁輪中隔側に囲まれた領域）が分かるように作ります。'),
    {
      title: '頻拍を誘発する（AHジャンプ）',
      todo: '「刺激」タブの「推奨プロトコルで誘発」を押します。HRAから S1 600 ms×8 + S2 を 400 ms から短くしていきます。',
      look: 'S2を短くしていくと、ある時点でAH間隔が50 ms以上急に延長します（AHジャンプ）。速伝導路がブロックされ、遅伝導路を下行したサインです。その後、速伝導路を上行して心房に戻ると頻拍になります。',
      done: (ss) => ss.tachy(),
    },
    {
      title: '頻拍を診断する（電位の読み方）',
      todo: '波形を観察し、読み終えたら「次へ」。',
      look: 'QRS幅の狭い頻拍（周期約350 ms）です。His電極で心房波（A）と心室波（V）がほぼ同時に出ています（VA時間 < 70 ms）。CS は近位（9-10）の心房波が最も早い同心性興奮です。体表ではII・III・aVFの偽性S波、V1の偽性r\'波がAVNRTに典型的です。副伝導路を介する頻拍（ORT）ではVAがもっと長く、左側副伝導路ではCSが偏心性になる点が鑑別です。',
      manual: true,
    },
    {
      title: '標的部位を確認する',
      todo: 'ABLでHis電位が記録される部位（Hisカテの位置）と、CS入口部の位置を3D上で確認します。必要ならRVからのペーシングなどで頻拍を停止させてから進みます。',
      look: 'His電位が記録される部位は房室ブロックの危険が高い領域です。遅伝導路はKoch三角の下部、CS入口部と三尖弁輪の間を走ります。',
      manual: true,
    },
    {
      title: '遅伝導路を焼灼する',
      todo: '「焼灼」タブで RF 20–35 W（またはフォーカル・クライオ）を選び、標的部位に接触させて通電します。',
      look: '目安の部位：Koch三角の下1/3、CS入口部の前上方から三尖弁輪の間です。His電位の記録部位からは十分離れた位置で行います。有効な通電では接合部調律（P波のないQRS）が出現します。接合部調律で心房波が続かない（VA伝導が途絶）、PRの延長、房室ブロックの徴候があれば直ちに停止します。クライオマッピング（−30℃）で安全を確認してから焼灼に移る方法もあります。',
      done: (ss) => tags(ss, 1),
    },
    {
      title: '効果を判定する',
      todo: '「刺激」タブでイソプロテレノールを投与し、S1S2を再度行います。「20分待機」後にも確認します。',
      look: 'AHジャンプが消失するか、エコーが1拍までで頻拍が誘発されなければ成功です。PR・HV間隔が延長していないか（房室伝導障害がないか）も確認します。最後に「記録」タブの「手技終了・評価」で答え合わせをします。',
      manual: true,
    },
  ],
  WPW: [
    S_CATH(['HRA', 'HIS', 'CS', 'RVA', 'ABL']),
    S_SINUS('このシナリオでは副伝導路を伝わって心室が早期に興奮します（早期興奮）。'),
    {
      title: '体表心電図でδ波を確認する',
      todo: '心電図の上部で「12誘導」を選び、QRSの立ち上がりを観察します。読み終えたら「次へ」。',
      look: 'PRが短く、QRSの立ち上がりが緩やか（δ波）で幅が広くなっています。I・aVLのδ波が陰性、V1でR波が高い場合は左側壁の副伝導路を示唆します。CS遠位（1-2）では心房波と心室波が近接・融合しています。',
      manual: true,
    },
    S_FAM('LA', '左房', 30, '左房の壁をタップすると経中隔アプローチになります。僧帽弁輪の周囲を丁寧に作ります。'),
    {
      title: '頻拍を誘発する',
      todo: '「刺激」タブの「推奨プロトコルで誘発」を押します（HRAから S1S2）。',
      look: '早い期外刺激が副伝導路でブロックされて房室結節を下行し、副伝導路を上行して心房に戻ると順方向性房室回帰性頻拍（ORT）になります。',
      done: (ss) => ss.tachy(),
    },
    {
      title: '頻拍を診断する（電位の読み方）',
      todo: '波形を観察し、読み終えたら「次へ」。',
      look: 'QRS幅の狭い頻拍で、δ波は消えています（房室結節を下行するため）。CSでは遠位（CS 1-2）の心房波が最も早い偏心性の興奮順序で、VA時間は70 msを超えます。これらは左側副伝導路を上行していることを示します。',
      manual: true,
    },
    {
      title: '副伝導路の付着部をマッピングする',
      todo: 'ポイント自動取得をON（頻拍中は基準 CS 9-10。洞調律では基準 QRS onset）にし、僧帽弁輪の周囲で点を集め、LAT表示にします。',
      look: '頻拍中は逆行性の心房興奮が最も早い部位、洞調律では心室興奮が最も早い部位が付着部です。ABL単極電位がQS型で、局所の心房波と心室波が連続して融合する部位が目安です。',
      done: (ss, v) => pts(ss, v, 40),
    },
    {
      title: '副伝導路を焼灼する',
      todo: '「焼灼」タブでRF 30–35 Wを選び、最早期部位に接触させて通電します。',
      look: '目安の部位：僧帽弁輪の側壁（CS遠位電極の近く）で、心房側から行います。通電開始から数秒以内にδ波が消える（洞調律時）か、頻拍が室房ブロックで停止すれば有効で、さらに30–60秒追加します。',
      done: (ss) => tags(ss, 1),
    },
    {
      title: '効果を判定する',
      todo: '12誘導でδ波を確認し、心室ペーシング（RV d）で室房伝導を、S1S2で再誘発を確認します。「20分待機」後にも確認します。',
      look: 'δ波の消失、心室ペーシング時の心房興奮が中隔最早期の同心性（房室結節経由）になること、頻拍が誘発されないことを確認します。待機後にδ波が戻れば再伝導です。最後に「記録」タブの「手技終了・評価」で答え合わせをします。',
      manual: true,
    },
  ],
  PVC: [
    S_CATH(['HIS', 'CS', 'RVA', 'ABL']),
    {
      title: 'PVCの波形を読む',
      todo: '心電図上部で「12誘導」を選び、時々出る幅の広いQRS（PVC）を観察します。読み終えたら「次へ」。',
      look: '左脚ブロック型（V1でQSまたはrS）・下方軸（II・III・aVFで陽性）、胸部誘導の移行帯がV3–V4付近です。これは右室流出路起源を示唆します。PVCは3拍に1回（三段脈）出ています。',
      manual: true,
    },
    S_FAM('RV', '右室', 35, '心尖部から流出路（肺動脈弁の下）まで作ります。'),
    {
      title: 'PVCを確認・増やす',
      todo: 'PVCが少ない場合は「刺激」タブでイソプロテレノールを投与します。',
      look: 'PVCが出るとテンプレート（12誘導の形）が自動で保存され、後でペースマップの比較に使われます。',
      done: (ss) => !!ss.pvcTemplate,
    },
    {
      title: 'PVCの最早期部位をマッピングする',
      todo: '「マップ」タブで基準を「QRS onset」にし、「PVCのみ取得」をONにしてポイント自動取得します。流出路を中心に点を集め、LAT表示にします。',
      look: 'PVCの時だけ点を取ります。体表QRSより20–30 ms以上先行し（LATが−20〜−30 ms以下）、ABL単極電位がQS型の部位が起源の目安です。',
      done: (ss, v) => pts(ss, v, 25),
    },
    {
      title: 'ペースマップで確認する',
      todo: 'ABLを最早期部位に接触させ、「刺激」タブで部位を ABL d にして連続ペーシング（CL 600）します。',
      look: 'ペーシングの12誘導とPVCの一致率が刺激タブに表示されます。90%以上なら起源の近くです。',
      manual: true,
    },
    {
      title: '起源を焼灼する',
      todo: '「焼灼」タブでRF 30–40 Wを選び、最早期部位で通電します。',
      look: '目安の部位：右室流出路の中隔側、肺動脈弁のすぐ下です。通電中にPVCが一時的に増える（加速）→消える、が有効な所見です。',
      done: (ss) => tags(ss, 1),
    },
    {
      title: '効果を判定する',
      todo: 'イソプロテレノールを投与し、「20分待機」後にもPVCが出ないことを確認します。',
      look: 'PVCが出なければ成功です。表面の焼灼が浅いと（起源が深いと）しばらくして再出現します。最後に「記録」タブの「手技終了・評価」で答え合わせをします。',
      manual: true,
    },
  ],
  PAF: [
    S_CATH(['CS', 'ABL'], '肺静脈用のデバイス（クライオバルーン、PFA）は「焼灼」タブで選びます。'),
    S_SINUS('このシナリオでは、肺静脈起源の心房期外収縮が時々出現します。'),
    S_FAM('LA', '左房', 30, '左房の壁をタップすると経中隔アプローチになります。4本の肺静脈・左心耳・僧帽弁輪が分かるように作ります。'),
    {
      title: 'AFを確認する（省略可）',
      todo: '「刺激」タブの「推奨プロトコルで誘発」でAFを誘発できます。洞調律のまま隔離に進んでもかまいません（「次へ」）。',
      look: '体表では基線の細かい揺れ（f波）と、RR間隔が全く不規則な絶対性不整脈になります。CSの心房波も速く不規則です。',
      done: (ss) => ss.st.pvpm.af,
    },
    {
      title: '電位マップで肺静脈の入口を確認する',
      todo: 'ポイント自動取得をONにして左房内の点を集め、表示を「電位」にします。',
      look: '肺静脈の奥は電位が低く（灰色〜赤）、入口部（前庭部）で電位が変わります。焼灼はこの前庭部で行います。',
      done: (ss, v) => { const m = ss.maps[ss.activeMap]; return !!m && m.points.length >= 40 && v.opts.mapMode === 'volt'; },
    },
    {
      title: '肺静脈を隔離する',
      todo: '「焼灼」タブでクライオバルーンまたはPFAを選び、3D上で静脈をタップして標的にします。押し込む・傾きで位置を合わせ、「造影」で閉塞（接触）を確認してから通電します。',
      look: '目安の部位：各肺静脈の入口部（前庭部）を全周性に。クライオバルーン：造影で完全閉塞（グレード4）を確認して180秒。右側の静脈では横隔神経ペーシングのCMAPが30%以上低下したら直ちにダブルストップ。PFA：バスケットとフラワーを36°ずつ回転させながら各静脈8回程度。RFの場合は前庭部に点状焼灼を連続させ、後壁では食道温に注意します。',
      done: (ss) => tags(ss, 4),
    },
    {
      title: '隔離を確認する',
      todo: 'デバイスを各静脈に合わせ、円形カテ（PV 1-2〜9-10）の電位を観察します。「20分待機」後にも確認し、AFの再誘発もしてみます。',
      look: '隔離前は心房波の後に鋭いPV電位が続きますが、隔離されるとPV電位が消えます（入口ブロック）。静脈内に電位が残っていても、左房と無関係のリズム（解離）なら出口ブロックです。待機後にPV電位が戻れば再伝導です。最後に「記録」タブの「手技終了・評価」で答え合わせをします。',
      manual: true,
    },
  ],
};
void ORIGIN;

// ---------------- operation tour ----------------
export const TOUR = [
  { sel: '#view3d', title: '3D画面', text: 'ドラッグで回転、ホイール（ピンチ）でズーム、右ドラッグで移動します。壁をタップ（クリック）すると、操作中のカテーテルがその部位へ移動します。' },
  { sel: '#viewbar', title: '表示の切り替え', text: '上段：視点（AP・LAO など）。中段：マップの表示（形状・LAT・電位・伝播）。下段：解剖ガイド（正解の形）、真の伝播（学習用）、焼灼タグ。' },
  { sel: '#pad', title: '操作パッド', text: '操作するカテーテルを選び、矢印で位置を微調整、押す／緩めるで接触圧を変えます。通電はここか Space キーで行います。' },
  { sel: '#hud', title: 'モニター', text: '接触圧（緑が適正）、通電中の出力・インピーダンス・焼灼指標、食道温などが表示されます。' },
  { sel: '#egmWrap', title: '心電図', text: '上が体表心電図、下がカテーテルごとの心内電位です。フリーズで止め、2回クリックで間隔を計測できます。' },
  { sel: '#side', title: '操作タブ', text: 'カテ（挿入・留置部位）、マップ（形状作り・点の取得）、焼灼（エネルギー選択）、刺激（ペーシング・誘発）、記録（ログ・評価）。' },
  { sel: '#speed', title: '時間の速さ', text: '一時停止や、ゆっくり再生ができます。' },
  { sel: '#guide', title: '手順ガイド', text: 'ここに「やること」と「見るポイント」が表示されます。達成すると自動で次のステップに進みます。' },
];

export class Guide {
  constructor(root, ss, view, onChange) {
    this.root = root; this.ss = ss; this.view = view; this.onChange = onChange;
    this.steps = GUIDES[ss.key] || [];
    this.i = 0; this.collapsed = false; this.doneSet = new Set();
    this.render();
  }
  tick() {
    const st = this.steps[this.i];
    if (!st || st.manual || !st.done) return;
    let ok = false;
    try { ok = st.done(this.ss, this.view); } catch { ok = false; }
    if (ok) {
      this.doneSet.add(this.i);
      if (this.i < this.steps.length - 1) { this.i++; this.render(true); }
      else this.render();
    }
  }
  go(d) { this.i = Math.max(0, Math.min(this.steps.length - 1, this.i + d)); if (d > 0) this.doneSet.add(this.i - 1); this.render(); }
  render(advanced) {
    const el = this.root;
    const st = this.steps[this.i];
    el.classList.toggle('collapsed', this.collapsed);
    el.classList.remove('hidden');
    if (!st) { el.classList.add('hidden'); return; }
    const dots = this.steps.map((_, k) => `<span class="gdot${k === this.i ? ' cur' : this.doneSet.has(k) ? ' ok' : ''}"></span>`).join('');
    if (this.collapsed) {
      el.innerHTML = `<button class="gpill" data-g="open">ガイド ${this.i + 1}/${this.steps.length}：${st.title} ▸</button>`;
    } else {
      el.innerHTML = `
        <div class="ghead"><span class="gnum">STEP ${this.i + 1}/${this.steps.length}</span><b>${st.title}</b><span class="gsp"></span>
          <button data-g="tour" title="画面の操作説明">操作説明</button><button data-g="close" title="たたむ">▾</button></div>
        <div class="gdots">${dots}</div>
        <div class="gsec"><div class="glab">やること</div><div>${st.todo}</div></div>
        <div class="gsec look"><div class="glab">見るポイント</div><div>${st.look}</div></div>
        <div class="gfoot"><button data-g="prev" ${this.i === 0 ? 'disabled' : ''}>◀ 前へ</button>
          <span class="gstate">${st.manual ? '読み終えたら「次へ」' : '達成すると自動で次へ進みます'}</span>
          <button data-g="next" ${this.i === this.steps.length - 1 ? 'disabled' : ''}>次へ ▶</button></div>`;
      if (advanced) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    }
    el.querySelectorAll('[data-g]').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.g;
      if (a === 'open') { this.collapsed = false; this.render(); }
      if (a === 'close') { this.collapsed = true; this.render(); }
      if (a === 'prev') this.go(-1);
      if (a === 'next') this.go(1);
      if (a === 'tour') startTour();
    }));
    this.onChange && this.onChange();
  }
  destroy() { this.root.innerHTML = ''; this.root.classList.add('hidden'); }
}

export function startTour() {
  let k = 0;
  const ov = document.createElement('div');
  ov.className = 'tour';
  document.body.append(ov);
  const show = () => {
    let st = TOUR[k];
    while (st && (!document.querySelector(st.sel) || document.querySelector(st.sel).classList.contains('hidden'))) st = TOUR[++k];
    if (!st) { ov.remove(); return; }
    const r = document.querySelector(st.sel).getBoundingClientRect();
    const pad = 4;
    const W = window.innerWidth, H = window.innerHeight;
    const bw = Math.min(340, W - 24);
    let bx = Math.min(Math.max(12, r.left + r.width / 2 - bw / 2), W - bw - 12);
    let by = r.bottom + 12;
    if (by + 170 > H) by = Math.max(12, r.top - 182);
    if (r.height > H * 0.6) by = Math.min(H - 190, r.top + 60);
    ov.innerHTML = `<div class="thole" style="left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px"></div>
      <div class="tbub" style="left:${bx}px;top:${by}px;width:${bw}px"><div class="tt">${k + 1}/${TOUR.length}　${st.title}</div><div>${st.text}</div>
      <div class="tb"><button data-t="skip">閉じる</button><button data-t="next" class="pri">${k === TOUR.length - 1 ? '始める' : '次へ'}</button></div></div>`;
    ov.querySelector('[data-t=skip]').onclick = () => ov.remove();
    ov.querySelector('[data-t=next]').onclick = () => { k++; show(); };
  };
  show();
}
