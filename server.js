/*
 * 网易云解析 + 静态托管服务（可选，仅在需要"粘贴链接自动解析歌词"时使用）
 * 需要 Node.js 18+（自带全局 fetch / crypto.randomUUID）
 * 启动： npm install && npm start   然后访问 http://localhost:8080
 * 不用解析功能的话，index.html 双击即可用，不需要这个文件。
 *
 * 歌词解析采用网易云网页端的加密接口（WEAPI：两轮 AES-CBC + RSA），
 * 比明文 /api/ 接口更稳定、更不易被限流。移植自开源项目
 * jitwxs/163MusicLyrics（C#），此处用 Node 原生 crypto + BigInt 实现。
 * 明文接口作为兜底：WEAPI 失败时自动回退。
 */
const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

/* ============ WEAPI 加密（对齐 163MusicLyrics 的实现） ============ */
const MODULUS =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725' +
  '152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312' +
  'ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424' +
  'd813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const NONCE = '0CoJUm6Qyw8W8jud';
const PUBKEY = '010001';
const IV = '0102030405060708';

// 一轮 AES-128-CBC 加密，返回 base64（PKCS7 填充，与 C# 默认一致）
function aesEncode(text, key) {
  const cipher = crypto.createCipheriv(
    'aes-128-cbc',
    Buffer.from(key, 'utf8'),
    Buffer.from(IV, 'utf8')
  );
  return cipher.update(text, 'utf8', 'base64') + cipher.final('base64');
}

// 快速幂取模（RSA 加密核心）
function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

// RSA 无填充加密：反转密钥 → 转 hex → modPow → 补齐 256 位
function rsaEncode(text) {
  const reversed = text.split('').reverse().join('');
  const a = BigInt('0x' + Buffer.from(reversed, 'utf8').toString('hex'));
  const key = modPow(a, BigInt('0x' + PUBKEY), BigInt('0x' + MODULUS)).toString(16);
  return key.padStart(256, '0').slice(-256);
}

function createSecretKey(len) {
  const str = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < len; i++) s += str[Math.floor(Math.random() * str.length)];
  return s;
}

// 把请求体加密成 { params, encSecKey }
function weapiPrepare(obj) {
  const raw = JSON.stringify(obj);
  const secretKey = createSecretKey(16);
  return {
    params: aesEncode(aesEncode(raw, NONCE), secretKey),
    encSecKey: rsaEncode(secretKey),
  };
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3239.132 Safari/537.36';

async function weapiPost(url, obj) {
  const body = new URLSearchParams(weapiPrepare(obj)).toString();
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: 'https://music.163.com/',
      Cookie: 'os=pc; appver=8.9.70; NMTID=' + crypto.randomUUID(),
    },
    body,
  });
  return r.json();
}

/* ============ 明文接口（兜底） ============ */
const NE_HEADERS = {
  'User-Agent': UA,
  Referer: 'https://music.163.com/',
  Cookie: 'os=pc; appver=8.9.70',
};

// 静态托管当前目录（index.html 等）
app.use(express.static(__dirname));

// 从链接 / 短链 / 纯数字里解析出歌曲 id
async function resolveSongId(input) {
  input = (input || '').trim();
  if (!input) return null;
  if (/^\d+$/.test(input)) return input; // 直接就是 id

  let m = input.match(/[?&]id=(\d+)/);
  if (m) return m[1];
  m = input.match(/song\/(\d+)/);
  if (m) return m[1];

  // 短链（163cn.tv 之类）需要跟随重定向
  if (/163cn\.tv|music\.163\.com|\.163\.com/.test(input)) {
    try {
      const res = await fetch(input, { redirect: 'follow', headers: NE_HEADERS });
      const finalUrl = res.url || '';
      m = finalUrl.match(/[?&]id=(\d+)/) || finalUrl.match(/song\/(\d+)/);
      if (m) return m[1];
      const text = await res.text();
      m = text.match(/\/song\?id=(\d+)/) || text.match(/"id"\s*:\s*(\d+)/);
      if (m) return m[1];
    } catch (e) {
      /* ignore */
    }
  }
  return null;
}

