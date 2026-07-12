/* ===================== 全局状态（播放器与 PV 共享） ===================== */
const S = {
  audio: document.getElementById('audio'),
  audioURL: '', imgURL: '',
  meta: { title:'', artist:'', origin:'', album:'' },
  lyrics: [],          // {t, text, tr, end}
  activeLyric: -1,
  beatOffset: 0,       // 打拍对齐起点(秒)
  imgEl: null,         // 已加载的 Image，用于 PV 绘制
  loaded: false,       // 是否已 apply 过素材
};
const $ = id => document.getElementById(id);
const fmt = s => { s=Math.max(0,s|0); return (s/60|0)+':'+String(s%60).padStart(2,'0'); };

/* ===================== 视图切换 ===================== */
$('tabPlayer').onclick = () => switchView('player');
$('tabPV').onclick = () => switchView('pv');
function switchView(v){
  const isP = v==='player';
  $('tabPlayer').classList.toggle('active', isP);
  $('tabPV').classList.toggle('active', !isP);
  $('playerView').classList.toggle('active', isP);
  $('pvView').classList.toggle('active', !isP);
  updateOverlayVis();
  if(!isP){ resizeCanvas(); ensurePVLoop(); requestAnimationFrame(()=>{ syncOverlay(); renderTimeline(); }); }
}

/* ===================== 弹窗 & 上传 ===================== */
$('openModal').onclick = () => { $('sharedBadge').style.display = S.loaded ? 'inline-flex' : 'none'; $('modal').classList.add('show'); };
$('closeModal').onclick = () => $('modal').classList.remove('show');
$('modal').addEventListener('click', e => { if(e.target.id==='modal') $('modal').classList.remove('show'); });

function bindDrop(dropId, inputId, cb){
  const drop=$(dropId), input=$(inputId);
  drop.onclick=()=>input.click();
  input.onchange=()=>{ if(input.files[0]){ drop.textContent=input.files[0].name; drop.classList.add('has'); cb(input.files[0]); } };
  drop.ondragover=e=>{ e.preventDefault(); drop.classList.add('has'); };
  drop.ondragleave=()=>drop.classList.remove('has');
  drop.ondrop=e=>{ e.preventDefault(); const f=e.dataTransfer.files[0]; if(f){ input.files=e.dataTransfer.files;
    drop.textContent=f.name; drop.classList.add('has'); cb(f); } };
}
bindDrop('dropAudio','fAudio', f=>{
  if(S.audioURL) URL.revokeObjectURL(S.audioURL);
  S.audioURL=URL.createObjectURL(f);
  if(!$('iTitle').value) $('iTitle').value=f.name.replace(/\.[^.]+$/,'');
});
bindDrop('dropImg','fImg', f=>{ if(S.imgURL) URL.revokeObjectURL(S.imgURL); S.imgURL=URL.createObjectURL(f); });
bindDrop('dropLrc','fLrc', f=>{ const r=new FileReader(); r.onload=()=>$('lrcText').value=r.result; r.readAsText(f,'utf-8'); });

/* ===================== 网易云解析（仅歌词 + 原唱） ===================== */
$('neGo').onclick = async () => {
  const url=$('neUrl').value.trim(); const st=$('neStatus');
  if(!url){ st.className='status err'; st.textContent='请先粘贴链接'; return; }
  st.className='status'; st.textContent='解析中…';
  try{
    const r = await fetch('/api/netease?url='+encodeURIComponent(url));
    if(!r.ok){ const e=await r.json().catch(()=>({})); throw new Error(e.error||('HTTP '+r.status)); }
    const d = await r.json();
    // 翻唱 PV 场景：只取歌词 + 原曲演唱者（填入「原唱」）
    if(d.name && !$('iTitle').value) $('iTitle').value=d.name;
    if(d.artists) $('iOrigin').value=d.artists;   // 原曲演唱者 → 原唱
    $('lrcText').value = mergeLrc(d.lyric, d.tlyric);
    st.className='status ok';
    st.textContent='解析成功：歌词已填入，原唱=「'+(d.artists||'—')+'」；封面与音频请手动上传';
  }catch(err){
    st.className='status err';
    st.textContent='解析失败：'+err.message+'（是否已用 node server.js 启动？）';
  }
};
function mergeLrc(lrc, tlrc){
  if(!lrc) return '';
  if(!tlrc) return lrc;
  // 原词与译文各带相同时间戳，拼在一起即可；parseLRC 会按时间戳把译文合并到对应原词行
  return lrc + '\n' + tlrc;
}

/* ===================== 应用导入（一次载入，两个视图共用） ===================== */
$('applyBtn').onclick = () => {
  if(!S.audioURL){ alert('请先选择音频文件'); return; }
  S.meta.title = $('iTitle').value.trim() || '未命名';
  S.meta.artist= $('iArtist').value.trim();
  S.meta.origin= $('iOrigin').value.trim();
  S.meta.album = $('iAlbum').value.trim();
  S.lyrics = parseLRC($('lrcText').value);
  S.audio.src = S.audioURL;
  S.loaded = true;

  if(S.imgURL){
    $('discCover').style.backgroundImage=`url("${S.imgURL}")`;
    $('barCover').style.backgroundImage=`url("${S.imgURL}")`;
    $('bgBlur').style.backgroundImage=`url("${S.imgURL}")`;
    S.imgEl=new Image(); S.imgEl.crossOrigin='anonymous'; S.imgEl.src=S.imgURL;
  }
  $('mTitle').textContent=S.meta.title;
  const tags=[]; if(S.meta.artist)tags.push('翻唱：'+S.meta.artist);
  if(S.meta.origin)tags.push('原唱：'+S.meta.origin); if(S.meta.album)tags.push('专辑：'+S.meta.album);
  $('mTags').innerHTML=tags.map(t=>`<span>${t}</span>`).join('');
  $('barName').textContent=S.meta.title;
  $('barArtist').textContent=S.meta.artist||S.meta.origin;
  renderLyrics();
  if(typeof renderTlTicks==='function') renderTlTicks();
  $('modal').classList.remove('show');
};

/* ===================== LRC 解析 ===================== */
function parseLRC(text){
  if(!text) return [];
  const out=[]; const lines=text.split(/\r?\n/);
  const meta=/^\[(ti|ar|al|by|offset|length|re|ve|kana):/i;
  let offset=0;
  for(const line of lines){
    const om=line.match(/\[offset:\s*(-?\d+)\]/i); if(om) offset=parseInt(om[1])/1000;
    if(meta.test(line)) continue;
    const times=[...line.matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)];
    if(!times.length) continue;
    const txt=line.replace(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g,'').trim();
    for(const m of times){
      const mm=+m[1], ss=+m[2], ms=m[3]?+('0.'+m[3]):0;
      out.push({ t: mm*60+ss+ms+offset, text: txt });
    }
  }
  out.sort((a,b)=>a.t-b.t);
  // 合并相同时间戳的翻译行：同一 t 的第二条作为 tr
  const merged=[];
  for(const l of out){
    const prev=merged[merged.length-1];
    if(prev && Math.abs(prev.t-l.t)<0.02 && !prev.tr && l.text){ prev.tr=l.text; }
    else merged.push({...l});
  }
  const res=merged.filter(l=>l.text||l.tr);
  // 计算每句结束时间（下一句开始），末句给 5 秒
  for(let i=0;i<res.length;i++){ res[i].end = i+1<res.length ? res[i+1].t : res[i].t+5; }
  return res;
}
function renderLyrics(){
  const box=$('lyricBox');
  if(!S.lyrics.length){ box.innerHTML='<div class="lyric-empty">暂无歌词</div>'; return; }
  box.innerHTML='<div class="pad"></div>'+S.lyrics.map((l,i)=>
    `<div class="lyric-line" data-i="${i}">${l.text||'&nbsp;'}${l.tr?`<span class="tr">${l.tr}</span>`:''}</div>`
  ).join('')+'<div class="pad"></div>';
  box.querySelectorAll('.lyric-line').forEach(el=>{
    el.onclick=()=>{ S.audio.currentTime=S.lyrics[+el.dataset.i].t; if(S.audio.paused) S.audio.play(); };
  });
}
function syncLyrics(t){
  if(!S.lyrics.length) return;
  let idx=-1;
  for(let i=0;i<S.lyrics.length;i++){ if(S.lyrics[i].t<=t+0.15) idx=i; else break; }
  if(idx===S.activeLyric) return;
  S.activeLyric=idx;
  const box=$('lyricBox'); const lines=box.querySelectorAll('.lyric-line');
  lines.forEach(el=>el.classList.remove('active'));
  if(idx>=0 && lines[idx]){
    lines[idx].classList.add('active');
    const off=lines[idx].offsetTop - box.clientHeight/2 + lines[idx].clientHeight/2;
    box.scrollTo({ top:off, behavior:'smooth' });
  }
}

/* ===================== 播放控制 ===================== */
const audio=S.audio;
$('playBtn').onclick=togglePlay;
function togglePlay(){ if(!audio.src){ $('modal').classList.add('show'); return; } audio.paused?audio.play():audio.pause(); }
audio.onplay=()=>{ $('playBtn').textContent='⏸'; $('disc').classList.add('playing'); $('tonearm').classList.add('playing'); };
audio.onpause=()=>{ $('playBtn').textContent='▶'; $('disc').classList.remove('playing'); $('tonearm').classList.remove('playing'); };
audio.onloadedmetadata=()=>{ $('dur').textContent=fmt(audio.duration); if(typeof updateTimelineBar==='function'){ updateTimelineBar(); renderTlTicks(); } };
audio.ontimeupdate=()=>{
  const p=audio.currentTime/(audio.duration||1);
  $('fill').style.width=(p*100)+'%'; $('knob').style.left=(p*100)+'%';
  $('cur').textContent=fmt(audio.currentTime);
  syncLyrics(audio.currentTime);
};
$('prev10').onclick=()=>audio.currentTime=Math.max(0,audio.currentTime-10);
$('next10').onclick=()=>audio.currentTime=Math.min(audio.duration||0,audio.currentTime+10);

function bindTrack(trackId, onSeek){
  const track=$(trackId);
  const seek=e=>{ const r=track.getBoundingClientRect(); onSeek(Math.min(1,Math.max(0,(e.clientX-r.left)/r.width))); };
  let drag=false;
  track.onmousedown=e=>{ drag=true; seek(e); };
  window.addEventListener('mousemove',e=>{ if(drag) seek(e); });
  window.addEventListener('mouseup',()=>drag=false);
}
bindTrack('track', p=>{ if(audio.duration) audio.currentTime=p*audio.duration; });
bindTrack('volTrack', p=>{ audio.volume=p; $('volFill').style.width=(p*100)+'%'; });

document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
  if(e.code==='Space'){ e.preventDefault(); togglePlay(); }
  if(e.code==='ArrowRight') audio.currentTime+=5;
  if(e.code==='ArrowLeft') audio.currentTime-=5;
});

/* ===================== PV 渲染引擎（字幕为主） ===================== */
const cv=$('pvCanvas'), cx=cv.getContext('2d');
const PV={
  aspect:'16:9', bpm:120, beatAmp:0.06, camAmp:0.35, dim:0.30,
  ly:{ fs:62, fw:700, pos:0.86, color:'#ffffff', stroke:'#000000', strokeW:6,
       layout:'center', backdrop:'none', bdColor:'#ec4141', orient:'h', rot:0 },
  anim:'fade', animDur:0.5,
  fx:{ flash:false, grain:false, title:true },
  // 画面滤镜/整体特效（非卡点，后期层）
  filt:{ intensity:0.6, tintColor:'#2a3a6a',
    vignette:false, scanlines:false, noise:false, tint:false, letterbox:false,
    glow:false, invert:false, duotone:false, chromatic:false, oldfilm:false,
    blur:false, warm:false, cool:false, lightleak:false, sepia:false },
  deco:{ color:'#ec4141', underline:true, brackets:false, beatDots:false,
    particles:false, grid:false, frame:false, progress:true, den:0.5,
    crosshair:false, corners:false, scanline:false, sidebars:false },
  // 大面积矢量动效（铺满画面的生成器层）
  fxbig:{ color:'#ec4141', intensity:0.6, opacity:1, layer:'back', weight:1, size:1,  // weight=粗细, size=大小, opacity=整层透明度
    rings:false, rays:false, blinds:false, diag:false, gridwave:false,
    polys:false, halftone:false, bars:false, frames:false, sweep:false,
    blocks:false, glitch:false, burst:false, scatter:false },   // 后 4 个带随机性
  seed:12345, loopOn:false,
};
const ASPECTS={ '16:9':[1280,720], '9:16':[720,1280], '1:1':[900,900] };
function resizeCanvas(){ const [w,h]=ASPECTS[PV.aspect]; cv.width=w; cv.height=h; }

/* ===================== 关键帧引擎（补间 + 缓动） =====================
 * 每个可动画对象持有 keys:{ x:[], y:[], scale:[], rot:[], op:[] }
 * 每个关键帧 = { t:秒, v:数值, ease:'linear'|'in'|'out'|'inout' }
 * 无关键帧时 sampleKey 返回传入的静态默认值，保证向后兼容。
 */
const KF_PROPS=['x','y','scale','rot','op'];
const EASES={
  linear: x=>x,
  in:     x=>x*x*x,
  out:    x=>1-Math.pow(1-x,3),
  inout:  x=>x<0.5 ? 4*x*x*x : 1-Math.pow(-2*x+2,3)/2,
};
const EASE_NAME={ linear:'匀速', in:'慢入', out:'慢出', inout:'缓入缓出' };

// 在关键帧数组 arr 中采样时刻 t 的值；空数组返回 fallback
function sampleKey(arr, t, fallback){
  if(!arr || !arr.length) return fallback;
  if(t<=arr[0].t) return arr[0].v;
  if(t>=arr[arr.length-1].t) return arr[arr.length-1].v;
  for(let i=0;i<arr.length-1;i++){
    const a=arr[i], b=arr[i+1];
    if(t>=a.t && t<=b.t){
      const span=b.t-a.t; if(span<=0) return b.v;
      const p=(t-a.t)/span;
      const e=(EASES[b.ease]||EASES.linear)(p);
      return a.v + (b.v-a.v)*e;
    }
  }
  return fallback;
}
function hasKeys(obj){ return obj && obj.keys && KF_PROPS.some(k=>obj.keys[k] && obj.keys[k].length); }
function emptyKeys(){ return { x:[], y:[], scale:[], rot:[], op:[] }; }
// 在某属性轨道上写入/更新关键帧（同一时刻覆盖），保持按时间排序
function putKey(track, t, v, ease){
  t=+t.toFixed(3);
  const i=track.findIndex(k=>Math.abs(k.t-t)<0.02);
  if(i>=0){ track[i].v=v; if(ease) track[i].ease=ease; }
  else { track.push({ t, v, ease:ease||'out' }); track.sort((a,b)=>a.t-b.t); }
}

// 背景运镜：作为一个可打关键帧的对象（scale 以 1 为基准，x/y 为画面比例偏移，rot 度）
// cur = 当前编辑位姿；无关键帧时直接用 cur 作为静态位姿
PV.cam={ keys:emptyKeys(), cur:{ scale:1, x:0, y:0, rot:0 } };
// 字幕整体关键帧（位移/缩放/旋转）：cur=当前编辑位姿，keys=关键帧
PV.lyKf={ keys:emptyKeys(), cur:{ scale:1, x:0, y:0, rot:0 } };

// —— 控件绑定 ——
function segBind(id, cb){ $(id).querySelectorAll('button').forEach(b=>b.onclick=()=>{
  $(id).querySelectorAll('button').forEach(x=>x.classList.remove('on')); b.classList.add('on'); cb(b.dataset.v); }); }
