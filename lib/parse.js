/* Parses OCR text from a MapleStory Libae gear tooltip into { slot, lines }.
   Works in the browser (window.QParse) and in Node (module.exports) for tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SLOTS = ['Hat', 'Top', 'Bottom', 'Cape', 'Glove', 'Shoe'];
  const squash = s => s.toLowerCase().replace(/[^a-z]/g, '');

  // Map one hologram line of text to a solver stat key (or 'other' / null if not a hologram line)
  function classify(line) {
    const q = squash(line);
    if (q.includes('regist') || q.includes('istry')) return 'reg';
    if (q.includes('whitehol') || q.includes('holel') || q.includes('halel')) return 'wh';
    if (q.includes('blackhol')) return 'other';
    if (q.includes('dimension') || q.includes('sional') || q.includes('nsiohal') || q.includes('leap') || q.includes('lean')) return 'dl';
    if ((q.includes('crit') || q.includes('cite') || q.includes('cito')) && q.includes('enhance')) return 'crit';
    if (q.includes('boss') && q.includes('enhance')) return 'bd';
    if ((q.includes('attackpower') || q.includes('magicatt')) && (q.includes('enha') || q.includes('hologram'))) return 'atk';
    const c = q.replace(/damage/g, ''); // "damage" contains "mage"
    if (/magician|mage/.test(c)) return 'mage';
    if (c.includes('pirate')) return 'pirate';
    if (/thief|rogue|thist|hief|histatack|histattack/.test(c)) return 'thief';
    if (c.includes('warrior') || /rior.*skill/.test(c)) return 'warrior';
    if (/bowman|sowma[nr]|archer/.test(c)) return 'archer';
    return 'other';
  }

  const isHologramLine = l =>
    !/required|set effect|duration|potential/i.test(l) &&
    !/^(skill\s+)?l[vy]\.?\s*\+\s*\d+$/i.test(l.trim()) &&
    (/hologram/i.test(l) || /\bl[vy]\.?\s*\+\s*\d/i.test(l));

  function detectSlot(text) {
    // Strip "Hat  Libae's Supercharged Hat" rows from the Set Effect panel so they don't outvote the item.
    const clean = text.replace(/\b(Hat|Top|Bottom|Gloves?|Shoes?|Cape)[ \t]+[^\n|]*?(?:Supercharged|Libae|Lihae|Libha)[^\n]*?(?:Hat|Top|Pants|Bottom|Gloves?|Shoes?|Cape)\b/gi, '');
    const pats = [
      [0, /\bhat\b/gi], [1, /\b(top|overall)\b/gi], [2, /\b(bottom|pants|trousers|skirt)\b/gi],
      [3, /\bcape\b/gi], [4, /\bgloves?\b/gi], [5, /\bshoes?\b/gi]
    ];
    let best = null, bestCount = 0;
    for (const [i, re] of pats) {
      const m = clean.match(re);
      const c = m ? m.length : 0;
      if (c > bestCount) { bestCount = c; best = i; }
    }
    if (best !== null) return best;
    const kw = [
      [0, /\b(cap|helm|helmet|crown|hood|beret)\b/i], [1, /shirt|robe|vest|jacket|coat|suit/i],
      [3, /cloak|mantle/i], [4, /gauntlet|bracer/i], [5, /boot|sandal|slipper/i]
    ];
    for (const [i, re] of kw) if (re.test(text)) return i;
    return null;
  }

  const NOISE = /\b(required|job|all stats|max hp|max mp|jump|speed|scroll|remaining|restore|jewel|enhancement details|interact|harvest|potential|duration|untradable|combat power|currently equipped|libae|supercharged|percharged)\b/i;

  const IS_TOOLTIP = /supercharged|untradable|required\s+(job|level)|scroll\s+enhanc|jewel\s+stats|currently\s+equipped|combat\s+power|l\s*[vy]\.?\s*\+\s*1\b/i;

  function detectItemJob(text) {
    const m = text.match(/(?:required\s+)?jo[bh]\s+(war|bow|mag|thi|pir)/i)
      || text.match(/(?:supercharged|hat|top|pants|bottom|cape|gloves?|shoes?)\s*[\(\[]\s*(war|bow|mag|thi|pir)/i)
      || text.match(/\((war|bow|mag|thi|pir)[a-z]*\)?/i);
    if (!m) return null;
    const j = m[1].toLowerCase();
    if (j === 'war') return 'WAR';
    if (j === 'bow') return 'BOW';
    if (j === 'mag') return 'MAG';
    if (j === 'thi') return 'THF';
    if (j === 'pir') return 'PIR';
    return null;
  }

  function parseTooltip(text) {
    const raw = String(text || '');
    if (/3l\s+solver|quanah\s+world\s+utilities|one\s+drop\s+finishes|add\s+to\s+my\s+gear/i.test(raw) || !IS_TOOLTIP.test(raw)) {
      return { slot: null, lines: [], job: null };
    }
    const rows = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const lines = [];
    for (const r of rows) {
      if (lines.length >= 3) break;
      if (NOISE.test(r) || /^\s*(str|dex|int|luk)\b/i.test(r) || /\brequired level\b/i.test(r)) continue;
      if (/^(skill\s+)?l\s*[vy]\.?\s*\+\s*\d+$/i.test(r)) continue;
      const k = classify(r);
      const isClass = k==='mage'||k==='pirate'||k==='thief'||k==='warrior'||k==='archer';
      if (k !== 'other' && (!isClass || /skill|hologram/i.test(r))) {
        if (!lines.includes(k)) lines.push(k);
        continue;
      }
      if (isHologramLine(r)) lines.push('other');
    }
    return { slot: detectSlot(rows.join('\n')), lines, job: detectItemJob(raw) };
  }

  function detectCharClass(text) {
    if (!/character\s*info/i.test(text)) return null;
    const t = text.toLowerCase();
    const map = [
      ['WAR', 'STR', /erel|hero|paladin|dark\s*knight|dawn\s*warrior|mihile|blaster|demon|aran|kaiser|adele|hayato|zero/],
      ['PIR', 'STR', /buccaneer|cannoneer|shade|thunder\s*breaker|ark|corsair|mechanic|angelic\s*buster/],
      ['MAG', 'INT', /bishop|arch\s*mage|kanna|evan|luminous|battle\s*mage|blaze\s*wizard|illium|lara|kinesis|lynn/],
      ['THF', 'LUK', /night\s*lord|shadower|dual\s*blade|phantom|cadena|hoyoung|khali|night\s*walker/],
      ['BOW', 'DEX', /bowmaster|marksman|pathfinder|wind\s*archer|mercedes|wild\s*hunter|kain/]
    ];
    for (const [job, stat, re] of map) {
      const m = t.match(re);
      if (m) return { job, mainStat: stat, className: m[0] };
    }
    return null;
  }

  return { SLOTS, classify, detectSlot, detectItemJob, parseTooltip, detectCharClass };
});
