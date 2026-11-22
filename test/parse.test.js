const assert = require('assert');
const { parseTooltip } = require('../lib/parse');

// Text transcribed from a real in-game tooltip (Libae's Supercharged Pants)
const pants = `Libae's Supercharged Pants (Thief)
Heroic: Untradable
Duration: 3/10/2027 00:00 UTC (Can't Extend)
Armor
Bottom
Required Job Thief
Required Level Lv. 160
Set Effect Libae's Supercharged Equipment Set
STR +25 (0 +25)
Attack Power +6
Enemy DEF Ignored +5%
[Hologram] Registry Lv. +1
White Hole Lv. +1
[Hologram] Boss Damage Enhancement Skill Lv. +1
Scroll Enhancement None
Potential : Unique
Max HP +10%`;
let r = parseTooltip(pants);
assert.strictEqual(r.slot, 2);
assert.strictEqual(r.job, 'THF');
assert.deepStrictEqual(r.lines, ['reg', 'wh', 'bd']);

r = parseTooltip(`Libae's Hat\nHat\n[Hologram] Attack Power & Magic ATT Enhancement Skill Lv. +1\n[Hologram] Dimensional Leap Lv. +1\n[Hologram] Mage Skill Lv. +1`);
assert.strictEqual(r.slot, 0);
assert.deepStrictEqual(r.lines, ['atk', 'dl', 'mage']);

r = parseTooltip(`Gloves\n[Hologram] Critical Damage Enhancement Lv. +1\n[Hologram] Damage Enhancement Lv. +1\n[Hologram] Thief Lv.+1`);
assert.deepStrictEqual(r.lines, ['crit', 'dmg', 'thief']);

// Wrapped [Hologram] Attack Power & Magic ATT Enhancement\nSkill Lv. +1
r = parseTooltip(`Libae's Supercharged Hat (Warrior)\nHat\n[Hologram] Attack Power & Magic ATT Enhancement\nSkill Lv. +1\nDimensional Leap Lv. +1\nWhite Hole Lv. +1`);
assert.strictEqual(r.slot, 0);
assert.deepStrictEqual(r.lines, ['atk', 'dl', 'wh']);

r = parseTooltip(`[Hologram] Warrior Attack Skill Level Lv. +1\n[Hologram] Registry Lv. +1\n[Hologram] Bowman Attack Skill Level Lv. +1`);
assert.deepStrictEqual(r.lines, ['warrior', 'reg', 'archer']);

// Equipped Cape with Set Effect panel listing Hat, Top, Bottom, Gloves, Shoes, Cape
r = parseTooltip(`percharged Cape (Warrior)\nCape\nHat Libae's Supercharged Hat\nTop Libae's Supercharged Top\nCape Libae's Supercharged Cape\n[Hologram] Warrior Attack Skill Level Lv. +1\n[Hologram] Registry Lv. +1`);
assert.strictEqual(r.slot, 3);
assert.deepStrictEqual(r.lines, ['warrior', 'reg']);

// OCR variants from real Pants scan
r = parseTooltip(`Bottom\n[Hologram] Magician Attack Skill Ly. +1\nrologaml hist Atack Skill or CSuill Ly oq\nHoloaram Cite Damage Enhancement Skil Ly +1`);
assert.strictEqual(r.slot, 2);
assert.deepStrictEqual(r.lines, ['mage', 'thief', 'crit']);

// Shoes scan where Set Effect has "Gloves Libae's Supercharged Glove" (singular Glove)
r = parseTooltip(`ae's Supercharged Shoes (Warrior) | Hat Libae's Supercharged Hat\nTop Libhae's Supercharged Top\nBottom Lihae's Supercharged Pants\ni Gloves Libae's Supercharged Glove\n~ l' Shoes Lihae's Supercharged Shoes\nShoes 25et Effect\nram) Pirate Attack Skill Lv. +1\nram] Registry Ly. +1\nrarn] Attack Power & Magic ATT Enhancement`);
assert.strictEqual(r.slot, 5);
assert.deepStrictEqual(r.lines, ['pirate', 'reg', 'atk']);

// Cape scan where "Enhancement" is clipped at the right edge
r = parseTooltip(`Libae's Supercharged Cape (Mag\nDimensional Leap Lv. +1\n[Hologram] Critical Damage Enhancement S\n[Hologram] Attack Power & Magic ATT Enhan\nSkill Lv. +1`);
assert.strictEqual(r.slot, 3);
assert.deepStrictEqual(r.lines, ['dl', 'crit', 'atk']);

// Ignore our own overlay / non-tooltip screen text
r = parseTooltip(`3L Solver 17/18\nAuto: ON\nONE DROP FINISHES IT (8)\nDimensional Leap\nWhite Hole`);
assert.strictEqual(r.slot, null);
assert.deepStrictEqual(r.lines, []);

// Missing closing paren or clipped "(Thi" / "(Thil" at right edge
r = parseTooltip(`Libae's Supercharged Top (Thi\nRequired Job`);
assert.strictEqual(r.slot, 1);
assert.strictEqual(r.job, 'THF');
console.log('parse tests passed');