segBind('aspect', v=>{ PV.aspect=v; resizeCanvas(); });
segBind('fw', v=>PV.ly.fw=+v);
segBind('lyAnim', v=>{ PV.anim=v; $('lyAnim2').querySelectorAll('button').forEach(x=>x.classList.remove('on')); });
segBind('lyAnim2', v=>{ PV.anim=v; $('lyAnim').querySelectorAll('button').forEach(x=>x.classList.remove('on')); });
function onLayoutChange(){ $('tplBox').style.display = (PV.ly.layout==='template')?'block':'none'; }
function clearLayoutOn(except){ ['lyLayout','lyLayout2'].forEach(id=>{ if(id!==except) $(id).querySelectorAll('button').forEach(x=>x.classList.remove('on')); }); }
segBind('lyLayout',  v=>{ PV.ly.layout=v; clearLayoutOn('lyLayout');  onLayoutChange(); });
segBind('lyLayout2', v=>{ PV.ly.layout=v; clearLayoutOn('lyLayout2'); onLayoutChange(); });
segBind('lyOrient', v=>{ PV.ly.orient=v; });
$('lyRot').oninput=e=>{ PV.ly.rot=+e.target.value; $('lyRotVal').textContent=e.target.value+'°'; };
$('splitLyric').onclick=splitCurrentLyric;
// 字幕整体关键帧滑块
$('lykScale').oninput=e=>{ PV.lyKf.cur.scale=e.target.value/100; $('lykScaleVal').textContent=(e.target.value/100).toFixed(2)+'×'; setEdit(PV.lyKf,'scale',PV.lyKf.cur.scale); };
$('lykX').oninput=e=>{ PV.lyKf.cur.x=e.target.value/100; $('lykXVal').textContent=e.target.value+'%'; setEdit(PV.lyKf,'x',PV.lyKf.cur.x); };
$('lykY').oninput=e=>{ PV.lyKf.cur.y=e.target.value/100; $('lykYVal').textContent=e.target.value+'%'; setEdit(PV.lyKf,'y',PV.lyKf.cur.y); };
$('lykRot').oninput=e=>{ PV.lyKf.cur.rot=+e.target.value; $('lykRotVal').textContent=e.target.value+'°'; setEdit(PV.lyKf,'rot',PV.lyKf.cur.rot); };
$('lykClear').onclick=()=>{ PV.lyKf.keys=emptyKeys(); clearEdit(); renderKfLists(); };
// 字幕关键帧打点（绑到自己那组按钮）
$('lykBtns').addEventListener('click', e=>{
  const btn=e.target.closest('button'); if(!btn||btn.id==='lykClear') return;
  const p=btn.dataset.p; if(!p) return;
  const t=audio.currentTime;
  const props = p==='all' ? ['scale','x','y','rot'] : [p];
  for(const pp of props) putKey(PV.lyKf.keys[pp], t, PV.lyKf.cur[pp], PV.curEase);
  clearEdit(); renderKfLists();
  if($('pvStatus')) $('pvStatus').textContent='字幕已在 '+t.toFixed(2)+'s 打关键帧';
});
// 版式模板控件
segBind('tplName', v=>{ PV.tpl.name=v; $('tplName2').querySelectorAll('button').forEach(x=>x.classList.remove('on')); });
segBind('tplName2', v=>{ PV.tpl.name=v; $('tplName').querySelectorAll('button').forEach(x=>x.classList.remove('on')); });
$('tplScale').oninput=e=>{ PV.tpl.scale=e.target.value/100; $('tplScaleVal').textContent=(e.target.value/100).toFixed(1)+'×'; };
$('tplScatter').oninput=e=>{ PV.tpl.scatter=e.target.value/100; $('tplScatterVal').textContent=e.target.value+'%'; };
$('tplBig').oninput=e=>{ PV.tpl.bigRatio=e.target.value/100; $('tplBigVal').textContent=(e.target.value/100).toFixed(1)+'×'; };
segBind('lyBackdrop', v=>{ PV.ly.backdrop=v; $('lyBackdrop2').querySelectorAll('button').forEach(x=>x.classList.remove('on')); });
segBind('lyBackdrop2', v=>{ PV.ly.backdrop=v; $('lyBackdrop').querySelectorAll('button').forEach(x=>x.classList.remove('on')); });
$('lyBdColor').oninput=e=>PV.ly.bdColor=e.target.value;
$('fs').oninput=e=>{ PV.ly.fs=+e.target.value; $('fsVal').textContent=e.target.value; };
$('lyPos').oninput=e=>{ PV.ly.pos=e.target.value/100; $('posVal').textContent=e.target.value+'%'; };
$('lyColor').oninput=e=>PV.ly.color=e.target.value;
$('lyStroke').oninput=e=>PV.ly.stroke=e.target.value;
$('stroke').oninput=e=>{ PV.ly.strokeW=+e.target.value; $('stVal').textContent=e.target.value; };
$('animDur').oninput=e=>{ PV.animDur=+e.target.value; $('animDurVal').textContent=e.target.value+'s'; };
$('lyBeat').onchange=e=>PV.lyBeatOn=e.target.checked; PV.lyBeatOn=true;
$('beatAmp').oninput=e=>{ PV.beatAmp=e.target.value/100; $('beatAmpVal').textContent=e.target.value+'%'; };
$('bpm').oninput=e=>{ PV.bpm=+e.target.value; $('bpmVal').textContent=e.target.value; };
$('camAmp').oninput=e=>{ PV.camAmp=e.target.value/100; $('camAmpVal').textContent=e.target.value<15?'静止':e.target.value<50?'适中':'明显'; };
// 背景手动位姿滑块
$('camScale').oninput=e=>{ PV.cam.cur.scale=e.target.value/100; $('camScaleVal').textContent=(e.target.value/100).toFixed(2)+'×'; setEdit(PV.cam,'scale',PV.cam.cur.scale); };
$('camX').oninput=e=>{ PV.cam.cur.x=e.target.value/100; $('camXVal').textContent=e.target.value+'%'; setEdit(PV.cam,'x',PV.cam.cur.x); };
$('camY').oninput=e=>{ PV.cam.cur.y=e.target.value/100; $('camYVal').textContent=e.target.value+'%'; setEdit(PV.cam,'y',PV.cam.cur.y); };
$('camRot').oninput=e=>{ PV.cam.cur.rot=+e.target.value; $('camRotVal').textContent=e.target.value+'°'; setEdit(PV.cam,'rot',PV.cam.cur.rot); };
// 背景运镜打点（复用当前缓动 PV.curEase）
$('camKfBtns').addEventListener('click', e=>{
  const btn=e.target.closest('button'); if(!btn) return;
  if(btn.id==='camKfClear'){ PV.cam.keys=emptyKeys(); clearEdit(); renderKfLists(); return; }
  const p=btn.dataset.p; if(!p) return;
  const t=audio.currentTime;
  const props = p==='all' ? ['scale','x','y','rot'] : [p];
  for(const pp of props) putKey(PV.cam.keys[pp], t, PV.cam.cur[pp], PV.curEase);
  clearEdit(); renderKfLists();
  if($('pvStatus')) $('pvStatus').textContent='背景运镜已在 '+t.toFixed(2)+'s 打关键帧';
});
$('dim').oninput=e=>{ PV.dim=e.target.value/100; $('dimVal').textContent=e.target.value+'%'; };
$('fxFlash').onchange=e=>PV.fx.flash=e.target.checked;
$('fxGrain').onchange=e=>PV.fx.grain=e.target.checked;
$('fxTitle').onchange=e=>PV.fx.title=e.target.checked;
// 矢量图形装饰
$('decoColor').oninput=e=>PV.deco.color=e.target.value;
$('dcUnderline').onchange=e=>PV.deco.underline=e.target.checked;
$('dcBrackets').onchange=e=>PV.deco.brackets=e.target.checked;
$('dcBeatDots').onchange=e=>PV.deco.beatDots=e.target.checked;
$('dcParticles').onchange=e=>PV.deco.particles=e.target.checked;
$('dcGrid').onchange=e=>PV.deco.grid=e.target.checked;
$('dcFrame').onchange=e=>PV.deco.frame=e.target.checked;
$('dcProgress').onchange=e=>PV.deco.progress=e.target.checked;
$('decoDen').oninput=e=>{ PV.deco.den=e.target.value/100; $('decoDenVal').textContent=e.target.value<34?'疏':e.target.value<67?'中':'密'; };
// 大面积矢量动效绑定
$('fxbColor').oninput=e=>PV.fxbig.color=e.target.value;
segBind('fxbLayer', v=>PV.fxbig.layer=v);
['rings','rays','blinds','diag','gridwave','polys','halftone','bars','frames','sweep','blocks','glitch','burst','scatter'].forEach(k=>{
  const id='fxb'+k.charAt(0).toUpperCase()+k.slice(1);
  $(id).onchange=e=>PV.fxbig[k]=e.target.checked;
});
$('fxbInt').oninput=e=>{ PV.fxbig.intensity=e.target.value/100; $('fxbIntVal').textContent=e.target.value+'%'; };
$('fxbWeight').oninput=e=>{ PV.fxbig.weight=e.target.value/100; $('fxbWeightVal').textContent=(e.target.value/100).toFixed(1)+'×'; };
$('fxbSize').oninput=e=>{ PV.fxbig.size=e.target.value/100; $('fxbSizeVal').textContent=(e.target.value/100).toFixed(1)+'×'; };
$('fxbOp').oninput=e=>{ PV.fxbig.opacity=e.target.value/100; $('fxbOpVal').textContent=e.target.value+'%'; };
// 画面滤镜绑定
['vignette','glow','scanlines','noise','tint','duotone','invert','chromatic','oldfilm','letterbox',
 'blur','warm','cool','sepia','lightleak'].forEach(k=>{
  const id='ft'+k.charAt(0).toUpperCase()+k.slice(1);
  $(id).onchange=e=>PV.filt[k]=e.target.checked;
});
$('ftTintColor').oninput=e=>PV.filt.tintColor=e.target.value;
$('ftInt').oninput=e=>{ PV.filt.intensity=e.target.value/100; $('ftIntVal').textContent=e.target.value+'%'; };
// 新增矢量装饰
$('dcCrosshair').onchange=e=>PV.deco.crosshair=e.target.checked;
$('dcCorners').onchange=e=>PV.deco.corners=e.target.checked;
$('dcScanline').onchange=e=>PV.deco.scanline=e.target.checked;
$('dcSidebars').onchange=e=>PV.deco.sidebars=e.target.checked;
// 跟拍点击测 BPM：连续点击，实时算平均间隔→BPM，起点定在第一下
let tapTimes=[];
$('tapBeat').onclick=()=>{
  const now=performance.now()/1000;              // 用真实时间(秒)
  const at=audio.currentTime;
  if(tapTimes.length && now-tapTimes[tapTimes.length-1].now>2){ tapTimes=[]; }  // 停顿 >2s 重来
  tapTimes.push({ now, at });
  if(tapTimes.length===1){
    S.beatOffset=at;                             // 第一下 = 节拍起点
    $('pvStatus').className='status'; $('pvStatus').textContent='已记第 1 拍，继续跟着点…';
    return;
  }
  // 取最近若干拍算平均间隔
  const recent=tapTimes.slice(-8);
  const dt=(recent[recent.length-1].now-recent[0].now)/(recent.length-1);
  let bpm=Math.round(60/dt);
  if(bpm<40||bpm>300){ /* 明显异常忽略 */ }
  else {
    PV.bpm=bpm; $('bpm').value=Math.min(200,Math.max(60,bpm)); $('bpmVal').textContent=bpm;
    S.beatOffset=tapTimes[0].at;                 // 起点 = 第一下对应的音频时刻
    $('pvStatus').className='status ok';
    $('pvStatus').textContent='测得 BPM ≈ '+bpm+'（已应用，点第 '+tapTimes.length+' 下）';
  }
};

/* ===================== 图形元素编辑器 ===================== */
PV.elements=[];            // 自由布置的图形
PV.sel=null;               // 当前选中元素 id
let elemSeq=0;
const SHAPE_NAME={ rect:'方形', circle:'圆形', triangle:'三角', ring:'圆环', line:'线条', star:'星形',
  diamond:'菱形', pentagon:'五边形', hexagon:'六边形', octagon:'八边形', star6:'六角星',
  cross:'十字块', plus:'加号', arrow:'箭头', chevron:'V形', heart:'心形', wave:'波浪线',
  doubleline:'双线', semicircle:'半圆', dot:'圆点', dots3:'三点', bracket:'括号', concentric:'同心圆' };
const SHAPE_ICON={ rect:'■', circle:'●', triangle:'▲', ring:'○', line:'—', star:'★',
  diamond:'◆', pentagon:'⬠', hexagon:'⬡', octagon:'8', star6:'✦',
  cross:'✚', plus:'＋', arrow:'→', chevron:'∨', heart:'♥', wave:'~',
  doubleline:'=', semicircle:'◗', dot:'•', dots3:'···', bracket:'[ ]', concentric:'◎' };
// 哪些是"描边型"（无填充，只描边）
const STROKE_SHAPES=['line','plus','chevron','wave','doubleline','bracket','concentric','arrow'];
// 元素显示标签（char 类型显示那个字）
function elemLabel(e){ return e.type==='char' ? ('字「'+e.str+'」') : (SHAPE_ICON[e.type]+' '+SHAPE_NAME[e.type]); }

function addElement(type){
  const strokeType=STROKE_SHAPES.includes(type);
  const el={ id:++elemSeq, type, x:0.5, y:0.5, size:140, rot:0, op:1,
    fill:'#ec4141', fillOn:!strokeType, stroke:'#ffffff', strokeW:strokeType?6:0, layer:'mid', when:'always',
    anim:{ pulse:false, spin:false, shake:false, float:false, breath:false, flicker:false },
    amp:0.5, spd:1, keys:emptyKeys() };
  PV.elements.push(el); PV.sel=el.id; renderElemList(); syncInspector(); syncOverlay(); renderTimeline();
}

// #1 逐字拆分：把当前播放位置的这句歌词，拆成一个个可独立编辑的「字」元素
PV.splitLines = PV.splitLines || {};   // 记录已拆分的歌词索引 → 抑制原句渲染
function splitCurrentLyric(){
  const t=audio.currentTime;
  const L=curLyric(t);
  if(!L || !L.text){ alert('当前时刻没有歌词，先把进度拖到有歌词的地方'); return; }
  const chars=[...L.text];
  const W=cv.width||1280, H=cv.height||720;
  const baseFs=PV.ly.fs;                       // 逐字元素默认字号=字幕字号
  // 估算整行宽度（用离屏度量）
  cx.save(); cx.font=`${PV.ly.fw} ${Math.round(baseFs*(H/720))}px sans-serif`;
  const widths=chars.map(c=>cx.measureText(c).width); cx.restore();
  const totalW=widths.reduce((a,b)=>a+b,0);
  let x0=W/2 - totalW/2, cursor=x0;
  const cy=H*PV.ly.pos;
  const created=[];
  for(let i=0;i<chars.length;i++){
    const cxp=cursor+widths[i]/2; cursor+=widths[i];
    if(!chars[i].trim()) continue;             // 跳过空格
    const el={ id:++elemSeq, type:'char', str:chars[i],
      x:cxp/W, y:cy/H, size:baseFs, rot:0, op:1,
      fill:PV.ly.color, fillOn:true, stroke:PV.ly.stroke, strokeW:0,
      layer:'front', when:'always', t0:L.t, t1:L.end,
      anim:{ pulse:false, spin:false, shake:false, float:false, breath:false, flicker:false },
      amp:0.5, spd:1, keys:emptyKeys() };
    PV.elements.push(el); created.push(el.id);
  }
  PV.splitLines[L.t.toFixed(2)]=true;          // 用开始时间(稳定)标记，抑制这句的原始字幕渲染
  PV.sel = created[0]||null;
  renderElemList(); syncInspector(); syncOverlay(); renderTimeline();
  if($('pvStatus')){ $('pvStatus').className='status ok';
    $('pvStatus').textContent='已把「'+L.text+'」拆成 '+created.length+' 个字元素，可各自拖动/旋转/缩放/打关键帧'; }
}

