#!/usr/bin/env node
/**
 * Extracts inline HTML templates from src/index.ts into separate files.
 * Run once: node scripts/extract-templates.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const indexPath = join(root, 'src', 'index.ts');
const src = readFileSync(indexPath, 'utf-8');

mkdirSync(join(root, 'src', 'templates'), { recursive: true });

// --- 1. Extract ERROR_HTML function ---
// Pattern: function ERROR_HTML(message: string): string { return `...`; }
const errorMatch = src.match(/^function ERROR_HTML\(message: string\): string \{[\s\S]*?\n\}/m);
if (!errorMatch) throw new Error('Could not find ERROR_HTML');
const errorFn = 'export ' + errorMatch[0] + '\n';
writeFileSync(join(root, 'src', 'templates', 'error.ts'), errorFn);
console.log('✓ error.ts written');

// --- 2. Extract HOME_HTML ---
// Find: const HOME_HTML = `...`; (ends with \n`;)
const homeStart = src.indexOf("const HOME_HTML = `");
if (homeStart === -1) throw new Error('Could not find HOME_HTML');
// Find the matching closing backtick-semicolon
let homeEnd = findTemplateEnd(src, homeStart + "const HOME_HTML = `".length);
const homeContent = src.substring(homeStart, homeEnd);
writeFileSync(join(root, 'src', 'templates', 'home.ts'), 'export ' + homeContent + '\n');
console.log('✓ home.ts written');

// --- 3. Extract GAME_HTML ---
const gameStart = src.indexOf("const GAME_HTML = `");
if (gameStart === -1) throw new Error('Could not find GAME_HTML');
let gameEnd = findTemplateEnd(src, gameStart + "const GAME_HTML = `".length);
const gameContent = src.substring(gameStart, gameEnd);
writeFileSync(join(root, 'src', 'templates', 'game.ts'), 'export ' + gameContent + '\n');
console.log('✓ game.ts written');

// --- 4. Extract ANALYTICS_HTML ---
const analyticsStart = src.indexOf("const ANALYTICS_HTML = `");
if (analyticsStart === -1) throw new Error('Could not find ANALYTICS_HTML');
let analyticsEnd = findTemplateEnd(src, analyticsStart + "const ANALYTICS_HTML = `".length);
const analyticsContent = src.substring(analyticsStart, analyticsEnd);
writeFileSync(join(root, 'src', 'templates', 'analytics.ts'), 'export ' + analyticsContent + '\n');
console.log('✓ analytics.ts written');

// --- 5. Build new index.ts ---
// Replace the template definitions with imports
let newIndex = src;

// Remove ERROR_HTML function
newIndex = newIndex.replace(errorMatch[0], '');
// Remove the 3 template constants  
newIndex = newIndex.replace(homeContent, '');
newIndex = newIndex.replace(gameContent, '');
newIndex = newIndex.replace(analyticsContent, '');

// Remove leftover blank comment lines
newIndex = newIndex.replace(/\n\/\/ Fix 5: Error page for expired\/ended rooms\n\n/g, '\n');
newIndex = newIndex.replace(/\n\/\/ Inline HTML - Frontend will be defined below\n/g, '\n');

// Add imports after the existing imports
const lastImport = newIndex.lastIndexOf("} from './d1-queries';");
const insertPoint = newIndex.indexOf('\n', lastImport) + 1;
const templateImports = `import { HOME_HTML } from './templates/home';
import { GAME_HTML } from './templates/game';
import { ANALYTICS_HTML } from './templates/analytics';
import { ERROR_HTML } from './templates/error';
`;
newIndex = newIndex.substring(0, insertPoint) + templateImports + newIndex.substring(insertPoint);

// Clean up excessive blank lines (3+ newlines -> 2)
newIndex = newIndex.replace(/\n{4,}/g, '\n\n');

writeFileSync(indexPath, newIndex);
console.log('✓ index.ts updated');

// Count lines
const newLines = newIndex.split('\n').length;
console.log(`\nindex.ts: ${newLines} lines (was 2854)`);

for (const f of ['error.ts', 'home.ts', 'game.ts', 'analytics.ts']) {
  const content = readFileSync(join(root, 'src', 'templates', f), 'utf-8');
  console.log(`templates/${f}: ${content.split('\n').length} lines`);
}

/**
 * Find the end of a template literal string, handling escaped backticks.
 * Start searching from the position AFTER the opening backtick.
 * Returns the position AFTER the closing `; 
 */
function findTemplateEnd(str, startAfterBacktick) {
  let i = startAfterBacktick;
  while (i < str.length) {
    if (str[i] === '\\') {
      i += 2; // skip escaped character
      continue;
    }
    if (str[i] === '`') {
      // Found closing backtick. Include the semicolon.
      const afterBacktick = str.indexOf(';', i);
      return afterBacktick + 1;
    }
    i++;
  }
  throw new Error('Could not find end of template literal');
}