// —— WEAPI：歌曲详情 —— 返回 { name, artists }
async function fetchDetailWeapi(id) {
  const url = 'https://music.163.com/weapi/v3/song/detail?csrf_token=';
  const data = { c: JSON.stringify([{ id }]), csrf_token: '' };
  const obj = await weapiPost(url, data);
  const song = obj && obj.songs && obj.songs[0];
  if (!song) return null;
  // weapi v3 用 ar/al；老结构用 artists/album，两者都兼容
  const artists = (song.ar || song.artists || []).map((a) => a.name).filter(Boolean);
  return { name: song.name || '', artists: artists.join(' / ') };
}

// —— WEAPI：歌词 —— 返回 { lyric, tlyric }
async function fetchLyricWeapi(id) {
  const url = 'https://music.163.com/weapi/song/lyric?csrf_token=';
  const data = { id: String(id), os: 'pc', lv: '-1', kv: '-1', tv: '-1', csrf_token: '' };
  const obj = await weapiPost(url, data);
  return {
    lyric: obj && obj.lrc ? obj.lrc.lyric || '' : '',
    tlyric: obj && obj.tlyric ? obj.tlyric.lyric || '' : '',
  };
}

// —— 明文兜底 ——
async function fetchDetailPlain(id) {
  const r = await fetch(`https://music.163.com/api/song/detail/?ids=[${id}]`, {
    headers: NE_HEADERS,
  });
  const detail = await r.json();
  const song = detail && detail.songs && detail.songs[0];
  if (!song) return null;
  return {
    name: song.name || '',
    artists: (song.artists || []).map((a) => a.name).join(' / '),
  };
}
async function fetchLyricPlain(id) {
  const r = await fetch(`https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`, {
    headers: NE_HEADERS,
  });
  const obj = await r.json();
  return {
    lyric: obj && obj.lrc ? obj.lrc.lyric || '' : '',
    tlyric: obj && obj.tlyric ? obj.tlyric.lyric || '' : '',
  };
}

// 解析歌曲信息 + 歌词（先 WEAPI，失败/空则回退明文）
app.get('/api/netease', async (req, res) => {
  try {
    const id = await resolveSongId(req.query.url);
    if (!id) return res.status(400).json({ error: '无法从该链接解析出歌曲 ID' });

    // 详情
    let detail = null;
    try {
      detail = await fetchDetailWeapi(id);
    } catch (e) {
      /* 回退 */
    }
    if (!detail || !detail.name) {
      try {
        detail = (await fetchDetailPlain(id)) || detail;
      } catch (e) {
        /* ignore */
      }
    }

    // 歌词
    let lyric = null;
    try {
      lyric = await fetchLyricWeapi(id);
    } catch (e) {
      /* 回退 */
    }
    if (!lyric || !lyric.lyric) {
      try {
        const plain = await fetchLyricPlain(id);
        if (plain.lyric) lyric = plain;
      } catch (e) {
        /* ignore */
      }
    }

    if ((!detail || !detail.name) && (!lyric || !lyric.lyric)) {
      return res.status(502).json({ error: '解析失败：接口无返回，可能被限流或该歌曲无公开歌词' });
    }

    res.json({
      id,
      name: detail ? detail.name : '',
      artists: detail ? detail.artists : '',
      lyric: lyric ? lyric.lyric : '',
      tlyric: lyric ? lyric.tlyric : '',
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 通用代理：把网易云的封面 / 音频转成同源，避免 canvas 被污染（影响导出）
app.get('/api/proxy', async (req, res) => {
  try {
    const u = req.query.u;
    if (!u) return res.status(400).end();
    const r = await fetch(u, { headers: NE_HEADERS, redirect: 'follow' });
    res.set('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    res.set('Access-Control-Allow-Origin', '*');
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(500).end();
  }
});

app.listen(PORT, () => {
  console.log(`\n  ▶ 播放器 / PV 工具已启动：  http://localhost:${PORT}\n`);
});