// 生成图形网格按钮（全部 23 种）
(function buildShapeGrid(){
  const grid=$('shapeAdd'); if(!grid) return;
  grid.innerHTML=Object.keys(SHAPE_NAME).map(k=>
    `<button data-v="${k}"><span class="gi">${SHAPE_ICON[k]}</span>${SHAPE_NAME[k]}</button>`).join('');
  grid.querySelectorAll('button').forEach(b=>b.onclick=()=>addElement(b.dataset.v));
})();
function elById(id){ return PV.elements.find(e=>e.id===id); }

function renderElemList(){
  const box=$('elemList');
  if(!PV.elements.length){ box.innerHTML='<div class="hint" style="margin:4px 0">还没有图形，点上面按钮添加。</div>'; return; }
  box.innerHTML=PV.elements.map(e=>
    `<div class="elem-item ${e.id===PV.sel?'sel':''}" data-id="${e.id}">
       <span class="swatch" style="background:${e.fillOn?e.fill:'transparent'};border:1px solid ${e.stroke}"></span>
       <span class="en">${elemLabel(e)} #${e.id}</span>
       <span class="eh">${e.layer==='back'?'背景':e.layer==='front'?'顶层':'中层'}</span>
     </div>`).join('');
  box.querySelectorAll('.elem-item').forEach(it=>it.onclick=()=>{ clearEdit(); PV.sel=+it.dataset.id; renderElemList(); syncInspector(); syncOverlay(); renderKfLists(); });
}

// 把检查器控件同步到当前选中元素（背景运镜有独立控件，这里只管图形元素）
function syncInspector(){
  const insp=$('inspector'), e=elById(PV.sel);
  if(!e){ insp.style.display='none'; return; }
  insp.style.display='block';
  $('inspTitle').textContent=elemLabel(e)+' #'+e.id;
  $('eFillOn').checked=e.fillOn; $('eFill').value=e.fill;
  $('eStroke').value=e.stroke; $('eStrokeW').value=e.strokeW;
  $('eSize').value=e.size; $('eSizeVal').textContent=e.size;
  $('eOp').value=Math.round(e.op*100); $('eOpVal').textContent=Math.round(e.op*100)+'%';
  $('eRot').value=e.rot; $('eRotVal').textContent=e.rot+'°';
  segSet('eLayer', e.layer); segSet('eWhen', e.when);
  $('aPulse').checked=e.anim.pulse; $('aSpin').checked=e.anim.spin; $('aShake').checked=e.anim.shake;
  $('aFloat').checked=e.anim.float; $('aBreath').checked=e.anim.breath; $('aFlicker').checked=e.anim.flicker;
  $('aAmp').value=Math.round(e.amp*100); $('aAmpVal').textContent=Math.round(e.amp*100)+'%';
  $('aSpd').value=Math.round(e.spd*100); $('aSpdVal').textContent=e.spd.toFixed(1)+'×';
  renderKfLists();
}
function segSet(id,v){ $(id).querySelectorAll('button').forEach(b=>b.classList.toggle('on', b.dataset.v===v)); }
function withSel(fn){ const e=elById(PV.sel); if(e){ fn(e); } }

$('eFillOn').onchange=e=>withSel(x=>{ x.fillOn=e.target.checked; renderElemList(); });
$('eFill').oninput=e=>withSel(x=>{ x.fill=e.target.value; renderElemList(); });
$('eStroke').oninput=e=>withSel(x=>{ x.stroke=e.target.value; renderElemList(); });
$('eStrokeW').oninput=e=>withSel(x=>x.strokeW=+e.target.value);
$('eSize').oninput=e=>withSel(x=>{ x.size=+e.target.value; $('eSizeVal').textContent=e.target.value; syncOverlay(); setEdit(x,'scale',x.size/120); });
$('eOp').oninput=e=>withSel(x=>{ x.op=e.target.value/100; $('eOpVal').textContent=e.target.value+'%'; setEdit(x,'op',x.op); });
$('eRot').oninput=e=>withSel(x=>{ x.rot=+e.target.value; $('eRotVal').textContent=e.target.value+'°'; syncOverlay(); setEdit(x,'rot',x.rot); });
segBind('eLayer', v=>withSel(x=>{ x.layer=v; renderElemList(); }));
segBind('eWhen', v=>withSel(x=>x.when=v));
['pulse','spin','shake','float','breath','flicker'].forEach(k=>{
  $('a'+k[0].toUpperCase()+k.slice(1)).onchange=e=>withSel(x=>x.anim[k]=e.target.checked);
});
$('aAmp').oninput=e=>withSel(x=>{ x.amp=e.target.value/100; $('aAmpVal').textContent=e.target.value+'%'; });
$('aSpd').oninput=e=>withSel(x=>{ x.spd=e.target.value/100; $('aSpdVal').textContent=(e.target.value/100).toFixed(1)+'×'; });
$('elemDel').onclick=()=>{ PV.elements=PV.elements.filter(e=>e.id!==PV.sel); PV.sel=null; renderElemList(); syncInspector(); syncOverlay(); renderTimeline(); };

// —— 关键帧打点 ——
segBind('kfEase', v=>PV.curEase=v);
// 取当前对象某属性的“当前值”（用于打点）
function curPropValue(ref, p){
  if(ref===PV.cam){ return { x:PV.cam.cur.x, y:PV.cam.cur.y, scale:PV.cam.cur.scale, rot:PV.cam.cur.rot, op:1 }[p]; }
  return { x:ref.x, y:ref.y, scale:ref.size/120, rot:ref.rot, op:ref.op }[p];
}
function selRef(){ return PV.sel==='cam' ? PV.cam : elById(PV.sel); }
$('inspector').querySelector('.kf-btns').addEventListener('click', e=>{
  const btn=e.target.closest('button'); if(!btn) return;
  const ref=selRef(); if(!ref) return;
  const t=audio.currentTime;
  const props = btn.dataset.p==='all' ? TL.props : [btn.dataset.p];
  for(const p of props){ putKey(ref.keys[p], t, curPropValue(ref, p), PV.curEase); }
  clearEdit(); renderKfLists();
  $('pvStatus') && ($('pvStatus').textContent='已在 '+t.toFixed(2)+'s 打关键帧：'+props.map(x=>PROP_NAME[x]).join('、'));
});
$('kfClear').onclick=()=>{ const ref=selRef(); if(ref){ ref.keys=emptyKeys(); clearEdit(); renderKfLists(); } };

// —— 计算某元素在时刻 t 的动效变换 ——
function elemTransform(el, t){
  const bi=beatInfo(t); const A=el.amp, S2=el.spd;
  let scale=1, dx=0, dy=0, rot=el.rot, op=el.op;
  if(el.anim.pulse)  scale *= 1 + A*0.4*Math.pow(1-bi.beatProg,3);
  if(el.anim.breath) scale *= 1 + A*0.18*Math.sin(t*2*S2);
  if(el.anim.spin)   rot += (t*S2*90) % 360;
  if(el.anim.shake){ const amp=A*18*(el.anim.pulse?1:0.6+0.4*Math.pow(1-bi.beatProg,3));
    dx += (rand(bi.beatIdx*3+el.id)-.5)*amp; dy += (rand(bi.beatIdx*3+el.id+99)-.5)*amp; }
  if(el.anim.float){ dx += A*30*Math.sin(t*0.6*S2+el.id); dy += A*30*Math.cos(t*0.5*S2+el.id*1.7); }
  if(el.anim.flicker) op *= 0.55 + 0.45*Math.abs(Math.sin(t*4*S2+el.id));
  return { scale, dx, dy, rot, op };
}

// —— 绘制单个图形（在其自身坐标系，中心为原点） ——
// 正多边形路径辅助
function polyPath(n, s, rot){
  const r=s/2; for(let i=0;i<n;i++){ const a=-Math.PI/2+rot+(i*2*Math.PI/n);
    const px=Math.cos(a)*r, py=Math.sin(a)*r; i?cx.lineTo(px,py):cx.moveTo(px,py); } cx.closePath();
}
function shapePath(type, s){
  cx.beginPath();
  const r=s/2;
  switch(type){
    case 'rect': cx.rect(-s/2,-s/2,s,s); break;
    case 'circle': case 'ring': cx.arc(0,0,r,0,7); break;
    case 'line': cx.moveTo(-s/2,0); cx.lineTo(s/2,0); break;
    case 'triangle': polyPath(3,s,0); break;
    case 'diamond': polyPath(4,s,0); break;                 // 菱形
    case 'pentagon': polyPath(5,s,0); break;
    case 'hexagon': polyPath(6,s,Math.PI/6); break;
    case 'octagon': polyPath(8,s,Math.PI/8); break;
    case 'star': { const R=r, ri=R*0.42; for(let i=0;i<10;i++){ const a=-Math.PI/2+i*Math.PI/5;
      const rad=i%2?ri:R, px=Math.cos(a)*rad, py=Math.sin(a)*rad; i?cx.lineTo(px,py):cx.moveTo(px,py); } cx.closePath(); break; }
    case 'star6': { const R=r, ri=R*0.5; for(let i=0;i<12;i++){ const a=-Math.PI/2+i*Math.PI/6;
      const rad=i%2?ri:R, px=Math.cos(a)*rad, py=Math.sin(a)*rad; i?cx.lineTo(px,py):cx.moveTo(px,py); } cx.closePath(); break; }
    case 'cross': { const t=s*0.28; cx.moveTo(-t,-r); cx.lineTo(t,-r); cx.lineTo(t,-t); cx.lineTo(r,-t);
      cx.lineTo(r,t); cx.lineTo(t,t); cx.lineTo(t,r); cx.lineTo(-t,r); cx.lineTo(-t,t); cx.lineTo(-r,t);
      cx.lineTo(-r,-t); cx.lineTo(-t,-t); cx.closePath(); break; }
    case 'plus': cx.moveTo(0,-r); cx.lineTo(0,r); cx.moveTo(-r,0); cx.lineTo(r,0); break;  // 描边用
    case 'arrow': cx.moveTo(-r,0); cx.lineTo(r*0.4,0); cx.moveTo(r*0.4,0); cx.lineTo(r*0.4,-s*0.22);
      cx.lineTo(r,0); cx.lineTo(r*0.4,s*0.22); cx.lineTo(r*0.4,0); break;
    case 'chevron': cx.moveTo(-r,-s*0.25); cx.lineTo(0,s*0.25); cx.lineTo(r,-s*0.25); break;  // V形，描边
    case 'heart': { const k=s*0.5; cx.moveTo(0,k*0.65);
      cx.bezierCurveTo(k*0.9,-k*0.2, k*0.55,-k*0.95, 0,-k*0.4);
      cx.bezierCurveTo(-k*0.55,-k*0.95, -k*0.9,-k*0.2, 0,k*0.65); cx.closePath(); break; }
    case 'wave': { const w=s, seg=8; cx.moveTo(-w/2,0);
      for(let i=0;i<=seg;i++){ const x=-w/2+w*i/seg; const y=Math.sin(i/seg*Math.PI*3)*s*0.12; cx.lineTo(x,y); } break; }
    case 'doubleline': cx.moveTo(-s/2,-s*0.08); cx.lineTo(s/2,-s*0.08); cx.moveTo(-s/2,s*0.08); cx.lineTo(s/2,s*0.08); break;
    case 'semicircle': cx.arc(0,0,r,Math.PI,0); cx.closePath(); break;
    case 'dot': cx.arc(0,0,r*0.4,0,7); break;
    case 'dots3': for(let i=0;i<3;i++){ cx.moveTo(-r+i*r+r*0.2,0); cx.arc(-r*0.7+i*r*0.7,0,r*0.16,0,7); } break;
    case 'bracket': { const arm=s*0.3; cx.moveTo(-r+arm,-r); cx.lineTo(-r,-r); cx.lineTo(-r,r); cx.lineTo(-r+arm,r);
      cx.moveTo(r-arm,-r); cx.lineTo(r,-r); cx.lineTo(r,r); cx.lineTo(r-arm,r); break; }
    case 'concentric': cx.arc(0,0,r,0,7); cx.moveTo(r*0.6,0); cx.arc(0,0,r*0.6,0,7); break;
    default: cx.rect(-s/2,-s/2,s,s);
  }
}
function drawElements(t, layer){
  const W=cv.width, H=cv.height, k=H/720;
  const Lc=curLyric(t);
  for(const el of PV.elements){
    if(el.layer!==layer) continue;
    if(el.when==='lyric' && !(Lc && Lc.visible)) continue;
    // 逐字元素：只在其所属歌词时间范围内显示
    if(el.type==='char' && (t<el.t0 || t>el.t1)) continue;
    const tr=elemTransform(el, t);
    // 基准值：有关键帧则用采样值，否则用静态属性；再叠加开关式动效(tr)
    const bx = sampleOrEdit(el, 'x', t, el.x);
    const by = sampleOrEdit(el, 'y', t, el.y);
    const bScale = sampleOrEdit(el, 'scale', t, el.size/120);   // 缩放以 120px 为基准
    const bRot = sampleOrEdit(el, 'rot', t, el.rot);
    const bOp = sampleOrEdit(el, 'op', t, el.op);
    const s=120*k*bScale*tr.scale;
    cx.save();
    cx.globalAlpha=Math.max(0,Math.min(1, bOp*(tr.op/el.op||1)));
    cx.translate(bx*W+tr.dx, by*H+tr.dy);
    cx.rotate((bRot+ (tr.rot-el.rot))*Math.PI/180);
    cx.lineJoin='round'; cx.lineCap='round';
    if(el.type==='char'){
      // 逐字文字元素：字号 = size（120基准由 scale 承担），走字幕描边/填充
      cx.textAlign='center'; cx.textBaseline='middle';
      cx.font=`${PV.ly.fw} ${Math.round(s)}px "PingFang SC","Microsoft YaHei",sans-serif`;
      if(PV.ly.strokeW>0){ cx.lineWidth=PV.ly.strokeW; cx.strokeStyle=PV.ly.stroke; cx.strokeText(el.str,0,0); }
      cx.fillStyle=el.fill; cx.fillText(el.str,0,0);
    } else {
      shapePath(el.type, s);
      const strokeOnly=STROKE_SHAPES.includes(el.type);
      if(el.fillOn && !strokeOnly){ cx.fillStyle=el.fill; cx.fill(); }
      if(el.strokeW>0 || strokeOnly || el.type==='ring'){
        cx.lineWidth=Math.max(2, (el.strokeW||(el.type==='ring'?6:6))*k);
        cx.strokeStyle=el.stroke; cx.stroke();
      }
    }
    cx.restore();
  }
}

/* —— 画面上的拖动覆盖层：让每个元素可直接拖动定位 —— */
const overlay=$('pvOverlay');
function syncOverlay(){
  // 覆盖层对齐到 canvas 实际显示区域（canvas 按 contain 缩放）
  const wrap=cv.parentElement, cr=cv.getBoundingClientRect(), wr=wrap.getBoundingClientRect();
  overlay.style.left=(cr.left-wr.left)+'px'; overlay.style.top=(cr.top-wr.top)+'px';
  overlay.style.width=cr.width+'px'; overlay.style.height=cr.height+'px';
  const sx=cr.width/cv.width, sy=cr.height/cv.height;
  // 录制时隐藏手柄，避免录进视频；平时只给“选中的那个”元素显示拖动框
  if(recorder && recorder.state==='recording'){ overlay.innerHTML=''; return; }
  const t=audio.currentTime||0;
  overlay.innerHTML=PV.elements.filter(e=>e.id===PV.sel).map(e=>{
    const s=e.size*(cv.height/720)*sampleOrEdit(e,'scale',t,1);
    const ex=sampleOrEdit(e,'x',t,e.x), ey=sampleOrEdit(e,'y',t,e.y);
    return `<div class="hit sel" data-id="${e.id}"
      style="left:${ex*cv.width*sx}px;top:${ey*cv.height*sy}px;width:${Math.max(20,s*sx)}px;height:${Math.max(20,s*sy)}px"></div>`;
  }).join('');
  overlay.querySelectorAll('.hit').forEach(h=>{
    h.onpointerdown=ev=>{
      ev.preventDefault(); const id=+h.dataset.id; PV.sel=id; renderElemList(); syncInspector(); renderTimeline();
      const el=elById(id); const rect=cv.getBoundingClientRect();
      // 若已有位置关键帧，拖动即在播放头处写入/更新关键帧；否则改静态位置
      const hasPosKeys = el.keys.x.length || el.keys.y.length;
      const move=m=>{
        const nx=Math.min(1,Math.max(0,(m.clientX-rect.left)/rect.width));
        const ny=Math.min(1,Math.max(0,(m.clientY-rect.top)/rect.height));
        el.x=nx; el.y=ny;
        if(hasPosKeys){ const t=audio.currentTime; putKey(el.keys.x,t,nx,PV.curEase); putKey(el.keys.y,t,ny,PV.curEase); }
        syncOverlay();
      };
      const up=()=>{ window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',up); if(hasPosKeys) renderTimeline(); };
      window.addEventListener('pointermove',move); window.addEventListener('pointerup',up);
    };
  });
}
window.addEventListener('resize', ()=>{ syncOverlay(); renderTimeline(); });
// 只有 PV 视图激活时覆盖层可见/可交互
function updateOverlayVis(){ overlay.style.display = $('pvView').classList.contains('active') ? 'block':'none'; }
renderElemList();

/* —— 给 PV 面板里每个滑块加“↺ 复位”按钮 —— */
function installSliderResets(root){
  root.querySelectorAll('input[type=range]').forEach(sl=>{
    if(sl.dataset.rstDone) return; sl.dataset.rstDone='1';
    const def = sl.getAttribute('value');           // HTML 里的初始值
    const wrap=document.createElement('div'); wrap.className='slider-wrap';
    sl.parentNode.insertBefore(wrap, sl); wrap.appendChild(sl);
    // 双击滑块 → 手动输入数值（#5）
    sl.title='双击可手动输入数值';
    sl.ondblclick=()=>{
      const v=prompt('输入数值（范围 '+sl.min+' ~ '+sl.max+'）', sl.value);
      if(v===null) return; const n=parseFloat(v);
      if(!isNaN(n)){ sl.value=n; sl.dispatchEvent(new Event('input',{bubbles:true})); }
    };
    const btn=document.createElement('button'); btn.className='rst-btn'; btn.type='button';
    btn.textContent='↺'; btn.title='恢复初始值 ('+def+')';
    btn.onclick=()=>{ sl.value=def; sl.dispatchEvent(new Event('input',{bubbles:true})); };
    wrap.appendChild(btn);
  });
}
installSliderResets($('pvView'));
installSliderResets($('playerView'));

/* ===================== 关键帧清单（C 方案） ===================== */
PV.curEase='out';                       // 当前打点用的缓动
const TL={ props:['x','y','scale','rot','op'] };
const PROP_NAME={ x:'X位置', y:'Y位置', scale:'缩放', rot:'旋转', op:'透明度' };
const PROP_UNIT={ x:'', y:'', scale:'×', rot:'°', op:'' };
function fmtKv(p, v){
  if(p==='x'||p==='y') return (v*100).toFixed(0)+'%';
  if(p==='scale') return v.toFixed(2)+'×';
  if(p==='rot') return Math.round(v)+'°';
  if(p==='op') return Math.round(v*100)+'%';
  return (''+v);
}
// 渲染某对象的关键帧清单到指定容器；props 决定显示哪些属性
function renderKfList(hostId, ref, props){
  const host=$(hostId); if(!host) return;
  if(!ref){ host.innerHTML=''; return; }
  let html='';
  for(const p of props){
    const track=ref.keys[p]||[];
    if(!track.length) continue;
    const chips=track.map((k,ki)=>`<span class="kf-chip" data-prop="${p}" data-ki="${ki}" title="${EASE_NAME[k.ease]||''}，点击跳到此刻">
      ${k.t.toFixed(2)}s·${fmtKv(p,k.v)}<span class="kx" data-del="1">×</span></span>`).join('');
    html+=`<div class="kf-prop-row"><span class="kfp-name">${PROP_NAME[p]}</span><span class="kf-chips">${chips}</span></div>`;
  }
  host.innerHTML = html || '<div class="kf-empty">暂无关键帧</div>';
  // 绑定：点 chip 跳到该时刻；点 × 删除
  host.querySelectorAll('.kf-chip').forEach(chip=>{
    const p=chip.dataset.prop, ki=+chip.dataset.ki;
    chip.onclick=ev=>{
      if(ev.target.dataset.del){ ref.keys[p].splice(ki,1); renderKfLists(); return; }
      audio.currentTime = ref.keys[p][ki].t;   // 跳到该关键帧时刻预览
    };
  });
}
// 同时刷新元素清单与背景运镜清单
function renderKfLists(){
  const el = elById(PV.sel);
  renderKfList('kfList', el, TL.props);
  renderKfList('camKfList', PV.cam, ['scale','x','y','rot']);
  renderKfList('lykList', PV.lyKf, ['scale','x','y','rot']);
  if(typeof renderTlTicks==='function') renderTlTicks();
}
// 兼容旧调用名
function renderTimeline(){ renderKfLists(); }
function positionPlayhead(){ /* C 方案无独立播放头，进度用底部进度条 */ }

/* —— 实时预览：按对象暂存“手上正在调的多个属性”，互不覆盖 ——
 * PV.editRef = 正在编辑的对象；PV.editVals = { prop: val, ... } 已调过的属性都留着，
 * 直到打关键帧或切换对象才清空。这样连续调缩放→位置→旋转，预览会全部叠加。
 */
PV.editRef=null; PV.editVals={};
function setEdit(ref, prop, val){
  if(PV.editRef!==ref){ PV.editRef=ref; PV.editVals={}; }   // 换对象则重置暂存
  PV.editVals[prop]=val;
}
function clearEdit(){ PV.editRef=null; PV.editVals={}; }
// 采样：该对象正在编辑的属性用暂存值（实时预览，可多属性叠加）；否则按关键帧采样，无帧回退 fallback
function sampleOrEdit(ref, prop, t, fallback){
  if(PV.editRef===ref && (prop in PV.editVals)) return PV.editVals[prop];
  return sampleKey(ref.keys[prop], t, fallback);
}

function beatPulse(t){
  if(!PV.lyBeatOn) return 1;
  const spb=60/PV.bpm; const rel=Math.max(0,t-S.beatOffset);
  const beatProg=(rel%spb)/spb;
  return 1 + PV.beatAmp*Math.pow(1-beatProg,3);
}

// 当前歌词（含入场进度）
function curLyric(t){
  let idx=-1;
  for(let i=0;i<S.lyrics.length;i++){ if(S.lyrics[i].t<=t) idx=i; else break; }
  if(idx<0) return null;
  const l=S.lyrics[idx];
  const age=t-l.t;               // 出现了多久
  const p=Math.min(1, age/Math.max(0.05,PV.animDur)); // 入场进度 0..1
  return { ...l, idx, age, p, visible: t<l.end };
}

// 缓动
const easeOut=x=>1-Math.pow(1-x,3);
const easeBack=x=>{ const c1=1.70158,c3=c1+1; return 1+c3*Math.pow(x-1,3)+c1*Math.pow(x-1,2); };

function drawBackground(t){
  const W=cv.width, H=cv.height;
  cx.fillStyle='#000'; cx.fillRect(0,0,W,H);
  const img=S.imgEl;
  if(img && img.complete && img.naturalWidth){
    let scale, px, py, rot;
    const camEditing = PV.editRef===PV.cam;
    if(hasKeys(PV.cam) || camEditing){
      // 关键帧驱动的运镜（编辑中的属性实时预览）：scale 基准 1，x/y 画面比例偏移，rot 度
      scale = sampleOrEdit(PV.cam, 'scale', t, PV.cam.cur.scale) * 1.02;   // 略放大避免边缘露黑
      px = sampleOrEdit(PV.cam, 'x', t, PV.cam.cur.x) * W;
      py = sampleOrEdit(PV.cam, 'y', t, PV.cam.cur.y) * H;
      rot = sampleOrEdit(PV.cam, 'rot', t, PV.cam.cur.rot) * Math.PI/180;
    } else if(PV.cam.cur.scale!==1 || PV.cam.cur.x || PV.cam.cur.y || PV.cam.cur.rot){
      // 有手动位姿（但没打关键帧）：用静态位姿
      scale=PV.cam.cur.scale*1.02; px=PV.cam.cur.x*W; py=PV.cam.cur.y*H; rot=PV.cam.cur.rot*Math.PI/180;
    } else {
      // 默认：温和自动运镜（camAmp 滑块）
      const amp=PV.camAmp, slow=t*0.03;
      scale=1.06 + amp*(0.06 + 0.03*Math.sin(slow));
      px=amp*0.04*Math.sin(slow*0.7)*W;
      py=amp*0.04*Math.cos(slow*0.5)*H;
      rot=0;
    }
    const ir=img.naturalWidth/img.naturalHeight, cr=W/H;
    let dw,dh; if(ir>cr){ dh=H*scale; dw=dh*ir; } else { dw=W*scale; dh=dw/ir; }
    cx.save();
    cx.translate(W/2+px, H/2+py);
    if(rot) cx.rotate(rot);
    cx.drawImage(img, -dw/2, -dh/2, dw, dh);
    cx.restore();
  } else {
    cx.fillStyle='#181820'; cx.fillRect(0,0,W,H);
    cx.fillStyle='#555'; cx.font='22px sans-serif'; cx.textAlign='center';
    cx.fillText('导入图片作为背景（字幕才是主角）', W/2, H/2);
  }
  // 背景暗化（让字幕更清晰）
  if(PV.dim>0){ cx.fillStyle=`rgba(0,0,0,${PV.dim})`; cx.fillRect(0,0,W,H); }
}

function drawGrain(){
  const W=cv.width,H=cv.height;
  const g=cx.createRadialGradient(W/2,H/2,H*0.3,W/2,H/2,W*0.75);
  g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,'rgba(0,0,0,0.5)');
  cx.fillStyle=g; cx.fillRect(0,0,W,H);
  cx.globalAlpha=0.04; for(let i=0;i<W*H/1200;i++){ cx.fillStyle=Math.random()>.5?'#fff':'#000';
    cx.fillRect(Math.random()*W,Math.random()*H,1,1); } cx.globalAlpha=1;
}

// 字幕锚点：根据排版模式算出这句的中心位置
function lyricAnchor(L, t, W, H, baseFs){
  const idx=L.idx;
  switch(PV.ly.layout){
    case 'alt': {           // 左右交替，纵向也错开
      const left = idx%2===0;
      return { cx: left ? W*0.32 : W*0.68, cy: H*(0.28 + (idx%3)*0.20) };
    }
    case 'random': {        // 伪随机跳位（按句号稳定，不会每帧乱跳）
      return { cx: W*(0.22 + rand(idx*2+1)*0.56), cy: H*(0.22 + rand(idx*2+7)*0.54) };
    }
    default: return { cx:W/2, cy:H*PV.ly.pos };   // center / kinetic
  }
}
// 字幕底板（色条/方框/色块/上下线）
function drawBackdrop(ccx, ccy, textW, fs, alpha){
  if(PV.ly.backdrop==='none') return;
  const padX=fs*0.5, padY=fs*0.35, w=textW+padX*2, h=fs+padY*2;
  const x=ccx-w/2, y=ccy-h/2;
  cx.save(); cx.globalAlpha=alpha; cx.fillStyle=PV.ly.bdColor; cx.strokeStyle=PV.ly.bdColor;
  if(PV.ly.backdrop==='bar'){ cx.globalAlpha=alpha*0.55; cx.fillRect(x,y,w,h); }
  else if(PV.ly.backdrop==='box'){ cx.lineWidth=Math.max(2,fs*0.05); cx.strokeRect(x,y,w,h); }
  else if(PV.ly.backdrop==='block'){ cx.fillRect(x,y,w,h); }
  else if(PV.ly.backdrop==='line'){ cx.lineWidth=Math.max(2,fs*0.06); cx.lineCap='round';
    cx.beginPath(); cx.moveTo(x,y); cx.lineTo(x+w,y); cx.moveTo(x,y+h); cx.lineTo(x+w,y+h); cx.stroke(); }
  cx.restore();
}
// 底板为 block/box 时，文字自动取反差色更清晰
function textColorOn(bd){ return (bd==='block') ? '#ffffff' : PV.ly.color; }

/* ===================== 版式模板引擎（网易云动效歌词风） =====================
 * 每句歌词生成一组 piece：文字块 / 矩形 / 线条，各带 {type,x,y,...,delay}
 * x/y 为画面比例(0..1)，delay 为入场延迟(秒)。drawPieces 统一渲染 + 交错入场。
 * 微调：PV.tpl = { scale, scatter, bigRatio }
 */
PV.tpl={ name:'plate', scale:1, scatter:1, bigRatio:2.2 };
// 把一句拆成词组（中文按 2 字，英文按空格）
function splitWords(text){
  if(/\s/.test(text)) return text.split(/(\s+)/).filter(w=>w.trim());
  const s=[...text], w=[]; for(let i=0;i<s.length;i+=2) w.push(s.slice(i,i+2).join('')); return w;
}
// 生成某句的版式 pieces（纯数据，渲染与导出共用）
// 逐字排布：返回每个字的画面坐标（比例）与字号（像素），横排居中于 (cx0,cy0)
// 逐字排布，超过 maxW(默认 76% 宽)自动折行；返回每字 {x,y,w}（比例坐标）
function layoutChars(chars, fsPx, cx0, cy0, W, H){
  cx.save(); cx.font=`${PV.ly.fw} ${Math.round(fsPx)}px sans-serif`;
  const ws=chars.map(c=>cx.measureText(c).width||fsPx*0.5); cx.restore();
  const gap=fsPx*0.12, hardMax=W*0.72, lh=fsPx*1.35;
  // 均衡分行：先算行数，按目标宽度尽量等宽分（与 wrapText 一致）
  const totalW=ws.reduce((a,b)=>a+b,0)+gap*(chars.length-1);
  const nLines=Math.max(1, Math.ceil(totalW/hardMax));
  const target=totalW/nLines;
  const rows=[]; let cur=[], curW=0;
  for(let i=0;i<chars.length;i++){
    if(cur.length && (curW+ws[i]>target) && rows.length<nLines-1){ rows.push(cur); cur=[]; curW=0; }
    else if(cur.length && curW+ws[i]>hardMax){ rows.push(cur); cur=[]; curW=0; }
    cur.push({i,w:ws[i]}); curW+=ws[i]+gap;
  }
  if(cur.length) rows.push(cur);
  const totalH=(rows.length-1)*lh;
  const out=new Array(chars.length);
  rows.forEach((row,ri)=>{
    const rowW=row.reduce((a,c)=>a+c.w,0)+gap*(row.length-1);
    let px=cx0*W-rowW/2;
    const ry=cy0*H - totalH/2 + ri*lh;
    for(const c of row){ out[c.i]={x:(px+c.w/2)/W, y:ry/H, w:c.w}; px+=c.w+gap; }
  });
  return out;
}
function buildPieces(L, W, H){
  const fs=PV.ly.fs*(H/720)*PV.tpl.scale;      // 字号(px)
  const fsR=fs/H;                              // 字号占高度比
  const col=PV.ly.color, bd=PV.ly.bdColor, stk=PV.ly.stroke;
  const idx=L.idx;
  const chars=[...(L.text||'')].filter(c=>c.trim());
  const n=chars.length, P=[];
  const cx0=0.5, cy0=PV.ly.pos>0.7?0.5:PV.ly.pos;
  const plate=fsR*1.5;                          // 实心底板恒比字大
  const PLATE_SHP=['rect','circle','diamond','hexagon'];
  const DECO_SHP=['ring','circle','diamond','triangle'];
  // 随机挑约 35% 的字给底板（按句号+字号稳定，不每帧变）
  const hasPlate=i=>rand(idx*97+i*7)<0.35;
  const plateShp=i=>PLATE_SHP[Math.floor(rand(idx*31+i)*PLATE_SHP.length)];

  if(PV.tpl.name==='plate'){
    // 【字底板】随机挑字踩实心底板（交替形状、卡点脉冲），个别字旁点缀空心图形
    const pos=layoutChars(chars, fs, cx0, cy0, W, H);
    pos.forEach((p,i)=>{
      const on=hasPlate(i);
      if(on) P.push({type:'shape',shp:plateShp(i),solid:true,beat:true,color:i%2?bd:stk,size:plate,x:p.x,y:p.y,delay:i*0.06});
      P.push({type:'text',str:chars[i],x:p.x,y:p.y,fs,color:on?'#fff':col,delay:i*0.06+0.04});
      if(!on && rand(idx*53+i)<0.2) P.push({type:'shape',shp:'ring',solid:false,color:bd,size:fsR*0.55,x:p.x,y:p.y-plate*0.7,delay:i*0.06+0.1});
    });
  }
  else if(PV.tpl.name==='accent'){
    // 【关键字强调】随机抽 2~3 个字放大 + 实心底板，其余正常；空心框破型
    const pos=layoutChars(chars, fs, cx0, cy0, W, H);
    const nAcc=Math.min(n, 2+Math.floor(rand(idx*11)*2));  // 抽 2~3 个
    const acc={}; let picked=0, guard=0;
    while(picked<nAcc && guard++<50){ const k=Math.floor(rand(idx*7+guard)*n); if(!acc[k]){ acc[k]=1; picked++; } }
    pos.forEach((p,i)=>{
      if(acc[i]){
        P.push({type:'shape',shp:plateShp(i),solid:true,beat:true,color:bd,size:fsR*1.9,x:p.x,y:p.y,delay:0.1+i*0.05});
        P.push({type:'text',str:chars[i],x:p.x,y:p.y,fs:fs*1.25,color:'#fff',delay:0.14+i*0.05});
      } else {
        P.push({type:'text',str:chars[i],x:p.x,y:p.y,fs:fs*0.9,color:col,delay:i*0.05});
      }
    });
  }
  else if(PV.tpl.name==='stagger'){
    // 【错落阶梯】用均衡换行定位（换行标准），再叠加每字随机微抖 + 随机顺序蹦出
    const pos=layoutChars(chars, fs, cx0, cy0, W, H);
    // 每个字随机出现顺序
    const order=[...Array(n).keys()].sort((a,b)=>rand(idx*61+a)-rand(idx*61+b));
    const delayOf={}; order.forEach((ci,rankIndex)=>{ delayOf[ci]=rankIndex*0.08; });
    pos.forEach((p,c)=>{
      const jx=(rand(idx*29+c)-0.5)*0.02;      // 轻微错开（比例坐标）
      const jy=(rand(idx*37+c)-0.5)*fsR*0.4;
      const x=p.x+jx, y=p.y+jy;
      const on=hasPlate(c);
      if(on) P.push({type:'shape',shp:plateShp(c),solid:true,beat:true,color:bd,size:plate,x,y,delay:delayOf[c]});
      P.push({type:'text',str:chars[c],x,y,fs,color:on?'#fff':col,delay:delayOf[c]+0.03});
      if(!on && rand(idx*41+c)<0.15) P.push({type:'shape',shp:DECO_SHP[c%DECO_SHP.length],solid:false,color:stk,size:fsR*0.5,x,y:y-plate*0.7,delay:delayOf[c]+0.1});
    });
  }
  else if(PV.tpl.name==='boxed'){
    // 【框字】随机挑字用空心框包住（破型装饰），个别实心底板；无多余线条
    const pos=layoutChars(chars, fs, cx0, cy0, W, H);
    pos.forEach((p,i)=>{
      const r=rand(idx*29+i);
      if(r<0.25){ P.push({type:'shape',shp:'rect',solid:true,beat:true,color:bd,size:plate,x:p.x,y:p.y,delay:i*0.06});
        P.push({type:'text',str:chars[i],x:p.x,y:p.y,fs,color:'#fff',delay:i*0.06+0.04}); }
      else if(r<0.55){ P.push({type:'shape',shp:'rect',solid:false,color:stk,size:fsR*1.45,x:p.x,y:p.y,rot:(rand(i)-0.5)*10,delay:i*0.06});
        P.push({type:'text',str:chars[i],x:p.x,y:p.y,fs,color:col,delay:i*0.06+0.04}); }
      else P.push({type:'text',str:chars[i],x:p.x,y:p.y,fs,color:col,delay:i*0.06});
    });
  }
  else { // magazine：整句偏左大字 + 交叉破型线（保留线条，因为它是相交排版）
    const pos=layoutChars(chars, fs*1.1, cx0-0.02, cy0, W, H);
    if(pos[0]) P.push({type:'shape',shp:'rect',solid:true,beat:true,color:bd,size:fsR*1.7,x:pos[0].x,y:pos[0].y,delay:0});
    pos.forEach((p,i)=>P.push({type:'text',str:chars[i],x:p.x,y:p.y,fs:fs*1.1,color:i===0?'#fff':col,delay:i*0.05+0.05}));
    // 相交破型线（贯穿文字）
    P.push({type:'line',color:stk,x1:cx0-0.4,y1:cy0-0.02,x2:cx0+0.4,y2:cy0+0.03,delay:0.12});
    P.push({type:'line',color:bd,x1:cx0+0.28,y1:cy0-0.18,x2:cx0+0.28,y2:cy0+0.18,delay:0.18});
    P.push({type:'shape',shp:'ring',solid:false,color:bd,size:fsR*0.8,x:cx0+0.28,y:cy0-0.18,delay:0.28});
  }
  return P;
}
// 渲染 pieces：age 为该句已出现时长，用于交错入场（每个 piece 各自 delay）
function drawPieces(pieces, age, W, H, t){
  const beat = t!=null ? Math.pow(1-beatInfo(t).beatProg,3) : 0;   // 卡点脉冲量
  for(const pc of pieces){
    const local=age-(pc.delay||0);
    if(local<0) continue;
    const prog=Math.min(1, local/0.4), e=easeOut(prog);
    // 入场：实心底板缩放弹入、空心/线用生长、文字上浮
    cx.save(); cx.globalAlpha=e;
    if(pc.type==='rect'){
      // 兼容旧的矩形色条
      const w=pc.w*W, h=pc.h*H, x=pc.x*W-w/2, y=pc.y*H-h/2;
      const sc=0.6+0.4*e; cx.translate(pc.x*W,pc.y*H); cx.scale(sc,sc); cx.translate(-pc.x*W,-pc.y*H);
      if(pc.fill){ cx.fillStyle=pc.fill; cx.fillRect(x,y,w,h); }
      if(pc.stroke){ cx.strokeStyle=pc.stroke; cx.lineWidth=Math.max(2,H*0.004); cx.strokeRect(x,y,w,h); }
    } else if(pc.type==='shape'){
      // 通用图形：实心底板 / 空心装饰，size 为画面高度比例；可卡点脉冲
      const base=pc.size*H;
      const pulse = pc.beat ? (1+0.12*beat) : 1;
      const sc=(pc.solid ? easeBack(Math.min(1,prog)) : e) * pulse;
      cx.translate(pc.x*W, pc.y*H);
      if(pc.spin) cx.rotate((pc.rot||0)*Math.PI/180 + (pc.spin*age));
      else if(pc.rot) cx.rotate(pc.rot*Math.PI/180);
      cx.scale(sc,sc);
      cx.lineJoin='round'; cx.lineCap='round';
      shapePath(pc.shp, base);
      if(pc.solid){ cx.fillStyle=pc.color; cx.fill(); }
      else { cx.strokeStyle=pc.color; cx.lineWidth=Math.max(2,pc.lw||H*0.006); cx.stroke(); }
    } else if(pc.type==='line'){
      const grow=e; const mx=(pc.x1+pc.x2)/2, my=(pc.y1+pc.y2)/2;
      const x1=mx+(pc.x1-mx)*grow, x2=mx+(pc.x2-mx)*grow;
      const y1=my+(pc.y1-my)*grow, y2=my+(pc.y2-my)*grow;
      cx.strokeStyle=pc.color; cx.lineWidth=Math.max(2,pc.lw||H*0.005); cx.lineCap='round';
      cx.beginPath(); cx.moveTo(x1*W,y1*H); cx.lineTo(x2*W,y2*H); cx.stroke();
    } else if(pc.type==='text'){
      const dy=(1-e)*pc.fs*0.4;
      cx.translate(pc.x*W, pc.y*H+dy);
      if(pc.rot) cx.rotate(pc.rot*Math.PI/180);
      cx.textAlign=pc.align||'center'; cx.textBaseline='middle';
      cx.font=`${PV.ly.fw} ${Math.round(pc.fs)}px "PingFang SC","Microsoft YaHei",sans-serif`;
      cx.lineJoin='round';
      if(PV.ly.strokeW>0){ cx.lineWidth=PV.ly.strokeW; cx.strokeStyle=PV.ly.stroke; cx.strokeText(pc.str,0,0); }
      cx.fillStyle=pc.color; cx.fillText(pc.str,0,0);
    }
    cx.restore();
  }
}

// 核心：绘制字幕（排版 + 底板 + AE 风入场动效）
// 字幕外层：叠加整体关键帧变换（位移/缩放/旋转），再画字幕本体
function drawLyric(t){
  const L=curLyric(t);
  if(!L || !L.visible || !L.text) return;
  if(PV.splitLines && PV.splitLines[L.t.toFixed(2)]) return;   // 该句已拆成逐字元素，原句不再画
  const W=cv.width, H=cv.height, kf=PV.lyKf, editing=(PV.editRef===kf);
  const useKf = kf.keys.x.length||kf.keys.y.length||kf.keys.scale.length||kf.keys.rot.length||editing
    || kf.cur.x||kf.cur.y||kf.cur.scale!==1||kf.cur.rot || PV.ly.rot;
  if(!useKf){ drawLyricBody(t); return; }
  const lx=sampleOrEdit(kf,'x',t,kf.cur.x), ly=sampleOrEdit(kf,'y',t,kf.cur.y);
  const ls=sampleOrEdit(kf,'scale',t,kf.cur.scale), lr=sampleOrEdit(kf,'rot',t,kf.cur.rot);
  cx.save();
  cx.translate(W/2+lx*W, H/2+ly*H); cx.scale(ls,ls);
  cx.rotate((lr+PV.ly.rot)*Math.PI/180);   // 叠加简单旋转滑块，对所有排版生效
  cx.translate(-W/2,-H/2);
  drawLyricBody(t);
  cx.restore();
}
function drawLyricBody(t){
  const L=curLyric(t);
  if(!L || !L.visible || !L.text) return;
  if(PV.splitLines && PV.splitLines[L.t.toFixed(2)]) return;   // 该句已拆成逐字元素，原句不再画
  const W=cv.width, H=cv.height;
  const baseFs=PV.ly.fs * (H/720);          // 字号随分辨率缩放
  const pulse=beatPulse(t);
  const p=L.p, e=easeOut(p);
  // —— 版式模板（网易云动效歌词风）优先处理 ——
  if(PV.ly.layout==='template'){
    cx.save();
    drawPieces(buildPieces(L, W, H), L.age, W, H, t);
    cx.restore(); return;
  }

  const A=lyricAnchor(L, t, W, H, baseFs);  // 锚点

  cx.save();
  cx.textAlign='center'; cx.textBaseline='middle';
  cx.lineJoin='round';

  // —— 逐词错落（kinetic）单独处理 ——
  if(PV.ly.layout==='kinetic'){
    drawKinetic(L, t, A.cx, A.cy, baseFs, pulse);
    cx.restore(); return;
  }
  // —— 竖排 ——
  if(PV.ly.orient==='v'){
    drawVertical(L, t, A.cx, A.cy, baseFs, pulse, e);
    cx.restore(); return;
  }

  // —— 逐字类入场动效 ——
  if(PV.anim==='typewriter' || PV.anim==='wordpop'){
    // 底板按整行宽度
    cx.font=`${PV.ly.fw} ${Math.round(baseFs)}px "PingFang SC","Microsoft YaHei",sans-serif`;
    drawBackdrop(A.cx, A.cy, cx.measureText(L.text).width, baseFs, e);
    drawPerChar(L, t, A.cx, A.cy, baseFs, pulse);
    cx.restore(); return;
  }

  // —— 整行入场动效 ——
  let alpha=1, dx=0, dy=0, sc=1, blur=0;
  if(PV.anim==='fade'){ alpha=e; }
  else if(PV.anim==='rise'){ alpha=e; dy=(1-e)*baseFs*0.8; }
  else if(PV.anim==='scale'){ alpha=e; sc=easeBack(Math.min(1,p)); }
  else if(PV.anim==='blur'){ alpha=e; blur=(1-e)*12; }
  else if(PV.anim==='slide'){ alpha=e; dx=(1-e)*W*0.15; }
  // none: 全默认

  cx.font=`${PV.ly.fw} ${Math.round(baseFs*sc)}px "PingFang SC","Microsoft YaHei",sans-serif`;
  drawBackdrop(A.cx+dx, A.cy+dy, cx.measureText(L.text).width, baseFs*sc*pulse, alpha);
  drawLine(L.text, A.cx+dx, A.cy+dy, baseFs, sc*pulse, alpha, blur, textColorOn(PV.ly.backdrop));
  cx.restore();
}

// 按画面宽度把整句折成多行（中文按字、英文按词）
function wrapText(text, fs){
  const hardMax=cv.width*0.72;     // 硬上限：更早换行，多分几行
  cx.save(); cx.font=`${PV.ly.fw} ${Math.round(fs)}px "PingFang SC","Microsoft YaHei",sans-serif`;
  const hasSpace=/\s/.test(text);
  const units = hasSpace ? text.split(/(\s+)/).filter(u=>u!=='') : [...text];
  const full=cx.measureText(text.trim()).width;
  // 目标行数：按硬上限算，再取平衡目标宽度
  const nLines=Math.max(1, Math.ceil(full/hardMax));
  const target=full/nLines;        // 均衡目标：每行接近等宽
  const lines=[]; let cur='';
  for(const u of units){
    const test=cur+u;
    // 超过目标且已有内容就换行；但不超过硬上限时允许略超目标以避免过碎
    if(cur.trim() && cx.measureText(test).width>target && lines.length<nLines-1){
      lines.push(cur.trim()); cur=hasSpace?u.trimStart():u;
    } else if(cur.trim() && cx.measureText(test).width>hardMax){
      lines.push(cur.trim()); cur=hasSpace?u.trimStart():u;
    } else cur=test;
  }
  if(cur.trim()) lines.push(cur.trim());
  cx.restore();
  return lines.length?lines:[text];
}
function drawLine(text, x, y, fs, scale, alpha, blur, color){
  const lines=wrapText(text, fs*scale);
  const lh=fs*1.3;                       // 行高（未缩放）
  cx.save();
  cx.globalAlpha=alpha;
  if(blur>0) cx.filter=`blur(${blur}px)`;
  cx.translate(x,y); cx.scale(scale,scale);
  cx.font=`${PV.ly.fw} ${Math.round(fs)}px "PingFang SC","Microsoft YaHei",sans-serif`;
  const y0=-(lines.length-1)*lh/2;       // 多行整体垂直居中
  for(let i=0;i<lines.length;i++){
    const ly=y0+i*lh;
    if(PV.ly.strokeW>0){ cx.lineWidth=PV.ly.strokeW; cx.strokeStyle=PV.ly.stroke; cx.strokeText(lines[i],0,ly); }
    cx.fillStyle=color||PV.ly.color; cx.fillText(lines[i],0,ly);
  }
  cx.restore();
}

// 逐字打字 / 逐字弹出（acx/acy = 该句锚点中心）
function drawPerChar(L, t, acx, acy, baseFs, pulse){
  const y=acy;
  const chars=[...L.text];
  const per=PV.animDur/Math.max(1,chars.length);  // 每字间隔
  cx.font=`${PV.ly.fw} ${Math.round(baseFs)}px "PingFang SC","Microsoft YaHei",sans-serif`;
  const widths=chars.map(c=>cx.measureText(c).width);
  const total=widths.reduce((a,b)=>a+b,0);
  let x=acx-total/2;
  const col=textColorOn(PV.ly.backdrop);
  for(let i=0;i<chars.length;i++){
    const cage=L.age - i*per;                 // 该字出现时长
    if(cage<0){ x+=widths[i]; continue; }
    const cp=Math.min(1,cage/Math.max(0.05,per*1.5));
    let alpha=1, sc=1, dy=0;
    if(PV.anim==='typewriter'){ alpha=cp; }
    else { alpha=cp; sc=easeBack(cp); }        // wordpop 弹出
    cx.save();
    cx.globalAlpha=alpha;
    cx.translate(x+widths[i]/2, y+dy); cx.scale(sc*pulse, sc*pulse);
    if(PV.ly.strokeW>0){ cx.lineWidth=PV.ly.strokeW; cx.strokeStyle=PV.ly.stroke; cx.strokeText(chars[i],0,0); }
    cx.fillStyle=col; cx.fillText(chars[i],0,0);
    cx.restore();
    x+=widths[i];
  }
}

// 逐词错落（kinetic typography）：按空格/标点分词，逐词交错弹入、纵向轻微错开
function drawKinetic(L, t, acx, acy, baseFs, pulse){
  // 中文按 2 字一组，英文按空格分词
  let words;
  if(/\s/.test(L.text)) words=L.text.split(/(\s+)/).filter(w=>w.trim());
  else { words=[]; const s=[...L.text]; for(let i=0;i<s.length;i+=2) words.push(s.slice(i,i+2).join('')); }
  const per=PV.animDur/Math.max(1,words.length);
  cx.font=`${PV.ly.fw} ${Math.round(baseFs)}px "PingFang SC","Microsoft YaHei",sans-serif`;
  const gap=baseFs*0.25, W=cv.width;
  const widths=words.map(w=>cx.measureText(w).width);
  // 均衡分行：先算行数，按目标宽度分
  const totalW=widths.reduce((a,b)=>a+b,0)+gap*(words.length-1);
  const hardMax=W*0.72, nLines=Math.max(1,Math.ceil(totalW/hardMax)), target=totalW/nLines;
  const rows=[]; let cur=[], curW=0;
  for(let i=0;i<words.length;i++){
    if(cur.length && curW+widths[i]>target && rows.length<nLines-1){ rows.push(cur); cur=[]; curW=0; }
    else if(cur.length && curW+widths[i]>hardMax){ rows.push(cur); cur=[]; curW=0; }
    cur.push(i); curW+=widths[i]+gap;
  }
  if(cur.length) rows.push(cur);
  const lh=baseFs*1.4, y0=acy-(rows.length-1)*lh/2;
  const col=textColorOn(PV.ly.backdrop);
  rows.forEach((row,ri)=>{
    const rowW=row.reduce((a,i)=>a+widths[i],0)+gap*(row.length-1);
    let x=acx-rowW/2;
    const ry=y0+ri*lh;
    for(const i of row){
      const wage=L.age - i*per*0.6;
      const cp=wage<0?0:Math.min(1,wage/Math.max(0.05,per*1.5));
      const sc=easeBack(Math.max(0,cp));
      const yoff=(rand(L.idx*7+i)-0.5)*baseFs*0.5;   // 每词纵向错落
      cx.save();
      cx.globalAlpha=cp;
      cx.translate(x+widths[i]/2, ry+yoff); cx.scale(sc*pulse, sc*pulse);
      if(PV.ly.strokeW>0){ cx.lineWidth=PV.ly.strokeW; cx.strokeStyle=PV.ly.stroke; cx.strokeText(words[i],0,0); }
      cx.fillStyle=col; cx.fillText(words[i],0,0);
      cx.restore();
      x+=widths[i]+gap;
    }
  });
}

// #4：竖排字幕（从上往下，右起或居中列）
function drawVertical(L, t, acx, acy, baseFs, pulse, e){
  const chars=[...L.text].filter(c=>c.trim());
  const H=cv.height, W=cv.width;
  const lh=baseFs*1.18, colW=baseFs*1.35;
  const maxPerCol=Math.max(1, Math.floor(H*0.72/lh));   // 每列最多几字，超了换列
  const nCol=Math.ceil(chars.length/maxPerCol);
  const perCol=Math.ceil(chars.length/nCol);
  const col=textColorOn(PV.ly.backdrop);
  const per=PV.animDur/Math.max(1,chars.length);
  cx.font=`${PV.ly.fw} ${Math.round(baseFs)}px "PingFang SC","Microsoft YaHei",sans-serif`;
  cx.textAlign='center'; cx.textBaseline='middle';
  // 列从右到左（传统竖排），整体在锚点居中
  const totalW=(nCol-1)*colW;
  for(let i=0;i<chars.length;i++){
    const ci=Math.floor(i/perCol), ri=i%perCol;
    const rows=(ci===nCol-1)?(chars.length-ci*perCol):perCol;
    const x=acx + totalW/2 - ci*colW;                    // 右列先排
    const colH=(rows-1)*lh;
    const y=acy - colH/2 + ri*lh;
    const cage=L.age - i*per;
    const cp=cage<0?0:Math.min(1,cage/Math.max(0.05,PV.animDur));
    const ce=easeOut(cp);
    cx.save();
    cx.globalAlpha=ce;
    cx.translate(x, y+(1-ce)*baseFs*0.4); cx.scale(pulse,pulse);
    if(PV.ly.strokeW>0){ cx.lineWidth=PV.ly.strokeW; cx.strokeStyle=PV.ly.stroke; cx.strokeText(chars[i],0,0); }
    cx.fillStyle=col; cx.fillText(chars[i],0,0);
    cx.restore();
  }
}

function drawTitle(t){
  if(!PV.fx.title || t>=5 || !S.meta.title) return;
  const W=cv.width, H=cv.height;
  const a=t<4?1:(5-t);
  cx.save(); cx.globalAlpha=a; cx.textAlign='left'; cx.textBaseline='alphabetic';
  cx.font='700 '+Math.round(H*0.05)+'px sans-serif'; cx.fillStyle='#fff';
  cx.fillText(S.meta.title, W*0.06, H*0.14);
  const sub=[S.meta.artist&&('翻唱 '+S.meta.artist), S.meta.origin&&('原唱 '+S.meta.origin)].filter(Boolean).join('　');
  if(sub){ cx.font=Math.round(H*0.028)+'px sans-serif'; cx.fillStyle='rgba(255,255,255,.8)';
    cx.fillText(sub, W*0.06, H*0.14+H*0.05); }
  cx.restore();
}

function drawFlash(t){
  if(!PV.fx.flash) return;
  const spb=60/PV.bpm; const rel=Math.max(0,t-S.beatOffset);
  const beatProg=(rel%spb)/spb;
  const f=Math.pow(1-beatProg,8)*0.3;
  if(f>0.01){ cx.fillStyle=`rgba(255,255,255,${f})`; cx.fillRect(0,0,cv.width,cv.height); }
}

/* ===================== 画面滤镜 / 整体特效（非卡点，后期层） ===================== */
function drawFilters(t){
  const F=PV.filt, W=cv.width, H=cv.height, I=F.intensity;
  // —— 像素级（先处理，避免被叠加层影响）——
  if(F.invert||F.duotone||F.chromatic){
    try{
      const img=cx.getImageData(0,0,W,H), d=img.data;
      if(F.invert){ for(let i=0;i<d.length;i+=4){ d[i]=255-d[i]; d[i+1]=255-d[i+1]; d[i+2]=255-d[i+2]; } }
      if(F.duotone){
        const c1=hexArr(F.tintColor), c2=[255,255,255];
        for(let i=0;i<d.length;i+=4){ const l=(d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114)/255;
          d[i]=c1[0]+(c2[0]-c1[0])*l; d[i+1]=c1[1]+(c2[1]-c1[1])*l; d[i+2]=c1[2]+(c2[2]-c1[2])*l; } }
      cx.putImageData(img,0,0);
      if(F.chromatic){ const dx=Math.round(3+I*8);
        cx.save(); cx.globalCompositeOperation='lighter'; cx.globalAlpha=0.5;
        cx.drawImage(cv,-dx,0); cx.drawImage(cv,dx,0); cx.restore(); }
    }catch(e){/* 跨域图会污染 canvas，忽略像素滤镜 */}
  }
  // —— 叠加层（便宜，安全）——
  if(F.tint){ cx.save(); cx.globalAlpha=0.35*I; cx.globalCompositeOperation='overlay';
    cx.fillStyle=F.tintColor; cx.fillRect(0,0,W,H); cx.restore(); }
  if(F.glow){ cx.save(); cx.globalCompositeOperation='lighter'; cx.globalAlpha=0.15*I;
    const g=cx.createRadialGradient(W/2,H/2,0,W/2,H/2,Math.hypot(W,H)/2);
    g.addColorStop(0,'#ffffff'); g.addColorStop(1,'rgba(255,255,255,0)'); cx.fillStyle=g; cx.fillRect(0,0,W,H); cx.restore(); }
  if(F.vignette){ const g=cx.createRadialGradient(W/2,H/2,Math.min(W,H)*0.35,W/2,H/2,Math.hypot(W,H)/1.6);
    g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,`rgba(0,0,0,${0.4+0.4*I})`);
    cx.save(); cx.fillStyle=g; cx.fillRect(0,0,W,H); cx.restore(); }
  if(F.scanlines){ cx.save(); cx.globalAlpha=0.15+0.2*I; cx.fillStyle='#000';
    const step=Math.max(2,Math.round(3+I*3)); for(let y=0;y<H;y+=step*2) cx.fillRect(0,y,W,step); cx.restore(); }
  if(F.noise){ cx.save(); cx.globalAlpha=0.04+0.12*I;
    for(let i=0;i<W*H/700;i++){ cx.fillStyle=Math.random()>.5?'#fff':'#000'; cx.fillRect(Math.random()*W,Math.random()*H,1,1); } cx.restore(); }
  if(F.oldfilm){ // 老电影：暗角 + 竖划痕 + 轻微闪烁
    cx.save(); const fl=0.06*Math.sin(t*30); cx.globalAlpha=Math.max(0,0.08+fl); cx.fillStyle='#000'; cx.fillRect(0,0,W,H); cx.restore();
    cx.save(); cx.globalAlpha=0.25; cx.strokeStyle='#000'; cx.lineWidth=1;
    for(let k=0;k<3;k++){ const x=(rand(Math.floor(t*8)+k)*W); cx.beginPath(); cx.moveTo(x,0); cx.lineTo(x,H); cx.stroke(); } cx.restore(); }
  if(F.warm){ cx.save(); cx.globalCompositeOperation='overlay'; cx.globalAlpha=0.3*I; cx.fillStyle='#ff8a3a'; cx.fillRect(0,0,W,H); cx.restore(); }
  if(F.cool){ cx.save(); cx.globalCompositeOperation='overlay'; cx.globalAlpha=0.3*I; cx.fillStyle='#3a7aff'; cx.fillRect(0,0,W,H); cx.restore(); }
  if(F.sepia){ cx.save(); cx.globalCompositeOperation='color'; cx.globalAlpha=0.6*I; cx.fillStyle='#704214'; cx.fillRect(0,0,W,H); cx.restore(); }
  if(F.lightleak){ // 漏光：暖色从一角径向渗入（screen 混合）
    cx.save(); cx.globalCompositeOperation='screen'; cx.globalAlpha=0.4*I;
    const g=cx.createRadialGradient(W*0.85,H*0.15,0,W*0.85,H*0.15,Math.hypot(W,H)*0.6);
    g.addColorStop(0,'#ffc44a'); g.addColorStop(0.5,'rgba(255,90,60,0.4)'); g.addColorStop(1,'rgba(0,0,0,0)');
    cx.fillStyle=g; cx.fillRect(0,0,W,H); cx.restore(); }
  if(F.blur){ cx.save(); cx.filter=`blur(${Math.round(2+I*8)}px)`; cx.globalAlpha=0.6; cx.drawImage(cv,0,0); cx.restore(); }
  if(F.letterbox){ const bh=H*(0.10+0.05*I); cx.save(); cx.fillStyle='#000'; cx.fillRect(0,0,W,bh); cx.fillRect(0,H-bh,W,bh); cx.restore(); }
}
function hexArr(hex){ const n=parseInt(hex.slice(1),16); return [(n>>16)&255,(n>>8)&255,n&255]; }

/* ===================== 矢量图形装饰（AE 风 motion graphics） ===================== */
// 拍内进度 0..1（拍头=0）与"距最近拍头的时间"，供卡点动效用
function beatInfo(t){
  const spb=60/PV.bpm; const rel=Math.max(0,t-S.beatOffset);
  const beatProg=(rel%spb)/spb; const beatIdx=Math.floor(rel/spb);
  return { spb, beatProg, beatIdx };
}

/* ===================== 大面积矢量动效（铺满画面的生成器层） ===================== */
function hexRGBA(hex,a){ const n=parseInt(hex.slice(1),16); return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`; }
// 供各 fx 读取的全局粗细/大小/透明度系数
let FXW=1, FXS=1, FXO=1;
function drawFxBig(t){
  const F=PV.fxbig; const W=cv.width, H=cv.height, col=F.color, I=F.intensity;
  FXW=F.weight; FXS=F.size; FXO=F.opacity;
  const beat=0;   // 大面积动效不跟卡点脉冲
  if(F.rings)    fxRings(t,W,H,col,I,beat);
  if(F.rays)     fxRays(t,W,H,col,I,beat);
  if(F.blinds)   fxBlinds(t,W,H,col,I,beat);
  if(F.diag)     fxDiag(t,W,H,col,I,beat);
  if(F.gridwave) fxGridWave(t,W,H,col,I,beat);
  if(F.polys)    fxPolys(t,W,H,col,I,beat);
  if(F.halftone) fxHalftone(t,W,H,col,I,beat);
  if(F.bars)     fxBars(t,W,H,col,I,beat);
  if(F.frames)   fxFrames(t,W,H,col,I,beat);
  if(F.sweep)    fxSweep(t,W,H,col,I,beat);
  if(F.blocks)   fxBlocks(t,W,H,col,I,beat);
  if(F.glitch)   fxGlitch(t,W,H,col,I,beat);
  if(F.burst)    fxBurst(t,W,H,col,I,beat);
  if(F.scatter)  fxScatter(t,W,H,col,I,beat);
}
// 1) 扩散圆环：每拍从中心涌出一圈圈同心环
function fxRings(t,W,H,col,I,beat){
  const spb=60/PV.bpm, cxp=W/2, cyp=H/2, maxR=Math.hypot(W,H)/2*FXS;
  cx.save(); cx.lineWidth=Math.max(2,H*0.006*(0.5+I))*FXW;
  for(let k=0;k<6;k++){
    const age=((t-S.beatOffset)%(spb*6))/(spb*6);   // 0..1 循环
    const phase=(age+k/6)%1;
    const r=phase*maxR;
    cx.globalAlpha=FXO*(1-phase)*0.5*I;
    cx.strokeStyle=col; cx.beginPath(); cx.arc(cxp,cyp,r,0,7); cx.stroke();
  }
  cx.restore();
}
// 2) 旋转放射线（阳光放射）
function fxRays(t,W,H,col,I,beat){
  const cxp=W/2, cyp=H/2, R=Math.hypot(W,H), n=Math.round(12+I*24);
  cx.save(); cx.translate(cxp,cyp); cx.rotate(t*0.15*(1+beat*0.5));
  cx.globalAlpha=FXO*0.12*I+0.08*beat*I; cx.fillStyle=col;
  for(let i=0;i<n;i++){ cx.rotate(Math.PI*2/n); const hw=0.03*FXW;
    cx.beginPath(); cx.moveTo(0,0); cx.lineTo(R, -R*hw); cx.lineTo(R, R*hw); cx.closePath(); cx.fill(); }
  cx.restore();
}
// 3) 横向百叶（滚动条纹）
function fxBlinds(t,W,H,col,I,beat){
  const n=Math.round(6+I*14), h=H/n, off=(t*40)%h;
  cx.save(); cx.globalAlpha=FXO*0.18*I+0.1*beat; cx.fillStyle=col;
  for(let i=-1;i<n+1;i++){ const y=i*h+off; cx.fillRect(0,y,W,h*(0.35+0.15*beat)); }
  cx.restore();
}
// 4) 斜纹滚动
function fxDiag(t,W,H,col,I,beat){
  const gap=Math.max(30,90-I*60)*FXS, off=(t*60)%(gap*2);
  cx.save(); cx.globalAlpha=FXO*0.14*I+0.08*beat; cx.strokeStyle=col; cx.lineWidth=gap*0.4*FXW;
  for(let x=-H; x<W+H; x+=gap*2){ const xx=x+off; cx.beginPath(); cx.moveTo(xx,0); cx.lineTo(xx-H,H); cx.stroke(); }
  cx.restore();
}
// 5) 网格波动（点阵随波起伏 + 拍头放大）
function fxGridWave(t,W,H,col,I,beat){
  const gap=Math.max(28,70-I*36), r=Math.max(1.5,H*0.004*(1+beat));
  cx.save(); cx.fillStyle=col;
  for(let x=gap/2;x<W;x+=gap) for(let y=gap/2;y<H;y+=gap){
    const w=Math.sin(t*2+x*0.01+y*0.01);
    cx.globalAlpha=FXO*(0.12+0.12*w)*I+0.1*beat;
    const rr=r*(1+0.5*w); cx.beginPath(); cx.arc(x,y,Math.max(0.5,rr),0,7); cx.fill();
  }
  cx.restore();
}
// 6) 大多边形漂浮（空心大形，缓慢旋转+漂移）
function fxPolys(t,W,H,col,I,beat){
  const n=Math.round(3+I*4);
  cx.save(); cx.strokeStyle=col; cx.lineWidth=Math.max(2,H*0.005)*FXW;
  for(let i=0;i<n;i++){
    const px=(0.5+0.4*Math.sin(t*0.1+i*2))*W, py=(0.5+0.4*Math.cos(t*0.13+i*3))*H;
    const size=(0.25+0.2*((i%3)/3))*H*(1+beat*0.15)*FXS;
    const sides=3+(i%4);
    cx.globalAlpha=FXO*0.12*I+0.06*beat;
    cx.save(); cx.translate(px,py); cx.rotate(t*0.2+i);
    cx.beginPath(); for(let s=0;s<sides;s++){ const a=-Math.PI/2+s*2*Math.PI/sides; const X=Math.cos(a)*size/2, Y=Math.sin(a)*size/2; s?cx.lineTo(X,Y):cx.moveTo(X,Y); } cx.closePath(); cx.stroke();
    cx.restore();
  }
  cx.restore();
}
// 7) 半调点阵（大点场，拍头整体放大）
function fxHalftone(t,W,H,col,I,beat){
  const gap=Math.max(26,64-I*32);
  cx.save(); cx.fillStyle=col;
  for(let x=gap/2;x<W;x+=gap) for(let y=gap/2;y<H;y+=gap){
    const d=Math.hypot(x-W/2,y-H/2)/Math.hypot(W/2,H/2);
    const rr=gap*0.42*(1-d)*(0.6+beat*0.8)*I;
    if(rr<0.5) continue;
    cx.globalAlpha=FXO*0.35*I; cx.beginPath(); cx.arc(x,y,rr,0,7); cx.fill();
  }
  cx.restore();
}
// 8) 律动条（四周边缘的音条，随拍伸缩）
function fxBars(t,W,H,col,I,beat){
  const n=Math.round(16+I*32), bw=W/n;
  cx.save(); cx.fillStyle=col; cx.globalAlpha=FXO*0.3*I+0.2*beat;
  for(let i=0;i<n;i++){
    const h=(0.03+0.12*Math.abs(Math.sin(t*3+i*0.5))*(0.5+beat))*H;
    cx.fillRect(i*bw+bw*0.15, H-h, bw*0.7, h);       // 底部
    cx.fillRect(i*bw+bw*0.15, 0, bw*0.7, h*0.7);     // 顶部
  }
  cx.restore();
}
// 9) 边框脉冲（每拍一圈矩形从中心放大退出）
function fxFrames(t,W,H,col,I,beat){
  const spb=60/PV.bpm; cx.save(); cx.strokeStyle=col; cx.lineWidth=Math.max(2,H*0.006);
  for(let k=0;k<4;k++){
    const phase=(((t-S.beatOffset)/(spb*4))+k/4)%1;
    const w=phase*W*1.3, h=phase*H*1.3;
    cx.globalAlpha=FXO*(1-phase)*0.4*I;
    cx.strokeRect(W/2-w/2,H/2-h/2,w,h);
  }
  cx.restore();
}
// 10) 光束扫过（斜向亮带循环扫过画面）
function fxSweep(t,W,H,col,I,beat){
  const period=3, p=((t%period)/period), x=p*(W+H)-H;
  const bw=W*0.18;
  const g=cx.createLinearGradient(x,0,x+bw,H);
  g.addColorStop(0,hexRGBA(col,0)); g.addColorStop(0.5,hexRGBA(col,0.22*I+0.1*beat)); g.addColorStop(1,hexRGBA(col,0));
  cx.save(); cx.fillStyle=g; cx.translate(0,0);
  cx.beginPath(); cx.moveTo(x,0); cx.lineTo(x+bw,0); cx.lineTo(x+bw-H,H); cx.lineTo(x-H,H); cx.closePath(); cx.fill();
  cx.restore();
}
// —— 带随机性的大面积动效（每拍换一批随机位置，用 beatIdx 当种子稳定一拍内不乱跳）——
// 11) 随机闪现方块：每拍在随机位置蹦出一批空心/实心方块
function fxBlocks(t,W,H,col,I,beat){
  const bi=beatInfo(t), seed=bi.beatIdx*13.7;
  const n=Math.round(4+I*10);
  cx.save(); cx.strokeStyle=col; cx.fillStyle=col; cx.lineWidth=Math.max(2,H*0.005)*FXW;
  for(let i=0;i<n;i++){
    const x=rand(seed+i)*W, y=rand(seed+i+50)*H;
    const s=(0.05+rand(seed+i+99)*0.14)*H*FXS;
    cx.globalAlpha=FXO*beat*(0.25+rand(seed+i+7)*0.4)*I;
    if(rand(seed+i+3)>0.5){ cx.fillRect(x-s/2,y-s/2,s,s); } else { cx.strokeRect(x-s/2,y-s/2,s,s); }
  }
  cx.restore();
}
// 12) 故障条：随机水平错位亮条（glitch）
function fxGlitch(t,W,H,col,I,beat){
  const bi=beatInfo(t), seed=Math.floor(t*12);   // 每 1/12 秒变一次
  const n=Math.round(3+I*8);
  cx.save(); cx.fillStyle=col;
  for(let i=0;i<n;i++){
    const y=rand(seed+i)*H, h=(0.01+rand(seed+i+20)*0.04)*H*FXS;
    const w=(0.2+rand(seed+i+40)*0.6)*W, x=rand(seed+i+60)*W*0.4;
    cx.globalAlpha=FXO*(0.15+rand(seed+i+5)*0.35)*I*(0.5+beat);
    cx.fillRect(x,y,w,h);
  }
  cx.restore();
}
// 13) 多边形爆发：每拍从中心向外炸开一批随机空心多边形
function fxBurst(t,W,H,col,I,beat){
  const bi=beatInfo(t), seed=bi.beatIdx*7.3;
  const prog=bi.beatProg;                       // 0(拍头)→1
  const n=Math.round(5+I*10);
  cx.save(); cx.strokeStyle=col; cx.lineWidth=Math.max(2,H*0.004)*FXW; cx.globalAlpha=FXO*(1-prog)*0.6*I;
  for(let i=0;i<n;i++){
    const ang=rand(seed+i)*Math.PI*2, dist=prog*(0.15+rand(seed+i+30)*0.35)*Math.hypot(W,H);
    const x=W/2+Math.cos(ang)*dist, y=H/2+Math.sin(ang)*dist;
    const s=(0.03+rand(seed+i+11)*0.06)*H*FXS, sides=3+Math.floor(rand(seed+i+22)*4);
    cx.save(); cx.translate(x,y); cx.rotate(rand(seed+i+9)*6.28);
    cx.beginPath(); for(let k=0;k<sides;k++){ const a=k*2*Math.PI/sides; const X=Math.cos(a)*s,Y=Math.sin(a)*s; k?cx.lineTo(X,Y):cx.moveTo(X,Y); } cx.closePath(); cx.stroke();
    cx.restore();
  }
  cx.restore();
}
// 14) 随机散布：全屏随机小图形（点/十字/环），缓慢漂移 + 拍头闪亮
function fxScatter(t,W,H,col,I,beat){
  const n=Math.round(20+I*60);
  cx.save(); cx.strokeStyle=col; cx.fillStyle=col; cx.lineWidth=Math.max(1.5,H*0.003)*FXW;
  for(let i=0;i<n;i++){
    const x=((rand(i)*W)+t*(10+rand(i+3)*20))%W;
    const y=((rand(i+7)*H)+t*(6+rand(i+9)*14))%H;
    const s=(0.006+rand(i+1)*0.02)*H*FXS;
    cx.globalAlpha=FXO*(0.15+rand(i+5)*0.3)*I*(0.6+beat*0.6);
    const kind=Math.floor(rand(i+2)*3);
    if(kind===0){ cx.beginPath(); cx.arc(x,y,s,0,7); cx.fill(); }
    else if(kind===1){ cx.beginPath(); cx.moveTo(x-s,y); cx.lineTo(x+s,y); cx.moveTo(x,y-s); cx.lineTo(x,y+s); cx.stroke(); }
    else { cx.beginPath(); cx.arc(x,y,s,0,7); cx.stroke(); }
  }
  cx.restore();
}
// 伪随机（同一 seed → 固定值，保证粒子/网格每帧位置稳定）
function rand(n){ const x=Math.sin((n+1)*127.1+PV.seed)*43758.5453; return x-Math.floor(x); }
// 当前字幕的中心宽度（用于下划线/角括号贴合），返回 {w, cx, cy, alpha}
function curLyricBox(t){
  const L=curLyric(t);
  if(!L || !L.visible || !L.text) return null;
  const H=cv.height, W=cv.width;
  const baseFs=PV.ly.fs*(H/720);
  cx.save();
  cx.font=`${PV.ly.fw} ${Math.round(baseFs)}px "PingFang SC","Microsoft YaHei",sans-serif`;
  const w=cx.measureText(L.text).width;
  cx.restore();
  return { w, cx:W/2, cy:H*PV.ly.pos, fs:baseFs, p:L.p, alpha:easeOut(L.p) };
}

// 1) 字幕下划线：随字幕入场从中间向两端展开
function drawUnderline(t){
  const b=curLyricBox(t); if(!b) return;
  const grow=easeOut(Math.min(1,b.p));
  const half=(b.w/2+b.fs*0.15)*grow;
  const y=b.cy+b.fs*0.62;
  cx.save(); cx.globalAlpha=b.alpha;
  cx.strokeStyle=PV.deco.color; cx.lineWidth=Math.max(2,b.fs*0.05); cx.lineCap='round';
  cx.beginPath(); cx.moveTo(b.cx-half,y); cx.lineTo(b.cx+half,y); cx.stroke();
  cx.restore();
}
// 2) 字幕角括号 [ ]：贴合字幕两侧，入场时轻微外扩
function drawBrackets(t){
  const b=curLyricBox(t); if(!b) return;
  const pad=b.fs*(0.35+0.25*(1-b.alpha));
  const half=b.w/2+pad, hh=b.fs*0.55, arm=b.fs*0.28, lw=Math.max(2,b.fs*0.06);
  cx.save(); cx.globalAlpha=b.alpha;
  cx.strokeStyle=PV.deco.color; cx.lineWidth=lw; cx.lineCap='round'; cx.lineJoin='round';
  // 左
  cx.beginPath(); cx.moveTo(b.cx-half+arm,b.cy-hh); cx.lineTo(b.cx-half,b.cy-hh);
  cx.lineTo(b.cx-half,b.cy+hh); cx.lineTo(b.cx-half+arm,b.cy+hh); cx.stroke();
  // 右
  cx.beginPath(); cx.moveTo(b.cx+half-arm,b.cy-hh); cx.lineTo(b.cx+half,b.cy-hh);
  cx.lineTo(b.cx+half,b.cy+hh); cx.lineTo(b.cx+half-arm,b.cy+hh); cx.stroke();
  cx.restore();
}
// 3) 卡点圆点/圆环：四角处随拍头放大后回落
function drawBeatDots(t){
  const { beatProg }=beatInfo(t);
  const W=cv.width, H=cv.height;
  const pop=Math.pow(1-beatProg,3);            // 拍头=1，衰减
  const r=Math.min(W,H)*0.014*(0.6+pop);
  const m=Math.min(W,H)*0.08;
  const pts=[[m,m],[W-m,m],[m,H-m],[W-m,H-m]];
  cx.save();
  for(let i=0;i<pts.length;i++){
    const [x,y]=pts[i];
    cx.globalAlpha=0.35+0.55*pop;
    if(i%2===0){ cx.fillStyle=PV.deco.color; cx.beginPath(); cx.arc(x,y,r,0,7); cx.fill(); }
    else { cx.strokeStyle=PV.deco.color; cx.lineWidth=Math.max(1.5,r*0.28);
      cx.beginPath(); cx.arc(x,y,r*1.4,0,7); cx.stroke(); }
  }
  cx.restore();
}
// 4) 漂浮粒子：缓慢上升，拍头轻微加亮
function drawParticles(t){
  const W=cv.width, H=cv.height;
  const n=Math.round(14+PV.deco.den*46);
  const { beatProg }=beatInfo(t);
  const glow=0.4+0.4*Math.pow(1-beatProg,3);
  cx.save(); cx.fillStyle=PV.deco.color;
  for(let i=0;i<n;i++){
    const seed=i*97.13;
    const x=((rand(i)*W)+Math.sin(t*0.2+seed)*20)%W;
    const speed=0.02+rand(i+3)*0.05;
    const y=H-((t*speed*H + rand(i+7)*H)%H);   // 由下往上循环
    const r=(0.6+rand(i+1)*1.8)*(H/720);
    cx.globalAlpha=(0.12+rand(i+5)*0.35)*glow;
    cx.beginPath(); cx.arc(x,y,r,0,7); cx.fill();
  }
  cx.restore();
}
// 5) 点阵网格：静态科技感底纹，拍头整体轻微呼吸
function drawGrid(t){
  const W=cv.width, H=cv.height;
  const { beatProg }=beatInfo(t);
  const gap=Math.max(22, 60-PV.deco.den*40);
  const r=1.3*(H/720)*(0.8+0.5*Math.pow(1-beatProg,3));
  cx.save(); cx.fillStyle=PV.deco.color; cx.globalAlpha=0.10+0.06*Math.pow(1-beatProg,3);
  for(let x=gap/2;x<W;x+=gap) for(let y=gap/2;y<H;y+=gap){
    cx.beginPath(); cx.arc(x,y,r,0,7); cx.fill();
  }
  cx.restore();
}
// 6) 安全边框 + 角标（AE 常见构图装饰）
function drawFrame(){
  const W=cv.width, H=cv.height, m=Math.min(W,H)*0.045, c=Math.min(W,H)*0.05;
  cx.save(); cx.strokeStyle=PV.deco.color; cx.globalAlpha=0.5; cx.lineWidth=Math.max(1.5,H*0.003);
  cx.strokeRect(m,m,W-2*m,H-2*m);
  cx.globalAlpha=0.9; cx.lineWidth=Math.max(2,H*0.006); cx.lineCap='round';
  const corners=[[m,m,1,1],[W-m,m,-1,1],[m,H-m,1,-1],[W-m,H-m,-1,-1]];
  for(const [x,y,sx,sy] of corners){
    cx.beginPath(); cx.moveTo(x+sx*c,y); cx.lineTo(x,y); cx.lineTo(x,y+sy*c); cx.stroke();
  }
  cx.restore();
}
// 7) 底部进度条（细线 + 播放头小圆）
function drawProgress(t){
  const W=cv.width, H=cv.height, dur=audio.duration||1;
  const p=Math.min(1,t/dur), y=H*0.965, x0=W*0.06, x1=W*0.94;
  cx.save();
  cx.strokeStyle='rgba(255,255,255,.25)'; cx.lineWidth=Math.max(2,H*0.004); cx.lineCap='round';
  cx.beginPath(); cx.moveTo(x0,y); cx.lineTo(x1,y); cx.stroke();
  cx.strokeStyle=PV.deco.color;
  cx.beginPath(); cx.moveTo(x0,y); cx.lineTo(x0+(x1-x0)*p,y); cx.stroke();
  cx.fillStyle='#fff'; cx.beginPath(); cx.arc(x0+(x1-x0)*p,y,Math.max(3,H*0.006),0,7); cx.fill();
  cx.restore();
}
// 新增装饰：中心十字准星
function drawCrosshair(t){
  const W=cv.width,H=cv.height,c=PV.deco.color,g=Math.min(W,H)*0.03;
  cx.save(); cx.strokeStyle=c; cx.globalAlpha=0.6; cx.lineWidth=Math.max(1.5,H*0.003);
  cx.beginPath(); cx.moveTo(W/2-g,H/2); cx.lineTo(W/2+g,H/2); cx.moveTo(W/2,H/2-g); cx.lineTo(W/2,H/2+g); cx.stroke();
  cx.globalAlpha=0.4; cx.beginPath(); cx.arc(W/2,H/2,g*1.4,0,7); cx.stroke();
  cx.restore();
}
// 四角取景框标记
function drawCorners(t){
  const W=cv.width,H=cv.height,c=PV.deco.color,m=Math.min(W,H)*0.06,len=Math.min(W,H)*0.05;
  cx.save(); cx.strokeStyle=c; cx.globalAlpha=0.8; cx.lineWidth=Math.max(2,H*0.005); cx.lineCap='round';
  const cs=[[m,m,1,1],[W-m,m,-1,1],[m,H-m,1,-1],[W-m,H-m,-1,-1]];
  for(const [x,y,sx,sy] of cs){ cx.beginPath(); cx.moveTo(x+sx*len,y); cx.lineTo(x,y); cx.lineTo(x,y+sy*len); cx.stroke(); }
  cx.restore();
}
// 扫描线：一条水平亮线上下往返
function drawScanline(t){
  const W=cv.width,H=cv.height,c=PV.deco.color;
  const y=(Math.sin(t*0.8)*0.5+0.5)*H;
  cx.save(); cx.globalAlpha=0.5; cx.strokeStyle=c; cx.lineWidth=Math.max(2,H*0.004);
  cx.beginPath(); cx.moveTo(0,y); cx.lineTo(W,y); cx.stroke();
  cx.restore();
}
// 两侧竖边条
function drawSidebars(t){
  const W=cv.width,H=cv.height,c=PV.deco.color,bw=Math.min(W,H)*0.012,m=Math.min(W,H)*0.05;
  cx.save(); cx.fillStyle=c; cx.globalAlpha=0.7;
  cx.fillRect(m,H*0.2,bw,H*0.6); cx.fillRect(W-m-bw,H*0.2,bw,H*0.6);
  cx.restore();
}

function drawPV(t){
  drawBackground(t);
  if(PV.fxbig.layer==='back') drawFxBig(t);   // 大面积动效：字幕之后
  // —— 背景层装饰（在字幕之下） ——
  if(PV.deco.grid) drawGrid(t);
  if(PV.deco.particles) drawParticles(t);
  if(PV.fx.grain) drawGrain();
  drawElements(t, 'back');            // 用户图形：背景层
  if(PV.deco.frame) drawFrame();
  if(PV.deco.beatDots) drawBeatDots(t);
  drawFlash(t);
  // —— 字幕及其贴合装饰 ——
  drawElements(t, 'mid');             // 用户图形：字幕之下
  if(PV.deco.underline) drawUnderline(t);
  if(PV.deco.brackets) drawBrackets(t);
  drawLyric(t);
  drawElements(t, 'front');          // 用户图形：最上层
  if(PV.fxbig.layer==='front') drawFxBig(t);  // 大面积动效：字幕之前
  // —— 顶层 UI 装饰 ——
  drawTitle(t);
  if(PV.deco.progress) drawProgress(t);
  if(PV.deco.sidebars) drawSidebars(t);
  if(PV.deco.corners) drawCorners(t);
  if(PV.deco.crosshair) drawCrosshair(t);
  if(PV.deco.scanline) drawScanline(t);
  drawFilters(t);   // 画面滤镜后期层（最后）
}

function ensurePVLoop(){ if(PV.loopOn) return; PV.loopOn=true; requestAnimationFrame(pvTick); }
function pvTick(){
  if($('pvView').classList.contains('active')){ drawPV(audio.currentTime||0); updateTimelineBar(); }
  requestAnimationFrame(pvTick);
}

/* ===================== 独立时间轴（精细定位播放头） ===================== */
function tlDuration(){ return audio.duration||60; }
function updateTimelineBar(){
  const dur=tlDuration(), t=audio.currentTime||0, pct=Math.min(100, t/dur*100);
  const head=$('tlHead'), fill=$('tlFill'), tm=$('tlTime'), dr=$('tlDur');
  if(head) head.style.left=pct+'%';
  if(fill) fill.style.width=pct+'%';
  if(tm) tm.textContent=t.toFixed(2)+'s';
  if(dr) dr.textContent='/ '+dur.toFixed(2)+'s';
}
// 刻度：歌词起点（白）+ 当前选中元素/背景的关键帧（黄）
function renderTlTicks(){
  const host=$('tlTicks'); if(!host) return;
  const dur=tlDuration(); let html='';
  for(const l of S.lyrics){ html+=`<span class="tk ly" style="left:${(l.t/dur*100)}%"></span>`; }
  const ref = PV.sel==='cam' ? PV.cam : elById(PV.sel);
  if(ref && ref.keys){ const seen={};
    for(const p of ['x','y','scale','rot','op']){ for(const k of (ref.keys[p]||[])){
      const key=k.t.toFixed(2); if(seen[key]) continue; seen[key]=1;
      html+=`<span class="tk kf" style="left:${(k.t/dur*100)}%"></span>`; } } }
  host.innerHTML=html;
}
function tlSeek(clientX){
  const tr=$('tlTrack'), r=tr.getBoundingClientRect();
  let p=Math.min(1,Math.max(0,(clientX-r.left)/r.width));
  audio.currentTime=p*tlDuration(); clearEdit(); updateTimelineBar();
}
(function initTimeline(){
  const tr=$('tlTrack'); if(!tr) return;
  let drag=false;
  tr.addEventListener('pointerdown', e=>{ drag=true; tlSeek(e.clientX); });
  window.addEventListener('pointermove', e=>{ if(drag) tlSeek(e.clientX); });
  window.addEventListener('pointerup', ()=>drag=false);
  const nudge=d=>{ audio.currentTime=Math.min(tlDuration(),Math.max(0,audio.currentTime+d)); clearEdit(); updateTimelineBar(); };
  $('tlPlay').onclick=()=>{ audio.paused?audio.play():audio.pause(); };
  $('tlF1').onclick=()=>nudge(-1); $('tlN1').onclick=()=>nudge(1);
  $('tlFp1').onclick=()=>nudge(-0.1); $('tlNp1').onclick=()=>nudge(0.1);
  $('tlFrmB').onclick=()=>nudge(-1/30); $('tlFrmF').onclick=()=>nudge(1/30);
  // 双击时间数字 → 手动输入精确秒数
  $('tlTime').ondblclick=()=>{ const v=prompt('跳到第几秒？', (audio.currentTime||0).toFixed(2));
    if(v!==null){ const n=parseFloat(v); if(!isNaN(n)){ audio.currentTime=Math.min(tlDuration(),Math.max(0,n)); clearEdit(); updateTimelineBar(); } } };
  audio.addEventListener('play', ()=>{ const b=$('tlPlay'); if(b) b.textContent='⏸'; });
  audio.addEventListener('pause', ()=>{ const b=$('tlPlay'); if(b) b.textContent='▶'; });
})();

/* ===================== 导出 WebM（通用录制器） ===================== */
let recorder=null, recCtx=null;
// 音频源只能建一次：全局缓存 AudioContext + 源节点 + 目标流
function getAudioDest(){
  if(recCtx) return recCtx;
  const ac=new (window.AudioContext||window.webkitAudioContext)();
  const srcNode=ac.createMediaElementSource(audio);
  const dest=ac.createMediaStreamDestination();
  srcNode.connect(dest); srcNode.connect(ac.destination);
  recCtx={ ac, dest };
  return recCtx;
}
// 录制任意 canvas + 音频；onStopUI(label) 用于恢复按钮文字
async function recordCanvas(canvas, statusEl, btnEl, idleLabel){
  if(!S.audioURL){ alert('请先导入音频'); return; }
  if(recorder && recorder.state==='recording'){ recorder.stop(); return; }
  try{
    const { ac, dest }=getAudioDest();
    const canvasStream=canvas.captureStream(60);
    const mixed=new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus' : 'video/webm';
    recorder=new MediaRecorder(mixed,{ mimeType:mime, videoBitsPerSecond:8_000_000 });
    const chunks=[];
    recorder.ondataavailable=e=>{ if(e.data.size) chunks.push(e.data); };
    recorder.onstop=()=>{
      const blob=new Blob(chunks,{type:'video/webm'});
      const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
      a.download=(S.meta.title||'pv')+'.webm'; a.click();
      statusEl.className='status ok'; statusEl.textContent='导出完成，已下载 .webm';
      btnEl.textContent=idleLabel;
    };
    audio.currentTime=0; await audio.play(); await ac.resume();
    recorder.start();
    btnEl.textContent='■ 停止录制';
    statusEl.className='status'; statusEl.textContent='录制中…播放结束会自动停止（也可手动停止）';
    audio.onended=()=>{ if(recorder&&recorder.state==='recording') recorder.stop(); };
  }catch(err){
    statusEl.className='status err'; statusEl.textContent='录制失败：'+err.message;
  }
}
$('exportWebm').onclick = () => {
  recordCanvas(cv, $('pvStatus'), $('exportWebm'), '● 录制并导出 PV（.webm）');
};

/* ===================== 播放器画面渲染（用于导出视频） ===================== */
const plCv=$('playerCanvas'), plx=plCv.getContext('2d');
let plLoop=false;
function drawPlayer(t){
  const W=plCv.width, H=plCv.height;
  plx.clearRect(0,0,W,H);
  const img=S.imgEl;
  // 背景：封面模糊铺满 + 压暗
  if(img && img.complete && img.naturalWidth){
    const ir=img.naturalWidth/img.naturalHeight, cr=W/H;
    let dw,dh; if(ir>cr){ dh=H*1.15; dw=dh*ir; } else { dw=W*1.15; dh=dw/ir; }
    plx.save(); plx.filter='blur(40px) brightness(0.45)';
    plx.drawImage(img, W/2-dw/2, H/2-dh/2, dw, dh); plx.restore();
    plx.fillStyle='rgba(13,13,16,0.45)'; plx.fillRect(0,0,W,H);
  } else { plx.fillStyle='#14161a'; plx.fillRect(0,0,W,H); }

  // —— 左侧：旋转黑胶 + 歌名 ——
  const cxp=W*0.28, cyp=H*0.44, R=Math.min(W,H)*0.26;
  const spin=(t/20)*Math.PI*2;   // 20 秒一圈，与 CSS 一致
  plx.save(); plx.translate(cxp,cyp); plx.rotate(spin);
  // 黑胶盘
  plx.beginPath(); plx.arc(0,0,R,0,7); plx.fillStyle='#0a0a0a'; plx.fill();
  plx.strokeStyle='rgba(255,255,255,0.06)'; plx.lineWidth=1;
  for(let r=R*0.42; r<R; r+=6){ plx.beginPath(); plx.arc(0,0,r,0,7); plx.stroke(); }
  // 封面圆
  if(img && img.complete && img.naturalWidth){
    plx.save(); plx.beginPath(); plx.arc(0,0,R*0.62,0,7); plx.clip();
    const s=R*1.24, ir=img.naturalWidth/img.naturalHeight; let dw,dh;
    if(ir>1){ dh=s; dw=s*ir; } else { dw=s; dh=s/ir; }
    plx.drawImage(img,-dw/2,-dh/2,dw,dh); plx.restore();
  } else { plx.beginPath(); plx.arc(0,0,R*0.62,0,7); plx.fillStyle='#333'; plx.fill(); }
  // 中心轴
  plx.beginPath(); plx.arc(0,0,R*0.08,0,7); plx.fillStyle='#14161a'; plx.fill();
  plx.strokeStyle='#555'; plx.lineWidth=3; plx.stroke();
  plx.restore();

  // 歌名 + 歌手（唱片下方）
  plx.textAlign='center'; plx.fillStyle='#fff';
  plx.font='700 '+Math.round(H*0.045)+'px "PingFang SC","Microsoft YaHei",sans-serif';
  plx.fillText(S.meta.title||'未命名', cxp, cyp+R+H*0.09);
  const sub=[S.meta.artist&&('翻唱 '+S.meta.artist),S.meta.origin&&('原唱 '+S.meta.origin)].filter(Boolean).join('   ');
  if(sub){ plx.font=Math.round(H*0.026)+'px sans-serif'; plx.fillStyle='rgba(255,255,255,.65)';
    plx.fillText(sub, cxp, cyp+R+H*0.09+H*0.05); }

  drawPlayerLyrics(t, W, H);
}

// 右侧滚动歌词：当前句高亮居中，上下各显示几句
function drawPlayerLyrics(t, W, H){
  if(!S.lyrics.length){ return; }
  let idx=-1;
  for(let i=0;i<S.lyrics.length;i++){ if(S.lyrics[i].t<=t) idx=i; else break; }
  const cxp=W*0.72, cyp=H*0.5, lh=H*0.085;
  plx.textAlign='center';
  for(let d=-3; d<=3; d++){
    const i=idx+d; if(i<0||i>=S.lyrics.length) continue;
    const ln=S.lyrics[i], y=cyp+d*lh;
    const active=(d===0);
    plx.globalAlpha=active?1:Math.max(0.2,0.6-Math.abs(d)*0.13);
    plx.fillStyle=active?'#fff':'rgba(255,255,255,.7)';
    plx.font=(active?'700 ':'')+Math.round(H*(active?0.042:0.032))+'px "PingFang SC","Microsoft YaHei",sans-serif';
    plx.fillText(ln.text||' ', cxp, y);
  }
  plx.globalAlpha=1;
}

function playerRecTick(){
  if(!plLoop) return;
  drawPlayer(audio.currentTime||0);
  requestAnimationFrame(playerRecTick);
}
$('exportPlayer').onclick = () => {
  if(!S.audioURL){ alert('请先导入音频与歌词'); return; }
  if(recorder && recorder.state==='recording'){ recorder.stop(); return; }
  plLoop=true; drawPlayer(0); requestAnimationFrame(playerRecTick);
  recordCanvas(plCv, $('plStatus'), $('exportPlayer'), '● 录制并导出播放器视频（.webm）');
  // 录制结束时停掉绘制循环
  const origOnstop=()=>{ plLoop=false; };
  const chk=setInterval(()=>{ if(!recorder||recorder.state!=='recording'){ plLoop=false; clearInterval(chk); } }, 500);
};

/* AE 导出已移除 */

/* 初始化 */
resizeCanvas();
window.addEventListener('load',()=>{ setTimeout(()=>{ $('sharedBadge').style.display='none'; $('modal').classList.add('show'); }, 400); });
